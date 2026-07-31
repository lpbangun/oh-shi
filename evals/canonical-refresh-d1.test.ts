import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  persistCanonicalFailure,
  persistCanonicalSource,
  type CanonicalCompanySource,
} from "../lib/canonical-refresh-store";
import type { NormalizedJob } from "../lib/ats-adapters";
import { prepareSeedJobStatement } from "../lib/job-store";
import type { Job } from "../lib/types";

const source: CanonicalCompanySource = {
  id: "ashby:integration-board",
  companyId: "company-integration",
  provider: "ashby",
  boardId: "integration-board",
};

function job(externalId: string): NormalizedJob {
  return {
    externalId,
    title: `Engineer ${externalId}`,
    roleFamily: "Engineering",
    location: "Remote - US",
    remoteStatus: "Remote",
    employmentType: "Full-time",
    compensation: "See posting",
    canonicalUrl: `https://jobs.ashbyhq.com/integration-board/${externalId}`,
    publishedAt: "2026-07-01T00:00:00.000Z",
    summary: "Canonical integration fixture.",
  };
}

test("D1 quarantine prevents mutation, recovers, and later permits a narrow closure", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: "canonical-refresh-integration" },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;

  await database.batch([
    database.prepare(`CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      role_family TEXT NOT NULL,
      location TEXT NOT NULL,
      remote_status TEXT NOT NULL,
      employment_type TEXT NOT NULL,
      compensation TEXT NOT NULL,
      canonical_url TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      source_updated_at TEXT,
      published_at TEXT,
      last_verified_at TEXT NOT NULL,
      closed_at TEXT,
      raw_url TEXT NOT NULL,
      discovery_channel TEXT NOT NULL,
      evidence_url TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      snapshot_run_id TEXT NOT NULL,
      linkedin_presence_state TEXT NOT NULL,
      linkedin_evidence_url TEXT,
      linkedin_checked_at TEXT,
      summary TEXT NOT NULL,
      CHECK(linkedin_presence_state='unknown' OR (
        linkedin_evidence_url IS NOT NULL AND linkedin_checked_at IS NOT NULL
      )),
      UNIQUE(provider, source_id, external_id)
    )`),
    database.prepare(`CREATE TABLE changes (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      source_url TEXT NOT NULL
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
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      board_id TEXT NOT NULL,
      careers_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      discovery_status TEXT NOT NULL DEFAULT 'active',
      first_discovered_at TEXT NOT NULL,
      last_attempted_at TEXT,
      last_successful_at TEXT,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      review_notes TEXT NOT NULL DEFAULT '',
      quarantine_snapshot_id TEXT,
      quarantine_application_id TEXT
    )`),
    database.prepare(`CREATE TABLE canonical_source_snapshots (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('accepted','quarantined')),
      existing_open_count INTEGER NOT NULL,
      observed_open_count INTEGER NOT NULL,
      missing_count INTEGER NOT NULL,
      missing_ratio_bps INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      quarantine_reason TEXT,
      board_id TEXT,
      UNIQUE(run_id, source_id)
    )`),
    database.prepare(`CREATE TABLE canonical_snapshot_members (
      snapshot_id TEXT NOT NULL, external_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('observed','missing','existing')),
      PRIMARY KEY(snapshot_id, external_id, kind)
    )`),
  ]);
  await database.prepare(`INSERT INTO company_sources (
    id, company_id, provider, board_id, careers_url, discovery_status,
    first_discovered_at, last_successful_at
  ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`).bind(
    source.id,
    source.companyId,
    source.provider,
    source.boardId,
    "https://jobs.ashbyhq.com/integration-board",
    "2026-07-01T00:00:00.000Z",
    "2026-07-29T00:00:00.000Z"
  ).run();

  const seedStatements = Array.from({ length: 100 }, (_, index) => {
    const externalId = `existing-${index}`;
    return database.prepare(`INSERT INTO jobs (
      id, company_id, external_id, provider, source_id, title, role_family,
      location, remote_status, employment_type, compensation, canonical_url,
      source, status, first_seen_at, last_seen_at, source_updated_at, published_at,
      last_verified_at, raw_url, discovery_channel, evidence_url, parser_version,
      snapshot_run_id, linkedin_presence_state, summary
    ) VALUES (?, ?, ?, ?, ?, ?, 'Engineering', 'Remote - US', 'Remote',
      'Full-time', 'See posting', ?, 'ashby', 'verified_open', ?, ?, ?, ?, ?, ?,
      'public_ats', ?, 'seed-1.0', 'seed-run', 'unknown', ?)`).bind(
      `job-${externalId}`,
      source.companyId,
      externalId,
      source.provider,
      source.id,
      `Engineer ${index}`,
      `https://jobs.ashbyhq.com/integration-board/${externalId}`,
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
      "2026-07-29T00:00:00.000Z",
      `https://jobs.ashbyhq.com/integration-board/${externalId}`,
      `https://jobs.ashbyhq.com/integration-board/${externalId}`,
      "Canonical integration fixture."
    );
  });
  for (let offset = 0; offset < seedStatements.length; offset += 40) {
    await database.batch(seedStatements.slice(offset, offset + 40));
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

  const adversarialPayload = [
    job("existing-0"),
    ...Array.from({ length: 99 }, (_, index) => job(`replacement-${index}`)),
  ];
  const quarantined = await persistCanonicalSource(
    database,
    source,
    adversarialPayload,
    "2026-07-30T00:00:00.000Z",
    "canonical-quarantine"
  );
  assert.equal(quarantined.status, "quarantined");
  assert.equal(quarantined.observed, 100);
  assert.equal(quarantined.verified, 0);
  assert.equal(quarantined.opened, 0);
  assert.equal(quarantined.closed, 0);

  const afterQuarantine = await database.prepare(`SELECT
    SUM(CASE WHEN status='verified_open' THEN 1 ELSE 0 END) AS openCount,
    SUM(CASE WHEN external_id LIKE 'replacement-%' THEN 1 ELSE 0 END) AS replacementCount
    FROM jobs`).first<{ openCount: number; replacementCount: number }>();
  assert.equal(Number(afterQuarantine?.openCount), 100);
  assert.equal(Number(afterQuarantine?.replacementCount), 0);
  assert.equal(
    Number((await database.prepare("SELECT COUNT(*) AS count FROM changes")
      .first<{ count: number }>())?.count),
    0
  );
  assert.deepEqual(
    await database.prepare(`SELECT status, existing_open_count AS existingOpenCount,
      observed_open_count AS observedOpenCount, missing_count AS missingCount,
      missing_ratio_bps AS missingRatioBps, quarantine_reason AS quarantineReason
      FROM canonical_source_snapshots WHERE run_id='canonical-quarantine'`)
      .first(),
    {
      status: "quarantined",
      existingOpenCount: 100,
      observedOpenCount: 100,
      missingCount: 99,
      missingRatioBps: 9900,
      quarantineReason: "mass_deletion_guard",
    }
  );
  assert.deepEqual(
    await database.prepare(`SELECT discovery_status AS discoveryStatus,
      last_successful_at AS lastSuccessfulAt, consecutive_failures AS consecutiveFailures
      FROM company_sources WHERE id=?`).bind(source.id).first(),
    {
      discoveryStatus: "quarantined",
      lastSuccessfulAt: "2026-07-29T00:00:00.000Z",
      consecutiveFailures: 1,
    }
  );

  const completePayload = Array.from({ length: 100 }, (_, index) => job(`existing-${index}`));
  const recovered = await persistCanonicalSource(
    database,
    source,
    completePayload,
    "2026-07-30T06:00:00.000Z",
    "canonical-recovery"
  );
  assert.equal(recovered.status, "success");
  assert.equal(recovered.opened, 0);
  assert.equal(recovered.closed, 0);
  assert.deepEqual(
    await database.prepare(`SELECT discovery_status AS discoveryStatus,
      last_successful_at AS lastSuccessfulAt, last_error AS lastError,
      consecutive_failures AS consecutiveFailures
      FROM company_sources WHERE id=?`).bind(source.id).first(),
    {
      discoveryStatus: "active",
      lastSuccessfulAt: "2026-07-30T06:00:00.000Z",
      lastError: null,
      consecutiveFailures: 0,
    }
  );

  const narrowPayload = completePayload.slice(0, 99);
  const narrowClosure = await persistCanonicalSource(
    database,
    source,
    narrowPayload,
    "2026-07-30T12:00:00.000Z",
    "canonical-narrow-closure"
  );
  assert.equal(narrowClosure.status, "success");
  assert.equal(narrowClosure.closed, 1);
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE status='verified_open'"
    ).first<{ count: number }>())?.count),
    99
  );
  assert.deepEqual(
    (await database.prepare(
      "SELECT status FROM canonical_source_snapshots ORDER BY captured_at"
    ).all<{ status: string }>()).results.map((row) => row.status),
    ["quarantined", "accepted", "accepted"]
  );

  const malformed = await persistCanonicalFailure(
    database,
    source,
    "2026-07-30T18:00:00.000Z",
    "canonical-incomplete",
    new Error("ashby board integration-board returned an incomplete payload")
  );
  assert.equal(malformed.status, "quarantined");
  assert.equal(malformed.quarantineReason, "incomplete_payload");
  assert.equal(malformed.closed, 0);
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE status='verified_open'"
    ).first<{ count: number }>())?.count),
    99
  );
  assert.deepEqual(
    await database.prepare(`SELECT status, existing_open_count AS existingOpenCount,
      observed_open_count AS observedOpenCount, missing_count AS missingCount,
      quarantine_reason AS quarantineReason
      FROM canonical_source_snapshots WHERE run_id='canonical-incomplete'`).first(),
    {
      status: "quarantined",
      existingOpenCount: 99,
      observedOpenCount: 0,
      missingCount: 99,
      quarantineReason: "incomplete_payload",
    }
  );

  const recoveredAgain = await persistCanonicalSource(
    database,
    source,
    narrowPayload,
    "2026-07-31T00:00:00.000Z",
    "canonical-post-parser-recovery"
  );
  assert.equal(recoveredAgain.status, "success");
  assert.equal(recoveredAgain.opened, 0);
  assert.equal(recoveredAgain.closed, 0);
  assert.deepEqual(
    await database.prepare(`SELECT
      last_seen_at AS lastSeenAt, source_updated_at AS sourceUpdatedAt,
      raw_url AS rawUrl, discovery_channel AS discoveryChannel,
      evidence_url AS evidenceUrl, parser_version AS parserVersion,
      snapshot_run_id AS snapshotRunId,
      linkedin_presence_state AS linkedInPresenceState,
      linkedin_evidence_url AS linkedInEvidenceUrl,
      linkedin_checked_at AS linkedInCheckedAt
      FROM jobs WHERE external_id='existing-0'`).first(),
    {
      lastSeenAt: "2026-07-31T00:00:00.000Z",
      sourceUpdatedAt: "2026-07-01T00:00:00.000Z",
      rawUrl: "https://jobs.ashbyhq.com/integration-board/existing-0",
      discoveryChannel: "public_ats",
      evidenceUrl: "https://jobs.ashbyhq.com/integration-board/existing-0",
      parserVersion: "1.0",
      snapshotRunId: "canonical-post-parser-recovery",
      linkedInPresenceState: "unknown",
      linkedInEvidenceUrl: null,
      linkedInCheckedAt: null,
    }
  );
  assert.deepEqual(
    (await database.prepare(
      "SELECT status FROM canonical_source_snapshots ORDER BY captured_at"
    ).all<{ status: string }>()).results.map((row) => row.status),
    ["quarantined", "accepted", "accepted", "quarantined", "accepted"]
  );

  const alternateSource: CanonicalCompanySource = {
    id: "workable:integration-board",
    companyId: source.companyId,
    provider: "workable",
    boardId: "integration-board",
  };
  await database.prepare(`INSERT INTO company_sources (
    id, company_id, provider, board_id, careers_url, discovery_status,
    first_discovered_at
  ) VALUES (?, ?, ?, ?, ?, 'active', ?)`).bind(
    alternateSource.id,
    alternateSource.companyId,
    alternateSource.provider,
    alternateSource.boardId,
    "https://apply.workable.com/integration-board/",
    "2026-07-31T00:00:00.000Z"
  ).run();
  const alternateObservation = {
    ...job("existing-0"),
    externalId: "alternate-existing-0",
    canonicalUrl: "https://apply.workable.com/j/ALTERNATE0/",
  };
  const deduplicated = await persistCanonicalSource(
    database,
    alternateSource,
    [alternateObservation],
    "2026-07-31T01:00:00.000Z",
    "canonical-cross-source"
  );
  assert.equal(deduplicated.opened, 0);
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM jobs"
    ).first<{ count: number }>())?.count),
    100
  );
  assert.deepEqual(
    await database.prepare(`SELECT COUNT(*) AS observationCount,
      COUNT(DISTINCT job_id) AS canonicalCount
      FROM job_observations WHERE job_id='job-existing-0'`).first(),
    { observationCount: 2, canonicalCount: 1 }
  );
  assert.equal(
    (await database.prepare(`SELECT match_method AS method
      FROM job_observations WHERE provider='workable'`).first<{ method: string }>())?.method,
    "high_confidence"
  );
  await persistCanonicalSource(
    database,
    alternateSource,
    [alternateObservation],
    "2026-07-31T01:30:00.000Z",
    "canonical-cross-source-repeat"
  );
  assert.equal(
    (await database.prepare(`SELECT match_method AS method
      FROM job_observations WHERE provider='workable'`).first<{ method: string }>())?.method,
    "high_confidence"
  );

  const primaryDisappeared = await persistCanonicalSource(
    database,
    source,
    narrowPayload.slice(1),
    "2026-07-31T02:00:00.000Z",
    "canonical-primary-disappeared"
  );
  assert.equal(primaryDisappeared.closed, 0);
  assert.equal(
    (await database.prepare(
      "SELECT status FROM jobs WHERE id='job-existing-0'"
    ).first<{ status: string }>())?.status,
    "verified_open"
  );
  assert.deepEqual(
    (await database.prepare(`SELECT provider, status FROM job_observations
      WHERE job_id='job-existing-0' ORDER BY provider`)
      .all<{ provider: string; status: string }>()).results,
    [
      { provider: "ashby", status: "verified_closed" },
      { provider: "workable", status: "verified_open" },
    ]
  );
  const allObservationsGone = await persistCanonicalSource(
    database,
    alternateSource,
    [],
    "2026-07-31T03:00:00.000Z",
    "canonical-all-observations-gone"
  );
  assert.equal(allObservationsGone.closed, 1);
  assert.equal(
    (await database.prepare(
      "SELECT status FROM jobs WHERE id='job-existing-0'"
    ).first<{ status: string }>())?.status,
    "verified_closed"
  );
});

