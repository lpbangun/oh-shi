import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { Miniflare } from "miniflare";
import type { NormalizedJob } from "../lib/ats-adapters";
import { retryCanonicalFetch } from "../lib/canonical-fetch-retry";
import {
  persistCanonicalFailure,
  persistCanonicalSource,
  type CanonicalCompanySource,
} from "../lib/canonical-refresh-store";
import {
  MASS_DELETION_GUARD,
  assessCanonicalSnapshot,
  planCanonicalClosures,
  snapshotFingerprint,
} from "../lib/ingestion-core";
import type { AtsProvider } from "../lib/source-registry";

// Characterization of the frozen canonical lifecycle semantics against real D1
// (Miniflare D1 plus the checked-in drizzle migrations, applied in numeric
// order over the legacy base schema). These four tests document the behavior
// that already ships on the base revision: a first observation opens exactly
// once, a closure requires a complete validated payload and is planned per
// source, and both unsafe-snapshot guards (incomplete payload, mass
// disappearance) quarantine without mutating jobs, observations, or freshness.
//
// `lib/refresh.ts` cannot be imported from node:test (it imports
// `cloudflare:workers`), so the incomplete-payload tests drive the same two
// production calls that `refreshCanonicalBoards` chains: the real adapter
// (`retryCanonicalFetch`, which rejects the payload) and the real store
// (`persistCanonicalFailure`, which quarantines without touching job state).

const COMPANY_ID = "company-lifecycle";

const ashbySource: CanonicalCompanySource = {
  id: "ashby:lifecycle-board",
  companyId: COMPANY_ID,
  provider: "ashby",
  boardId: "lifecycle-board",
};

// Second source used only for the strict-ratio boundary below. Its titles and
// bodies are deliberately distinct so cross-source high-confidence dedupe can
// never collapse the two fixtures onto one canonical job.
const boundarySource: CanonicalCompanySource = {
  id: "workable:lifecycle-boundary",
  companyId: COMPANY_ID,
  provider: "workable",
  boardId: "lifecycle-boundary",
};

type JobStateRow = {
  id: string;
  externalId: string;
  provider: string;
  sourceId: string;
  status: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastVerifiedAt: string;
  closedAt: string | null;
  snapshotRunId: string;
  canonicalUrl: string;
};

type ObservationStateRow = {
  id: string;
  jobId: string;
  provider: string;
  sourceId: string;
  externalId: string;
  status: string;
  closedAt: string | null;
  snapshotRunId: string;
  matchMethod: string;
};

type ChangeStateRow = {
  id: string;
  entityId: string;
  changeType: string;
  description: string;
  occurredAt: string;
  sourceUrl: string;
};

type SourceStateRow = {
  discoveryStatus: string;
  lastAttemptedAt: string | null;
  lastSuccessfulAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  quarantineSnapshotId: string | null;
};

type SnapshotStateRow = {
  id: string;
  runId: string;
  sourceId: string;
  provider: string;
  status: string;
  existingOpenCount: number;
  observedOpenCount: number;
  missingCount: number;
  missingRatioBps: number;
  fingerprint: string;
  quarantineReason: string | null;
  boardId: string | null;
};

// The legacy base shape (pre-migration) for the tables these tests seed. The
// lifecycle storage tables themselves come from the drizzle migrations below,
// exactly as a forwarded database receives them.
const lifecycleBaseSchema = (database: D1Database) => [
  database.prepare(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, external_id TEXT NOT NULL,
    provider TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT NOT NULL,
    role_family TEXT NOT NULL, location TEXT NOT NULL, remote_status TEXT NOT NULL,
    employment_type TEXT NOT NULL, compensation TEXT NOT NULL,
    canonical_url TEXT NOT NULL UNIQUE, source TEXT NOT NULL, status TEXT NOT NULL,
    first_seen_at TEXT NOT NULL, published_at TEXT, last_verified_at TEXT NOT NULL,
    closed_at TEXT, summary TEXT NOT NULL
  )`),
  database.prepare(`CREATE TABLE changes (
    id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    change_type TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
    occurred_at TEXT NOT NULL, source_url TEXT NOT NULL
  )`),
  database.prepare(`CREATE TABLE company_sources (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, provider TEXT NOT NULL,
    board_id TEXT NOT NULL, careers_url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    discovery_status TEXT NOT NULL DEFAULT 'active', first_discovered_at TEXT NOT NULL,
    last_attempted_at TEXT, last_successful_at TEXT, last_error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0, review_notes TEXT NOT NULL DEFAULT '',
    UNIQUE(provider, board_id)
  )`),
];

const lifecycleMigrations = [
  "0004_canonical_snapshot_guard.sql",
  "0005_job_provenance.sql",
  "0008_job_observations.sql",
  "0010_canonical_snapshot_reviews.sql",
  "0014_job_description_fidelity.sql",
];

async function applyLifecycleMigration(database: D1Database, file: string) {
  const sql = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
  const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) await database.prepare(statement).run();
}

async function createLifecycleDatabase(t: TestContext, name: string) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: name },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  await database.batch(lifecycleBaseSchema(database));
  for (const migration of lifecycleMigrations) {
    await applyLifecycleMigration(database, migration);
  }
  return database;
}

function ashbyJob(externalId: string): NormalizedJob {
  return {
    externalId,
    title: `Lifecycle Engineer ${externalId}`,
    roleFamily: "Engineering",
    location: "Remote - US",
    remoteStatus: "Remote",
    employmentType: "Full-time",
    compensation: "See posting",
    canonicalUrl: `https://jobs.ashbyhq.com/lifecycle-board/${externalId}`,
    publishedAt: "2026-08-01T00:00:00.000Z",
    description: `Canonical lifecycle fixture for ${externalId}.`,
    summary: `Canonical lifecycle fixture for ${externalId}.`,
  };
}

