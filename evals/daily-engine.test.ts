import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEngine, type DailyRun, type Baseline } from "../lib/daily-engine/engine";
import { openLocalStore } from "../lib/daily-engine/local";
import { listDailyCompanies, readRecords } from "../lib/daily-engine/persist";
import { directSources } from "../lib/daily-engine/lanes/direct";
import { tinyfishSources, TINYFISH_PREREQUISITE } from "../lib/daily-engine/lanes/tinyfish";
import { validateReadinessManifest } from "../lib/daily-engine/readiness";
import { cli } from "../lib/daily-engine/cli";
import { budgetFetcher, webSession } from "../lib/daily-engine/lanes/shared";
import { createCaptureRecorder, type CaptureEvent } from "../lib/daily-engine/capture";
import { createHash } from "node:crypto";
import { assertTregRoute, loadTregKey, redactTreg, TregTransport, TREG_KEY_FILE, type TregOptions } from "../lib/daily-engine/treg";
import { PhaseLedger, ledgerTotals, validateTregLedger, type TregLedger } from "../lib/daily-engine/treg-ledger";
import { buildTregDiscovery, tregDiscoveryHtml, tregReportCli } from "../lib/daily-engine/treg-report";
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
  assert.equal(r.counts.fundingEventsExistingCompanies,1);
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
  assert.equal(comparison.verdict,"inconclusive"); assert.match(comparison.liveComparison.sharedBaseline,/Same fixture baseline inputs.*UNVERIFIED/);
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

test("daily D2: retained pending-HQ funding is separate from verified-US funding counters", async t => {
  const store = await storeFor(t);
  const current = await runEngine({...base,sources:await sources(),dryRun:true});
  const pending = await directSources({fixtures:"fixtures/daily-engine/pending-hq",existing:[]});
  const r = await runEngine({...base,sources:[...await sources(),...pending],db:store.db});
  const record = r.records.find(r=>r.company.domain==="uscustomers.example")!;
  assert.equal(record.company.hqStatus,"unknown"); assert.equal(record.fundingEvents.length,1);
  assert.ok(r.assessments.some(a=>a.domain==="uscustomers.example" && a.disposition==="pending_hq" && a.funding));
  assert.ok((await readRecords(store.db)).some(r=>r.company.domain==="uscustomers.example" && r.fundingEvents.length===1));
  assert.equal(r.counts.fundingEventsNewCompanies,current.counts.fundingEventsNewCompanies+1);
  assert.equal(r.counts.fundingEventsExistingCompanies,current.counts.fundingEventsExistingCompanies);
  assert.equal(r.counts.verifiedFundingEventsNewCompanies,current.counts.verifiedFundingEventsNewCompanies);
  assert.equal(r.counts.verifiedFundingEventsExistingCompanies,current.counts.verifiedFundingEventsExistingCompanies);
  assert.equal(r.counts.pendingHqFundingEvents,current.counts.pendingHqFundingEvents+1);
  assert.ok(r.counts.pendingHqFundingEvents>=1);
  assert.equal(r.counts.fundingEventsNewCompanies+r.counts.fundingEventsExistingCompanies,
    r.counts.verifiedFundingEventsNewCompanies+r.counts.verifiedFundingEventsExistingCompanies+r.counts.pendingHqFundingEvents);
});

async function retainedComparison() {
  const inputs = await Promise.all(["lane-a","lane-b"].map(async lane => {
    const report = JSON.parse(await readFile(`outputs/${lane}/run-report.json`,"utf8")) as DailyRun;
    const records = JSON.parse(await readFile(`outputs/${lane}/records.json`,"utf8"));
    return {report,records,path:`../${lane}`};
  }));
  const blocked = {report:JSON.parse(await readFile("outputs/tinyfish-blocked/run-report.json","utf8")) as DailyRun,path:"../tinyfish-blocked"};
  return {inputs,blocked,data:buildComparison(inputs,baseline,blocked)};
}

test("daily D1: retained per-side verdicts, live blockers and friendly metric labels are receipt-derived", async () => {
  const {inputs,blocked,data}=await retainedComparison();
  const html=comparisonHtml(data);
  for(const lane of data.lanes) {
    const report=inputs.find(i=>i.report.lane===lane.lane)!.report;
    assert.match(lane.functionalVerdict,/FIXTURE MECHANICS: ISSUES REPORTED/);
    for(const stage of report.stageReceipts.filter(s=>!s.ok)) assert.ok(lane.functionalVerdict.includes(stage.stage));
    for(const status of ["completed","failed","blocked"] as const) assert.ok(lane.functionalVerdict.includes(`${report.sourceReceipts.filter(r=>r.status===status).length} ${status==="completed"?"sources completed":status}`));
    assert.ok(html.includes(lane.functionalVerdict.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")));
    assert.equal(lane.liveYield,"UNKNOWN");
    assert.equal(lane.metricLabels.baselineKnown,"Baseline-known companies");
    assert.match(html,/New verified US companies \(absent from limited baseline\)/);
    assert.match(html,/<small>recentVerifiedFundingEvents<\/small>/);
    assert.equal(lane.metrics.recentVerifiedFundingEvents,lane.metrics.recentFundingExistingCompanies+lane.metrics.recentFundingNewCompanies);
  }
  assert.match(data.lanes[0].liveStatus,/LIVE: NOT RUN.*0 external requests/);
  assert.match(data.lanes[1].liveStatus,/LIVE: BLOCKED — credentials\/configuration missing/);
  const exact=blocked.report.sourceReceipts[0].missingPrerequisite!;
  assert.equal(data.lanes[1].missingPrerequisite,exact); assert.ok(html.includes(exact));
  assert.ok(html.includes('href="../tinyfish-blocked/run-report.json"'));
  await stat(join("outputs/comparison",data.lanes[1].blockedReceiptPath!));
  assert.match(data.recommendation,/mechanics tie.*No live evidence.*NOT evidence either lane is causally faster/);
  const unavailable=buildComparison(inputs,baseline);
  assert.match(unavailable.lanes[1].liveStatus,/prerequisite receipt unavailable/);
  assert.equal(unavailable.lanes[1].blockedReceiptPath,null);
  assert.ok(!unavailable.lanes[1].missingPrerequisite?.includes("Missing TINYFISH_API_KEY"));
  const healthy=inputs.map(i=>({...i,report:{...i.report,stageReceipts:i.report.stageReceipts.map(s=>({...s,ok:true})),sourceReceipts:i.report.sourceReceipts.map(s=>({...s,status:"completed" as const}))}}));
  assert.match(buildComparison(healthy,baseline).lanes[0].functionalVerdict,/FIXTURE MECHANICS: PASS/);
});

test("daily D3: baseline provenance separates unverified binding identity from limited coverage", async () => {
  const {data}=await retainedComparison();
  for(const content of [JSON.stringify(data),comparisonHtml(data)]) {
    assert.match(content,/general-jobs-index/); assert.match(content,/UNVERIFIED/);
    assert.match(content,/site-creator-d1/); assert.match(content,/Separate coverage limitation/);
    assert.ok(!content.includes("Read-only frozen production board_sources export"));
    assert.match(content,/absence from this limited baseline is not proof of novelty/);
  }
  assert.notEqual(data.liveComparison.sharedBaseline,"OK");
  assert.match(data.liveComparison.sharedBaseline,/fixture baseline inputs.*production binding identity UNVERIFIED/);
  assert.ok(!data.recommendation.includes("shared-baseline OK"));
});

const readinessManifest = () => validateReadinessManifest({
  schema: "ohshi-live-readiness/1", runId: "ohshi-live-readiness-r4-20261019", frozenAtUtc: now,
  authorizedCaps: { maxFetchRequests: 20, maxSearchRequests: 2, deadlineMsPerLane: 600000 },
  lanes: { direct: { permittedSourceIds: ["wikidata-startups", "techcrunch-venture"] }, tinyfish: { searchQueries: ["US startup funding headquarters"] } },
});
function transportContext(fetchCap = 20, searchCap = 2) {
  return { now, lookbackDays: 14, caps: { fetchRequests: 0, searchRequests: 0, maxFetchRequests: fetchCap, maxSearchRequests: searchCap, deadlineAt: Date.now() + 600000, exceeded: false }, checkpoint: [], existingCompanies: [] };
}
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

test("readiness TinyFish: documented GET search, POST HTML batches, exact auth and per-URL error isolation", async () => {
  const calls: Array<{url: string; init?: RequestInit}> = [];
  const hits = Array.from({length: 12}, (_, i) => ({ position: i + 1, site_name: "zerojobs.example", title: "ZeroJobs raises funding", snippet: "lead only", url: "https://zerojobs.example/news/" + i }));
  hits.push({position: 13, site_name: "not a domain/path", title: "Denied", snippet: "", url: "https://unpermitted.example/funding"});
  const units = await tinyfishSources({env: {TINYFISH_API_KEY: "mock-key"}, fetcher: async (input, init) => {
    const url = String(input); calls.push({url, init});
    assert.equal(init?.redirect, "error");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["X-API-Key"], "mock-key");
    assert.ok(!Object.keys(headers).some(k => k.toLowerCase() === "authorization"));
    if (url.startsWith("https://api.search.tinyfish.ai")) {
      assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined);
      assert.equal(new URL(url).searchParams.get("query"), "US startup funding headquarters");
      return jsonResponse({query: "US startup funding headquarters", results: hits, total_results: 13, page: 0});
    }
    assert.equal(url, "https://api.fetch.tinyfish.ai"); assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), ["format", "urls"]); assert.equal(body.format, "html");
    assert.equal(body.urls.length, 10);
    return jsonResponse({results: body.urls.slice(0, 9).map((url: string) => ({url, final_url: url, title: "ZeroJobs raises $2M", description: "", language: "en", format: "html", text: "<title>ZeroJobs raises $2M</title><p>ZeroJobs raised $2M. Headquartered in Austin, United States.</p>"})), errors: [{url: body.urls[9], code: "TIMEOUT", message: "timed out"}]});
  }});
  const context = transportContext(10);
  const result = await units[0].acquire(context);
  assert.equal(calls.length, 2); assert.equal(context.caps.fetchRequests, 10); assert.equal(context.caps.searchRequests, 1);
  assert.equal(result.receipt.fetchEnvelopes, 1); assert.equal(result.receipt.requests, 11);
  assert.equal(result.receipt.documentsSkipped, 3); assert.equal(result.receipt.documentsChecked, 9);
  assert.equal(result.receipt.documentErrors?.length, 1); assert.equal(result.candidates.length, 9);
});

