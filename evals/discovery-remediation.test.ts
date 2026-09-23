import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  COHORT_MANIFEST_PATH,
  parseCohortManifest,
  type CohortManifestRow,
} from "../lib/cohort-manifest";
import { cohortEvidenceSourceId } from "../lib/cohort-manifest-import";
import {
  discoveryRetryAt,
  discoveryRunnableSql,
  isTransientDiscoveryError,
} from "../lib/discovery-policy";
import { DISCOVERY_PIPELINE_VERSION } from "../lib/discovery-version";

/**
 * Characterization pins for the user-approved discovery remediation
 * (2026-09-23, `AGENTS.md` "User-approved remediation"). The remediation
 * changes exactly two behaviors:
 *
 *   1. the Workers platform subrequest ceiling ("Too many subrequests by
 *      single Worker invocation") becomes deferrable instead of terminal, and
 *   2. personio/recruitee board ids are derived from the careers URL hostname
 *      instead of its path.
 *
 * Everything else about the error map and the source-id derivation must stay
 * byte-unchanged. These characterization tests were written first and started
 * green against the pre-remediation code; the remediation's own tests live in
 * the same file and started red against that same code.
 */

const root = process.cwd();
const read = (file: string) => readFile(path.join(root, file), "utf8");

type ErrorCase = { name: string; error: unknown; transient: boolean };

test("discovery error map classifies exactly the documented transient set", () => {
  // The map the per-candidate catch sites consult (`lib/discovery.ts` binds the
  // queue status to this verdict: transient -> `discovered` + `next_attempt_at`,
  // otherwise the terminal `needs_review` stamp). Pinned case by case so the
  // subrequest-ceiling reclassification cannot silently move any other error.
  const cases: ErrorCase[] = [
    { name: "TypeError", error: new TypeError("fetch failed"), transient: true },
    { name: "AbortError", error: { name: "AbortError", message: "aborted" }, transient: true },
    { name: "TimeoutError", error: { name: "TimeoutError" }, transient: true },
    { name: "status 408", error: { status: 408 }, transient: true },
    { name: "status 425", error: { status: 425 }, transient: true },
    { name: "status 429", error: { status: 429 }, transient: true },
    { name: "status 500", error: { status: 500 }, transient: true },
    { name: "status 503", error: { status: 503 }, transient: true },
    { name: "timeout message", error: new Error("request timeout"), transient: true },
    { name: "network message", error: new Error("network failure"), transient: true },
    {
      name: "robots message (transient here; the call site refuses it as blocked first)",
      error: new Error("robots_policy_disallows_all_website_probes"),
      transient: true,
    },
    { name: "status 400", error: { status: 400 }, transient: false },
    { name: "status 403", error: { status: 403 }, transient: false },
    { name: "status 404 (no board)", error: { status: 404 }, transient: false },
    { name: "canonical board not detected", error: new Error("canonical_ats_not_detected"), transient: false },
    { name: "ambiguous boards", error: new Error("multiple_canonical_ats_candidates"), transient: false },
    { name: "unsupported career system", error: new Error("unsupported_external_career_system"), transient: false },
    { name: "no US-eligible openings", error: new Error("no_verified_us_open_jobs"), transient: false },
    { name: "null", error: null, transient: false },
    { name: "undefined", error: undefined, transient: false },
    { name: "string", error: "boom", transient: false },
    { name: "number", error: 42, transient: false },
  ];
  for (const item of cases) {
    assert.equal(
      isTransientDiscoveryError(item.error),
      item.transient,
      `${item.name} must classify as ${item.transient ? "transient" : "terminal"}`
    );
  }
});

test("cohort evidence source ids keep their path-derived form for the path-keyed families", async () => {
  const text = await readFile(path.join(root, COHORT_MANIFEST_PATH), "utf8");
  const { rows, issues } = parseCohortManifest(text);
  assert.deepEqual(issues, []);
  const byDomain = new Map(rows.map((row) => [row.domain, row]));

  // Real shipped manifest rows, one per family whose board slug lives in the
  // URL path. The remediation must not touch these.
  const pins: Array<[string, string]> = [
    ["deepgram.com", "curated:deepgram"],
    ["fivetran.com", "curated:fivetran"],
    ["handoff.ai", "curated:handoff"],
    ["hokali.com", "curated:hokali"],
    ["continental.com", "curated:continental"],
    // The structured family's careers URL is the employer's own site, so the
    // path (or its absence) is not a board id either way — unchanged here, and
    // deliberately left alone by the remediation.
    ["insforge.dev", "curated:insforge.dev"],
    ["mozilla.org", "curated:listings"],
  ];
  for (const [domain, expected] of pins) {
    const row = byDomain.get(domain);
    assert.ok(row, `${domain} must exist in the manifest`);
    assert.equal(cohortEvidenceSourceId(row), expected, `${domain} derivation is unchanged`);
  }

  // Enumerated (staged) rows cite the Wikidata entity that named the employer.
  const staged = rows.filter((row) => row.access_mode !== "public_page");
  assert.ok(staged.length > 0);
  for (const row of staged) {
    assert.match(cohortEvidenceSourceId(row), /^wikidata:Q\d+$/);
  }

  // Fallbacks: no board path -> the registrable domain; unparsable URL -> the
  // row's domain. Both are pre-existing behavior.
  const base: CohortManifestRow = {
    name: "Example Health",
    website_url: "https://examplehealth.example",
    domain: "examplehealth.example",
    sector: "Healthcare",
    ats_hint: "structured",
    careers_url: null,
    access_mode: "public_page",
    terms_url: "https://examplehealth.example/terms",
    evidence_url: "https://examplehealth.example",
    notes: "general:v1 POC seed; probe receipt evidence/cohorts/probes/example.json",
  };
  assert.equal(cohortEvidenceSourceId(base), "curated:examplehealth.example");
  assert.equal(
    cohortEvidenceSourceId({ ...base, careers_url: "not a url", evidence_url: "not a url" }),
    "curated:examplehealth.example"
  );
  assert.equal(
    cohortEvidenceSourceId({ ...base, careers_url: "https://examplehealth.example/careers" }),
    "curated:careers"
  );
});

