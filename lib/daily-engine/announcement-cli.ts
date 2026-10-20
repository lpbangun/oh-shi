import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { announcementSources, type AnnouncementInput } from "./announcements";
import { runEngine, type Baseline } from "./engine";
import { stableId } from "./funding-verification";
import { openLocalStore } from "./local";
import { listDailyCompanies } from "./persist";
import { DISCOVERY_SCHEDULE_MAX_ITEMS } from "../discovery-scheduler";
import { runAnnouncementScheduleTick } from "./announcement-scheduler";

export const ANNOUNCEMENT_SCHEDULE = Object.freeze({
  enabled: false, network: false, dryRun: true, lookbackDays: 14,
  maxAnnouncements: DISCOVERY_SCHEDULE_MAX_ITEMS, maxPublicFetches: 0, cadence: "daily",
  activationRequires: ["approved source reuse and access evidence", "authoritative production baseline and binding", "explicit production-write and schedule authority", "bounded captured-input acquisition with durable shared request budget"],
});
/** Offline intake only. No fetcher, credentials, cron registration, or remote DB option. */
export async function announcementCli(args: string[]) {
  const values = new Map<string, string>(), flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (["--persist-local", "--schedule-plan", "--fixture", "--dry-run", "--no-network", "--schedule-tick", "--schedule-local-dry-run", "--schedule-lease-active"].includes(args[i])) flags.add(args[i]);
    else if (["--input", "--out", "--store", "--local-database-id", "--now", "--lookback-days", "--published-baseline", "--next-attempt-at", "--last-attempted-at", "--max-announcements"].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith("--")) values.set(args[i], args[++i]);
    else throw new Error("Unknown or incomplete argument: " + args[i]);
  }
  if (flags.has("--dry-run") && flags.has("--persist-local")) throw new Error("--dry-run conflicts with --persist-local");
  const scheduleControls = flags.has("--schedule-local-dry-run") || flags.has("--schedule-lease-active") || ["--next-attempt-at", "--last-attempted-at", "--max-announcements"].some(key => values.has(key));
  if (scheduleControls && !flags.has("--schedule-tick")) throw new Error("schedule_controls_require_tick");
  if (flags.has("--schedule-plan") && flags.has("--schedule-tick")) throw new Error("schedule_plan_conflicts_with_tick");
  if (flags.has("--schedule-plan")) { console.log(JSON.stringify(ANNOUNCEMENT_SCHEDULE, null, 2)); return; }
  if (flags.has("--schedule-tick")) {
    if (!values.has("--out")) throw new Error("--schedule-tick requires --out");
    if (flags.has("--persist-local") || values.has("--store") || values.has("--local-database-id")) throw new Error("announcement_schedule_offline_dry_run_only");
    if (flags.has("--schedule-local-dry-run") && (!flags.has("--dry-run") || !flags.has("--no-network"))) throw new Error("local_schedule_requires_explicit_dry_run_and_no_network");
    const tickNow = values.get("--now") || new Date().toISOString();
    values.set("--now", tickNow);
    const tick = await runAnnouncementScheduleTick({
      now: tickNow, enabled: flags.has("--schedule-local-dry-run"),
      maxAnnouncements: values.has("--max-announcements") ? Number(values.get("--max-announcements")) : undefined,
      nextAttemptAt: values.get("--next-attempt-at"), lastAttemptedAt: values.get("--last-attempted-at"), resolving: flags.has("--schedule-lease-active"),
    }, limit => runAnnouncementIntake(values, flags, limit));
    const out = resolve(values.get("--out")!);
    await mkdir(out, { recursive: true });
    await writeFile(out + "/schedule-tick.json", JSON.stringify(tick, null, 2) + "\n");
    console.log(JSON.stringify(tick, null, 2));
    return;
  }
  return runAnnouncementIntake(values, flags);
}

