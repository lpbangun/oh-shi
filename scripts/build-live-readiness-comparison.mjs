import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

export function buildLiveReadinessComparison(a, b, evidence = {}) {
  if (a.lane !== "direct" || b.lane !== "tinyfish") throw new Error("comparison_lane_mismatch");
  const zero = b.caps.fetchRequests === 0 && b.caps.searchRequests === 0 && b.sourceReceipts.every(r => r.requests === 0);
  const missing = b.sourceReceipts.filter(r => r.status === "blocked").map(r => r.missingPrerequisite).filter(Boolean);
  if (!zero || !missing.some(m => m.includes("TINYFISH_API_KEY"))) throw new Error("B_requires_missing_key_zero_call_receipt");
  const live = a.label === "LIVE-READINESS";
  const receipt = run => ({ runId: run.runId, caps: { fetchRequests: run.caps.fetchRequests, searchRequests: run.caps.searchRequests, elapsedMs: run.caps.elapsedMs }, sourceReceipts: run.sourceReceipts });
  const priorRuns = evidence.priorDirect ? [receipt(evidence.priorDirect)] : [];
  const runs = [...priorRuns, receipt(a), receipt(b)];
  return {
    schema: "ohshi-live-readiness-comparison/1",
    ...(evidence.priorDirect ? { priorRuns, phaseLedger: { runs, totals: {
      fetchRequests: runs.reduce((sum, r) => sum + r.caps.fetchRequests, 0),
      searchRequests: runs.reduce((sum, r) => sum + r.caps.searchRequests, 0),
      maxFetchRequests: 20, elapsedMsSum: runs.reduce((sum, r) => sum + r.caps.elapsedMs, 0),
    } } } : {}),
    A: { status: live ? "LIVE-READINESS (bounded smoke; inspect source receipts)" : a.label + " — NOT LIVE", report: a,
      sampleCards: a.records.slice(0, 12).map(r => ({ company: r.company.name, domain: r.company.domain, hq: r.company.hqStatus,
        headquarters: r.company.headquarters || "UNKNOWN", openJobs: r.company.openJobCount, funding: r.fundingEvents.map(e => ({ title: e.title, date: e.occurredAt || "UNKNOWN", source: e.sourceUrl, evidenceGaps: e.evidenceGaps })) })),
      noJobs: "Companies with zero jobs are supported; job counts do not gate discovery.",
      accounting: a.caps, receipts: a.sourceReceipts },
    B: { status: "LIVE BLOCKED", missingPrerequisites: missing, zeroCalls: zero, report: b,
      contractRepair: evidence.contractEvidence ?? "UNKNOWN — documented-shape test evidence not supplied" },
    readiness: { A: live ? (a.stageReceipts.find(r => r.stage === "acquire")?.ok ? (a.captureEvidence?.events && a.captureEvidence?.bodies ? "Transport completed within recorded caps; per-request raw evidence captured" : "Transport completed within recorded caps") : "Transport issues; inspect receipts") : "NOT LIVE — fixture/blocked evidence only",
      B: "Transport not run; offline contract test evidence is separate from live readiness" },
    yield: "UNKNOWN-limited — counts are a bounded smoke sample, not scored yield or baseline-proven new-company counts",
    superiority: "NO winner claim possible; B never ran",
    baselineIdentity: { status: "UNRESOLVED", novelty: "UNKNOWN-limited", receipt: evidence.baselineIdentity ?? "UNKNOWN", baselineHash: a.baselineId },
    candidateIdentity: { revision: a.revision, runId: a.runId, dirtyDiffManifest: evidence.candidateIdentity ?? "UNKNOWN", caps: a.readinessManifest?.authorizedCaps ?? a.caps },
    paths: evidence.paths ?? {},
  };
}
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function liveReadinessHtml(data) {
  const sections = Object.entries(data).filter(([key]) => key !== "schema").map(([key, value]) => `<section><h2>${escape(key)}</h2><pre>${escape(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</pre></section>`).join("\n");
  const cards = data.A.sampleCards.map(card => `<article><h3>${escape(card.company)} · ${escape(card.domain)}</h3><p>HQ: ${escape(card.headquarters)} (${escape(card.hq)}) · Jobs: ${escape(card.openJobs)}</p>${card.funding.map(event => `<p>${escape(event.title)} · Date: ${escape(event.date)} · ${escape(event.source)}</p>`).join("")}</article>`).join("");
  const links = Object.entries(data.paths).map(([name, path]) => `<li><a href="${escape(path)}">${escape(name)}</a></li>`).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Live readiness comparison</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:1rem;color:#17212b;background:#f5f7fa}section{background:white;padding:1rem;margin:1rem 0;border:1px solid #ccd}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#1254a1}</style><h1>Live readiness — not a yield contest</h1><ul>${links}</ul><section><h2>Actual sample companies / funding</h2>${cards || "No retained companies in this bounded sample."}</section>${sections}</html>`;
}
async function main(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--direct", "--blocked", "--prior-direct", "--out", "--baseline-identity", "--candidate-identity", "--contract-evidence"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("invalid comparison argument");
    values.set(args[i], args[i + 1]);
  }
  for (const key of ["--direct", "--blocked", "--out", "--baseline-identity"]) if (!values.has(key)) throw new Error("required " + key);
  const out = resolve(values.get("--out"));
  const acceptedDelivery = "/home/logani/oprun-evidence/ohshi-daily-discovery-20261018/delivery";
  if (out === acceptedDelivery || out.startsWith(acceptedDelivery + "/")) throw new Error("accepted_delivery_is_read_only");
  const json = async path => JSON.parse(await readFile(path, "utf8"));
  const paths = { direct: resolve(values.get("--direct"), "run-report.json"), blocked: resolve(values.get("--blocked"), "run-report.json"), baselineIdentity: resolve(values.get("--baseline-identity")) };
  for (const [key, arg] of [["candidateIdentity", "--candidate-identity"], ["contractEvidence", "--contract-evidence"]]) if (values.has(arg)) paths[key] = resolve(values.get(arg));
  if (values.has("--prior-direct")) paths.priorDirect = resolve(values.get("--prior-direct"), "run-report.json");
  const receipts = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await json(path)])));
  const data = buildLiveReadinessComparison(receipts.direct, receipts.blocked, { ...receipts, paths: Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, relative(out, path)])) });
  await mkdir(out, { recursive: true });
  await writeFile(out + "/comparison.json", JSON.stringify(data, null, 2) + "\n");
  await writeFile(out + "/comparison.html", liveReadinessHtml(data));
  console.log(JSON.stringify({ html: out + "/comparison.html", json: out + "/comparison.json" }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
