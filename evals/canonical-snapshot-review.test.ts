import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import type { NormalizedJob } from "../lib/ats-adapters";
import {
  persistCanonicalFailure,
  persistCanonicalSource,
  type CanonicalCompanySource,
} from "../lib/canonical-refresh-store";
import {
  applyCanonicalSnapshot,
  inspectCanonicalSnapshot,
} from "../lib/canonical-snapshot-review";

const source: CanonicalCompanySource = {
  id: "ashby:review-board",
  companyId: "company-review",
  provider: "ashby",
  boardId: "review-board",
};

function normalized(externalId: string): NormalizedJob {
  return {
    externalId,
    title: `Engineer ${externalId}`,
    roleFamily: "Engineering",
    location: "Remote - US",
    remoteStatus: "Remote",
    employmentType: "Full-time",
    compensation: "See posting",
    canonicalUrl: `https://jobs.ashbyhq.com/review-board/${externalId}`,
    publishedAt: "2026-07-01T00:00:00.000Z",
    summary: "Canonical review fixture.",
  };
}

async function fixture(t: test.TestContext) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `canonical-review-${crypto.randomUUID()}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  await database.batch([
    database.prepare(`CREATE TABLE companies (
      id TEXT PRIMARY KEY, open_job_count INTEGER NOT NULL DEFAULT 0
    )`),
    database.prepare(`CREATE TABLE jobs (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, external_id TEXT NOT NULL,
      provider TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT NOT NULL,
      role_family TEXT NOT NULL, location TEXT NOT NULL, remote_status TEXT NOT NULL,
      employment_type TEXT NOT NULL, compensation TEXT NOT NULL,
      canonical_url TEXT NOT NULL UNIQUE, source TEXT NOT NULL, status TEXT NOT NULL,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, source_updated_at TEXT,
      published_at TEXT, last_verified_at TEXT NOT NULL, closed_at TEXT,
      raw_url TEXT NOT NULL, discovery_channel TEXT NOT NULL, evidence_url TEXT NOT NULL,
      parser_version TEXT NOT NULL, snapshot_run_id TEXT NOT NULL,
      linkedin_presence_state TEXT NOT NULL, linkedin_evidence_url TEXT,
      linkedin_checked_at TEXT, summary TEXT NOT NULL,
      UNIQUE(provider, source_id, external_id)
    )`),
    database.prepare(`CREATE TABLE changes (
      id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      change_type TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      occurred_at TEXT NOT NULL, source_url TEXT NOT NULL
    )`),
    database.prepare(`CREATE TABLE job_observations (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, company_id TEXT NOT NULL,
      provider TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
      canonical_url TEXT NOT NULL, normalized_canonical_url TEXT NOT NULL,
      title TEXT NOT NULL, location TEXT NOT NULL, employment_type TEXT NOT NULL,
      summary TEXT NOT NULL, published_at TEXT, status TEXT NOT NULL,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL, closed_at TEXT, raw_url TEXT NOT NULL,
      evidence_url TEXT NOT NULL, parser_version TEXT NOT NULL,
      snapshot_run_id TEXT NOT NULL, match_method TEXT NOT NULL,
      match_score_bps INTEGER NOT NULL,
      UNIQUE(provider, source_id, external_id)
    )`),
    database.prepare(`CREATE TABLE company_sources (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, provider TEXT NOT NULL,
      board_id TEXT NOT NULL, careers_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      discovery_status TEXT NOT NULL DEFAULT 'active',
      first_discovered_at TEXT NOT NULL, last_attempted_at TEXT,
      last_successful_at TEXT, last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      review_notes TEXT NOT NULL DEFAULT '', quarantine_snapshot_id TEXT,
      quarantine_application_id TEXT
    )`),
    database.prepare(`CREATE TABLE canonical_source_snapshots (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source_id TEXT NOT NULL,
      provider TEXT NOT NULL, captured_at TEXT NOT NULL, parser_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('accepted','quarantined')),
      existing_open_count INTEGER NOT NULL, observed_open_count INTEGER NOT NULL,
      missing_count INTEGER NOT NULL, missing_ratio_bps INTEGER NOT NULL,
      fingerprint TEXT NOT NULL, quarantine_reason TEXT, board_id TEXT,
      UNIQUE(run_id, source_id)
    )`),
    database.prepare(`CREATE TABLE canonical_snapshot_members (
      snapshot_id TEXT NOT NULL, external_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('observed','missing','existing')),
      PRIMARY KEY(snapshot_id, external_id, kind)
    )`),
    database.prepare(`CREATE TABLE canonical_snapshot_applications (
      idempotency_key TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL, provider TEXT NOT NULL, board_id TEXT NOT NULL,
      status TEXT NOT NULL, reason TEXT NOT NULL,
      original_fingerprint TEXT NOT NULL, fresh_fingerprint TEXT,
      original_existing_count INTEGER NOT NULL, fresh_existing_count INTEGER,
      original_observed_count INTEGER NOT NULL, fresh_observed_count INTEGER,
      original_missing_count INTEGER NOT NULL, fresh_missing_count INTEGER,
      requested_at TEXT NOT NULL, completed_at TEXT,
      opened_count INTEGER NOT NULL DEFAULT 0,
      closed_count INTEGER NOT NULL DEFAULT 0, error TEXT
    )`),
  ]);
  await database.batch([
    database.prepare("INSERT INTO companies (id, open_job_count) VALUES (?, 100)")
      .bind(source.companyId),
    database.prepare(`INSERT INTO company_sources (
      id, company_id, provider, board_id, careers_url, discovery_status,
      first_discovered_at, last_successful_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`).bind(
      source.id, source.companyId, source.provider, source.boardId,
      "https://jobs.ashbyhq.com/review-board",
      "2026-07-01T00:00:00.000Z", "2026-07-29T00:00:00.000Z"
    ),
  ]);
  const seedJobs = Array.from({ length: 100 }, (_, index) => {
    const externalId = `existing-${index}`;
    const url = `https://jobs.ashbyhq.com/review-board/${externalId}`;
    return database.prepare(`INSERT INTO jobs (
      id, company_id, external_id, provider, source_id, title, role_family,
      location, remote_status, employment_type, compensation, canonical_url,
      source, status, first_seen_at, last_seen_at, published_at, last_verified_at,
      raw_url, discovery_channel, evidence_url, parser_version, snapshot_run_id,
      linkedin_presence_state, summary
    ) VALUES (?, ?, ?, ?, ?, ?, 'Engineering', 'Remote - US', 'Remote',
      'Full-time', 'See posting', ?, 'ashby', 'verified_open', ?, ?, ?, ?, ?,
      'public_ats', ?, 'seed-1.0', 'seed-run', 'unknown', ?)`).bind(
        `job-${externalId}`, source.companyId, externalId, source.provider,
        source.id, `Engineer ${externalId}`, url,
        "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z", "2026-07-29T00:00:00.000Z",
        url, url, "Canonical review fixture."
      );
  });
  for (let offset = 0; offset < seedJobs.length; offset += 40) {
    await database.batch(seedJobs.slice(offset, offset + 40));
  }
  await database.prepare(`INSERT INTO job_observations (
    id, job_id, company_id, provider, source_id, external_id, canonical_url,
    normalized_canonical_url, title, location, employment_type, summary,
    published_at, status, first_seen_at, last_seen_at, last_verified_at,
    closed_at, raw_url, evidence_url, parser_version, snapshot_run_id,
    match_method, match_score_bps
  ) SELECT 'observation_' || id, id, company_id, provider, source_id, external_id,
    canonical_url, canonical_url, title, location, employment_type, summary,
    published_at, status, first_seen_at, last_seen_at, last_verified_at,
    closed_at, raw_url, evidence_url, parser_version, snapshot_run_id,
    'backfill', 10000 FROM jobs`).run();
  return database;
}