test("readiness TinyFish: batches at most ten URLs and validates results arrays", async () => {
  const sizes: number[] = [];
  const units = await tinyfishSources({env: {TINYFISH_API_KEY: "mock"}, fetcher: async (_input, init) => {
    if (init?.method === "GET") return jsonResponse({results: Array.from({length: 21}, (_, i) => ({site_name: "news.crunchbase.com", url: "https://news.crunchbase.com/venture/" + i}))});
    const {urls} = JSON.parse(String(init?.body)); sizes.push(urls.length);
    return jsonResponse({results: [], errors: urls.map((url: string) => ({url, message: "DNS failure"}))});
  }});
  const context = transportContext();
  const result = await units[0].acquire(context);
  assert.deepEqual(sizes, [10, 10]); assert.equal(context.caps.fetchRequests, 20);
  assert.equal(result.candidates.length, 0); assert.equal(result.receipt.documentErrors?.length, 20);
  for (const invalidSearch of [true, false]) {
    const bad = await tinyfishSources({env: {TINYFISH_API_KEY: "mock"}, fetcher: async (_input, init) => init?.method === "GET" && !invalidSearch ? jsonResponse({results: [{url: "https://news.crunchbase.com/venture/a"}]}) : jsonResponse({results: {}})});
    await assert.rejects(bad[0].acquire(transportContext()), /malformed_response/);
  }
});

test("readiness TinyFish: search cap precedes network; documented HTTP error diagnosis; missing key stays zero", async () => {
  let calls = 0;
  const units = await tinyfishSources({env: {TINYFISH_API_KEY: "mock"}, searchQueries: ["funding", "seed", "venture"], fetcher: async () => {calls++; return jsonResponse({results: []});}});
  await assert.rejects(units[0].acquire(transportContext(20, 2)), /search_cap/); assert.equal(calls, 2);
  const failed = await tinyfishSources({env: {TINYFISH_API_KEY: "mock"}, fetcher: async () => jsonResponse({error: {code: "FREE_ALLOWANCE_EXHAUSTED", message: "No free requests remain"}}, 402)});
  await assert.rejects(failed[0].acquire(transportContext()), /402.*FREE_ALLOWANCE_EXHAUSTED.*No free requests remain/);
  calls = 0;
  const blocked = await tinyfishSources({env: {}, fetcher: async () => {calls++; throw new Error("forbidden");}});
  assert.equal((await blocked[0].acquire(transportContext())).receipt.missingPrerequisite, TINYFISH_PREREQUISITE); assert.equal(calls, 0);
});

test("readiness TinyFish: publisher is not company identity, final URL permissions and endpoint lock stay closed", async () => {
  let calls = 0;
  const units = await tinyfishSources({env: {TINYFISH_API_KEY: "mock"}, fetcher: async (_input, init) => {
    calls++;
    if (init?.method === "GET") return jsonResponse({results: [
      {site_name: "news.crunchbase.com", url: "https://news.crunchbase.com/venture/a"},
      {site_name: "zerojobs.example", url: "https://zerojobs.example/news"},
    ]});
    return jsonResponse({results: [
      {url: "https://news.crunchbase.com/venture/a", format: "html", text: "<title>ZeroJobs raises $2M</title><p>ZeroJobs raised $2M.</p>"},
      {url: "https://zerojobs.example/news", final_url: "https://denied.example/news", format: "html", text: "<title>ZeroJobs raises $2M</title>"},
    ], errors: []});
  }});
  const result = await units[0].acquire(transportContext());
  assert.equal(calls, 2); assert.equal(result.candidates.length, 0);
  assert.equal(result.receipt.documentsSkipped, 1); assert.match(result.receipt.documentErrors![0].error, /permission_denied/);
  await assert.rejects(tinyfishSources({env: {TINYFISH_API_KEY: "mock", TINYFISH_SEARCH_URL: "https://arbitrary.example"}, verifiedEndpointsOnly: true}), /documented_tinyfish_endpoints/);
});

test("readiness manifest: strict nested schema, ceilings, run identity and source/query allowlists", () => {
  const valid = readinessManifest();
  for (const change of [
    {extra: true}, {schema: "other"}, {runId: "random"}, {frozenAtUtc: "yesterday"},
    {authorizedCaps: {...valid.authorizedCaps, maxFetchRequests: 21}},
    {authorizedCaps: {...valid.authorizedCaps, maxSearchRequests: 3}},
    {authorizedCaps: {...valid.authorizedCaps, deadlineMsPerLane: 600001}},
    {authorizedCaps: {...valid.authorizedCaps, extra: 1}},
    {lanes: {...valid.lanes, direct: {permittedSourceIds: ["unknown"]}}},
    {lanes: {...valid.lanes, tinyfish: {searchQueries: ["a", "b", "c"]}}},
    {lanes: {...valid.lanes, tinyfish: {searchQueries: ["a"], endpoint: "https://evil.example"}}},
  ]) assert.throws(() => validateReadinessManifest({...valid, ...change}), /invalid_readiness/);
});

test("readiness CLI: absent manifest preserves refusal; invalid manifest fails before network or output/baseline I/O", async () => {
  const dir = await mkdtemp(join(tmpdir(), "readiness-cli-"));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {calls++; throw new Error("network forbidden");};
  try {
    await assert.rejects(cli(["--live", "--dry-run", "--out", join(dir, "old")]), /^Error: LIVE-BLOCKED: live collection is implemented but not enabled\/scored this round$/);
    const path = join(dir, "manifest.json");
    await writeFile(path, JSON.stringify({...readinessManifest(), schema: "invalid"}));
    await assert.rejects(cli(["--readiness-manifest", path, "--baseline", join(dir, "nonexistent"), "--out", join(dir, "bad")]), /invalid_readiness/);
    assert.equal(calls, 0);
    await assert.rejects(stat(join(dir, "bad")), /ENOENT/);
  } finally { globalThis.fetch = originalFetch; await rm(dir, {recursive: true, force: true}); }
});