// ---------------------------------------------------------------------------
// Remediation 1 — the Workers platform subrequest ceiling is deferrable
// ---------------------------------------------------------------------------

const QUEUE_TABLE = `CREATE TABLE discovery_queue (
  id TEXT PRIMARY KEY, normalized_domain TEXT NOT NULL UNIQUE,
  company_name TEXT, website_url TEXT, status TEXT NOT NULL,
  first_discovered_at TEXT NOT NULL, review_notes TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0, discovery_version TEXT,
  next_attempt_at TEXT, last_attempted_at TEXT, last_outcome TEXT
)`;

const EVIDENCE_TABLE = `CREATE TABLE startup_domain_evidence (
  canonical_domain TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
  source_classification TEXT NOT NULL, evidence_url TEXT NOT NULL,
  permission_status TEXT NOT NULL, source_terms_url TEXT, observed_at TEXT NOT NULL,
  observed_website_urls_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(canonical_domain, source_kind, source_id, evidence_url)
)`;

const REVIEWS_TABLE = `CREATE TABLE discovery_candidate_reviews (
  candidate_id TEXT NOT NULL, status TEXT NOT NULL
)`;

async function withDatabase(name: string) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: name },
  });
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  return { miniflare, database };
}

const CEILING_ERROR_MESSAGE = "Too many subrequests by single Worker invocation. " +
  "To configure this limit, refer to " +
  "https://developers.cloudflare.com/workers/wrangler/configuration/#limits";

/**
 * The exact string the 41 burned candidates carry on the experimental deploy
 * (read-only `SELECT discovery_version, status, last_outcome, COUNT(*) FROM
 * discovery_queue GROUP BY …`, 2026-09-23: 8 `active`/activated + 40
 * `needs_review`/probe_failed + 1 `needs_review`/canonical_fetch_failed, all at
 * this version). The bump in this change is what makes those stamps stale, so
 * the pipeline's own runnable predicate re-queues them — no D1 data surgery.
 */
const LEGACY_PIPELINE_VERSION =
  "ats-detection-1.1:ats-adapter-1.0:canonical-probe-1.1:ats-slug-probe-1.1:structured-adapter-1.0";

async function permittedEvidence(database: D1Database, domain: string, observedAt: string) {
  await database.prepare(`INSERT INTO startup_domain_evidence (canonical_domain,
    source_kind, source_id, source_classification, evidence_url, permission_status,
    source_terms_url, observed_at) VALUES (?, 'curated_cohort', ?, 'general_v1_poc',
    ?, 'permitted', ?, ?)`).bind(
    domain,
    `curated:${domain.split(".")[0]}`,
    `https://${domain}/careers`,
    `https://${domain}/terms`,
    observedAt
  ).run();
}

