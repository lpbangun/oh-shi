import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEngine, type Baseline } from "../lib/daily-engine/engine";
import { openLocalStore } from "../lib/daily-engine/local";
import { listDailyCompanies, readRecords } from "../lib/daily-engine/persist";
import { directSources } from "../lib/daily-engine/lanes/direct";
import { tinyfishSources, TINYFISH_PREREQUISITE } from "../lib/daily-engine/lanes/tinyfish";
import { budgetFetcher } from "../lib/daily-engine/lanes/shared";
import { verifyHQ } from "../lib/daily-engine/hq-verification";
import { verifyFunding } from "../lib/daily-engine/funding-verification";
import { buildComparison, comparisonHtml } from "../lib/daily-engine/report";
import type { AcquisitionCandidate, CapCounter } from "../lib/daily-engine/types";

const exec = promisify(execFile);
const baseline = JSON.parse(await readFile("fixtures/daily-engine/baseline.json","utf8")) as Baseline;
const now = "2026-10-18T12:00:00.000Z";
const base = { lane: "direct" as const, baseline, inputId: "frozen-fixture", revision: "test-candidate", now, fixtures: true };
async function sources() { return directSources({ fixtures: "fixtures/daily-engine/direct", existing: [] }); }
async function storeFor(t: TestContext) {
  const store = await openLocalStore();
  t.after(() => store.close()); return store;
}

