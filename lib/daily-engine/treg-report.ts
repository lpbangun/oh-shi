import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { DailyRun } from "./engine";
import type { EngineRecord } from "./types";
import type { CaptureEvent } from "./capture";
import { ledgerTotals, validateTregLedger, type TregLedger } from "./treg-ledger";

type Audit = {call: {id: string | number; call_ref?: string; endpoint_id: string; tool_name: string; provider: string; cost_charged_micro: number; refused_by?: unknown}};
export function buildTregDiscovery(run: DailyRun, records: EngineRecord[], consumer: unknown[], ledger: TregLedger, audits: Audit[], events: CaptureEvent[], paths: Record<string,string> = {}) {
  validateTregLedger(ledger);
  const results = ledger.entries.filter(e => e.type === "result");
  const reservations = ledger.entries.filter(e => e.type === "reservation");
  const called = results.filter(r => typeof r.unitsConsumed === "number" && r.unitsConsumed > 0);
  const neverCalled = results.filter(r => r.unitsConsumed === 0 && r.callId == null && r.costHeader == null && r.status == null && r.auditOutcome === "not_read");
  const neverCalledUnits = neverCalled.reduce((n,r) => n + (reservations.find(e => e.id === r.id)?.units ?? 0), 0);
  const zero = reservations.length > 0 && results.length === reservations.length && called.length + neverCalled.length === results.length && audits.every(a => a.call.provider === "tinyfish" && a.call.cost_charged_micro === 0 && a.call.refused_by == null) && called.every(r => r.costHeader === "0" && r.auditOutcome === "verified_zero" && audits.some(a => (a.call.call_ref ?? a.call.id) === r.callId && a.call.provider === "tinyfish" && a.call.cost_charged_micro === 0 && a.call.refused_by == null && a.call.endpoint_id === (reservations.find(e => e.id === r.id)?.kind === "search" ? "tinyfish.web.search" : "tinyfish.web.fetch") && a.call.tool_name === a.call.endpoint_id));
  const consumed = {searchCalls: results.filter(r => reservations.find(e => e.id === r.id)?.kind === "search").reduce((n,r) => n + Number(r.unitsConsumed || 0), 0), fetchUrlUnits: results.filter(r => reservations.find(e => e.id === r.id)?.kind === "fetch").reduce((n,r) => n + Number(r.unitsConsumed || 0), 0)};
  const reasons = [...run.sourceReceipts.flatMap(r => [
    ...(r.error || r.missingPrerequisite ? [r.error || r.missingPrerequisite!] : []),
    ...(r.status === "completed" && r.documentsChecked > 0 && r.candidatesFound === 0 && r.documentErrors?.length === 0 ? [`All ${r.documentsChecked} fetched documents were skipped by identity/funding extraction (no extractable company identity or funding claim); 0 fetch errors.`] : []),
  ]), ...run.assessments.flatMap(a => a.reason ? [a.reason] : [])];
  const metrics = { candidates: run.counts.candidatesAcquired, verifiedUS: run.counts.usHqVerified, unknownHQ: run.counts.usHqUnknown, nonUS: run.counts.nonUsExcluded, duplicates: run.counts.duplicatesSkipped, unsupported: run.counts.falsePositivesExcluded, noJobs: records.filter(r => r.company.openJobCount === 0).length, fundingEvents: records.reduce((n,r) => n + r.fundingEvents.length, 0), consumerRecords: consumer.length };
  return {schema: "ohshi-treg-discovery-report/1", runId: run.runId, label: run.label,
    historicalA: "Historical A transport smoke is NOT a matched control.",
    B: {metrics, outcome: metrics.verifiedUS ? "Verified-US records observed; inspect first-party evidence and consumer readback." : "Zero verified-US yield; a refusal or empty result is not a successful discovery.", reasons: reasons.length ? reasons : [metrics.candidates ? "No additional refusal reason recorded; inspect HQ and funding assessments." : "No candidates acquired in the recorded run."], companies: records.map(r => ({name: r.company.name, domain: r.company.domain, hq: r.company.hqStatus, jobs: r.company.openJobCount, funding: r.fundingEvents.map(e => ({title: e.title, date: e.occurredAt || "UNKNOWN", source: e.sourceUrl}))}))},
    accounting: {phase: ledgerTotals(ledger.entries), consumed, run: run.caps, captureUnits: events.reduce((n,e) => n + e.requestUnits, 0), cost: zero ? `$0 — per-call audits verified charged_micro=0 and zero reserve/settle for every actual Treg /call (${called.length} of ${called.length}); ${neverCalledUnits} reserved units were never called (preflight refusal), so no charge was possible.` : "UNPROVEN — not every actual call has a matching zero-charge audit, or reservation outcome is unknown/unsafe", reservations: reservations.length, results: results.length},
    baseline: "Production baseline UNRESOLVED: limited baseline, binding identity unverified; absence is not proven global net-new.",
    superiority: "No superiority claim. B-only discovery is not a matched A/B experiment.",
    publication: "Local evidence only; no production publication.", paths};
}
const escape = (s: unknown) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
export function tregDiscoveryHtml(data: ReturnType<typeof buildTregDiscovery>) {
  const metrics = Object.entries(data.B.metrics).map(([k,v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join("");
  const cards = data.B.companies.map(c => `<article><h3>${escape(c.name)} (${escape(c.domain)})</h3><p>HQ: ${escape(c.hq)} · Jobs: ${c.jobs}</p>${c.funding.map(e => `<p>${escape(e.title)} · ${escape(e.date)} · ${escape(e.source)}</p>`).join("")}</article>`).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Treg discovery</title><style>body{font:16px system-ui;max-width:960px;margin:2rem auto;padding:1rem}section{border-top:1px solid #ccc;padding:1rem 0}dt{font-weight:bold}dd{margin-bottom:.5rem}</style><h1>B-only Treg discovery</h1><p>${escape(data.label)} · ${escape(data.runId)}</p><section><h2>Historical A</h2><p>${escape(data.historicalA)}</p></section><section><h2>B actual discovery</h2><p>${escape(data.B.outcome)}</p><dl>${metrics}</dl>${cards || "<p>No retained companies.</p>"}<h3>Refusal / zero-yield reasons</h3><ul>${data.B.reasons.map(r => `<li>${escape(r)}</li>`).join("")}</ul><p>Companies without jobs remain valid.</p></section><section><h2>Request accounting and cost</h2><p>Phase attempted searches: ${data.accounting.consumed.searchCalls}; attempted fetch URL units: ${data.accounting.consumed.fetchUrlUnits}; reserved search capacity: ${data.accounting.phase.searchCalls}; reserved fetch capacity: ${data.accounting.phase.fetchUrlUnits}; elapsed ms: ${data.accounting.phase.elapsedMs}; captured units: ${data.accounting.captureUnits}; cost: ${escape(data.accounting.cost)}.</p></section><section><h2>Baseline and limitations</h2><p>${escape(data.baseline)}</p><p>${escape(data.superiority)}</p><p>${escape(data.publication)}</p></section><section><h2>Receipts</h2><ul>${Object.entries(data.paths).map(([k,v]) => `<li><a href="${escape(v)}">${escape(k)}</a></li>`).join("")}</ul></section></html>`;
}
export async function tregReportCli(args: string[]) {
  const values = new Map<string,string>();
  for (let i=0;i<args.length;i+=2) {
    if (!["--run", "--ledger", "--audits", "--baseline", "--out-json", "--out-html"].includes(args[i]) || !args[i+1] || args[i+1].startsWith("--")) throw new Error("invalid_treg_report_argument");
    values.set(args[i], resolve(args[i+1]));
  }
  for (const key of ["--run", "--ledger", "--audits", "--baseline", "--out-json", "--out-html"]) if (!values.has(key)) throw new Error("required " + key);
  const json = async (path: string) => JSON.parse(await readFile(path,"utf8"));
  const run = values.get("--run")!, outHtml = values.get("--out-html")!, paths: Record<string,string> = {};
  const inputs = {run: join(run,"run-report.json"), records: join(run,"records.json"), consumer: join(run,"consumer.json"), capture: join(run,"capture/events.jsonl"), ledger: values.get("--ledger")!, baseline: values.get("--baseline")!};
  const report = await json(inputs.run) as DailyRun;
  let capturePresent = true;
  for (const [k,p] of Object.entries(inputs)) {
    try { await stat(p); paths[k] = relative(dirname(outHtml),p); }
    catch (error) {
      if (k !== "capture" || (error as NodeJS.ErrnoException).code !== "ENOENT" || report.caps.fetchRequests !== 0 || report.caps.searchRequests !== 0 || report.sourceReceipts.some(r => r.requests !== 0)) throw error;
      capturePresent = false;
    }
  }
  const audits: Audit[] = [];
  const auditFiles = await readdir(values.get("--audits")!).catch(error => { if (error.code !== "ENOENT") throw error; return []; });
  for (const file of auditFiles) if (file.endsWith(".json")) { const p = join(values.get("--audits")!,file); audits.push(await json(p)); paths["audit " + file] = relative(dirname(outHtml),p); }
  await json(inputs.baseline);
  const events = capturePresent ? (await readFile(inputs.capture,"utf8")).split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
  const data = buildTregDiscovery(report, await json(inputs.records), await json(inputs.consumer), await json(inputs.ledger), audits, events, paths);
  for (const p of [values.get("--out-json")!,outHtml]) await mkdir(dirname(p), {recursive:true});
  await writeFile(values.get("--out-json")!, JSON.stringify(data,null,2)+"\n", {flag:"wx"});
  await writeFile(outHtml, tregDiscoveryHtml(data), {flag:"wx"});
}
