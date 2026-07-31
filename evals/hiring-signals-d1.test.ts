import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import { parseHiringSignalImport } from "../lib/hiring-signals";
import {
  listActiveHiringSignalRecords,
  persistHiringSignalRecords,
} from "../lib/signal-store";

function fixture(id: string, expiresAt: string) {
  return {
    id,
    companyName: "Example Labs",
    companyDomain: "example.com",
    roleFunction: "Infrastructure engineering",
    summary: "The employer states a current intent to grow its infrastructure team.",
    sourceKind: "company_blog",
    sourceUrl: `https://example.com/blog/${id}`,
    evidenceUrl: `https://example.com/blog/${id}`,
    sourceRightsUrl: "https://example.com/terms",
    applicationUrl: "",
    permissionStatus: "permitted",
    confidence: 78,
    observedAt: "2026-07-30T12:00:00.000Z",
    lastVerifiedAt: "2026-07-30T12:00:00.000Z",
    expiresAt,
  };
}

test("D1 hiring signals expire from active reads without changing verified jobs", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: "hiring-signal-integration" },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  const migration = await readFile("drizzle/0006_hiring_signals.sql", "utf8");
  for (const statement of migration.split(";").map((value) => value.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
  }
  await database.prepare(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL
  )`).run();
  await database.prepare(
    "INSERT INTO jobs (id, status) VALUES ('canonical-job', 'verified_open')"
  ).run();

  const parseNow = new Date("2026-07-30T13:00:00.000Z");
  const longLived = parseHiringSignalImport(
    fixture("signal-long", "2026-08-29T12:00:00.000Z"),
    parseNow
  );
  const shortLived = parseHiringSignalImport(
    fixture("signal-short", "2026-08-05T12:00:00.000Z"),
    parseNow
  );
  assert.equal(longLived.reason, null);
  assert.equal(shortLived.reason, null);
  await persistHiringSignalRecords(database, [longLived.signal!, shortLived.signal!]);

  const initiallyActive = await listActiveHiringSignalRecords(database, parseNow);
  assert.deepEqual(initiallyActive.map((signal) => signal.id), [
    "signal-long",
    "signal-short",
  ]);
  await database.prepare(
    "UPDATE hiring_signals SET status='unverifiable' WHERE id='signal-short'"
  ).run();
  assert.deepEqual(
    (await listActiveHiringSignalRecords(database, parseNow)).map((signal) => signal.id),
    ["signal-long"]
  );
  await database.prepare(
    "UPDATE hiring_signals SET status='active' WHERE id='signal-short'"
  ).run();
  const afterShortExpiry = await listActiveHiringSignalRecords(
    database,
    new Date("2026-08-10T00:00:00.000Z")
  );
  assert.deepEqual(afterShortExpiry.map((signal) => signal.id), ["signal-long"]);

  const jobTotals = await database.prepare(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN status='verified_open' THEN 1 ELSE 0 END) AS verifiedOpen
    FROM jobs`).first<{ total: number; verifiedOpen: number }>();
  assert.deepEqual(jobTotals, { total: 1, verifiedOpen: 1 });
});

test("signal validation rejects unverifiable or stale imports atomically", () => {
  const now = new Date("2026-07-30T13:00:00.000Z");
  assert.match(
    parseHiringSignalImport({
      ...fixture("signal-http", "2026-08-29T12:00:00.000Z"),
      evidenceUrl: "http://example.com/evidence",
    }, now).reason || "",
    /HTTPS/
  );
  assert.match(
    parseHiringSignalImport(
      fixture("signal-expired", "2026-07-30T12:30:00.000Z"),
      now
    ).reason || "",
    /current signal/
  );
});

test("promotion migration installs durable evidence without rewriting signals or jobs", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: "hiring-signal-promotion-migration" },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  const migration = await readFile(
    "drizzle/0009_hiring_signal_promotions.sql",
    "utf8"
  );
  for (
    const statement of migration.split(";").map((value) => value.trim()).filter(Boolean)
  ) {
    await database.prepare(statement).run();
  }
  assert.deepEqual(
    (await database.prepare("PRAGMA table_info(hiring_signal_promotions)")
      .all<{ name: string }>()).results.map((column) => column.name),
    [
      "signal_id",
      "job_id",
      "company_id",
      "provider",
      "source_id",
      "external_id",
      "canonical_url",
      "evidence_url",
      "source_rights_url",
      "discovery_source_kind",
      "verified_at",
      "run_id",
    ]
  );
  assert.deepEqual(
    (await database.prepare("PRAGMA index_list(hiring_signal_promotions)")
      .all<{ name: string }>()).results.map((index) => index.name).sort(),
    [
      "hiring_signal_promotions_company_idx",
      "hiring_signal_promotions_job_idx",
      "sqlite_autoindex_hiring_signal_promotions_1",
    ]
  );
});