test("reviewed mass deletion closes only frozen missing observations and replays", async (t) => {
  const database = await fixture(t);
  await database.prepare(`INSERT INTO job_observations (
    id, job_id, company_id, provider, source_id, external_id, canonical_url,
    normalized_canonical_url, title, location, employment_type, summary,
    status, first_seen_at, last_seen_at, last_verified_at, raw_url,
    evidence_url, parser_version, snapshot_run_id, match_method, match_score_bps
  ) VALUES (
    'alternate-shared', 'job-existing-10', ?, 'workable', 'workable:shared',
    'alternate-10', 'https://apply.workable.com/j/ALT10/',
    'https://apply.workable.com/j/ALT10', 'Engineer existing-10', 'Remote - US',
    'Full-time', 'Shared alternate observation.', 'verified_open', ?, ?, ?, 
    'https://apply.workable.com/j/ALT10/', 'https://apply.workable.com/j/ALT10/',
    '1.0', 'alternate-run', 'high_confidence', 10000
  )`).bind(
    source.companyId,
    "2026-07-01T00:00:00.000Z",
    "2026-07-29T00:00:00.000Z",
    "2026-07-29T00:00:00.000Z"
  ).run();
  const current = Array.from({ length: 10 }, (_, index) => normalized(`existing-${index}`));
  const guarded = await persistCanonicalSource(
    database, source, current, "2026-07-30T00:00:00.000Z", "guarded-review"
  );
  assert.equal(guarded.status, "quarantined");
  const inspection = await inspectCanonicalSnapshot(database, guarded.snapshotId!);
  assert.equal(inspection.confirmable, true);
  assert.equal(inspection.observedExternalIds.length, 10);
  assert.equal(inspection.missingExternalIds.length, 90);
  assert.equal(inspection.snapshot?.boardId, source.boardId);

  await assert.rejects(
    applyCanonicalSnapshot({
      database,
      snapshotId: guarded.snapshotId!,
      idempotencyKey: "review-wrong-fingerprint",
      expectedFingerprint: "fnv1a32:00000000:10",
      reason: "Reviewed exact removal set.",
      fetchSource: async () => ({ jobs: current }),
    }),
    /expected fingerprint/
  );
  const applied = await applyCanonicalSnapshot({
    database,
    snapshotId: guarded.snapshotId!,
    idempotencyKey: "review-exact-application",
    expectedFingerprint: inspection.snapshot!.fingerprint,
    reason: "Reviewed exact source removal set.",
    now: "2026-07-30T01:00:00.000Z",
    fetchSource: async () => ({ jobs: current }),
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.closed, 89);
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM job_observations WHERE provider='ashby' AND status='verified_closed'"
    ).first<{ count: number }>())?.count),
    90
  );
  assert.equal(
    (await database.prepare(
      "SELECT status FROM jobs WHERE id='job-existing-10'"
    ).first<{ status: string }>())?.status,
    "verified_open"
  );
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE status='verified_open'"
    ).first<{ count: number }>())?.count),
    11
  );
  assert.deepEqual(
    await database.prepare(`SELECT discovery_status AS discoveryStatus,
      last_successful_at AS lastSuccessfulAt,
      quarantine_snapshot_id AS quarantineSnapshotId,
      quarantine_application_id AS quarantineApplicationId
      FROM company_sources WHERE id=?`).bind(source.id).first(),
    {
      discoveryStatus: "active",
      lastSuccessfulAt: "2026-07-29T00:00:00.000Z",
      quarantineSnapshotId: null,
      quarantineApplicationId: null,
    }
  );
  let replayFetches = 0;
  const replay = await applyCanonicalSnapshot({
    database,
    snapshotId: guarded.snapshotId!,
    idempotencyKey: "review-exact-application",
    expectedFingerprint: inspection.snapshot!.fingerprint,
    reason: "Reviewed exact source removal set.",
    fetchSource: async () => {
      replayFetches += 1;
      return { jobs: [] };
    },
  });
  assert.deepEqual(replay, applied);
  assert.equal(replayFetches, 0);
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM canonical_snapshot_applications"
    ).first<{ count: number }>())?.count),
    1
  );
});