test("job provenance migration preserves and truthfully backfills an existing D1 row", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: "job-provenance-migration" },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  await database.prepare(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, external_id TEXT NOT NULL,
    provider TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT NOT NULL,
    role_family TEXT NOT NULL, location TEXT NOT NULL, remote_status TEXT NOT NULL,
    employment_type TEXT NOT NULL, compensation TEXT NOT NULL,
    canonical_url TEXT NOT NULL UNIQUE, source TEXT NOT NULL, status TEXT NOT NULL,
    first_seen_at TEXT NOT NULL, published_at TEXT, last_verified_at TEXT NOT NULL,
    closed_at TEXT, summary TEXT NOT NULL
  )`).run();
  await database.prepare(`INSERT INTO jobs (
    id, company_id, external_id, provider, source_id, title, role_family,
    location, remote_status, employment_type, compensation, canonical_url,
    source, status, first_seen_at, published_at, last_verified_at, summary
  ) VALUES (
    'legacy-job', 'legacy-company', 'legacy-external', 'ashby', 'ashby:legacy',
    'Legacy Engineer', 'Engineering', 'Remote - US', 'Remote', 'Full-time',
    'See posting', 'https://jobs.ashbyhq.com/legacy/legacy-external',
    'ashby', 'verified_open', '2026-07-01T00:00:00.000Z', NULL,
    '2026-07-29T00:00:00.000Z', 'Legacy canonical record.'
  )`).run();

  const migration = await readFile(
    new URL("../drizzle/0005_job_provenance.sql", import.meta.url),
    "utf8"
  );
  for (const statement of migration.split(";").map((value) => value.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
  }
  assert.deepEqual(
    await database.prepare(`SELECT last_seen_at AS lastSeenAt,
      source_updated_at AS sourceUpdatedAt, raw_url AS rawUrl,
      discovery_channel AS discoveryChannel, evidence_url AS evidenceUrl,
      parser_version AS parserVersion, snapshot_run_id AS snapshotRunId,
      linkedin_presence_state AS linkedInPresenceState,
      linkedin_evidence_url AS linkedInEvidenceUrl,
      linkedin_checked_at AS linkedInCheckedAt FROM jobs WHERE id='legacy-job'`).first(),
    {
      lastSeenAt: "2026-07-29T00:00:00.000Z",
      sourceUpdatedAt: null,
      rawUrl: "https://jobs.ashbyhq.com/legacy/legacy-external",
      discoveryChannel: "public_ats",
      evidenceUrl: "https://jobs.ashbyhq.com/legacy/legacy-external",
      parserVersion: "legacy",
      snapshotRunId: "legacy",
      linkedInPresenceState: "unknown",
      linkedInEvidenceUrl: null,
      linkedInCheckedAt: null,
    }
  );
  await assert.rejects(
    database.prepare(
      "UPDATE jobs SET linkedin_presence_state='absent' WHERE id='legacy-job'"
    ).run(),
    /CHECK constraint failed/
  );
  await assert.rejects(
    database.prepare(
      "UPDATE jobs SET linkedin_presence_state='not_observed' WHERE id='legacy-job'"
    ).run(),
    /CHECK constraint failed/
  );
  await database.prepare(`UPDATE jobs SET linkedin_presence_state='not_observed',
    linkedin_evidence_url='https://licensed-evidence.example/check/legacy-job',
    linkedin_checked_at='2026-07-30T00:00:00.000Z' WHERE id='legacy-job'`).run();
  assert.deepEqual(
    await database.prepare(`SELECT linkedin_presence_state AS state,
      linkedin_evidence_url AS evidenceUrl, linkedin_checked_at AS checkedAt
      FROM jobs WHERE id='legacy-job'`).first(),
    {
      state: "not_observed",
      evidenceUrl: "https://licensed-evidence.example/check/legacy-job",
      checkedAt: "2026-07-30T00:00:00.000Z",
    }
  );
  const observationMigration = await readFile(
    new URL("../drizzle/0008_job_observations.sql", import.meta.url),
    "utf8"
  );
  for (
    const statement of observationMigration
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean)
  ) {
    await database.prepare(statement).run();
  }
  assert.deepEqual(
    await database.prepare(`SELECT job_id AS jobId, provider, source_id AS sourceId,
      external_id AS externalId, canonical_url AS canonicalUrl, status,
      match_method AS matchMethod, match_score_bps AS matchScoreBps
      FROM job_observations WHERE job_id='legacy-job'`).first(),
    {
      jobId: "legacy-job",
      provider: "ashby",
      sourceId: "ashby:legacy",
      externalId: "legacy-external",
      canonicalUrl: "https://jobs.ashbyhq.com/legacy/legacy-external",
      status: "verified_open",
      matchMethod: "backfill",
      matchScoreBps: 10000,
    }
  );

  const seeded: Job = {
    id: "new-seed-job",
    companyId: "seed-company",
    externalId: "new-seed-external",
    provider: "ashby",
    sourceId: "ashby:seed",
    title: "Seed Engineer",
    roleFamily: "Engineering",
    location: "Remote - US",
    remoteStatus: "Remote",
    employmentType: "Full-time",
    compensation: "See posting",
    canonicalUrl: "https://jobs.ashbyhq.com/seed/new-seed-external",
    source: "ashby",
    status: "verified_open",
    firstSeenAt: "2026-07-30T00:00:00.000Z",
    lastSeenAt: "2026-07-30T00:00:00.000Z",
    sourceUpdatedAt: null,
    publishedAt: null,
    lastVerifiedAt: "2026-07-30T00:00:00.000Z",
    closedAt: null,
    rawUrl: "https://jobs.ashbyhq.com/seed/new-seed-external",
    discoveryChannel: "public_ats",
    evidenceUrl: "https://jobs.ashbyhq.com/seed/new-seed-external",
    parserVersion: "seed-1.0",
    snapshotRunId: "seed-run",
    linkedInPresenceState: "unknown",
    linkedInEvidenceUrl: null,
    linkedInCheckedAt: null,
    summary: "Production-linked seed statement integration fixture.",
  };
  await prepareSeedJobStatement(database, seeded, "ashby", "ashby:seed").run();
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE id='new-seed-job'"
    ).first<{ count: number }>())?.count),
    1
  );
});
