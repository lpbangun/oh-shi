import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announcementCli } from "../lib/daily-engine/announcement-cli";
import { runAnnouncementScheduleTick } from "../lib/daily-engine/announcement-scheduler";
import { boundedDiscoveryScheduleLimit, DISCOVERY_SCHEDULE_MAX_ITEMS } from "../lib/discovery-scheduler";

const now = "2026-10-20T00:00:00.000Z";

// This regression initially failed: candidate 1 had only --schedule-plan.
test("announcement scheduling: executable tick is disabled by default without reading inputs", async t => {
  const out = await mkdtemp(join(tmpdir(), "ohshi-schedule-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  await announcementCli(["--schedule-tick", "--out", out, "--now", "2026-10-20T00:00:00Z"]);
  const report = JSON.parse(await readFile(join(out, "schedule-tick.json"), "utf8"));
  assert.equal(report.status, "disabled");
  assert.equal(report.publicFetches, 0);
  assert.equal(report.ran, false);
});

test("announcement scheduling: due, next-due replay, and shared stale lease boundaries", async () => {
  let calls = 0;
  const run = async (limit: number) => { calls++; assert.equal(limit, DISCOVERY_SCHEDULE_MAX_ITEMS); };
  const first = await runAnnouncementScheduleTick({ now, enabled: true, nextAttemptAt: now }, run);
  assert.equal(first.status, "ran");
  assert.equal(first.nextAttemptAt, "2026-10-21T00:00:00.000Z");
  assert.equal((await runAnnouncementScheduleTick({ now, enabled: true, nextAttemptAt: first.nextAttemptAt! }, run)).status, "not_due");
  assert.equal((await runAnnouncementScheduleTick({ now: first.nextAttemptAt!, enabled: true, nextAttemptAt: first.nextAttemptAt! }, run)).status, "ran");
  assert.equal((await runAnnouncementScheduleTick({ now, enabled: true, resolving: true, lastAttemptedAt: now }, run)).status, "not_due");
  assert.equal((await runAnnouncementScheduleTick({ now, enabled: true, resolving: true, lastAttemptedAt: "2026-10-19T23:00:00.000Z" }, run)).status, "not_due");
  assert.equal((await runAnnouncementScheduleTick({ now, enabled: true, resolving: true, lastAttemptedAt: "2026-10-19T22:59:59.999Z" }, run)).status, "ran");
  assert.equal(calls, 3);
});

test("announcement scheduling: finite shared cap, zero work, invalid limits and offline refusals", async () => {
  let calls = 0;
  const run = async (limit: number) => { calls++; assert.equal(limit, 25); };
  assert.equal((await runAnnouncementScheduleTick({ now, enabled: true, maxAnnouncements: 99999 }, run)).maxAnnouncements, 25);
  assert.equal((await runAnnouncementScheduleTick({ now, enabled: true, maxAnnouncements: 0 }, run)).status, "limit_zero");
  for (const maxAnnouncements of [NaN, Infinity, -1, 1.5]) {
    await assert.rejects(runAnnouncementScheduleTick({ now, enabled: true, maxAnnouncements }, run), /invalid_schedule_limit/);
  }
  for (const options of [{ network: true }, { dryRun: false }, { persistLocal: true }]) {
    await assert.rejects(runAnnouncementScheduleTick({ now, enabled: true, ...options }, run), /offline_dry_run_only/);
  }
  for (const options of [{ now: "invalid" }, { nextAttemptAt: "invalid" }, { lastAttemptedAt: "invalid" }]) {
    await assert.rejects(runAnnouncementScheduleTick({ now, enabled: true, ...options }, run), /invalid_schedule_time/);
  }
  assert.equal(calls, 1);
  for (const n of [NaN, Infinity, -Infinity, -1, 0]) assert.equal(boundedDiscoveryScheduleLimit(n), 0);
  assert.equal(boundedDiscoveryScheduleLimit(4.9), 4);
  assert.equal(boundedDiscoveryScheduleLimit(26), 25);
});

test("announcement scheduling: CLI executes actual offline engine only when explicitly opted in", async t => {
  const out = await mkdtemp(join(tmpdir(), "ohshi-schedule-engine-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const path = join(out, "input.json");
  await writeFile(path, JSON.stringify({ schema: "ohshi-announcement-input/1", announcements: [] }));
  const args = ["--schedule-tick", "--schedule-local-dry-run", "--dry-run", "--no-network", "--now", now, "--out", out, "--input", path];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("unexpected_network"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  await announcementCli(args);
  const report = JSON.parse(await readFile(join(out, "run-report.json"), "utf8"));
  const tick = JSON.parse(await readFile(join(out, "schedule-tick.json"), "utf8"));
  assert.equal(report.publicFetches, 0);
  assert.equal(report.persistence.companiesAdded, 0);
  assert.equal(report.productionNovelty, "UNKNOWN");
  assert.equal(tick.status, "ran");
  assert.equal(tick.ran, true);
  await announcementCli([...args, "--next-attempt-at", tick.nextAttemptAt]);
  assert.equal(JSON.parse(await readFile(join(out, "schedule-tick.json"), "utf8")).status, "not_due");
  for (const refused of [
    [...args, "--persist-local"], [...args, "--store", join(out, "forbidden")],
    [...args, "--activate"], [...args, "--live"], [...args, "--network"],
    ["--schedule-local-dry-run"],
    ["--schedule-tick", "--schedule-local-dry-run", "--out", out],
    [...args, "--schedule-plan"],
  ]) await assert.rejects(announcementCli(refused));
  await writeFile(path, JSON.stringify({ schema: "ohshi-announcement-input/1", announcements: [{}, {}] }));
  await assert.rejects(announcementCli([...args, "--max-announcements", "1"]), /schedule_announcement_limit_exceeded/);
});