test("daily gate 1: real default CLI exits zero with shared-stage JSON report", async () => {
  // --out changes only the destination; fixture corpus is the no-network default.
  const dir = await mkdtemp(join(tmpdir(),"daily-cli-"));
  try {
    const result = await exec(process.execPath,["scripts/run-daily-engine.mjs","--out",dir],{maxBuffer:2_000_000});
    const report = JSON.parse(result.stdout);
    assert.equal(report.label,"FIXTURE");
    assert.deepEqual(report.stageReceipts.map((s: {stage:string})=>s.stage),["acquire","identity","us_hq","funding","persist","report"]);
    const consumer = JSON.parse((await exec(process.execPath,["scripts/run-daily-engine.mjs","--list","--out",dir])).stdout);
    assert.ok(consumer.some((c: {domain:string;openJobCount:number})=>c.domain==="zerojobs.example" && c.openJobCount===0));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("daily gate 2: both native fixture adapters persist D1 and expose zero-job funding through consumer", async t => {
  for (const lane of ["direct","tinyfish"] as const) {
    const store = await storeFor(t);
    const units = lane === "direct" ? await sources() : await tinyfishSources({fixtures:"fixtures/daily-engine/tinyfish"});
    const result = await runEngine({...base,lane,sources:units,db:store.db});
    const consumer = await listDailyCompanies(store.db);
    const zero = consumer.find(c=>c.domain==="zerojobs.example")!;
    assert.equal(zero.openJobCount,0); assert.equal(zero.fundingEvents.length,2);
    assert.equal(result.records.find(r=>r.company.domain==="cloudlead.example")?.company.hqStatus,"unknown");
    assert.ok(!consumer.some(c=>["cloudlead.example","maplefirm.example"].includes(c.domain)));
    assert.ok(consumer.some(c=>c.domain==="sprout.example"));
  }
});

test("daily gate 3: baseline company funding is maintenance; domain and event duplicates are distinct", async t => {
  const store = await storeFor(t);
  const r = await runEngine({...base,sources:await sources(),db:store.db});
  assert.equal(r.counts.baselineKnownSkipped,1);
  assert.equal(r.counts.newCompaniesPersisted,3); // zerojobs, dateless, sprout; not Vanta
  assert.equal(r.counts.newFundingEventsExistingCompanies,1);
  assert.equal(r.counts.duplicatesSkipped,1);
  assert.equal(r.records.filter(r=>r.company.domain==="zerojobs.example").length,1);
  assert.equal(r.records.find(r=>r.company.domain==="vanta.com")?.isNewCompany,false);
  assert.equal(r.counts.fundingEventsWithoutDate,1);
  assert.equal(r.counts.speculativeExcluded,1);
  const zero = r.records.find(r=>r.company.domain==="zerojobs.example")!;
  assert.deepEqual(new Set(zero.fundingEvents.map(e=>e.status)),new Set(["completed","announced"]));
});

test("daily gate 4: identical replay inserts zero rows/events and uses source checkpoints", async t => {
  const store = await storeFor(t);
  await runEngine({...base,sources:await sources(),db:store.db});
  const before = await readRecords(store.db);
  const replay = await runEngine({...base,sources:await sources(),db:store.db});
  assert.equal(replay.persistence.companiesAdded,0); assert.equal(replay.persistence.eventsAdded,0);
  assert.equal(replay.counts.newCompaniesPersisted,0);
  assert.ok(replay.persistence.checkpointsReused >= 8);
  assert.deepEqual(await readRecords(store.db),before);
});

test("daily gate 5: HTML as JSON quarantines source with bounded status/type/excerpt diagnostics", async t => {
  const store = await storeFor(t);
  const r = await runEngine({...base,sources:await sources(),db:store.db});
  const receipt = r.sourceReceipts.find(s=>s.sourceId==="malformed-json")!;
  assert.equal(receipt.status,"failed");
  assert.match(receipt.error!,/malformed_response status=200 content-type=application\/json excerpt=<html>/);
  assert.ok(receipt.error!.length < 500);
  assert.ok(!r.assessments.some(a=>a.candidate.evidenceUrl==="https://query.wikidata.org/sparql"));
});

test("daily gate 6: failed source does not abort later sources; permission blockers are unfetched", async t => {
  const store = await storeFor(t);
  const units = await sources();
  for (const source of units.filter(s=>s.permission!=="permitted")) source.acquire=async()=>{ throw new Error("permission boundary crossed"); };
  const r = await runEngine({...base,sources:units,db:store.db});
  assert.equal(r.sourceReceipts.find(s=>s.sourceId==="source-failure")?.error,"fixture_connection_reset");
  assert.ok(r.records.some(r=>r.company.domain==="sprout.example"));
  assert.equal(r.sourceReceipts.filter(s=>s.status==="blocked").length,2);
  assert.ok(!JSON.stringify(r).includes("permission boundary crossed"));
});

test("daily gate 7: interruption resumes atomic source checkpoint; failed sources can recover", async t => {
  const store = await storeFor(t);
  await assert.rejects(runEngine({...base,sources:await sources(),db:store.db,interruptAfterSources:2}),/simulated_interruption/);
  assert.equal((await listDailyCompanies(store.db)).length,1);
  const resumed = await runEngine({...base,sources:await sources(),db:store.db});
  assert.equal(resumed.persistence.checkpointsReused,1);
  assert.equal((await listDailyCompanies(store.db)).length,4);
  const units = await sources();
  let calls=0;
  units[1]={id:"source-failure",permission:"permitted",async acquire(){calls++;return {candidates:[],receipt:{sourceId:"source-failure",lane:"direct",status:"completed",requests:0,documentsChecked:0,candidatesFound:0}};}};
  await runEngine({...base,sources:units,db:store.db});
  await runEngine({...base,sources:units,db:store.db});
  assert.equal(calls,1,"recovered failures must gain a durable checkpoint");
});

test("daily gate 8: only explicit first-party US HQ verifies; news and offices remain leads", () => {
  const candidate: AcquisitionCandidate={companyName:"Acme",websiteUrl:"https://acme.example",evidenceUrl:"https://acme.example/about",publisher:"Acme",observedAt:now,kind:"new_company"};
  const evidence=(text:string,url=candidate.evidenceUrl)=>verifyHQ({...candidate,evidenceUrl:url,document:{title:"Acme",text,publishedAt:"",permission:"permitted"}},now);
  assert.equal(evidence("Headquartered in Austin, United States").status,"verified_us");
  assert.equal(evidence("Headquartered in Toronto, Canada").status,"non_us");
  for(const text of ["US customers","USD billing","A US office in Boston","Headquartered in London"]) assert.equal(evidence(text).status,"unknown");
  assert.equal(evidence("Headquartered in Austin, United States","https://news.crunchbase.com/acme").status,"unknown");
  assert.equal(verifyHQ({...candidate,headquartersHint:{location:"United States",method:"search",evidenceUrl:candidate.evidenceUrl}},now).status,"unknown");
});

test("daily gate 9: dry-run writes nothing; missing TinyFish prerequisites make zero calls; caps bound transport", async t => {
  const store = await storeFor(t);
  const dry=await runEngine({...base,sources:await sources(),db:store.db,dryRun:true});
  assert.equal(dry.persistence.companiesAdded,0);
  assert.equal((await readRecords(store.db)).length,0);
  assert.equal((await store.db.prepare("SELECT COUNT(*) AS n FROM daily_sources").first<{n:number}>())?.n,0);
  let calls=0;
  const blocked=await tinyfishSources({env:{},fetcher:async()=>{calls++;throw new Error("network forbidden");}});
  const report=await runEngine({...base,lane:"tinyfish",fixtures:false,sources:blocked,dryRun:true});
  assert.equal(calls,0); assert.equal(report.caps.fetchRequests,0);
  assert.equal(report.sourceReceipts[0].missingPrerequisite,TINYFISH_PREREQUISITE);
  // Adapter itself is also fail closed if called outside the engine.
  const context={now,lookbackDays:14,caps:{fetchRequests:0,searchRequests:0,maxFetchRequests:1,maxSearchRequests:1,deadlineAt:Date.now()+10000,exceeded:false} satisfies CapCounter,checkpoint:[],existingCompanies:[]};
  assert.equal((await blocked[0].acquire(context)).receipt.status,"blocked");
  const fetcher=budgetFetcher(context.caps,async()=>{calls++;return new Response("ok");});
  await fetcher("https://example.com"); await assert.rejects(fetcher("https://example.com"),/cap/);
  assert.equal(calls,1);
  const dir=await mkdtemp(join(tmpdir(),"daily-dry-"));
  try {
    await exec(process.execPath,["scripts/run-daily-engine.mjs","--dry-run","--out",dir]);
    await assert.rejects(stat(join(dir,"d1")),/ENOENT/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("daily gate 10: comparison derives matching fixture metrics and refuses mismatched baseline/revision", async () => {
  const a=await runEngine({...base,sources:await sources(),dryRun:true});
  const b=await runEngine({...base,lane:"tinyfish",sources:await tinyfishSources({fixtures:"fixtures/daily-engine/tinyfish"}),dryRun:true});
  const inputs=[{report:a,records:a.records,path:"../lane-a"},{report:b,records:b.records,path:"../lane-b"}];
  const comparison=buildComparison(inputs,baseline);
  assert.deepEqual(comparison.lanes[0].metrics.verifiedUs,comparison.lanes[1].metrics.verifiedUs);
  assert.equal(comparison.lanes[0].metrics.fixtureNewCompanyAbsentFromLimitedBaseline,3);
  assert.equal(comparison.lanes[0].metrics.recentVerifiedFundingEvents,3);
  assert.equal(comparison.lanes[0].metrics.cost,"UNKNOWN");
  assert.equal(comparison.lanes[0].metrics.historicalNovelty,"UNKNOWN-limited");
  assert.equal(comparison.verdict,"inconclusive"); assert.equal(comparison.liveComparison.sharedBaseline,"OK");
  const html=comparisonHtml(comparison);
  assert.ok(html.includes('name="viewport"')); assert.ok(!/<(?:script[^>]+src|link|img)\b/i.test(html));
  assert.match(html,/LIVE-BLOCKED/); assert.match(html,/zerojobs/);
  assert.throws(()=>buildComparison([{...inputs[0],report:{...a,revision:"other"}},inputs[1]],baseline),/mismatch/);
  assert.throws(()=>buildComparison(inputs,{composition:{productionEmployerDomains:[],repoSeedCompanyDomains:[]}}),/mismatch/);
  const event=verifyFunding({...a.assessments[0].candidate,document:{...a.assessments[0].candidate.document!,publishedAt:""}}, "zerojobs.example",false,now).event!;
  assert.equal(event.occurredAt,""); assert.deepEqual(event.evidenceGaps,["announcement_date_missing"]);
  assert.equal(event.stage,null); assert.equal(event.latestFundingLabel,"");
  const candidate = a.assessments[0].candidate;
  assert.equal(verifyFunding({...candidate,evidenceUrl:"https://news.crunchbase.com/venture/zerojobs"},"zerojobs.example",false,now).event?.sourceKind,"reputable");
  assert.equal(verifyFunding({...candidate,evidenceUrl:"https://google.com/search?q=zerojobs"},"zerojobs.example",false,now).event,null);
  const narrowA=await runEngine({...base,sources:await sources(),dryRun:true,lookbackDays:1});
  const narrowB=await runEngine({...base,lane:"tinyfish",sources:await tinyfishSources({fixtures:"fixtures/daily-engine/tinyfish"}),dryRun:true,lookbackDays:1});
  const narrow=buildComparison([{report:narrowA,records:narrowA.records,path:"a"},{report:narrowB,records:narrowB.records,path:"b"}],baseline);
  assert.equal(narrow.lanes[0].metrics.recentVerifiedFundingEvents,0);
});