function boundaryJob(externalId: string): NormalizedJob {
  return {
    externalId,
    title: `Boundary Groundskeeper ${externalId}`,
    roleFamily: "Operations",
    location: "Remote - US",
    remoteStatus: "Remote",
    employmentType: "Full-time",
    compensation: "See posting",
    canonicalUrl: `https://apply.workable.com/j/${externalId}/`,
    publishedAt: "2026-08-01T00:00:00.000Z",
    description: `Boundary guard fixture for ${externalId}.`,
    summary: `Boundary guard fixture for ${externalId}.`,
  };
}

async function insertCompanySource(
  database: D1Database,
  source: CanonicalCompanySource,
  careersUrl: string,
  discoveredAt = "2026-07-01T00:00:00.000Z"
) {
  await database.prepare(`INSERT INTO company_sources (
    id, company_id, provider, board_id, careers_url, discovery_status, first_discovered_at
  ) VALUES (?, ?, ?, ?, ?, 'active', ?)`).bind(
    source.id, source.companyId, source.provider, source.boardId, careersUrl, discoveredAt
  ).run();
}

function selectJobs(database: D1Database, provider: AtsProvider) {
  return database.prepare(`SELECT id, external_id AS externalId, provider,
    source_id AS sourceId, status, first_seen_at AS firstSeenAt,
    last_seen_at AS lastSeenAt, last_verified_at AS lastVerifiedAt,
    closed_at AS closedAt, snapshot_run_id AS snapshotRunId,
    canonical_url AS canonicalUrl FROM jobs WHERE provider=? ORDER BY external_id`)
    .bind(provider)
    .all<JobStateRow>();
}

function selectObservations(database: D1Database, provider: AtsProvider) {
  return database.prepare(`SELECT id, job_id AS jobId, provider, source_id AS sourceId,
    external_id AS externalId, status, closed_at AS closedAt,
    snapshot_run_id AS snapshotRunId, match_method AS matchMethod
    FROM job_observations WHERE provider=? ORDER BY external_id`)
    .bind(provider)
    .all<ObservationStateRow>();
}

function selectChanges(database: D1Database) {
  return database.prepare(`SELECT id, entity_id AS entityId, change_type AS changeType,
    description, occurred_at AS occurredAt, source_url AS sourceUrl
    FROM changes ORDER BY occurred_at, id`).all<ChangeStateRow>();
}

function selectSource(database: D1Database, sourceId: string) {
  return database.prepare(`SELECT discovery_status AS discoveryStatus,
    last_attempted_at AS lastAttemptedAt, last_successful_at AS lastSuccessfulAt,
    consecutive_failures AS consecutiveFailures, last_error AS lastError,
    quarantine_snapshot_id AS quarantineSnapshotId
    FROM company_sources WHERE id=?`).bind(sourceId).first<SourceStateRow>();
}

function selectSnapshots(database: D1Database) {
  return database.prepare(`SELECT id, run_id AS runId, source_id AS sourceId, provider,
    status, existing_open_count AS existingOpenCount,
    observed_open_count AS observedOpenCount, missing_count AS missingCount,
    missing_ratio_bps AS missingRatioBps, fingerprint,
    quarantine_reason AS quarantineReason, board_id AS boardId
    FROM canonical_source_snapshots ORDER BY captured_at`).all<SnapshotStateRow>();
}

async function countChanges(database: D1Database, changeType: string) {
  return Number((await database.prepare(
    "SELECT COUNT(*) AS count FROM changes WHERE change_type=?"
  ).bind(changeType).first<{ count: number }>())?.count);
}