test("readiness fixture-driven engine: capped transport, stable runId, never labels fixture live", async () => {
  const manifest = readinessManifest(); manifest.authorizedCaps.maxFetchRequests = 2;
  const corpus = JSON.parse(await readFile("fixtures/daily-engine/direct/corpus.json", "utf8"));
  const docs = corpus.sources.flatMap((s: {documents?: unknown[]}) => s.documents || []).slice(0, 3);
  const makeSources = () => [{id: "wikidata-startups", permission: "permitted" as const, async acquire(context: ReturnType<typeof transportContext>) {
    const transport = budgetFetcher(context.caps, async () => new Response("fixture"));
    for (const doc of docs) { assert.ok(doc); await transport("https://mock.example/document"); }
    throw new Error("cap_should_have_stopped_work");
  }}];
  const a = await runEngine({...base, sources: makeSources(), dryRun: true, readinessManifest: manifest});
  const b = await runEngine({...base, sources: makeSources(), dryRun: true, readinessManifest: manifest});
  assert.equal(a.label, "FIXTURE"); assert.equal(a.runId, b.runId);
  assert.equal(a.caps.fetchRequests, 2); assert.equal(a.caps.fetchCap, 2); assert.match(a.sourceReceipts[0].error!, /request_or_time_cap/);
  const live = await runEngine({...base, fixtures: false, sources: [], dryRun: true, readinessManifest: manifest});
  assert.equal(live.label, "LIVE-READINESS");
});

test("readiness direct: robots and redirects spend the same request/deadline budget", async () => {
  let calls = 0;
  const units = await directSources({existing: [], fetcher: async input => {
    calls++; const url = String(input);
    if (url.endsWith("robots.txt")) return new Response("User-agent: *\nAllow: /");
    return new Response(null, {status: 302, headers: {location: "/next"}});
  }});
  const source = units.find(s => s.id === "techcrunch-venture")!;
  const context = transportContext(2);
  await assert.rejects(source.acquire(context), /request_or_time_cap/);
  assert.equal(calls, 2); assert.equal(context.caps.fetchRequests, 2);
  const expired = transportContext(); expired.caps.deadlineAt = Date.now() - 1;
  await assert.rejects(source.acquire(expired), /request_or_time_cap/); assert.equal(calls, 2);
});

test("readiness comparison: actual receipts embedded, fixtures never live, unknown identity and no winner", async () => {
  const {buildLiveReadinessComparison, liveReadinessHtml} = await import("../scripts/build-live-readiness-comparison.mjs");
  const a = await runEngine({...base, sources: await sources(), dryRun: true});
  const b = await runEngine({...base, lane: "tinyfish", fixtures: false, sources: await tinyfishSources({env: {}}), dryRun: true});
  const data = buildLiveReadinessComparison(a, b);
  assert.match(data.A.status, /FIXTURE.*NOT LIVE/); assert.equal(data.B.zeroCalls, true);
  assert.deepEqual(data.B.missingPrerequisites, [TINYFISH_PREREQUISITE]);
  assert.equal(data.baselineIdentity.status, "UNRESOLVED"); assert.equal(data.baselineIdentity.novelty, "UNKNOWN-limited");
  assert.match(data.superiority, /NO winner/); assert.match(data.B.contractRepair, /UNKNOWN/);
  const html = liveReadinessHtml(data); assert.match(html, /zerojobs/); assert.match(html, /UNKNOWN-limited/);
  const prior = {...a, runId: "prior-r4", caps: {...a.caps, fetchRequests: 7, elapsedMs: 1899}};
  const ledger = buildLiveReadinessComparison(a, b, {priorDirect: prior});
  assert.ok(ledger.priorRuns && ledger.phaseLedger);
  assert.deepEqual(ledger.priorRuns[0].sourceReceipts, prior.sourceReceipts);
  assert.equal(ledger.phaseLedger.runs[0].runId, "prior-r4");
  assert.equal(ledger.phaseLedger.totals.fetchRequests, 7 + a.caps.fetchRequests);
  assert.equal(ledger.phaseLedger.totals.elapsedMsSum, 1899 + a.caps.elapsedMs + b.caps.elapsedMs);
  assert.equal(ledger.phaseLedger.totals.maxFetchRequests, 20);
  assert.ok(!/<(?:script[^>]+src|link|img)\b/i.test(html));
  assert.throws(() => buildLiveReadinessComparison(a, {...b, caps: {...b.caps, fetchRequests: 1}}), /zero_call/);
});

