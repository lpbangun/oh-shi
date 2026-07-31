import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  persistCanonicalSource,
  type CanonicalCompanySource,
} from "../lib/canonical-refresh-store";
import type { NormalizedJob } from "../lib/ats-adapters";

const source: CanonicalCompanySource = {
  id: "structured:https://example.com/careers",
  companyId: "company-structured",
  provider: "structured",
  boardId: "https://example.com/careers",
};
const job: NormalizedJob = {
  externalId: "REQ-42",
  title: "Platform Engineer",
  roleFamily: "Engineering",
  location: "Remote US",
  remoteStatus: "Remote",
  employmentType: "Full-time",
  compensation: "See posting",
  canonicalUrl: "https://example.com/careers/REQ-42",
  publishedAt: "2026-07-01T00:00:00.000Z",
  summary: "Structured first-party fixture.",
};

test("fragile first-party roles close only after two clean misses 24–48 hours apart", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: "fragile-source-lifecycle" },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  await database.batch([
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
      board_id TEXT NOT NULL, careers_url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      discovery_status TEXT NOT NULL, first_discovered_at TEXT NOT NULL,
      last_attempted_at TEXT, last_successful_at TEXT, last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0, review_notes TEXT NOT NULL DEFAULT '',
      quarantine_snapshot_id TEXT, quarantine_application_id TEXT
    )`),
    database.prepare(`CREATE TABLE canonical_source_snapshots (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source_id TEXT NOT NULL,
      provider TEXT NOT NULL, captured_at TEXT NOT NULL, parser_version TEXT NOT NULL,
      status TEXT NOT NULL, existing_open_count INTEGER NOT NULL,
      observed_open_count INTEGER NOT NULL, missing_count INTEGER NOT NULL,
      missing_ratio_bps INTEGER NOT NULL, fingerprint TEXT NOT NULL,
      quarantine_reason TEXT, board_id TEXT, UNIQUE(run_id, source_id)
    )`),
    database.prepare(`CREATE TABLE canonical_snapshot_members (
      snapshot_id TEXT NOT NULL, external_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('observed','missing','existing')),
      PRIMARY KEY(snapshot_id, external_id, kind)
    )`),
    database.prepare(`CREATE TABLE fragile_job_misses (
      job_id TEXT NOT NULL, source_id TEXT NOT NULL, first_miss_at TEXT NOT NULL,
      last_miss_at TEXT NOT NULL, clean_miss_count INTEGER NOT NULL,
      last_run_id TEXT NOT NULL, PRIMARY KEY (job_id, source_id)
    )`),
  ]);
  await database.prepare(`INSERT INTO company_sources (
    id, company_id, provider, board_id, careers_url, discovery_status, first_discovered_at
  ) VALUES (?, ?, ?, ?, ?, 'active', ?)`).bind(
    source.id, source.companyId, source.provider, source.boardId, source.boardId,
    "2026-07-01T00:00:00.000Z"
  ).run();

  await persistCanonicalSource(
    database, source, [job], "2026-07-30T00:00:00.000Z", "initial"
  );
  const first = await persistCanonicalSource(
    database, source, [], "2026-07-30T01:00:00.000Z", "miss-1"
  );
  assert.equal(first.closed, 0);
  assert.equal(
    (await database.prepare("SELECT status FROM jobs").first<{ status: string }>())?.status,
    "verified_open"
  );
  assert.deepEqual(
    await database.prepare(`SELECT first_miss_at AS firstMissAt,
      clean_miss_count AS cleanMissCount FROM fragile_job_misses`).first(),
    { firstMissAt: "2026-07-30T01:00:00.000Z", cleanMissCount: 1 }
  );

  await persistCanonicalSource(
    database, source, [], "2026-07-30T12:00:00.000Z", "miss-early"
  );
  assert.deepEqual(
    await database.prepare(`SELECT first_miss_at AS firstMissAt,
      clean_miss_count AS cleanMissCount FROM fragile_job_misses`).first(),
    { firstMissAt: "2026-07-30T01:00:00.000Z", cleanMissCount: 2 }
  );
  await persistCanonicalSource(
    database, source, [job], "2026-07-30T18:00:00.000Z", "recovered"
  );
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM fragile_job_misses"
    ).first<{ count: number }>())?.count),
    0
  );

  await persistCanonicalSource(
    database, source, [], "2026-07-31T00:00:00.000Z", "miss-2a"
  );
  const second = await persistCanonicalSource(
    database, source, [], "2026-08-01T00:00:00.000Z", "miss-2b"
  );
  assert.equal(second.closed, 1);
  assert.equal(
    (await database.prepare("SELECT status FROM jobs").first<{ status: string }>())?.status,
    "verified_closed"
  );
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM fragile_job_misses"
    ).first<{ count: number }>())?.count),
    0
  );

  const recruiteeSource: CanonicalCompanySource = {
    id: "recruitee:acme",
    companyId: "company-recruitee",
    provider: "recruitee",
    boardId: "acme",
  };
  const recruiteeJob: NormalizedJob = {
    ...job,
    externalId: "42",
    canonicalUrl: "https://acme.recruitee.com/o/platform-engineer",
  };
  await database.prepare(`INSERT INTO company_sources (
    id, company_id, provider, board_id, careers_url, discovery_status, first_discovered_at
  ) VALUES (?, ?, ?, ?, ?, 'active', ?)`).bind(
    recruiteeSource.id,
    recruiteeSource.companyId,
    recruiteeSource.provider,
    recruiteeSource.boardId,
    "https://acme.recruitee.com/",
    "2026-07-01T00:00:00.000Z"
  ).run();
  await persistCanonicalSource(
    database,
    recruiteeSource,
    [recruiteeJob],
    "2026-08-01T01:00:00.000Z",
    "recruitee-open"
  );
  const authoritativeClosure = await persistCanonicalSource(
    database,
    recruiteeSource,
    [],
    "2026-08-01T02:00:00.000Z",
    "recruitee-close"
  );
  assert.equal(authoritativeClosure.closed, 1);
  assert.deepEqual(
    await database.prepare(`SELECT status, discovery_channel AS discoveryChannel
      FROM jobs WHERE provider='recruitee' AND external_id='42'`).first(),
    { status: "verified_closed", discoveryChannel: "public_ats" }
  );
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM fragile_job_misses WHERE source_id=?"
    ).bind(recruiteeSource.id).first<{ count: number }>())?.count),
    0
  );

  const workableSource: CanonicalCompanySource = {
    id: "workable:acme",
    companyId: "company-workable",
    provider: "workable",
    boardId: "acme",
  };
  const workableJob: NormalizedJob = {
    ...job,
    externalId: "ROLE123",
    canonicalUrl: "https://apply.workable.com/j/ROLE123",
  };
  await database.prepare(`INSERT INTO company_sources (
    id, company_id, provider, board_id, careers_url, discovery_status, first_discovered_at
  ) VALUES (?, ?, ?, ?, ?, 'active', ?)`).bind(
    workableSource.id,
    workableSource.companyId,
    workableSource.provider,
    workableSource.boardId,
    "https://apply.workable.com/acme/",
    "2026-07-01T00:00:00.000Z"
  ).run();
  await persistCanonicalSource(
    database,
    workableSource,
    [workableJob],
    "2026-08-01T03:00:00.000Z",
    "workable-open"
  );
  const workableClosure = await persistCanonicalSource(
    database,
    workableSource,
    [],
    "2026-08-01T04:00:00.000Z",
    "workable-close"
  );
  assert.equal(workableClosure.closed, 1);
  assert.deepEqual(
    await database.prepare(`SELECT status, discovery_channel AS discoveryChannel
      FROM jobs WHERE provider='workable' AND external_id='ROLE123'`).first(),
    { status: "verified_closed", discoveryChannel: "public_ats" }
  );
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM fragile_job_misses WHERE source_id=?"
    ).bind(workableSource.id).first<{ count: number }>())?.count),
    0
  );

  const personioSource: CanonicalCompanySource = {
    id: "personio:acme.jobs.personio.com",
    companyId: "company-personio",
    provider: "personio",
    boardId: "acme.jobs.personio.com",
  };
  const personioJob: NormalizedJob = {
    ...job,
    externalId: "84",
    canonicalUrl: "https://acme.jobs.personio.com/job/84?language=en",
  };
  await database.prepare(`INSERT INTO company_sources (
    id, company_id, provider, board_id, careers_url, discovery_status, first_discovered_at
  ) VALUES (?, ?, ?, ?, ?, 'active', ?)`).bind(
    personioSource.id,
    personioSource.companyId,
    personioSource.provider,
    personioSource.boardId,
    "https://acme.jobs.personio.com/",
    "2026-07-01T00:00:00.000Z"
  ).run();
  await persistCanonicalSource(
    database,
    personioSource,
    [personioJob],
    "2026-08-01T05:00:00.000Z",
    "personio-open"
  );
  const personioClosure = await persistCanonicalSource(
    database,
    personioSource,
    [],
    "2026-08-01T06:00:00.000Z",
    "personio-close"
  );
  assert.equal(personioClosure.closed, 1);
  assert.deepEqual(
    await database.prepare(`SELECT status, discovery_channel AS discoveryChannel
      FROM jobs WHERE provider='personio' AND external_id='84'`).first(),
    { status: "verified_closed", discoveryChannel: "public_ats" }
  );
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM fragile_job_misses WHERE source_id=?"
    ).bind(personioSource.id).first<{ count: number }>())?.count),
    0
  );

  const smartRecruitersSource: CanonicalCompanySource = {
    id: "smartrecruiters:Acme",
    companyId: "company-smartrecruiters",
    provider: "smartrecruiters",
    boardId: "Acme",
  };
  const smartRecruitersJob: NormalizedJob = {
    ...job,
    externalId: "744000000000001",
    canonicalUrl:
      "https://jobs.smartrecruiters.com/Acme/744000000000001-platform-engineer",
  };
  await database.prepare(`INSERT INTO company_sources (
    id, company_id, provider, board_id, careers_url, discovery_status, first_discovered_at
  ) VALUES (?, ?, ?, ?, ?, 'active', ?)`).bind(
    smartRecruitersSource.id,
    smartRecruitersSource.companyId,
    smartRecruitersSource.provider,
    smartRecruitersSource.boardId,
    "https://careers.smartrecruiters.com/Acme",
    "2026-07-01T00:00:00.000Z"
  ).run();
  await persistCanonicalSource(
    database,
    smartRecruitersSource,
    [smartRecruitersJob],
    "2026-08-01T07:00:00.000Z",
    "smartrecruiters-open"
  );
  const smartRecruitersClosure = await persistCanonicalSource(
    database,
    smartRecruitersSource,
    [],
    "2026-08-01T08:00:00.000Z",
    "smartrecruiters-close"
  );
  assert.equal(smartRecruitersClosure.closed, 1);
  assert.deepEqual(
    await database.prepare(`SELECT status, discovery_channel AS discoveryChannel
      FROM jobs WHERE provider='smartrecruiters'
        AND external_id='744000000000001'`).first(),
    { status: "verified_closed", discoveryChannel: "public_ats" }
  );
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM fragile_job_misses WHERE source_id=?"
    ).bind(smartRecruitersSource.id).first<{ count: number }>())?.count),
    0
  );

});

test("fragile-source migration installs the two-miss ledger on a fresh D1 database", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: "fragile-source-migration" },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  const migration = await readFile(
    new URL("../drizzle/0007_fragile_source_misses.sql", import.meta.url),
    "utf8"
  );
  for (const statement of migration
    .split("--> statement-breakpoint")
    .map((value) => value.trim())
    .filter(Boolean)) {
    await database.prepare(statement).run();
  }
  assert.deepEqual(
    (await database.prepare("PRAGMA table_info(fragile_job_misses)")
      .all<{ name: string }>()).results.map((column) => column.name),
    [
      "job_id",
      "source_id",
      "first_miss_at",
      "last_miss_at",
      "clean_miss_count",
      "last_run_id",
    ]
  );
  await assert.rejects(
    database.prepare(`INSERT INTO fragile_job_misses (
      job_id, source_id, first_miss_at, last_miss_at, clean_miss_count, last_run_id
    ) VALUES ('job', 'source', '2026-07-30', '2026-07-30', 0, 'run')`).run(),
    /CHECK constraint failed/
  );
});
