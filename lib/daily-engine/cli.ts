import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createCaptureRecorder } from "./capture";
import { TREG_KEY_FILE } from "./treg";
import { execFileSync } from "node:child_process";
import { validateReadinessManifest } from "./readiness";
import { runEngine, type Baseline } from "./engine";
import { stableId } from "./funding-verification";
import { directSources } from "./lanes/direct";
import { tinyfishSources } from "./lanes/tinyfish";
import { readCorpus } from "./lanes/shared";
import { openLocalStore } from "./local";
import { listDailyCompanies } from "./persist";

export async function cli(args: string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i=0;i<args.length;i++) {
    if (["--dry-run","--live","--list","--capture"].includes(args[i])) flags.add(args[i]);
    else if (["--lane","--fixtures","--out","--lookback-days","--baseline","--stop-after-sources","--readiness-manifest","--treg-key-file","--treg-ledger"].includes(args[i]) && args[i+1] && !args[i+1].startsWith("--")) values.set(args[i],args[++i]);
    else throw new Error("Unknown or incomplete argument: " + args[i]);
  }
  // The manifest itself is the only permitted I/O before its validation.
  const readiness = values.has("--readiness-manifest") ? validateReadinessManifest(JSON.parse(await readFile(values.get("--readiness-manifest")!, "utf8"))) : undefined;
  if (readiness && flags.has("--dry-run")) throw new Error("readiness_dry_run_not_supported: --dry-run is incompatible with a readiness manifest; use fixtures with --dry-run or run readiness without --dry-run");
  if (flags.has("--capture") && !readiness) throw new Error("invalid_capture_without_readiness_manifest");
  if (readiness && flags.has("--list")) throw new Error("readiness_list_not_supported");
  const lane = values.get("--lane") || "direct";
  if (lane !== "direct" && lane !== "tinyfish") throw new Error("--lane must be direct|tinyfish");
  const fixtures = values.get("--fixtures") || (!readiness && !flags.has("--live") && lane === "direct" ? "fixtures/daily-engine/direct" : undefined);
  const tregKeyFile = values.get("--treg-key-file");
  if ((tregKeyFile || values.has("--treg-ledger")) && lane !== "tinyfish") throw new Error("treg_requires_tinyfish_lane");
  if (values.has("--treg-ledger") && !tregKeyFile) throw new Error("treg_ledger_requires_key_file");
  if (tregKeyFile && !fixtures && !flags.has("--dry-run")) {
    if (tregKeyFile !== TREG_KEY_FILE) throw new Error("treg_key_path_refused");
    if (!flags.has("--capture")) throw new Error("treg_capture_required");
    if (!values.has("--treg-ledger")) throw new Error("treg_ledger_required");
    if (!readiness) throw new Error("treg_readiness_required");
  }
  if (tregKeyFile && !fixtures && flags.has("--dry-run")) throw new Error("treg_dry_run_requires_fixtures");
  const out = resolve(values.get("--out") || "outputs/daily-engine-" + lane);
  if (flags.has("--list")) {
    const store = await openLocalStore(out + "/d1");
    try { console.log(JSON.stringify(await listDailyCompanies(store.db), null, 2)); } finally { await store.close(); }
    return;
  }
  const baselinePath = values.get("--baseline") || "fixtures/daily-engine/baseline.json";
  const baselineText = await readFile(baselinePath, "utf8");
  const baseline = JSON.parse(baselineText) as Baseline;
  const corpus = fixtures ? await readCorpus(fixtures) : undefined;
  const inputId = readiness ? stableId(JSON.stringify(readiness)) : fixtures ? stableId(await readFile(fixtures + "/corpus.json", "utf8")) : "unscored-live-path";
  const now = corpus?.now || new Date().toISOString();
  const dryRun = flags.has("--dry-run");
  const store = dryRun ? null : await openLocalStore(out + "/d1");
  try {
    const existing = store ? (await listDailyCompanies(store.db)).map(c => ({ id: c.id, name: c.name, domain: c.domain, sourceUrl: c.sourceUrl })) : [];
    let sources = lane === "direct" ? await directSources({ fixtures, existing }) : await tinyfishSources({ fixtures, searchQueries: readiness?.lanes.tinyfish.searchQueries, verifiedEndpointsOnly: !!readiness, ...(tregKeyFile ? {treg: {keyFile: tregKeyFile, ledger: values.get("--treg-ledger"), runId: readiness?.runId, audits: out + "/audits"}} : {}) });
    if (readiness && lane === "direct" && !fixtures) sources = sources.filter(s => readiness.lanes.direct.permittedSourceIds.includes(s.id));
    // The historical live refusal remains unchanged unless explicitly authorized.
    if (!readiness && !fixtures && (lane === "direct" || sources.some(s => s.permission === "permitted"))) throw new Error("LIVE-BLOCKED: live collection is implemented but not enabled/scored this round");
    const report = await runEngine({
      capture: flags.has("--capture") ? createCaptureRecorder(out + "/capture") : undefined,
      lane, sources, baseline, inputId, now, readinessManifest: readiness, fixtures: !!fixtures, dryRun, db: store?.db,
      revision: execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),
      lookbackDays: Number(values.get("--lookback-days") || 14),
      interruptAfterSources: values.has("--stop-after-sources") ? Number(values.get("--stop-after-sources")) : undefined,
    });
    await mkdir(out, { recursive: true });
    await writeFile(out + "/run-report.json", JSON.stringify({ ...report, paths: { records: out + "/records.json", receipts: out + "/run-report.json", baseline: resolve(baselinePath) } }, null, 2) + "\n");
    await writeFile(out + "/records.json", JSON.stringify(report.records, null, 2) + "\n");
    if (store) await writeFile(out + "/consumer.json", JSON.stringify(await listDailyCompanies(store.db),null,2) + "\n");
    console.log(JSON.stringify(report,null,2));
  } finally { await store?.close(); }
}