// Drives the real provider adapter against a stubbed public board response and
// returns the error the scheduled refresh would hand to the quarantine store.
async function canonicalFetchError(
  provider: AtsProvider,
  boardId: string,
  body: string
): Promise<Error> {
  const fetcher = (async () => new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  const outcome = await retryCanonicalFetch({ provider, boardId }, fetcher).then(
    () => null,
    (error: unknown) => error as Error
  );
  assert.ok(outcome, `${provider} board ${boardId} must reject an invalid payload`);
  return outcome;
}

test("lifecycle: first observed posting opens", async (t) => {
  const database = await createLifecycleDatabase(t, "lifecycle-first-observation");
  await insertCompanySource(database, ashbySource, "https://jobs.ashbyhq.com/lifecycle-board");

  const observedAt = "2026-08-01T00:00:00.000Z";
  const runId = "lifecycle-open";
  const posting = ashbyJob("posting-1");
  const result = await persistCanonicalSource(
    database, ashbySource, [posting], observedAt, runId
  );
  assert.equal(result.status, "success");
  assert.equal(result.opened, 1);
  assert.equal(result.closed, 0);
  assert.equal(result.observed, 1);
  assert.equal(result.verified, 1);
  assert.equal(result.snapshotId, `${runId}:${ashbySource.id}`);

  const job = await database.prepare(`SELECT id, company_id AS companyId,
    external_id AS externalId, provider, source_id AS sourceId, status,
    first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
    last_verified_at AS lastVerifiedAt, closed_at AS closedAt,
    snapshot_run_id AS snapshotRunId, canonical_url AS canonicalUrl
    FROM jobs`).first<{
      id: string;
      companyId: string;
      externalId: string;
      provider: string;
      sourceId: string;
      status: string;
      firstSeenAt: string;
      lastSeenAt: string;
      lastVerifiedAt: string;
      closedAt: string | null;
      snapshotRunId: string;
      canonicalUrl: string;
    }>();
  assert.ok(job);
  assert.match(job.id, /^job_ashby_lifecycle-board_posting-1_[0-9a-f]{16}$/);
  assert.deepEqual(
    { ...job, id: undefined },
    {
      id: undefined,
      companyId: COMPANY_ID,
      externalId: "posting-1",
      provider: "ashby",
      sourceId: ashbySource.id,
      status: "verified_open",
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      lastVerifiedAt: observedAt,
      closedAt: null,
      snapshotRunId: runId,
      canonicalUrl: posting.canonicalUrl,
    }
  );

  const observation = await database.prepare(`SELECT id, job_id AS jobId,
    company_id AS companyId, provider, source_id AS sourceId,
    external_id AS externalId, status, first_seen_at AS firstSeenAt,
    last_seen_at AS lastSeenAt, last_verified_at AS lastVerifiedAt,
    closed_at AS closedAt, snapshot_run_id AS snapshotRunId,
    match_method AS matchMethod FROM job_observations`).first<{
      id: string;
      jobId: string;
      companyId: string;
      provider: string;
      sourceId: string;
      externalId: string;
      status: string;
      firstSeenAt: string;
      lastSeenAt: string;
      lastVerifiedAt: string;
      closedAt: string | null;
      snapshotRunId: string;
      matchMethod: string;
    }>();
  assert.ok(observation);
  assert.deepEqual({ ...observation, id: undefined }, {
    id: undefined,
    jobId: job.id,
    companyId: COMPANY_ID,
    provider: "ashby",
    sourceId: ashbySource.id,
    externalId: "posting-1",
    status: "verified_open",
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    lastVerifiedAt: observedAt,
    closedAt: null,
    snapshotRunId: runId,
    matchMethod: "new",
  });

  const changes = (await selectChanges(database)).results;
  assert.equal(changes.length, 1, "exactly one change event for the first observation");
  assert.deepEqual({ ...changes[0], id: undefined }, {
    id: undefined,
    entityId: job.id,
    changeType: "job_opened",
    description: "Canonical ashby posting verified open.",
    occurredAt: observedAt,
    sourceUrl: posting.canonicalUrl,
  });

  const snapshots = (await selectSnapshots(database)).results;
  assert.equal(snapshots.length, 1);
  assert.deepEqual({
    runId: snapshots[0].runId,
    status: snapshots[0].status,
    existingOpenCount: snapshots[0].existingOpenCount,
    observedOpenCount: snapshots[0].observedOpenCount,
    missingCount: snapshots[0].missingCount,
    missingRatioBps: snapshots[0].missingRatioBps,
    quarantineReason: snapshots[0].quarantineReason,
  }, {
    runId,
    status: "accepted",
    existingOpenCount: 0,
    observedOpenCount: 1,
    missingCount: 0,
    missingRatioBps: 0,
    quarantineReason: null,
  });

  const source = await selectSource(database, ashbySource.id);
  assert.deepEqual(source, {
    discoveryStatus: "active",
    lastAttemptedAt: observedAt,
    lastSuccessfulAt: observedAt,
    consecutiveFailures: 0,
    lastError: null,
    quarantineSnapshotId: null,
  });

  // Re-observing the same posting is a refresh, not a second opening.
  const replayAt = "2026-08-01T02:00:00.000Z";
  const replay = await persistCanonicalSource(
    database, ashbySource, [posting], replayAt, "lifecycle-open-replay"
  );
  assert.equal(replay.status, "success");
  assert.equal(replay.opened, 0);
  assert.equal(replay.closed, 0);
  assert.equal((await selectJobs(database, "ashby")).results.length, 1);
  assert.equal(await countChanges(database, "job_opened"), 1);
  assert.deepEqual(
    await database.prepare("SELECT last_seen_at AS lastSeenAt FROM jobs")
      .first<{ lastSeenAt: string }>(),
    { lastSeenAt: replayAt }
  );
});

test("lifecycle: clean close only on complete validated payload", async (t) => {
  const database = await createLifecycleDatabase(t, "lifecycle-clean-close");
  await insertCompanySource(database, ashbySource, "https://jobs.ashbyhq.com/lifecycle-board");

  const openedAt = "2026-08-02T00:00:00.000Z";
  await persistCanonicalSource(
    database, ashbySource, [ashbyJob("posting-1"), ashbyJob("posting-2")],
    openedAt, "lifecycle-close-open"
  );
  const openJobs = (await selectJobs(database, "ashby")).results;
  assert.equal(openJobs.length, 2);
  const omitted = openJobs.find((row) => row.externalId === "posting-2");
  const retained = openJobs.find((row) => row.externalId === "posting-1");
  assert.ok(omitted);
  assert.ok(retained);

  // The closure plan is scoped per source and is exactly what the store applies.
  const plan = planCanonicalClosures(
    openJobs.map((row) => ({ id: row.id, externalId: row.externalId, status: row.status })),
    ["posting-1"]
  );
  assert.deepEqual(plan.closingJobIds, [omitted.id]);
  assert.deepEqual(plan.closingExternalIds, ["posting-2"]);
  assert.equal(plan.assessment.status, "accepted");
  assert.equal(plan.assessment.missingCount, 1);

  const closeRunId = "lifecycle-close-complete";
  const closedAt = "2026-08-02T06:00:00.000Z";
  const complete = await persistCanonicalSource(
    database, ashbySource, [ashbyJob("posting-1")], closedAt, closeRunId
  );
  assert.equal(complete.status, "success");
  assert.equal(complete.opened, 0);
  assert.equal(complete.closed, 1);

  const jobs = new Map(
    (await selectJobs(database, "ashby")).results.map((row) => [row.externalId, row])
  );
  assert.deepEqual({
    retainedStatus: jobs.get("posting-1")?.status,
    retainedClosedAt: jobs.get("posting-1")?.closedAt,
    omittedStatus: jobs.get("posting-2")?.status,
    omittedClosedAt: jobs.get("posting-2")?.closedAt,
    omittedLastVerifiedAt: jobs.get("posting-2")?.lastVerifiedAt,
  }, {
    retainedStatus: "verified_open",
    retainedClosedAt: null,
    omittedStatus: "verified_closed",
    omittedClosedAt: closedAt,
    omittedLastVerifiedAt: closedAt,
  });

  const observations = new Map(
    (await selectObservations(database, "ashby")).results
      .map((row) => [row.externalId, row])
  );
  assert.deepEqual({
    omittedStatus: observations.get("posting-2")?.status,
    omittedClosedAt: observations.get("posting-2")?.closedAt,
    omittedSourceId: observations.get("posting-2")?.sourceId,
    retainedStatus: observations.get("posting-1")?.status,
  }, {
    omittedStatus: "verified_closed",
    omittedClosedAt: closedAt,
    omittedSourceId: ashbySource.id,
    retainedStatus: "verified_open",
  });

  // The terminal job state and its change event reference the same
  // company_sources id/provider whose complete validated snapshot omitted it.
  const closureRefs = await database.prepare(`SELECT
    snapshots.source_id AS snapshotSourceId, snapshots.provider AS snapshotProvider,
    sources.id AS sourceRowId, sources.provider AS sourceRowProvider,
    observations.source_id AS observationSourceId,
    observations.provider AS observationProvider,
    jobs.source_id AS jobSourceId, jobs.provider AS jobProvider
    FROM canonical_source_snapshots snapshots
    JOIN company_sources sources ON sources.id = snapshots.source_id
    JOIN job_observations observations
      ON observations.provider = snapshots.provider
      AND observations.source_id = snapshots.source_id
      AND observations.external_id = ?
    JOIN jobs ON jobs.id = observations.job_id
    WHERE snapshots.run_id = ?`).bind("posting-2", closeRunId).first<{
      snapshotSourceId: string;
      snapshotProvider: string;
      sourceRowId: string;
      sourceRowProvider: string;
      observationSourceId: string;
      observationProvider: string;
      jobSourceId: string;
      jobProvider: string;
    }>();
  assert.deepEqual(closureRefs, {
    snapshotSourceId: ashbySource.id,
    snapshotProvider: "ashby",
    sourceRowId: ashbySource.id,
    sourceRowProvider: "ashby",
    observationSourceId: ashbySource.id,
    observationProvider: "ashby",
    jobSourceId: ashbySource.id,
    jobProvider: "ashby",
  });

  const closedEvents = await database.prepare(`SELECT entity_id AS entityId,
    description, occurred_at AS occurredAt, source_url AS sourceUrl
    FROM changes WHERE change_type='job_closed'`).all<{
      entityId: string;
      description: string;
      occurredAt: string;
      sourceUrl: string;
    }>();
  assert.equal(closedEvents.results.length, 1);
  assert.equal(closedEvents.results[0].entityId, omitted.id);
  assert.equal(closedEvents.results[0].occurredAt, closedAt);
  assert.equal(closedEvents.results[0].sourceUrl, omitted.canonicalUrl);
  assert.match(closedEvents.results[0].description, /Canonical ashby source/);

  const closeSnapshot = (await selectSnapshots(database)).results.at(-1);
  assert.deepEqual({
    runId: closeSnapshot?.runId,
    sourceId: closeSnapshot?.sourceId,
    provider: closeSnapshot?.provider,
    status: closeSnapshot?.status,
    existingOpenCount: closeSnapshot?.existingOpenCount,
    observedOpenCount: closeSnapshot?.observedOpenCount,
    missingCount: closeSnapshot?.missingCount,
    missingRatioBps: closeSnapshot?.missingRatioBps,
    quarantineReason: closeSnapshot?.quarantineReason,
  }, {
    runId: closeRunId,
    sourceId: ashbySource.id,
    provider: "ashby",
    status: "accepted",
    existingOpenCount: 2,
    observedOpenCount: 1,
    missingCount: 1,
    missingRatioBps: 5000,
    quarantineReason: null,
  });

  // Re-running the same complete payload closes the posting exactly once.
  const repeatAt = "2026-08-03T00:00:00.000Z";
  const repeat = await persistCanonicalSource(
    database, ashbySource, [ashbyJob("posting-1")], repeatAt, "lifecycle-close-repeat"
  );
  assert.equal(repeat.status, "success");
  assert.equal(repeat.closed, 0);
  assert.equal(await countChanges(database, "job_closed"), 1);
  assert.equal(
    (await database.prepare("SELECT closed_at AS closedAt FROM jobs WHERE external_id='posting-2'")
      .first<{ closedAt: string | null }>())?.closedAt,
    closedAt,
    "a repeat snapshot must not re-stamp closed_at"
  );

  // An incomplete fetch carries no observed identity set, so it can never close
  // anything: the surviving posting stays open behind the quarantine.
  const incompleteError = await canonicalFetchError(
    "ashby",
    ashbySource.boardId,
    JSON.stringify({ jobs: [{ id: "", title: "Incomplete", jobUrl: "not-a-url" }] })
  );
  const failure = await persistCanonicalFailure(
    database, ashbySource, "2026-08-03T06:00:00.000Z", "lifecycle-close-incomplete",
    incompleteError
  );
  assert.equal(failure.status, "quarantined");
  assert.equal(failure.closed, 0);
  assert.equal(
    (await database.prepare("SELECT status FROM jobs WHERE external_id='posting-1'")
      .first<{ status: string }>())?.status,
    "verified_open"
  );
  assert.equal(await countChanges(database, "job_closed"), 1);
});

test("lifecycle: incomplete payload quarantines with zero mutations", async (t) => {
  const database = await createLifecycleDatabase(t, "lifecycle-incomplete-payload");
  await insertCompanySource(database, ashbySource, "https://jobs.ashbyhq.com/lifecycle-board");

  const openRunId = "lifecycle-incomplete-open";
  const openedAt = "2026-09-01T00:00:00.000Z";
  const opened = await persistCanonicalSource(
    database, ashbySource, [ashbyJob("posting-1"), ashbyJob("posting-2")],
    openedAt, openRunId
  );
  assert.equal(opened.opened, 2);

  const before = {
    jobs: (await selectJobs(database, "ashby")).results,
    observations: (await selectObservations(database, "ashby")).results,
    changes: (await selectChanges(database)).results,
    source: await selectSource(database, ashbySource.id),
  };
  assert.equal(before.jobs.length, 2);
  assert.equal(before.observations.length, 2);
  assert.equal(before.changes.length, 2);
  assert.equal(before.source?.lastSuccessfulAt, openedAt);
  assert.equal(before.source?.discoveryStatus, "active");

  // The real adapter rejects a structurally incomplete public payload.
  const incompleteError = await canonicalFetchError(
    "ashby",
    ashbySource.boardId,
    JSON.stringify({ jobs: [{ id: "", title: "Incomplete", jobUrl: "not-a-url" }] })
  );
  assert.match(incompleteError.message, /returned an incomplete payload/);
  const incompleteRunId = "lifecycle-incomplete";
  const incompleteAt = "2026-09-01T02:00:00.000Z";
  const incomplete = await persistCanonicalFailure(
    database, ashbySource, incompleteAt, incompleteRunId, incompleteError
  );
  assert.equal(incomplete.status, "quarantined");
  assert.equal(incomplete.quarantineReason, "incomplete_payload");
  assert.equal(incomplete.snapshotId, `${incompleteRunId}:${ashbySource.id}`);
  assert.equal(incomplete.observed, 0);
  assert.equal(incomplete.verified, 0);
  assert.equal(incomplete.opened, 0);
  assert.equal(incomplete.closed, 0);

  // A parse throw (truncated JSON body) takes the same quarantine path.
  const parseError = await canonicalFetchError("ashby", ashbySource.boardId, "{\"jobs\": [");
  assert.ok(parseError instanceof SyntaxError);
  const parseRunId = "lifecycle-parse-throw";
  const parseAt = "2026-09-01T04:00:00.000Z";
  const parseFailure = await persistCanonicalFailure(
    database, ashbySource, parseAt, parseRunId, parseError
  );
  assert.equal(parseFailure.status, "quarantined");
  assert.equal(parseFailure.quarantineReason, "parser_error");
  assert.equal(parseFailure.opened, 0);
  assert.equal(parseFailure.closed, 0);

  // Zero mutations: not one job, observation, or change row moved, and nothing
  // was deleted. There are no opens and no closes behind either quarantine.
  assert.deepEqual((await selectJobs(database, "ashby")).results, before.jobs);
  assert.deepEqual((await selectObservations(database, "ashby")).results, before.observations);
  assert.deepEqual((await selectChanges(database)).results, before.changes);
  assert.equal(await countChanges(database, "job_opened"), 2);
  assert.equal(await countChanges(database, "job_closed"), 0);

  const snapshots = (await selectSnapshots(database)).results;
  assert.deepEqual(snapshots.map((row) => ({
    runId: row.runId,
    sourceId: row.sourceId,
    provider: row.provider,
    status: row.status,
    existingOpenCount: row.existingOpenCount,
    observedOpenCount: row.observedOpenCount,
    missingCount: row.missingCount,
    missingRatioBps: row.missingRatioBps,
    quarantineReason: row.quarantineReason,
  })), [
    {
      runId: openRunId,
      sourceId: ashbySource.id,
      provider: "ashby",
      status: "accepted",
      existingOpenCount: 0,
      observedOpenCount: 2,
      missingCount: 0,
      missingRatioBps: 0,
      quarantineReason: null,
    },
    {
      runId: incompleteRunId,
      sourceId: ashbySource.id,
      provider: "ashby",
      status: "quarantined",
      existingOpenCount: 2,
      observedOpenCount: 0,
      missingCount: 2,
      missingRatioBps: 10000,
      quarantineReason: "incomplete_payload",
    },
    {
      runId: parseRunId,
      sourceId: ashbySource.id,
      provider: "ashby",
      status: "quarantined",
      existingOpenCount: 2,
      observedOpenCount: 0,
      missingCount: 2,
      missingRatioBps: 10000,
      quarantineReason: "parser_error",
    },
  ]);
  for (const snapshot of snapshots.slice(1)) {
    assert.equal(snapshot.fingerprint, snapshotFingerprint([]));
  }

  const after = await selectSource(database, ashbySource.id);
  assert.ok(after);
  assert.equal(after.discoveryStatus, "quarantined");
  assert.equal(after.quarantineSnapshotId, `${parseRunId}:${ashbySource.id}`);
  assert.equal(after.lastAttemptedAt, parseAt);
  assert.equal(after.consecutiveFailures, 2);
  assert.ok(after.lastError, "the quarantine records its failure message");
  assert.equal(
    after.lastSuccessfulAt,
    before.source?.lastSuccessfulAt,
    "last_successful_at must not advance on a quarantined fetch"
  );
});

test("lifecycle: mass disappearance quarantines, never deletes", async (t) => {
  const database = await createLifecycleDatabase(t, "lifecycle-mass-disappearance");
  await insertCompanySource(database, ashbySource, "https://jobs.ashbyhq.com/lifecycle-board");

  const seededAt = "2026-09-10T00:00:00.000Z";
  const existingIds = Array.from(
    { length: 24 },
    (_, index) => `existing-${String(index).padStart(2, "0")}`
  );
  const seeded = await persistCanonicalSource(
    database, ashbySource, existingIds.map(ashbyJob), seededAt, "lifecycle-mass-seed"
  );
  assert.equal(seeded.opened, 24);

  const retainedIds = existingIds.slice(0, 10);
  const missingIds = existingIds.slice(10);
  const freshIds = Array.from(
    { length: 5 },
    (_, index) => `fresh-${String(index).padStart(2, "0")}`
  );
  const observedIds = [...retainedIds, ...freshIds];

  // All three guard conditions hold: existing open >= 20, missing >= 10, and
  // the missing ratio is strictly above 0.5.
  assert.ok(existingIds.length >= MASS_DELETION_GUARD.minimumExistingOpen);
  assert.ok(missingIds.length >= MASS_DELETION_GUARD.minimumMissing);
  assert.ok(
    missingIds.length / existingIds.length > MASS_DELETION_GUARD.maximumAcceptedMissingRatio
  );

  const quarantineRunId = "lifecycle-mass-quarantine";
  const quarantinedAt = "2026-09-10T02:00:00.000Z";
  const quarantined = await persistCanonicalSource(
    database, ashbySource, observedIds.map(ashbyJob), quarantinedAt, quarantineRunId
  );
  assert.equal(quarantined.status, "quarantined");
  assert.equal(quarantined.quarantineReason, "mass_deletion_guard");
  assert.equal(quarantined.observed, observedIds.length);
  assert.equal(quarantined.verified, 0);
  assert.equal(quarantined.opened, 0);
  assert.equal(quarantined.closed, 0);
  assert.equal(quarantined.snapshotId, `${quarantineRunId}:${ashbySource.id}`);

  const snapshot = (await selectSnapshots(database)).results.find(
    (row) => row.runId === quarantineRunId
  );
  assert.ok(snapshot);
  assert.deepEqual({
    sourceId: snapshot.sourceId,
    provider: snapshot.provider,
    status: snapshot.status,
    existingOpenCount: snapshot.existingOpenCount,
    observedOpenCount: snapshot.observedOpenCount,
    missingCount: snapshot.missingCount,
    missingRatioBps: snapshot.missingRatioBps,
    quarantineReason: snapshot.quarantineReason,
    boardId: snapshot.boardId,
  }, {
    sourceId: ashbySource.id,
    provider: "ashby",
    status: "quarantined",
    existingOpenCount: 24,
    observedOpenCount: 15,
    missingCount: 14,
    missingRatioBps: 5833,
    quarantineReason: "mass_deletion_guard",
    boardId: ashbySource.boardId,
  });
  // `observed_open_count` is the raw observed-set size (the documented override
  // in planCanonicalClosures), never the overlap with the prior identity set.
  assert.notEqual(snapshot.observedOpenCount, retainedIds.length);
  assert.match(snapshot.fingerprint, /^fnv1a32:[0-9a-f]{8}:15$/);

  // Exact membership: observed payload, disappeared identities, and the full
  // previously open identity set are each recorded verbatim.
  const members = (await database.prepare(`SELECT kind, external_id AS externalId
    FROM canonical_snapshot_members WHERE snapshot_id=? ORDER BY kind, external_id`)
    .bind(snapshot.id).all<{ kind: string; externalId: string }>()).results;
  const expectedMembers = [
    ...existingIds.map((externalId) => ({ kind: "existing", externalId })),
    ...missingIds.map((externalId) => ({ kind: "missing", externalId })),
    ...observedIds.map((externalId) => ({ kind: "observed", externalId })),
  ].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.externalId.localeCompare(right.externalId)
  );
  assert.deepEqual(members, expectedMembers);

  // Never deletes and never closes: every seeded job is still open, the omitted
  // ones included, and no payload-only identity was opened behind the guard.
  const jobState = await database.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN status='verified_open' THEN 1 ELSE 0 END) AS openCount,
    SUM(CASE WHEN status='verified_closed' THEN 1 ELSE 0 END) AS closedCount,
    SUM(CASE WHEN closed_at IS NOT NULL THEN 1 ELSE 0 END) AS closedAtCount,
    SUM(CASE WHEN external_id LIKE 'fresh-%' THEN 1 ELSE 0 END) AS freshCount
    FROM jobs WHERE provider='ashby'`).first<{
      total: number;
      openCount: number;
      closedCount: number;
      closedAtCount: number;
      freshCount: number;
    }>();
  assert.deepEqual(jobState, {
    total: 24,
    openCount: 24,
    closedCount: 0,
    closedAtCount: 0,
    freshCount: 0,
  });
  const observations = (await selectObservations(database, "ashby")).results;
  assert.equal(observations.length, 24);
  assert.ok(observations.every((row) => row.status === "verified_open" && row.closedAt === null));
  assert.equal(await countChanges(database, "job_opened"), 24);
  assert.equal(await countChanges(database, "job_closed"), 0);
  const quarantinedClosures = await database.prepare(`SELECT COUNT(*) AS count FROM changes
    WHERE change_type='job_closed' AND description LIKE '%ashby%'`)
    .first<{ count: number }>();
  assert.equal(Number(quarantinedClosures?.count), 0);

  const source = await selectSource(database, ashbySource.id);
  assert.deepEqual({
    discoveryStatus: source?.discoveryStatus,
    quarantineSnapshotId: source?.quarantineSnapshotId,
    lastAttemptedAt: source?.lastAttemptedAt,
    lastSuccessfulAt: source?.lastSuccessfulAt,
    consecutiveFailures: source?.consecutiveFailures,
    lastError: source?.lastError,
  }, {
    discoveryStatus: "quarantined",
    quarantineSnapshotId: snapshot.id,
    lastAttemptedAt: quarantinedAt,
    lastSuccessfulAt: seededAt,
    consecutiveFailures: 1,
    lastError: "mass_deletion_guard: 14 of 24 previously open jobs disappeared",
  });

  // Boundary: the ratio test is strict. Exactly 20 existing open with exactly
  // 10 missing is precisely 50%, so it is accepted and closes normally — the
  // guard needs all three conditions, and the ratio must exceed 0.5.
  assert.equal(assessCanonicalSnapshot(20, 10).status, "accepted");
  assert.equal(assessCanonicalSnapshot(24, 10).status, "quarantined");
  assert.equal(assessCanonicalSnapshot(20, 12).status, "accepted");
  assert.deepEqual(MASS_DELETION_GUARD, {
    minimumExistingOpen: 20,
    minimumMissing: 10,
    maximumAcceptedMissingRatio: 0.5,
  });

  await insertCompanySource(
    database, boundarySource, "https://apply.workable.com/lifecycle-boundary/"
  );
  const boundaryIds = Array.from(
    { length: 20 },
    (_, index) => `boundary-${String(index).padStart(2, "0")}`
  );
  const boundarySeed = await persistCanonicalSource(
    database, boundarySource, boundaryIds.map(boundaryJob), "2026-09-11T00:00:00.000Z",
    "lifecycle-boundary-seed"
  );
  assert.equal(boundarySeed.opened, 20);

  const boundaryAt = "2026-09-11T02:00:00.000Z";
  const boundary = await persistCanonicalSource(
    database, boundarySource, boundaryIds.slice(0, 10).map(boundaryJob), boundaryAt,
    "lifecycle-boundary-half"
  );
  assert.equal(boundary.status, "success");
  assert.equal(boundary.opened, 0);
  assert.equal(boundary.closed, 10);
  const boundarySnapshot = (await selectSnapshots(database)).results.find(
    (row) => row.runId === "lifecycle-boundary-half"
  );
  assert.deepEqual({
    status: boundarySnapshot?.status,
    existingOpenCount: boundarySnapshot?.existingOpenCount,
    observedOpenCount: boundarySnapshot?.observedOpenCount,
    missingCount: boundarySnapshot?.missingCount,
    missingRatioBps: boundarySnapshot?.missingRatioBps,
    quarantineReason: boundarySnapshot?.quarantineReason,
  }, {
    status: "accepted",
    existingOpenCount: 20,
    observedOpenCount: 10,
    missingCount: 10,
    missingRatioBps: 5000,
    quarantineReason: null,
  });
  const boundaryClosures = await database.prepare(`SELECT COUNT(*) AS count FROM changes
    WHERE change_type='job_closed' AND description LIKE '%workable%'`)
    .first<{ count: number }>();
  assert.equal(Number(boundaryClosures?.count), 10);
  const boundarySourceState = await selectSource(database, boundarySource.id);
  assert.deepEqual({
    discoveryStatus: boundarySourceState?.discoveryStatus,
    lastSuccessfulAt: boundarySourceState?.lastSuccessfulAt,
    consecutiveFailures: boundarySourceState?.consecutiveFailures,
  }, {
    discoveryStatus: "active",
    lastSuccessfulAt: boundaryAt,
    consecutiveFailures: 0,
  });
});