async function captureTestDir(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "offline-test-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}
async function captureEvents(dir: string): Promise<CaptureEvent[]> {
  return (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

test("round5 CLI: readiness dry-run refuses direct and TinyFish before baseline, network or store; fixtures stay offline", async t => {
  const dir = await captureTestDir(t), manifest = join(dir, "manifest.json");
  await writeFile(manifest, JSON.stringify(readinessManifest()));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("network forbidden"); });
  // Mock the entire env object; never assign a credential to process.env.
  const originalEnv = process.env;
  for (const [lane, configured] of [["direct", false], ["tinyfish", true], ["tinyfish", false]] as const) {
    Object.defineProperty(process, "env", {value: {...originalEnv, TINYFISH_API_KEY: configured ? "offline-mock-only" : undefined}, configurable: true, writable: true});
    try {
      await assert.rejects(cli(["--readiness-manifest", manifest, "--dry-run", "--capture", "--lane", lane, "--baseline", join(dir, "absent"), "--out", join(dir, "refused")]), /readiness_dry_run_not_supported/);
    } finally { Object.defineProperty(process, "env", {value: originalEnv, configurable: true, writable: true}); }
  }
  await assert.rejects(stat(join(dir, "refused")), /ENOENT/);
  await assert.rejects(cli(["--capture", "--out", join(dir, "invalid")]), /invalid_capture_without_readiness_manifest/);
  t.mock.method(console, "log", () => {});
  await cli(["--fixtures", "fixtures/daily-engine/direct", "--dry-run", "--out", join(dir, "fixture")]);
  await assert.rejects(stat(join(dir, "fixture", "d1")), /ENOENT/);
  await assert.rejects(stat(join(dir, "fixture", "capture")), /ENOENT/);
  assert.equal(calls, 0);
  const valid = readinessManifest(); valid.lanes.direct.permittedSourceIds = ["wikidata-startups"];
  await writeFile(manifest, JSON.stringify(valid));
  t.mock.method(globalThis, "fetch", async () => { calls++; return jsonResponse({results: {bindings: []}}); });
  for (const enabled of [false, true]) {
    const out = join(dir, enabled ? "on" : "off");
    await cli(["--readiness-manifest", manifest, "--out", out, ...(enabled ? ["--capture"] : [])]);
    const report = JSON.parse(await readFile(join(out, "run-report.json"), "utf8"));
    if (enabled) {
      assert.equal(report.captureEvidence.events, join(out, "capture", "events.jsonl"));
      assert.equal((await captureEvents(join(out, "capture"))).length, 1);
    } else {
      assert.equal(report.captureEvidence, undefined);
      await assert.rejects(stat(join(out, "capture")), /ENOENT/);
    }
  }
  assert.equal(calls, 2);
});

test("round5 capture: real engine robots, redirect and content reconcile; bodies hashed; one read; default untouched", async t => {
  const dir = await captureTestDir(t), capture = createCaptureRecorder(join(dir, "capture"));
  let calls = 0, reads = 0;
  const spy: typeof fetch = async input => {
    calls++;
    const url = String(input);
    const response = new Response(url.endsWith("robots.txt") ? "User-agent: *\nAllow: /" : "<title>Nothing</title>", {status: url.endsWith("/start") ? 302 : 200, headers: {"content-type": "text/html", location: "/end", "set-cookie": "private"}});
    const getReader = response.body!.getReader.bind(response.body!);
    response.body!.getReader = (() => { reads++; return getReader(); }) as typeof getReader;
    return response;
  };
  const report = await runEngine({...base, dryRun: true, capture, sources: [{id: "mock", permission: "permitted", async acquire(context) {
    const response = await webSession(context.caps, spy, context.capture).fetch("https://example.com/start");
    assert.deepEqual([...response.headers.keys()], ["content-type"]);
    await response.text();
    return {candidates: [], receipt: {sourceId: "mock", lane: "direct", status: "completed", requests: context.caps.fetchRequests, documentsChecked: 1, candidatesFound: 0}};
  }}]});
  const events = await captureEvents(join(dir, "capture"));
  assert.deepEqual(events.map(e => e.phase), ["robots", "redirect", "content"]);
  assert.equal(events.reduce((sum, e) => sum + e.requestUnits, 0), report.caps.fetchRequests + report.caps.searchRequests);
  assert.equal(calls, 3); assert.equal(reads, 3);
  for (const event of events) {
    const body = await readFile(event.body!.path, "utf8");
    assert.equal(event.body!.sha256, createHash("sha256").update(body).digest("hex"));
    assert.equal(event.body!.bytes, Buffer.byteLength(body));
    assert.equal(event.body!.truncated, false);
    assert.ok(event.startedAtUtc); assert.ok(event.elapsedMs >= 0);
  }
  assert.equal(events[1].ok, false);
  assert.equal(events[1].error, "http_302");
  const original = new Response("untouched");
  const returned = await budgetFetcher(transportContext().caps, async () => original)("https://example.com");
  assert.equal(returned, original); assert.equal(original.bodyUsed, false);
});

test("round5 capture: rejection, HTTP failure, cap refusal and oversized bodies are durable failed attempts", async t => {
  const dir = await captureTestDir(t), capture = createCaptureRecorder(dir);
  const context = transportContext(3);
  const rejection = budgetFetcher(context.caps, async () => { throw new Error("aborted offline"); }, 1, capture);
  await assert.rejects(rejection("https://example.com/a"), /aborted/);
  const bad = budgetFetcher(context.caps, async () => new Response("failure body", {status: 503}), 1, capture);
  assert.equal((await bad("https://example.com/b")).status, 503);
  const huge = budgetFetcher(context.caps, async () => new Response("x".repeat(1_000_001)), 1, capture);
  await assert.rejects(huge("https://example.com/c"), /public_document_too_large/);
  await assert.rejects(rejection("https://example.com/d"), /request_or_time_cap/);
  const events = await captureEvents(dir);
  assert.deepEqual(events.map(e => e.requestUnits), [1, 1, 1, 0]);
  assert.ok(events.every(e => !e.ok && e.error));
  assert.equal(events[0].body, undefined); assert.equal(events[3].body, undefined);
  assert.equal(await readFile(events[1].body!.path, "utf8"), "failure body");
  assert.equal(events[2].body!.truncated, true); assert.equal(events[2].body!.bytes, 1_000_000);
  assert.equal(events.reduce((sum, e) => sum + e.requestUnits, 0), context.caps.fetchRequests);
  const secret = "offline-reflected-secret";
  const reflected = budgetFetcher(transportContext().caps, async () => new Response("X-API-Key: " + secret), 1, capture);
  const response = await reflected("https://example.com/echo", {headers: {"X-API-Key": secret}});
  assert.doesNotMatch(await response.text(), /X-API-Key|offline-reflected-secret/i);
  const reflectedEvent = (await captureEvents(dir)).at(-1)!;
  assert.equal(reflectedEvent.body!.redacted, true);
  await budgetFetcher(transportContext().caps, async () => new Response("appended"), 1, createCaptureRecorder(dir))("https://example.com/append");
  const appended = (await captureEvents(dir)).at(-1)!;
  assert.match(appended.body!.path, /00000006-/);
  assert.equal(await readFile(appended.body!.path, "utf8"), "appended");
  assert.doesNotMatch(await readFile(reflectedEvent.body!.path, "utf8"), /X-API-Key|offline-reflected-secret/i);
});

test("round5 capture: TinyFish search and batch units reconcile without secrets; missing key has no events", async t => {
  const dir = await captureTestDir(t), capture = createCaptureRecorder(join(dir, "on"));
  let calls = 0;
  const units = await tinyfishSources({env: {TINYFISH_API_KEY: "offline-secret-marker"}, fetcher: async (_input, init) => {
    calls++;
    return init?.method === "GET" ? jsonResponse({results: [1, 2].map(i => ({url: "https://news.crunchbase.com/" + i}))}) : jsonResponse({results: []});
  }});
  const result = await runEngine({...base, lane: "tinyfish", sources: units, dryRun: true, capture});
  const events = await captureEvents(join(dir, "on"));
  assert.equal(calls, 2); assert.deepEqual(events.map(e => [e.phase, e.requestUnits]), [["search", 1], ["content", 2]]);
  assert.equal(events.reduce((sum, e) => sum + e.requestUnits, 0), result.caps.fetchRequests + result.caps.searchRequests);
  const evidence = JSON.stringify(events) + (await Promise.all(events.map(e => readFile(e.body!.path, "utf8")))).join("");
  assert.doesNotMatch(evidence, /X-API-Key|offline-secret-marker|headers/i);
  const blocked = await runEngine({...base, lane: "tinyfish", sources: await tinyfishSources({env: {}, fetcher: async () => {throw new Error("forbidden");}}), dryRun: true, capture: createCaptureRecorder(join(dir, "blocked"))});
  assert.equal(blocked.caps.fetchRequests + blocked.caps.searchRequests, 0);
  await assert.rejects(stat(join(dir, "blocked")), /ENOENT/);
});

test("round5 capture: failed HTTP document never gets a completed source receipt", async t => {
  const dir = await captureTestDir(t);
  const units = await directSources({existing: [], fetcher: async input => new Response("failed", {status: String(input).endsWith("robots.txt") ? 200 : 503, headers: {"content-type": "text/html"}})});
  const report = await runEngine({...base, sources: [units[0]], dryRun: true, capture: createCaptureRecorder(dir)});
  assert.equal(report.sourceReceipts[0].status, "failed");
  assert.equal((await captureEvents(dir))[0].ok, false);
});

const tregRunId = "ohshi-treg-discovery-r1-20261019";

// Round2: synthetic inputs exercise the real persistence boundary, not just the helper.
const encodedCanary = "R2%2F+ KEY/\"\\é";
const percentAll = (s: string) => Array.from(Buffer.from(s), b => "%" + b.toString(16).padStart(2, "0")).join("");
const jsonAll = (s: string) => s.split("").map(c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
const echoVariants = [encodedCanary, encodeURI(encodedCanary), encodeURIComponent(encodedCanary),
  new URLSearchParams({k: encodedCanary}).toString().slice(2), percentAll(encodedCanary),
  percentAll(encodedCanary).replace(/%[a-f0-9]{2}/g, (s, i) => i % 2 ? s.toUpperCase() : s),
  JSON.stringify(encodedCanary).slice(1,-1), jsonAll(encodedCanary),
  Array.from(encodedCanary, (c,i) => i % 3 === 0 ? percentAll(c) : i % 3 === 1 ? jsonAll(c) : c).join(""),
  encodeURIComponent(encodeURIComponent(encodedCanary)), jsonAll(encodeURIComponent(encodedCanary)),
  percentAll(jsonAll(encodedCanary))];

test("Treg round2 encoded echoes: capture, engine, ledger, audit, errors and reports", {timeout: 120000}, async t => {
  const ordinary = "ordinary %2f + space \\u0041 café <tag>";
  assert.equal(redactTreg(ordinary, encodedCanary), ordinary);
  for (const [index, echo] of echoVariants.entries()) for (const mode of ["success", "malformed", "http-error", "throw", "per-url", "cost-header", "off"]) {
    await t.test(`${index}-${mode}`, async t => {
      const s = await tregTest(t);
      const evidence = process.env.OHSHI_R2_EVIDENCE;
      const options = {...s.options, keyLoader: async () => encodedCanary};
      let calls = 0;
      const spy = mockTreg(url => {
        calls++;
        if (mode === "throw") throw new Error("provider " + echo);
        if (mode === "malformed") return new Response("invalid " + echo, {headers:{"content-type":"application/json; echo=" + echo}});
        if (mode === "http-error") return new Response("error " + echo, {status:500, headers:{"content-type":"application/json"}});
        if (mode === "per-url") return url.pathname.endsWith("search") ? jsonResponse({results:[{url:"https://acme.com/news",site_name:"acme.com"}]}) : jsonResponse({results:[],errors:[{url:"https://acme.com/news",error:echo}]});
        const response = jsonResponse({results:[], echo, ordinary});
        if (mode === "cost-header") response.headers.set("x-treg-cost-micro", echo);
        return response;
      }, c => { c.created_at = echo; c.ledger_id = echo; }, p => {
        for (const e of p.ledger as Record<string,unknown>[]) e.created_at = echo;
      });
      // Keep the existing mock's header assertions; only the transport sees the encoded synthetic key.
      const fetcher: typeof fetch = (input, init) => {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("x-treg-token"), encodedCanary);
        headers.set("x-treg-token", tregCanary);
        return spy(input, {...init, headers});
      };
      const units = await tinyfishSources({treg:options, searchQueries:["q"], fetcher});
      const before = await readFile(s.path,"utf8");
      const run = await runEngine({...base,lane:"tinyfish",sources:units,dryRun:true, capture:mode === "off" ? undefined : s.capture});
      const ledger = JSON.parse(await readFile(s.path,"utf8"));
      const audits = await Promise.all((await readdir(join(s.dir,"audits")).catch(()=>[])).map(async f=>JSON.parse(await readFile(join(s.dir,"audits",f),"utf8"))));
      const events = mode === "off" ? [] : await captureEvents(join(s.dir,"capture"));
      const data = buildTregDiscovery(run,[],[],ledger,audits,events, {
        "Synthetic fixtures only; zero live yield; original live attempt round-1/live/tinyfish-attempt2; round2 safety verification": "run-report.json",
      });
      const html = tregDiscoveryHtml(data);
      await writeFile(join(s.dir,"run-report.json"),JSON.stringify(run));
      await writeFile(join(s.dir,"synthetic-report.json"),JSON.stringify(data));
      const disk = await diskText(s.dir);
      if (evidence) {
        const {mkdir,cp} = await import("node:fs/promises");
        const dest = join(evidence,`${index}-${mode}`); await mkdir(dest,{recursive:true});
        await cp(s.dir,dest,{recursive:true,filter:p=>p!==s.key});
        await writeFile(join(dest,"synthetic-report.html"),html);
      }
      for (const variant of echoVariants) for (const output of [disk, JSON.stringify(run), html]) {
        assert.ok(!output.includes(variant), `${index}-${mode}: credential representation persisted`);
        assert.ok(!output.includes(JSON.stringify(variant).slice(1,-1)), `${index}-${mode}: JSON credential representation persisted`);
      }
      if (mode === "off") { assert.equal(calls,0); assert.equal(await readFile(s.path,"utf8"),before); assert.match(run.sourceReceipts[0].error!,/treg_capture_required/); }
      else if (mode === "success") { assert.equal(run.sourceReceipts[0].status,"completed"); assert.ok(disk.includes(JSON.stringify(ordinary).slice(1,-1))); }
      else if (mode !== "per-url") assert.equal(run.sourceReceipts[0].status,"failed");
    });
  }
});
const tregCanary = "synthetic-treg-canary-DO-NOT-PERSIST";
function emptyTregLedger(): TregLedger {
  return {schema: "ohshi-treg-acquisition-ledger/1", runId: tregRunId, caps: {maxSearchCalls: 2, maxFetchUrlUnits: 20, deadlineMs: 600000}, counters: {searchCalls: 0, fetchUrlUnits: 0, elapsedMs: 0}, entries: []};
}
async function tregTest(t: TestContext) {
  const dir = await captureTestDir(t), path = join(dir,"ledger.json"), key = join(dir,"key");
  await writeFile(path, JSON.stringify(emptyTregLedger()));
  await writeFile(key,tregCanary,{mode:0o600});
  const options: TregOptions = {keyFile: key, keyLoader: loadTregKey, ledger: path, runId: tregRunId, audits: join(dir,"audits")};
  return {dir, path, key, options, capture: createCaptureRecorder(join(dir,"capture"))};
}
function mockTreg(acquire: (url: URL, init?: RequestInit) => Response | Promise<Response>, changeAudit?: (call: Record<string,unknown>) => void, changePayload?: (payload: Record<string,unknown>) => void): typeof fetch {
  const endpoints = new Map<string,string>(); let n=0;
  return async (input,init) => {
    const url = new URL(String(input));
    assert.equal(url.origin,"https://treg.to");
    assert.equal(init?.redirect,"error");
    assert.equal(new Headers(init?.headers).get("x-treg-token"),tregCanary);
    if (url.pathname.endsWith("/access")) return jsonResponse({tier:"platform", estimated_cost_micro:0});
    if (url.pathname.startsWith("/calls/")) {
      const id = url.pathname.split("/").at(-1)!;
      const endpoint = endpoints.get(id);
      const call = {id, endpoint_id:endpoint, tool_name:endpoint, path:endpoint === "tinyfish.web.search" ? "https://api.search.tinyfish.ai/" : "https://api.fetch.tinyfish.ai/", credential_tier:"platform", provider:"tinyfish",cost_charged_micro:0,refused_by:null,user_email:"private@example.test",api_key:tregCanary};
      changeAudit?.(call);
      const payload: Record<string,unknown> = {call, charged_micro:0, ledger:[{kind:"reserve",amount_micro:0,endpoint_id:endpoint,created_at:now},{kind:"settle",amount_micro:0,endpoint_id:endpoint,created_at:now}]};
      changePayload?.(payload);
      return jsonResponse(payload);
    }
    assert.equal(new Headers(init?.headers).get("X-Treg-Route-Max-Cost"),"0");
    assert.match(new Headers(init?.headers).get("Idempotency-Key")!,/^[a-f0-9-]{36}$/);
    const response = await acquire(url,init), id = "call-" + ++n;
    endpoints.set(id,url.pathname.split("/").at(-1)!);
    if (!response.headers.has("x-treg-call-id")) response.headers.set("x-treg-call-id",id);
    if (!response.headers.has("x-treg-cost-micro")) response.headers.set("x-treg-cost-micro","0");
    return response;
  };
}
async function diskText(dir: string): Promise<string> {
  let text = "";
  for (const entry of await readdir(dir,{withFileTypes:true})) text += entry.isDirectory() ? await diskText(join(dir,entry.name)) : entry.name === "key" ? "" : await readFile(join(dir,entry.name),"utf8");
  return text;
}
test("Treg key: missing, empty, 0644 and non-regular files block with zero network", async t => {
  const setup = await tregTest(t); let calls=0;
  for (const mode of ["missing","empty","0644","directory"]) {
    const path = mode === "missing" ? join(setup.dir,"absent") : mode === "directory" ? setup.dir : setup.key;
    if (mode === "empty") await writeFile(setup.key,"");
    if (mode === "0644") { await writeFile(setup.key,tregCanary); await chmod(setup.key,0o644); }
    const units = await tinyfishSources({treg:{...setup.options,keyFile:path},fetcher:async()=>{calls++;throw new Error("forbidden");}});
    const report = await runEngine({...base,lane:"tinyfish",sources:units,dryRun:true});
    assert.equal(report.sourceReceipts[0].status,"blocked"); assert.equal(report.sourceReceipts[0].requests,0);
  }
  assert.equal(calls,0);
});

test("Treg documented transport: preflight, HTML POST <=10, per-URL errors, same-domain final URL and unique keys", async t => {
  const s = await tregTest(t), requests: RequestInit[]=[];
  const hits = Array.from({length:12},(_,i)=>({url:`https://acme.com/news/${i}`,site_name:"acme.com"}));
  const units = await tinyfishSources({treg:s.options,fetcher:mockTreg((url,init)=>{
    requests.push(init!);
    if (url.pathname.endsWith("search")) {assert.equal(url.searchParams.get("domain_type"),"web"); return jsonResponse({query:"q",results:[...hits,{url:"http://acme.com/no",site_name:"acme.com"},{url:"https://evil.example/no",site_name:"acme.com"}],total_results:14,page:1});}
    const body = JSON.parse(String(init?.body)); assert.ok(body.urls.length<=10); assert.equal(body.format,"html"); assert.equal(body.ttl,0); assert.equal(body.per_url_timeout_ms,30000);
    return jsonResponse({results:body.urls.map((url:string,i:number)=>({url,final_url:i===0?"https://other.com/news":url,format:i===1?"markdown":"html",text:"<title>Acme</title><p>Acme company</p>"})),errors:[{url:body.urls[2],error:"bad one"}]});
  })});
  const result = await units[0].acquire({...transportContext(),capture:s.capture});
  assert.equal(result.receipt.requests,13); assert.equal(result.receipt.fetchEnvelopes,2);
  assert.ok(result.receipt.documentErrors!.some(e=>e.error.includes("document_permission_denied")));
  assert.ok(result.receipt.documentErrors!.some(e=>e.error.includes("fetch_html_document_missing")));
  assert.ok(result.receipt.documentErrors!.some(e=>e.error.includes("bad one")));
  assert.ok(result.receipt.documentsChecked!>0);
  assert.equal(new Set(requests.map(r=>new Headers(r.headers).get("idempotency-key"))).size,requests.length);
  const events = await captureEvents(join(s.dir,"capture")); assert.equal(events.length,3); assert.equal(events.reduce((n,e)=>n+e.requestUnits,0),13);
  for (const e of events) assert.equal(createHash("sha256").update(await readFile(e.body!.path)).digest("hex"),e.body!.sha256);
  const ledger = validateTregLedger(JSON.parse(await readFile(s.path,"utf8"))); assert.equal(ledger.counters.fetchUrlUnits,12); assert.deepEqual(ledger.counters,ledgerTotals(ledger.entries));
  const text = await diskText(s.dir); assert.ok(!text.includes(tregCanary)); assert.ok(!text.includes("user_email")); assert.ok(!text.includes("api_key"));
});

test("Treg access: unknown/nonzero cost and absent or non-platform tier refuse all /call", async t => {
  for (const access of [{tier:"platform",estimated_cost_micro:1},{tier:"platform"},{tier:"platform",estimated_cost_micro:"0"},{estimated_cost_micro:0},{tier:"own_key",estimated_cost_micro:0},{tier:"other",estimated_cost_micro:0},null]) {
    const s=await tregTest(t); let calls=0;
    const units=await tinyfishSources({treg:s.options,fetcher:async input=>{if(String(input).includes("/call/")) calls++; return jsonResponse(access);}});
    await assert.rejects(units[0].acquire({...transportContext(),capture:s.capture}),/treg_access_not_proven_free/); assert.equal(calls,0);
  }
});

test("Treg routes: arbitrary origins/endpoints and redirects never forward the token", async t => {
  for (const url of ["https://evil.example/call/tinyfish.web.search","http://treg.to/call/tinyfish.web.search","https://treg.to/call/agent","https://user@treg.to/call/tinyfish.web.fetch","https://treg.to/call/tinyfish.web.fetch#bad"]) assert.throws(()=>assertTregRoute(url),/treg_route_refused/);
  const s=await tregTest(t); let calls=0;
  const units=await tinyfishSources({treg:s.options,fetcher:mockTreg(()=>{calls++; return new Response("",{status:302,headers:{location:"https://evil.example/"}});})});
  await assert.rejects(units[0].acquire({...transportContext(),capture:s.capture}),/treg_redirect_refused/); assert.equal(calls,1);
});

test("Treg cost and audit guards: absent/nonzero cost, missing id and audit mismatches stop later calls", async t => {
  for (const defect of ["absent-cost","paid","missing-id","endpoint","tool","provider","charged","refused"]) {
    const s=await tregTest(t); let calls=0;
    const spy=mockTreg(()=>{calls++; const r=jsonResponse({results:[]}); if(defect==="paid")r.headers.set("x-treg-cost-micro","1"); return r;},c=>{
      if(defect==="endpoint")c.endpoint_id="other"; if(defect==="tool")c.tool_name="other"; if(defect==="provider")c.provider="other"; if(defect==="charged")c.cost_charged_micro=1; if(defect==="refused")c.refused_by="guard";
    });
    const fetcher:typeof fetch=async(input,init)=>{const r=await spy(input,init); if(String(input).includes("/call/")){if(defect==="absent-cost")r.headers.delete("x-treg-cost-micro"); if(defect==="missing-id")r.headers.delete("x-treg-call-id");}return r;};
    const units=await tinyfishSources({treg:s.options,searchQueries:["one","two"],fetcher});
    const report=await runEngine({...base,lane:"tinyfish",sources:units,dryRun:true,capture:s.capture});
    assert.equal(report.sourceReceipts[0].status,"failed"); assert.equal(calls,1);
    const l=JSON.parse(await readFile(s.path,"utf8")); assert.ok(l.entries.some((e:{type:string})=>e.type==="failure"));
  }
});

test("Treg quarantine: malformed JSON/non-JSON and credential echoes are bounded and redacted everywhere", async t => {
  for (const variant of ["malformed","type","throw","per-url"]) {
    const s=await tregTest(t);
    const units=await tinyfishSources({treg:s.options,fetcher:mockTreg((url)=>{
      if(variant==="throw")throw new Error("X-Treg-Token " + tregCanary);
      if(variant==="per-url" && url.pathname.endsWith("search"))return jsonResponse({results:[{url:"https://acme.com/news",site_name:"acme.com"}]});
      if(variant==="per-url")return jsonResponse({results:[],errors:[{url:"https://acme.com/news",error:"X-Treg-Token " + tregCanary}]});
      return new Response(variant==="type"?JSON.stringify({results:[],error:tregCanary}):"X-Treg-Token " + tregCanary,{headers:{"content-type":variant==="type"?"text/html":"application/json"}});
    })});
    const report=await runEngine({...base,lane:"tinyfish",sources:units,dryRun:true,capture:s.capture});
    if(variant!=="per-url") assert.equal(report.sourceReceipts[0].status,"failed");
    if(["malformed","type"].includes(variant)) assert.match(report.sourceReceipts[0].error!,/malformed_response status=200 content-type=/);
    assert.ok(!JSON.stringify(report).includes(tregCanary)); const disk=await diskText(s.dir); assert.ok(!disk.includes(tregCanary)); assert.ok(!/x-treg-token/i.test(disk));
  }
});

test("Treg ledger: reservation fsynced before network resolves; restart search/fetch caps and reconciliation", async t => {
  const s=await tregTest(t);
  const ledger=new PhaseLedger(s.path,tregRunId,tregCanary);
  const spy=mockTreg(async()=>{
    const l=validateTregLedger(JSON.parse(await readFile(s.path,"utf8"))); assert.ok(l.entries.some(e=>e.type==="reservation")); return jsonResponse({results:[]});
  });
  const transport=new TregTransport(tregCanary,s.options,spy);
  await transport.call("https://treg.to/call/tinyfish.web.search?query=x",undefined,transportContext().caps,s.capture);
  await ledger.reserve("search",1);
  let network=0;
  const restart=new TregTransport(tregCanary,s.options,async()=>{network++;throw new Error("forbidden");});
  await assert.rejects(restart.call("https://treg.to/call/tinyfish.web.search",undefined,transportContext().caps,s.capture),/treg_phase_cap_exhausted/);
  await ledger.reserve("fetch",10); await ledger.reserve("fetch",10);
  await assert.rejects(restart.call("https://treg.to/call/tinyfish.web.fetch",["https://acme.com"],transportContext().caps,s.capture),/treg_phase_cap_exhausted/);
  assert.equal(network,0);
  const l=validateTregLedger(JSON.parse(await readFile(s.path,"utf8"))); assert.deepEqual(l.counters,ledgerTotals(l.entries)); assert.equal(l.counters.fetchUrlUnits,20);
});

test("Treg ledger: expired deadline, malformed counters/JSON and wrong run/token scope fail closed", async t => {
  for(const defect of ["deadline","counter","json","run","token"]) {
    const s=await tregTest(t), ledger=new PhaseLedger(s.path,tregRunId,tregCanary); await ledger.reserve("search",1);
    const l=JSON.parse(await readFile(s.path,"utf8"));
    if(defect==="deadline"){l.entries[0].at=Date.now()-600001; l.counters=ledgerTotals(l.entries);}
    if(defect==="counter")l.counters.searchCalls=0;
    if(defect==="run")l.runId="ohshi-treg-discovery-r1-20261020";
    if(defect==="token")l.entries[0].tokenScope="a".repeat(64);
    await writeFile(s.path,defect==="json"?"{":JSON.stringify(l)); let network=0;
    const transport=new TregTransport(tregCanary,s.options,async()=>{network++;throw new Error("forbidden");});
    await assert.rejects(transport.call("https://treg.to/call/tinyfish.web.search",undefined,transportContext().caps,s.capture),/treg_(?:phase_cap_exhausted|malformed_ledger|ledger_scope_mismatch)/); assert.equal(network,0);
  }
});

test("Treg capture OFF: authenticated acquisition refuses before network or persistence", async t => {
  const s=await tregTest(t), before=await readFile(s.path,"utf8"); let network=0;
  const units=await tinyfishSources({treg:s.options,fetcher:async()=>{network++;throw new Error(tregCanary);}});
  const report=await runEngine({...base,lane:"tinyfish",sources:units,dryRun:true});
  assert.match(report.sourceReceipts[0].error!,/treg_capture_required/); assert.equal(network,0); assert.equal(await readFile(s.path,"utf8"),before); await assert.rejects(stat(join(s.dir,"capture")),/ENOENT/);
});

test("Treg CLI/readiness: exact identity prefixes, dry-run/no-store, capture/ledger/lane gates and offline fixtures", async t => {
  const s=await tregTest(t), manifest=join(s.dir,"manifest.json"), out=join(s.dir,"refused");
  const m={...readinessManifest(),runId:tregRunId}; assert.equal(validateReadinessManifest(m).runId,tregRunId);
  for(const runId of ["arbitrary-20261019","ohshi-treg-discovery-r2-20261019","ohshi-treg-discovery-r1-20261019T120000Z"])assert.throws(()=>validateReadinessManifest({...m,runId}),/identity/);
  await writeFile(manifest,JSON.stringify(m));
  const args=["--readiness-manifest",manifest,"--lane","tinyfish","--treg-key-file",TREG_KEY_FILE,"--out",out,"--baseline",join(s.dir,"absent")];
  await assert.rejects(cli([...args,"--dry-run"]),/readiness_dry_run_not_supported/);
  await assert.rejects(cli(args),/treg_capture_required/);
  await assert.rejects(cli([...args,"--capture"]),/treg_ledger_required/);
  await assert.rejects(cli(["--lane","direct","--treg-key-file",TREG_KEY_FILE]),/treg_requires_tinyfish_lane/);
  await assert.rejects(stat(out),/ENOENT/);
  const units=await tinyfishSources({fixtures:"fixtures/daily-engine/tinyfish",treg:{keyFile:"does-not-exist"},fetcher:async()=>{throw new Error("forbidden");}}); assert.ok(units.length>0);
});

test("Treg B-only report: synthetic refusal, zero yield, escaped sections, unresolved baseline and no superiority", async () => {
  const run=await runEngine({...base,lane:"tinyfish",sources:await tinyfishSources({env:{}}),dryRun:true});
  run.sourceReceipts[0].missingPrerequisite="treg_capture_required <script>bad</script>";
  const data=buildTregDiscovery(run,[],[],emptyTregLedger(),[],[]);
  assert.equal(data.B.metrics.verifiedUS,0); assert.match(data.accounting.cost,/UNPROVEN/);
  const html=tregDiscoveryHtml(data);
  for(const word of ["NOT a matched control","Zero verified-US yield","B actual discovery","Request accounting and cost","Production baseline UNRESOLVED","binding identity unverified","No superiority claim","treg_capture_required","no production publication"])assert.ok(html.includes(word),word);
  assert.ok(!html.includes("<script>")); assert.ok(!html.includes("<pre>")); assert.ok(html.includes("&lt;script&gt;"));
});

test("Treg audit proof survives no-header capture; report cost requires actual matching audits", async t => {
  const s=await tregTest(t);
  const transport=new TregTransport(tregCanary,s.options,mockTreg(()=>jsonResponse({results:[]})));
  const response=await transport.call("https://treg.to/call/tinyfish.web.search?query=q",undefined,transportContext().caps,s.capture);
  assert.deepEqual([...response.headers.keys()],["content-type"]);
  const run=await runEngine({...base,lane:"tinyfish",sources:await tinyfishSources({env:{}}),dryRun:true});
  const ledger=JSON.parse(await readFile(s.path,"utf8"));
  const audits=await Promise.all((await readdir(join(s.dir,"audits"))).map(async f=>JSON.parse(await readFile(join(s.dir,"audits",f),"utf8"))));
  assert.match(buildTregDiscovery(run,[],[],ledger,audits,await captureEvents(join(s.dir,"capture"))).accounting.cost,/^\$0 — .*\(1 of 1\); 0 reserved units were never called/);
  const phase=new PhaseLedger(s.path,tregRunId,tregCanary), id=await phase.reserve("search",1);
  await phase.append(id,"result",{unitsConsumed:0,status:null,costHeader:null,callId:null,auditOutcome:"not_read",error:"treg_access_not_proven_free"});
  const withUnused=await phase.read();
  const data=buildTregDiscovery(run,[],[],withUnused,audits,[]);
  assert.equal(data.accounting.cost,"$0 — per-call audits verified charged_micro=0 and zero reserve/settle for every actual Treg /call (1 of 1); 1 reserved units were never called (preflight refusal), so no charge was possible.");
  assert.ok(tregDiscoveryHtml(data).includes(data.accounting.cost));
  assert.match(buildTregDiscovery(run,[],[],withUnused,[],[]).accounting.cost,/UNPROVEN/);
  const mismatch=structuredClone(withUnused); mismatch.entries.find(e=>e.type==="result" && e.unitsConsumed===1)!.auditOutcome="mismatch";
  assert.match(buildTregDiscovery(run,[],[],mismatch,audits,[]).accounting.cost,/UNPROVEN/);
  const unknown=structuredClone(withUnused); delete unknown.entries.find(e=>e.type==="result" && e.unitsConsumed===0)!.unitsConsumed;
  assert.match(buildTregDiscovery(run,[],[],unknown,audits,[]).accounting.cost,/UNPROVEN/);
  assert.match(buildTregDiscovery(run,[],[],ledger,[],[]).accounting.cost,/UNPROVEN/);
  assert.match(buildTregDiscovery(run,[],[],ledger,[...audits,{call:{...audits[0].call,id:"extra",cost_charged_micro:1}}],[]).accounting.cost,/UNPROVEN/);
  audits[0].call.cost_charged_micro=1;
  assert.match(buildTregDiscovery(run,[],[],ledger,audits,[]).accounting.cost,/UNPROVEN/);
});

test("Treg cross-domain final URL refused even when both publisher hosts are permitted", async t => {
  const s=await tregTest(t);
  const units=await tinyfishSources({treg:s.options,fetcher:mockTreg(url=>url.pathname.endsWith("search")?jsonResponse({results:[{url:"https://techcrunch.com/story",site_name:"techcrunch.com"}]}):jsonResponse({results:[{url:"https://techcrunch.com/story",final_url:"https://news.crunchbase.com/story",format:"html",text:"<title>Acme raises seed</title>"}]}))});
  const result=await units[0].acquire({...transportContext(),capture:s.capture});
  assert.equal(result.receipt.documentsChecked,0); assert.match(result.receipt.documentErrors![0].error,/document_permission_denied/);
});

test("Treg report CLI reads real files and links only existing zero-call refusal receipts", async t => {
  const s=await tregTest(t), run=await runEngine({...base,lane:"tinyfish",sources:await tinyfishSources({env:{}}),dryRun:true});
  await writeFile(join(s.dir,"run-report.json"),JSON.stringify(run)); await writeFile(join(s.dir,"records.json"),"[]"); await writeFile(join(s.dir,"consumer.json"),"[]");
  const out=join(s.dir,"discovery.json"), html=join(s.dir,"discovery.html");
  await tregReportCli(["--run",s.dir,"--ledger",s.path,"--audits",join(s.dir,"absent-audits"),"--baseline","fixtures/daily-engine/baseline.json","--out-json",out,"--out-html",html]);
  const report=JSON.parse(await readFile(out,"utf8")); assert.equal(report.paths.capture,undefined); assert.ok((await readFile(html,"utf8")).includes("Zero verified-US yield"));
  for(const p of Object.values(report.paths))await stat(join(s.dir,p as string));
});

test("Treg correction 1: incomplete or unsafe served-upstream/platform/total/ledger proof stops all later calls", async t => {
  const defects: Array<[string, (payload: Record<string,unknown>) => void, string]> = [
    ["swapped upstream",p=>{(p.call as Record<string,unknown>).path="https://api.fetch.tinyfish.ai/";},"upstream_path"],
    ["foreign upstream",p=>{(p.call as Record<string,unknown>).path="https://foreign.example/";},"upstream_path"],
    ["missing upstream",p=>{delete (p.call as Record<string,unknown>).path;},"upstream_path"],
    ["own key",p=>{(p.call as Record<string,unknown>).credential_tier="own_key";},"credential_tier"],
    ["other tier",p=>{(p.call as Record<string,unknown>).credential_tier="other";},"credential_tier"],
    ["missing tier",p=>{delete (p.call as Record<string,unknown>).credential_tier;},"credential_tier"],
    ["positive total",p=>{p.charged_micro=1;},"charged_micro"],
    ["missing total",p=>{delete p.charged_micro;},"charged_micro"],
    ["string total",p=>{p.charged_micro="0";},"charged_micro"],
    ["positive reserve",p=>{(p.ledger as Record<string,unknown>[])[0].amount_micro=1;},"ledger_proof"],
    ["positive settle",p=>{(p.ledger as Record<string,unknown>[])[1].amount_micro=1;},"ledger_proof"],
    ["missing amount",p=>{delete (p.ledger as Record<string,unknown>[])[0].amount_micro;},"ledger_proof"],
    ["string amount",p=>{(p.ledger as Record<string,unknown>[])[0].amount_micro="0";},"ledger_proof"],
    ["foreign endpoint",p=>{(p.ledger as Record<string,unknown>[])[0].endpoint_id="tinyfish.web.fetch";},"ledger_proof"],
    ["missing endpoint",p=>{delete (p.ledger as Record<string,unknown>[])[0].endpoint_id;},"ledger_proof"],
    ["missing reserve",p=>{p.ledger=(p.ledger as unknown[]).slice(1);},"ledger_proof"],
    ["missing settle",p=>{p.ledger=(p.ledger as unknown[]).slice(0,1);},"ledger_proof"],
    ["missing ledger",p=>{delete p.ledger;},"ledger_proof"],
    ["non-array ledger",p=>{p.ledger={};},"ledger_proof"],
    ["empty ledger",p=>{p.ledger=[];},"ledger_proof"],
    ["unknown kind",p=>{(p.ledger as Record<string,unknown>[]).push({kind:"refund",amount_micro:0,endpoint_id:"tinyfish.web.search"});},"ledger_proof"],
    ["null entry",p=>{(p.ledger as unknown[]).push(null);},"ledger_proof"],
    ["late positive entry",p=>{(p.ledger as Record<string,unknown>[]).push(...Array.from({length:20},()=>({kind:"settle",amount_micro:0,endpoint_id:"tinyfish.web.search"})),{kind:"settle",amount_micro:1,endpoint_id:"tinyfish.web.search"});},"ledger_proof"],
  ];
  for (const [name,change,reason] of defects) {
    const s=await tregTest(t); let calls=0;
    const transport=new TregTransport(tregCanary,s.options,mockTreg(()=>{calls++; return jsonResponse({results:[]});},undefined,change));
    const context=transportContext();
    await assert.rejects(transport.call("https://treg.to/call/tinyfish.web.search?query=q",undefined,context.caps,s.capture),new RegExp("treg_audit_mismatch " + reason),name);
    await assert.rejects(transport.call("https://treg.to/call/tinyfish.web.search?query=next",undefined,context.caps,s.capture),/treg_transport_stopped/,name);
    assert.equal(calls,1,name);
    const ledger=validateTregLedger(JSON.parse(await readFile(s.path,"utf8")));
    assert.equal(ledger.entries.find(e=>e.type==="result")!.auditOutcome,"mismatch",name);
    assert.match(String(ledger.entries.find(e=>e.type==="failure")!.error),new RegExp(reason),name);
    const disk=await diskText(s.dir); assert.ok(!disk.includes(tregCanary),name); assert.ok(!disk.includes("user_email"),name); assert.ok(!disk.includes("api_key"),name);
  }
});

test("Treg correction 1: exact platform upstream and zero reserve/settle/total audit pass search and fetch end-to-end", async t => {
  const s=await tregTest(t); let calls=0;
  const units=await tinyfishSources({treg:s.options,fetcher:mockTreg(url=>{
    calls++;
    return url.pathname.endsWith("search") ? jsonResponse({results:[{url:"https://acme.com/news",site_name:"acme.com"}]}) : jsonResponse({results:[{url:"https://acme.com/news",final_url:"https://acme.com/news",format:"html",text:"<title>Acme</title><p>Acme company</p>"}],errors:[]});
  })});
  const report=await runEngine({...base,lane:"tinyfish",sources:units,dryRun:true,capture:s.capture});
  assert.equal(report.sourceReceipts[0].status,"completed"); assert.equal(report.sourceReceipts[0].documentsChecked,1); assert.equal(calls,2);
  const ledger=validateTregLedger(JSON.parse(await readFile(s.path,"utf8")));
  assert.ok(ledger.entries.filter(e=>e.type==="result").every(e=>e.auditOutcome==="verified_zero"));
  for (const file of await readdir(join(s.dir,"audits"))) {
    const audit=JSON.parse(await readFile(join(s.dir,"audits",file),"utf8"));
    assert.equal(audit.charged_micro,0); assert.equal(audit.call.credential_tier,"platform");
    assert.equal(audit.call.path,audit.call.endpoint_id==="tinyfish.web.search"?"https://api.search.tinyfish.ai/":"https://api.fetch.tinyfish.ai/");
    assert.deepEqual(audit.ledger.map((e:{kind:string})=>e.kind),["reserve","settle"]);
    assert.ok(audit.ledger.every((e:{amount_micro:unknown;endpoint_id:string})=>e.amount_micro===0 && e.endpoint_id===audit.call.endpoint_id));
  }
  const text=await diskText(s.dir); assert.ok(!text.includes(tregCanary)); assert.ok(!text.includes("user_email")); assert.ok(!text.includes("api_key"));
});

test("Treg correction 2: documented platform access needs no catalog fields; 60000ms signal and 30000ms URL timeout", async t => {
  const s=await tregTest(t), timeouts:number[]=[];
  const timeout=AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal,"timeout",(ms:number)=>{timeouts.push(ms); return timeout(ms);});
  let acquisitions=0, accesses=0;
  const spy=mockTreg((url,init)=>{
    acquisitions++;
    assert.ok(init?.signal instanceof AbortSignal); assert.equal(init.signal.aborted,false);
    if (url.pathname.endsWith("search")) return jsonResponse({results:[{url:"https://acme.com/news",site_name:"acme.com"}]});
    assert.deepEqual(JSON.parse(String(init?.body)),{urls:["https://acme.com/news"],format:"html",ttl:0,per_url_timeout_ms:30000});
    return jsonResponse({results:[],errors:[{url:"https://acme.com/news",error:"synthetic missing document"}]});
  });
  const fetcher:typeof fetch=async(input,init)=>{
    if(String(input).endsWith("/access")) {
      accesses++;
      return jsonResponse({tier:"platform",detail:"synthetic platform access",estimated_cost_micro:0,estimated_cost_usd:0.0});
    }
    return spy(input,init);
  };
  const units=await tinyfishSources({treg:s.options,fetcher});
  const result=await units[0].acquire({...transportContext(),capture:s.capture});
  assert.equal(result.receipt.status,"completed"); assert.equal(accesses,2); assert.equal(acquisitions,2);
  assert.equal(timeouts.length,6); assert.ok(timeouts.every(ms=>ms===60000));
});