test("membership drift rejects without closures and parser quarantines are never confirmable", async (t) => {
  const database = await fixture(t);
  const current = Array.from({ length: 10 }, (_, index) => normalized(`existing-${index}`));
  const guarded = await persistCanonicalSource(
    database, source, current, "2026-07-30T00:00:00.000Z", "guarded-drift"
  );
  const inspection = await inspectCanonicalSnapshot(database, guarded.snapshotId!);
  const drifted = [
    ...current.slice(0, 9),
    normalized("replacement-with-same-count"),
  ];
  const result = await applyCanonicalSnapshot({
    database,
    snapshotId: guarded.snapshotId!,
    idempotencyKey: "review-drift-application",
    expectedFingerprint: inspection.snapshot!.fingerprint,
    reason: "Reviewed but source membership drifted.",
    now: "2026-07-30T01:00:00.000Z",
    fetchSource: async () => ({ jobs: drifted }),
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.closed, 0);
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE status='verified_open'"
    ).first<{ count: number }>())?.count),
    100
  );
  assert.equal(
    (await database.prepare(
      "SELECT discovery_status AS status FROM company_sources WHERE id=?"
    ).bind(source.id).first<{ status: string }>())?.status,
    "quarantined"
  );

  await database.prepare(`UPDATE company_sources SET discovery_status='active',
    quarantine_snapshot_id=NULL, quarantine_application_id=NULL WHERE id=?`)
    .bind(source.id).run();
  const parserFailure = await persistCanonicalFailure(
    database,
    source,
    "2026-07-30T02:00:00.000Z",
    "parser-quarantine",
    new SyntaxError("Unexpected end of JSON input")
  );
  const parserInspection = await inspectCanonicalSnapshot(
    database, parserFailure.snapshotId!
  );
  assert.equal(parserInspection.confirmable, false);
  assert.ok(parserInspection.blockers.includes("unsupported_quarantine_reason"));
  assert.ok(parserInspection.blockers.includes("exact_membership_unavailable"));
});

