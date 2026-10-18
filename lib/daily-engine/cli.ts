import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
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
    if (["--dry-run","--live","--list"].includes(args[i])) flags.add(args[i]);
    else if (["--lane","--fixtures","--out","--lookback-days","--baseline","--stop-after-sources"].includes(args[i]) && args[i+1] && !args[i+1].startsWith("--")) values.set(args[i],args[++i]);
    else throw new Error("Unknown or incomplete argument: " + args[i]);
  }
  const lane = values.get("--lane") || "direct";
  if (lane !== "direct" && lane !== "tinyfish") throw new Error("--lane must be direct|tinyfish");
  const fixtures = values.get("--fixtures") || (!flags.has("--live") && lane === "direct" ? "fixtures/daily-engine/direct" : undefined);
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
  const inputId = fixtures ? stableId(await readFile(fixtures + "/corpus.json", "utf8")) : "unscored-live-path";
  const now = corpus?.now || new Date().toISOString();
  const dryRun = flags.has("--dry-run");
  const store = dryRun ? null : await openLocalStore(out + "/d1");
  try {
    const existing = store ? (await listDailyCompanies(store.db)).map(c => ({ id: c.id, name: c.name, domain: c.domain, sourceUrl: c.sourceUrl })) : [];
    const sources = lane === "direct" ? await directSources({ fixtures, existing }) : await tinyfishSources({ fixtures });
    // Live direct execution is deliberately not enabled by this round's CLI.
    if (!fixtures && (lane === "direct" || sources.some(s => s.permission === "permitted"))) throw new Error("LIVE-BLOCKED: live collection is implemented but not enabled/scored this round");
    const report = await runEngine({
      lane, sources, baseline, inputId, now, fixtures: !!fixtures, dryRun, db: store?.db,
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