async function runAnnouncementIntake(values: Map<string, string>, flags: Set<string>, scheduleLimit?: number) {
  if (!values.has("--input") || !values.has("--out")) throw new Error("--input and --out required; default is offline dry-run");
  if (flags.has("--persist-local") && !values.has("--store")) throw new Error("--persist-local requires an isolated --store path");
  if (values.has("--local-database-id") && !/^[a-zA-Z0-9-]{1,80}$/.test(values.get("--local-database-id")!)) throw new Error("invalid_local_database_id");
  const now = values.get("--now") || new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error("invalid_run_time");
  const lookbackDays = Number(values.get("--lookback-days") || 14);
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 365) throw new Error("lookback-days must be 1..365");
  const inputPath = resolve(values.get("--input")!);
  if ((await stat(inputPath)).size > 25_000_000) throw new Error("announcement_input_too_large");
  const text = await readFile(inputPath, "utf8");
  const input = JSON.parse(text) as AnnouncementInput;
  if (scheduleLimit !== undefined && Array.isArray(input.announcements) && input.announcements.length > scheduleLimit) throw new Error("schedule_announcement_limit_exceeded");
  const sources = announcementSources(input);
  const baseline: Baseline = { composition: { productionEmployerDomains: [], repoSeedCompanyDomains: [] } };
  let baselineComparison: { kind: string; source: string; capturedAt: string; knownPublished: string[]; absentFromExport: string[]; absenceProvesNovelty: false } | undefined;
  if (values.has("--published-baseline")) {
    const path = resolve(values.get("--published-baseline")!);
    if ((await stat(path)).size > 25_000_000) throw new Error("published_baseline_too_large");
    const published = JSON.parse(await readFile(path, "utf8"));
    if (published.baseline_kind !== "production_content_export" || published.source_url !== "https://ohshi.work/exports/companies.jsonl" || published.http_status !== 200 || !Array.isArray(published.companies) || published.companies.some((c: { domain?: unknown }) => typeof c.domain !== "string") || published.companies.length !== published.record_count) throw new Error("invalid_published_content_baseline");
    const domains = new Set<string>(published.companies.map((c: { domain: string }) => c.domain.toLowerCase()));
    baseline.composition.productionEmployerDomains = [...domains];
    const inputDomains = input.announcements.map(a => new URL(a.websiteUrl).hostname.replace(/^www\./, ""));
    baselineComparison = { kind: "published_content_export_NOT_authoritative_DB", source: published.source_url, capturedAt: published.fetched_at_utc, knownPublished: inputDomains.filter(d => domains.has(d)), absentFromExport: inputDomains.filter(d => !domains.has(d)), absenceProvesNovelty: false };
  }
  const store = flags.has("--persist-local") ? await openLocalStore(resolve(values.get("--store")!), values.get("--local-database-id")) : null;
  try {
    const report = await runEngine({
      lane: "direct", sources, baseline,
      inputId: stableId(text), revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      now, fixtures: flags.has("--fixture"), dryRun: !store, db: store?.db, lookbackDays,
    });
    const consumer = store ? await listDailyCompanies(store.db) : [];
    const out = resolve(values.get("--out")!);
    await mkdir(out, { recursive: true });
    const verifiedFromInput = report.records.filter(r => r.company.hqStatus === "verified_us" && r.fundingEvents.some(e => e.occurredAt)).length;
    const outcome = verifiedFromInput === 0 ? "BLOCKED_ZERO_VERIFIED_RECENT_US_RECORDS" : store ? "LOCAL_VERIFIED" : "VERIFIED_DRY_RUN";
    const result = { ...report, outcome, verifiedCompaniesFromInput: verifiedFromInput, baselineComparison, inputKind: flags.has("--fixture") ? "SYNTHETIC_FIXTURE" : "CAPTURED_PUBLIC_EVIDENCE", productionNovelty: "UNKNOWN", publicFetches: 0, schedule: ANNOUNCEMENT_SCHEDULE, input: resolve(values.get("--input")!), consumer };
    await writeFile(out + "/run-report.json", JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ report: out + "/run-report.json", outcome, verifiedCompaniesFromInput: verifiedFromInput, companiesInLocalStore: consumer.length, persistence: report.persistence, publicFetches: 0, productionNovelty: "UNKNOWN" }, null, 2));
  } finally { await store?.close(); }
}