test("snapshot-review migration upgrades legacy guard tables without rewriting records", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `canonical-review-migration-${crypto.randomUUID()}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  await database.batch([
    database.prepare(`CREATE TABLE company_sources (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, provider TEXT NOT NULL,
      board_id TEXT NOT NULL
    )`),
    database.prepare(`CREATE TABLE canonical_source_snapshots (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source_id TEXT NOT NULL,
      provider TEXT NOT NULL, captured_at TEXT NOT NULL, parser_version TEXT NOT NULL,
      status TEXT NOT NULL, existing_open_count INTEGER NOT NULL,
      observed_open_count INTEGER NOT NULL, missing_count INTEGER NOT NULL,
      missing_ratio_bps INTEGER NOT NULL, fingerprint TEXT NOT NULL,
      quarantine_reason TEXT
    )`),
    database.prepare(`INSERT INTO company_sources
      (id, company_id, provider, board_id)
      VALUES ('legacy-source', 'legacy-company', 'ashby', 'legacy-board')`),
    database.prepare(`INSERT INTO canonical_source_snapshots (
      id, run_id, source_id, provider, captured_at, parser_version, status,
      existing_open_count, observed_open_count, missing_count, missing_ratio_bps,
      fingerprint, quarantine_reason
    ) VALUES (
      'legacy-snapshot', 'legacy-run', 'legacy-source', 'ashby',
      '2026-07-01T00:00:00.000Z', '1.0', 'quarantined',
      100, 10, 90, 9000, 'fnv1a32:00000000:10', 'mass_deletion_guard'
    )`),
  ]);
  const migration = await readFile(
    new URL("../drizzle/0010_canonical_snapshot_reviews.sql", import.meta.url),
    "utf8"
  );
  for (const statement of migration.split(";").map((value) => value.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
  }
  assert.equal(
    (await database.prepare(
      "SELECT COUNT(*) AS count FROM canonical_source_snapshots"
    ).first<{ count: number }>())?.count,
    1
  );
  assert.equal(
    (await database.prepare(
      "SELECT board_id AS boardId FROM canonical_source_snapshots WHERE id='legacy-snapshot'"
    ).first<{ boardId: string | null }>())?.boardId,
    null
  );
  assert.deepEqual(
    (await database.prepare("PRAGMA table_info(company_sources)")
      .all<{ name: string }>()).results
      .filter((column) => column.name.startsWith("quarantine_"))
      .map((column) => column.name),
    ["quarantine_snapshot_id", "quarantine_application_id"]
  );
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM canonical_snapshot_applications"
    ).first<{ count: number }>())?.count),
    0
  );
});
