import { stableId } from "./funding-verification";
import { domainsInBaseline } from "./identity";
import type { Baseline, DailyRun } from "./engine";
import type { EngineRecord } from "./types";

const metricLabels: Record<string, string> = {
  baselineKnown: "Baseline-known companies",
  fixtureNewCompanyAbsentFromLimitedBaseline: "New verified US companies (absent from limited baseline)",
  historicalNovelty: "Historical novelty", verifiedUs: "Verified US companies", pendingHq: "Companies pending HQ evidence",
  nonUs: "Non-US companies excluded", recentVerifiedFundingEvents: "Recent verified funding events",
  recentFundingExistingCompanies: "Recent verified funding events — existing companies",
  recentFundingNewCompanies: "Recent verified funding events — new companies",
  duplicates: "Duplicates skipped", unsupported: "Unsupported candidates", speculative: "Speculative funding excluded",
  evidenceGaps: "Evidence gaps", fundingEventsWithoutDate: "Funding events without date",
  overlapVerifiedDomains: "Verified companies shared by lanes", requests: "External requests (0 = fixtures)",
  searchRequests: "External search requests", elapsedMs: "Fixture elapsed time (ms; not causal speed evidence)",
  cost: "Cost (not measured)", fixtureDocuments: "Synthetic fixture documents", failedSources: "Failed sources", blockedSources: "Blocked sources",
};
type BlockedReceipt = { report: DailyRun; path: string };
export function buildComparison(inputs: Array<{ report: DailyRun; records: EngineRecord[]; path: string }>, baseline: Baseline, blocked?: BlockedReceipt) {
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
    const failedStages = report.stageReceipts.filter(s => !s.ok).map(s => s.stage);
    const sourceCount = (status: string) => report.sourceReceipts.filter(r => r.status === status).length;
    const failures = report.sourceReceipts.filter(r => r.status === "failed").map(r => r.error || "undiagnosed failure");
    const functionalVerdict = `FIXTURE MECHANICS: ${failedStages.length || sourceCount("failed") || sourceCount("blocked") || sourceCount("deferred") ? "ISSUES REPORTED" : "PASS"} — ${failedStages.length ? "stages not ok: " + failedStages.join(", ") : "all shared-core stages ok in run report"}; ${sourceCount("completed")} sources completed, ${sourceCount("failed")} failed${failures.length ? " diagnosing (" + failures.join("; ") + ")" : ""}, ${sourceCount("blocked")} blocked, ${sourceCount("deferred")} deferred`;
    const prerequisite = blocked?.report.lane === "tinyfish" ? blocked.report.sourceReceipts.find(r => r.status === "blocked" && r.sourceId === "tinyfish-search-fetch")?.missingPrerequisite : undefined;
    const externalRequests = report.caps.fetchRequests + report.caps.searchRequests;
    const liveStatus = report.lane === "direct"
      ? `LIVE: NOT RUN this round — live path implemented but unscored; fixture run made ${externalRequests} external requests (derived from run report caps)`
      : prerequisite ? "LIVE: BLOCKED — credentials/configuration missing" : "LIVE: BLOCKED — prerequisite receipt unavailable";
    return {
      functionalVerdict, liveStatus, liveYield: "UNKNOWN",
      ...(report.lane === "tinyfish" ? {
        missingPrerequisite: prerequisite || "Scoped free TinyFish Search + Fetch credentials/configuration required; no Browser/Agent/Monitor calls permitted.",
        blockedReceiptPath: prerequisite ? blocked!.path + "/run-report.json" : null,
      } : {}),
      metricLabels: { ...metricLabels },
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
    baseline: { ...baseline, provenance: 'Export source: D1 database "general-jobs-index", captured read-only via wrangler d1 execute --remote per BASELINE-CAPTURE.md (2026-10-18). Binding identity to this repository\'s production D1 is UNVERIFIED: vite.config.ts:37-38 names "site-creator-d1" with a placeholder database_id. Matching fixture inputs do not prove production binding identity.',
      limitation: "Separate coverage limitation: 120 board_sources employer domains + repo seeds; ATS-only employers without employer domains are absent. Historical novelty remains UNKNOWN-limited; absence from this limited baseline is not proof of novelty." },
    liveComparison: { label: "LIVE-BLOCKED", status: "blocked", sharedBaseline: "Same fixture baseline inputs on both lanes; production binding identity UNVERIFIED", reason: "Lane B scoped free Search + Fetch credentials/configuration missing. No live scored collection was run.", yield: "UNKNOWN" },
    recommendation: "Synthetic fixture mechanics tie; retained receipts include diagnosed source failures and blockers. No live evidence exists. Milliseconds/elapsedMs differences are NOT evidence either lane is causally faster. Live acquisition yield remains UNKNOWN, not measured zero. Both lanes use the same frozen fixture baseline inputs (mismatches refused); production binding identity is UNVERIFIED. Inconclusive; no forced winner.",
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
<p><strong>${escape(lane.functionalVerdict)}</strong></p><p><strong>${escape(lane.liveStatus)}</strong><br>Live acquisition yield: ${escape(lane.liveYield)}</p>
${lane.missingPrerequisite ? `<p>${escape(lane.missingPrerequisite)}${lane.blockedReceiptPath ? `<br><a href="${escape(lane.blockedReceiptPath)}">Actual TinyFish missing-credential run receipt</a>` : ""}</p>` : ""}
<p><a href="${escape(lane.receiptPath)}">FIXTURE source receipts / run report</a> · <a href="${escape(lane.recordsPath)}">FIXTURE exported records</a></p>
<dl>${Object.entries(lane.metrics).map(([key,value]) => `<dt>FIXTURE · ${escape(lane.metricLabels[key])}<br><small>${escape(key)}</small></dt><dd>${escape(value)}</dd>`).join("")}</dl>
<p>Requests are actual external calls (none in fixtures); document counts are local fixture inputs. Cost was not measured.</p>
${lane.records.map(record => `<article><h3>FIXTURE · ${escape(record.company.name)}</h3><p>${escape(record.company.hqStatus)} · ${record.company.openJobCount} open jobs</p>
<p><a href="${escape(record.company.evidenceUrl)}">Fixture evidence URL (synthetic; not live verification)</a></p><ul>${record.fundingEvents.map(e=>`<li>FIXTURE · ${escape(e.title)} · ${escape(e.status)}<br>Announcement: ${escape(e.occurredAt || "UNKNOWN — date missing")}<br>Discovered: ${escape(e.discoveredAt)}<br>Last checked: ${escape(e.lastCheckedAt)}</li>`).join("")}</ul></article>`).join("")}
<details><summary>FIXTURE · full source receipts and dispositions</summary><pre>${escape(JSON.stringify({receipts:lane.sourceReceipts,assessments:lane.assessments},null,2))}</pre></details></section>`).join("")}</div>
<section><h2>FIXTURE · overlap</h2><p>${escape(data.overlap.join(", ") || "No verified overlap in retained fixtures")}</p></section>
</main></html>`;
}
