import { stableId } from "./funding-verification";
import { domainsInBaseline } from "./identity";
import type { Baseline, DailyRun } from "./engine";
import type { EngineRecord } from "./types";

export function buildComparison(inputs: Array<{ report: DailyRun; records: EngineRecord[]; path: string }>, baseline: Baseline) {
  if (inputs.length !== 2 || new Set(inputs.map(x => x.report.lane)).size !== 2) throw new Error("Both isolated lane exports required");
  const baselineId = stableId(JSON.stringify(baseline));
  const first = inputs[0].report;
  for (const input of inputs) {
    if (input.report.baselineId !== baselineId || input.report.revision !== first.revision ||
        input.report.engineVersion !== first.engineVersion || input.report.lookbackDays !== first.lookbackDays) throw new Error("Shared revision/rules/baseline mismatch");
    if (JSON.stringify(input.records) !== JSON.stringify(input.report.records)) throw new Error("Records do not match retained run export");
  }
  const baselineDomains = domainsInBaseline(baseline);
  const verified = inputs.map(x => new Set(x.records.filter(r => r.company.hqStatus === "verified_us").map(r => r.company.domain)));
  const overlap = [...verified[0]].filter(d => verified[1].has(d));
  const lanes = inputs.map(({report,records,path}, index) => {
    const events = [...new Map(records.flatMap(r => r.fundingEvents).map(e => [e.id,e])).values()];
    const verifiedEvents = new Set(records.filter(r => r.company.hqStatus === "verified_us").flatMap(r => r.fundingEvents.map(e => e.id)));
    const recent = events.filter(e => verifiedEvents.has(e.id) && e.occurredAt &&
      Date.parse(e.occurredAt) <= Date.parse(records[0]?.company.lastCheckedAt || report.completedAt) &&
      Date.parse(e.occurredAt) >= Date.parse(records[0]?.company.lastCheckedAt || report.completedAt) - report.lookbackDays * 86400000);
    return {
      lane: report.lane, label: report.label, runId: report.runId, revision: report.revision,
      baselineId, inputId: report.inputId, receiptPath: path + "/run-report.json", recordsPath: path + "/records.json",
      metrics: {
        baselineKnown: new Set(report.assessments.filter(a => a.baselineKnown).map(a => a.domain)).size,
        fixtureNewCompanyAbsentFromLimitedBaseline: [...verified[index]].filter(d => !baselineDomains.has(d)).length,
        historicalNovelty: "UNKNOWN-limited", verifiedUs: verified[index].size,
        pendingHq: records.filter(r => r.company.hqStatus === "unknown").length,
        nonUs: new Set(report.assessments.filter(a => a.disposition === "non_us").map(a => a.domain)).size,
        recentVerifiedFundingEvents: recent.length,
        recentFundingExistingCompanies: recent.filter(e => e.companyExisting).length,
        recentFundingNewCompanies: recent.filter(e => !e.companyExisting).length,
        duplicates: report.assessments.filter(a => a.disposition === "duplicate").length,
        unsupported: report.assessments.filter(a => a.disposition === "unsupported").length,
        speculative: report.assessments.filter(a => a.disposition === "speculative").length,
        evidenceGaps: report.assessments.reduce((n,a) => n + (a.hq?.status === "unknown" ? 1 : 0) + (a.funding?.evidenceGaps.length || 0),0),
        fundingEventsWithoutDate: events.filter(e => !e.occurredAt).length,
        overlapVerifiedDomains: overlap.length,
        requests: report.sourceReceipts.reduce((n,r) => n+r.requests,0),
        searchRequests: report.caps.searchRequests, elapsedMs: report.caps.elapsedMs, cost: "UNKNOWN",
        fixtureDocuments: report.sourceReceipts.reduce((n,r) => n+r.documentsChecked,0),
        failedSources: report.sourceReceipts.filter(r => r.status === "failed").length,
        blockedSources: report.sourceReceipts.filter(r => r.status === "blocked").length,
      },
      records, assessments: report.assessments, sourceReceipts: report.sourceReceipts,
    };
  });
  return {
    label: first.label, verdict: "inconclusive", revision: first.revision, baselineId,
    baseline: { ...baseline, provenance: "Read-only frozen production board_sources export + repository seeds; BASELINE-CAPTURE.md (2026-10-18). Production companies/startup_domains tables absent.",
      limitation: "UNKNOWN-limited historical novelty. ATS-only employers without domains may be missing; absence from this baseline is not proof of historical novelty." },
    liveComparison: { label: "LIVE-BLOCKED", status: "blocked", sharedBaseline: "OK", reason: "Lane B scoped free Search + Fetch credentials/configuration missing. No live scored collection was run." },
    recommendation: "Fixture-based mechanics comparison only. Small synthetic samples test mechanics, not acquisition yield. Live A/B yield comparison is blocked (B credentials; shared-baseline OK). Inconclusive; no winner.",
    overlap, lanes,
  };
}
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]!));
export function comparisonHtml(data: ReturnType<typeof buildComparison>) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FIXTURE daily discovery comparison — inconclusive</title>
<style>body{font:16px/1.55 system-ui,sans-serif;margin:0;background:#101827;color:#edf2fa}main{max-width:1200px;margin:auto;padding:clamp(12px,4vw,40px)}h1,h2{line-height:1.2}a{color:#92d7ff;overflow-wrap:anywhere}.banner,article,section{padding:20px;border:1px solid #62728c;border-radius:12px;margin:16px 0;background:#18243a}.banner{border:2px solid #ffca70}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:20px}dl{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:8px}dt,dd{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}small{overflow-wrap:anywhere}.tag{font-weight:800;color:#ffdb8f}summary{cursor:pointer}li{margin-bottom:10px}</style>
<main><h1>Daily discovery: <span class="tag">FIXTURE</span></h1>
<div class="banner"><h2>LIVE-BLOCKED · Inconclusive</h2><p>${escape(data.recommendation)}</p><p>${escape(data.baseline.limitation)}</p>
<small>Candidate revision: ${escape(data.revision)}<br>Baseline: ${escape(data.baselineId)}<br>${escape(data.baseline.provenance)}</small></div>
<div class="grid">${data.lanes.map(lane => `<section><h2>${escape(lane.label)} · ${escape(lane.lane)}</h2><small>Run: ${escape(lane.runId)}<br>Input: ${escape(lane.inputId)}</small>
<p><a href="${escape(lane.receiptPath)}">FIXTURE source receipts / run report</a> · <a href="${escape(lane.recordsPath)}">FIXTURE exported records</a></p>
<dl>${Object.entries(lane.metrics).map(([key,value]) => `<dt>FIXTURE · ${escape(key)}</dt><dd>${escape(value)}</dd>`).join("")}</dl>
<p>Requests are actual external calls (none in fixtures); document counts are local fixture inputs. Cost was not measured.</p>
${lane.records.map(record => `<article><h3>FIXTURE · ${escape(record.company.name)}</h3><p>${escape(record.company.hqStatus)} · ${record.company.openJobCount} open jobs</p>
<p><a href="${escape(record.company.evidenceUrl)}">Fixture evidence URL (synthetic; not live verification)</a></p><ul>${record.fundingEvents.map(e=>`<li>FIXTURE · ${escape(e.title)} · ${escape(e.status)}<br>Announcement: ${escape(e.occurredAt || "UNKNOWN — date missing")}<br>Discovered: ${escape(e.discoveredAt)}<br>Last checked: ${escape(e.lastCheckedAt)}</li>`).join("")}</ul></article>`).join("")}
<details><summary>FIXTURE · full source receipts and dispositions</summary><pre>${escape(JSON.stringify({receipts:lane.sourceReceipts,assessments:lane.assessments},null,2))}</pre></details></section>`).join("")}</div>
<section><h2>FIXTURE · overlap</h2><p>${escape(data.overlap.join(", ") || "No verified overlap in retained fixtures")}</p></section>
</main></html>`;
}