test("the platform subrequest ceiling defers the candidate instead of stamping needs_review", async (t) => {
  const ceiling = new Error(CEILING_ERROR_MESSAGE);
  assert.equal(
    isTransientDiscoveryError(ceiling),
    true,
    "a per-invocation capacity limit is not a verdict about the employer"
  );

  const { miniflare, database } = await withDatabase("discovery-ceiling-deferral");
  t.after(() => miniflare.dispose());
  await database.prepare(QUEUE_TABLE).run();
  await database.prepare(EVIDENCE_TABLE).run();
  await database.prepare(REVIEWS_TABLE).run();

  const attemptedAt = "2026-09-23T12:00:00.000Z";
  // `lib/discovery.ts` imports `cloudflare:workers`, so it cannot be imported
  // from node:test (documented, pre-existing). This settles a queue row exactly
  // as the per-candidate catch does — classify, then stamp — and the source
  // pins below hold the real catch sites to the same binding.
  const settle = async (id: string, domain: string, error: unknown) => {
    const retryable = isTransientDiscoveryError(error);
    const status = retryable ? "discovered" : "needs_review";
    const nextAttemptAt = retryable ? discoveryRetryAt(attemptedAt, 1) : null;
    await database.prepare(`INSERT INTO discovery_queue (id, normalized_domain,
      status, first_discovered_at, attempt_count, discovery_version, next_attempt_at,
      last_outcome) VALUES (?, ?, ?, ?, 1, ?, ?, 'probe_failed')`).bind(
      id, domain, status, attemptedAt, DISCOVERY_PIPELINE_VERSION, nextAttemptAt
    ).run();
    await permittedEvidence(database, domain, attemptedAt);
    return { status, nextAttemptAt };
  };

  const ceilingRow = await settle("candidate_ceiling", "ceiling.example", ceiling);
  const badDataRow = await settle(
    "candidate_bad_data",
    "bad-data.example",
    new Error("unsupported_external_career_system")
  );

  assert.equal(ceilingRow.status, "discovered", "the ceiling attempt returns to a re-runnable state");
  assert.equal(ceilingRow.nextAttemptAt, "2026-09-23T18:00:00.000Z", "retry deferred with backoff");
  assert.equal(badDataRow.status, "needs_review", "genuine bad-data errors stay terminal");
  assert.equal(badDataRow.nextAttemptAt, null);

  const reviews = await database.prepare(
    `SELECT id FROM discovery_queue WHERE status='needs_review' ORDER BY id`
  ).all<{ id: string }>();
  assert.deepEqual(reviews.results.map((row) => row.id), ["candidate_bad_data"]);

  const runnable = async (now: string) => (await database.prepare(`SELECT q.id
    FROM discovery_queue q WHERE ${discoveryRunnableSql("q")} ORDER BY q.id`).bind(
      DISCOVERY_PIPELINE_VERSION,
      "2026-09-23T11:00:00.000Z",
      now
    ).all<{ id: string }>()).results.map((row) => row.id);
  assert.deepEqual(await runnable("2026-09-23T13:00:00.000Z"), [], "the backoff holds the retry");
  assert.deepEqual(
    await runnable("2026-09-23T18:00:00.000Z"),
    ["candidate_ceiling"],
    "once the backoff elapses the deferred candidate is runnable again"
  );

  // Both per-candidate catch sites bind the queue status to this classifier.
  const discovery = await read("lib/discovery.ts");
  assert.equal((discovery.match(/isTransientDiscoveryError\(error\)/g) || []).length, 2);
  assert.equal((discovery.match(/retryable \? "discovered" : "needs_review"/g) || []).length, 2);
  assert.match(discovery, /candidates_deferred/);
  assert.match(await read("lib/discovery-policy.ts"), /SUBREQUEST_CEILING/);
});

test("the pipeline version bump re-queues rows stamped at the older pipeline version", async (t) => {
  assert.notEqual(
    DISCOVERY_PIPELINE_VERSION,
    LEGACY_PIPELINE_VERSION,
    "the ceiling reclassification is a real pipeline behavior change, so the version must move"
  );
  assert.match(
    DISCOVERY_PIPELINE_VERSION,
    /^ats-detection-[\d.]+:ats-adapter-[\d.]+:canonical-probe-[\d.]+:ats-slug-probe-[\d.]+:structured-adapter-[\d.]+:error-classification-\d+$/
  );

  const { miniflare, database } = await withDatabase("discovery-version-recheck");
  t.after(() => miniflare.dispose());
  await database.prepare(QUEUE_TABLE).run();
  await database.prepare(EVIDENCE_TABLE).run();
  await database.prepare(REVIEWS_TABLE).run();

  const burnedAt = "2026-09-23T11:20:00.000Z";
  const rows = [
    ["burned", "burned.example", "needs_review", LEGACY_PIPELINE_VERSION],
    ["fresh", "fresh.example", "needs_review", DISCOVERY_PIPELINE_VERSION],
    ["active", "active.example", "active", LEGACY_PIPELINE_VERSION],
  ] as const;
  for (const [id, domain, status, version] of rows) {
    await database.prepare(`INSERT INTO discovery_queue (id, normalized_domain,
      status, first_discovered_at, attempt_count, discovery_version, last_outcome)
      VALUES (?, ?, ?, ?, 1, ?, 'probe_failed')`).bind(
      id, domain, status, burnedAt, version
    ).run();
    await permittedEvidence(database, domain, burnedAt);
  }

  const runnable = await database.prepare(`SELECT q.id FROM discovery_queue q
    WHERE ${discoveryRunnableSql("q")} ORDER BY q.id`).bind(
      DISCOVERY_PIPELINE_VERSION,
      "2026-09-23T13:00:00.000Z",
      "2026-09-23T14:00:00.000Z"
    ).all<{ id: string }>();
  assert.deepEqual(
    runnable.results.map((row) => row.id),
    ["burned"],
    "only the row stamped at an older pipeline version re-queues; a fresh terminal stamp does not"
  );
});