test("Treg correction 3: zero-candidate receipts explain extraction skips without inventing fetch errors", async () => {
  const run=await runEngine({...base,lane:"tinyfish",sources:[],dryRun:true});
  run.sourceReceipts=[{sourceId:"tinyfish-search-fetch",lane:"tinyfish",status:"completed",requests:10,documentsChecked:9,documentsSkipped:9,candidatesFound:0,documentErrors:[]}];
  const data=buildTregDiscovery(run,[],[],emptyTregLedger(),[],[]);
  const reason="All 9 fetched documents were skipped by identity/funding extraction (no extractable company identity or funding claim); 0 fetch errors.";
  assert.deepEqual(data.B.reasons,[reason]); assert.ok(tregDiscoveryHtml(data).includes(reason));
  run.sourceReceipts[0].documentErrors=[{url:"https://example.com",error:"synthetic fetch error"}];
  assert.ok(!buildTregDiscovery(run,[],[],emptyTregLedger(),[],[]).B.reasons.includes(reason));
  run.sourceReceipts[0].status="failed"; run.sourceReceipts[0].error="synthetic refusal"; run.sourceReceipts[0].documentErrors=[];
  assert.deepEqual(buildTregDiscovery(run,[],[],emptyTregLedger(),[],[]).B.reasons,["synthetic refusal"]);
});
