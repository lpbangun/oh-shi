import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file: string) => readFile(path.join(root, file), "utf8");

const publicRoutes = [
  "app/api/v1/companies/route.ts",
  "app/api/v1/jobs/route.ts",
  "app/api/v1/changes/route.ts",
  "app/api/v1/intelligence/route.ts",
  "app/api/v1/coverage/route.ts",
  "app/api/v1/signals/route.ts",
  "app/api/v1/off-board-openings/route.ts",
  "app/exports/companies.jsonl/route.ts",
  "app/exports/jobs.jsonl/route.ts",
  "app/exports/daily-changes.json/route.ts",
  "app/llms.txt/route.ts",
];

test("public agent routes are GET-only and do not require auth", async () => {
  for (const route of publicRoutes) {
    const source = await read(route);
    assert.match(source, /export async function GET|export function GET/);
    assert.doesNotMatch(source, /authorization|INGEST_TOKEN/i);
  }
});

test("agent discovery files advertise every stable public surface", async () => {
  const [llms, policyText] = await Promise.all([
    read("app/llms.txt/route.ts"),
    read("public/agent-policy.json"),
  ]);
  for (const endpoint of [
    "/api/v1/companies",
    "/api/v1/jobs",
    "/api/v1/changes",
    "/api/v1/intelligence",
    "/api/v1/coverage",
    "/api/v1/signals",
    "/api/v1/off-board-openings",
    "/exports/companies.jsonl",
    "/exports/jobs.jsonl",
    "/exports/daily-changes.json",
  ]) {
    assert.ok(llms.includes(endpoint), `llms.txt must advertise ${endpoint}`);
  }
  const policy = JSON.parse(policyText);
  assert.equal(policy.access, "public");
  assert.equal(policy.authentication, "none for read endpoints");
  assert.equal(policy.preferred_entrypoint, "/api/v1/intelligence");
  assert.equal(policy.instructions, "/llms.txt");
  assert.equal(policy.capabilities.jobs, "/api/v1/intelligence?view=jobs");
  assert.equal(policy.capabilities.companies, "/api/v1/intelligence?view=companies");
  assert.equal(policy.capabilities.movements, "/api/v1/intelligence?view=movements");
  assert.equal(policy.capabilities.sectors, "/api/v1/intelligence?view=sectors");
  assert.equal(policy.capabilities.signals, "/api/v1/signals");
  assert.equal(
    policy.capabilities.off_board_openings,
    "/api/v1/off-board-openings"
  );
});

test("agent instructions use the actual public field casing and query recipes", async () => {
  const llms = await read("app/llms.txt/route.ts");
  assert.ok(llms.includes("canonicalUrl"));
  assert.ok(llms.includes("evidenceUrl"));
  assert.ok(llms.includes("linkedInPresenceState"));
  assert.match(llms, /not_observed is not a claim/);
  assert.doesNotMatch(llms, /canonical_url/);
  for (const view of ["jobs", "companies", "movements", "sectors"]) {
    assert.ok(llms.includes(`view=${view}`), `llms.txt must document the ${view} view`);
  }
  assert.match(llms, /next_cursor/);
  assert.match(llms, /HTTP 400/);
  assert.match(llms, /sector=Healthcare&min_confidence=80/);
  assert.doesNotMatch(llms, /sector=Health&/);
});

test("API envelopes remain versioned, incremental, and licensed", async () => {
  const dataSource = await read("lib/data.ts");
  for (const field of [
    "schema_version",
    "generated_at",
    "cursor",
    "license",
    "data",
  ]) {
    assert.ok(dataSource.includes(field), `API envelope must contain ${field}`);
  }
  assert.match(dataSource, /schema_version:\s*"1\.0"/);
  assert.match(dataSource, /new Date\(\)\.toISOString\(\)/);
});

test("public capability surfaces report live availability and support conditional requests", async () => {
  const [coverage, intelligence, signals, offBoard, llms, policyText, worker] = await Promise.all([
    read("app/api/v1/coverage/route.ts"),
    read("app/api/v1/intelligence/route.ts"),
    read("app/api/v1/signals/route.ts"),
    read("app/api/v1/off-board-openings/route.ts"),
    read("app/llms.txt/route.ts"),
    read("public/agent-policy.json"),
    read("worker/index.ts"),
  ]);
  assert.match(coverage, /conditionalJsonResponse/);
  assert.match(intelligence, /coverage\.capabilityAvailability/);
  assert.match(signals, /status: signals\.length > 0 \? "available" : "dormant"/);
  assert.match(offBoard, /status: openings\.length > 0 \? "available" : "dormant"/);
  assert.match(llms, /If-None-Match/);
  assert.match(llms, /bounded to 100 records/);
  const policy = JSON.parse(policyText);
  assert.match(policy.capability_status, /capabilityAvailability/);
  assert.match(policy.conditional_requests, /ETag/);
  assert.match(worker, /request\.method === "OPTIONS" && isPublicAgentRoute/);
  assert.match(worker, /"Access-Control-Allow-Headers": "Cache-Control, If-None-Match"/);
  assert.match(worker, /headers\.set\("Access-Control-Allow-Origin", "\*"\)/);
});

test("discovery backlog exposes actionable stages and rechecks stale detector results", async () => {
  const [data, discovery, policy, schema, migration, retryMigration] = await Promise.all([
    read("lib/data.ts"),
    read("lib/discovery.ts"),
    read("lib/discovery-policy.ts"),
    read("db/schema.ts"),
    read("drizzle/0012_discovery_probe_version.sql"),
    read("drizzle/0013_discovery_retry_outcomes.sql"),
  ]);
  assert.match(data, /eligibleNeverQueued/);
  assert.match(data, /eligibleForPromotion/);
  assert.match(data, /permissionExcluded/);
  assert.match(data, /staleNeedsReview/);
  assert.match(data, /needsReviewReasons/);
  assert.match(data, /outcomeCounts/);
  assert.match(policy, /status='needs_review'[\s\S]*discovery_version/);
  assert.match(policy, /permission_status='permitted'/);
  assert.match(discovery, /discoveryRetryAt/);
  assert.match(discovery, /DEFAULT_PROCESS_LIMIT = 10/);
  assert.match(schema, /discoveryVersion: text\("discovery_version"\)/);
  assert.match(schema, /nextAttemptAt: text\("next_attempt_at"\)/);
  assert.match(migration, /ALTER TABLE discovery_queue ADD COLUMN discovery_version TEXT/);
  assert.match(retryMigration, /ALTER TABLE discovery_queue ADD COLUMN last_outcome TEXT/);
});

test("canonical refresh is protected", async () => {
  const source = await read("app/api/internal/refresh/route.ts");
  assert.match(source, /export function GET/);
  assert.match(source, /export async function POST/);
  assert.match(source, /authorization/i);
  assert.match(source, /INGEST_TOKEN/);
  assert.match(source, /status:\s*401/);
  assert.match(source, /idempotency-key/i);
  assert.match(source, /phase !== "discovery" && phase !== "canonical"/);
  assert.match(source, /phase === "discovery"/);
  assert.match(source, /phaseRefreshRunKey/);
  assert.match(source, /executeRefreshOnce/);
});

test("daily funding discovery is protected, idempotent, and scheduled", async () => {
  const [route, workflow, board] = await Promise.all([
    read("app/api/internal/funding/refresh/route.ts"),
    read(".github/workflows/daily-funding-discovery.yml"),
    read("app/components/JobBoard.tsx"),
  ]);
  assert.match(route, /export async function POST/);
  assert.match(route, /authorization/i);
  assert.match(route, /INGEST_TOKEN/);
  assert.match(route, /idempotency-key/i);
  assert.match(route, /executeRefreshOnce/);
  assert.match(route, /persistFundingDiscoveries/);
  assert.match(workflow, /cron:\s*["']20 11 \* \* \*["']/);
  assert.match(workflow, /run-funding-discovery\.mjs/);
  assert.match(board, /movement\.type === "funding"/);
  assert.match(board, /movement-source/);
});

test("manual discovery import is protected by the ingestion credential", async () => {
  const source = await read("app/api/internal/discovery/import/route.ts");
  assert.match(source, /export async function POST/);
  assert.match(source, /authorization/i);
  assert.match(source, /INGEST_TOKEN/);
  assert.match(source, /status:\s*401/);
});

test("candidate review staging is protected and approval is fingerprint-bound", async () => {
  const [route, review] = await Promise.all([
    read("app/api/internal/discovery/reviews/route.ts"),
    read("lib/discovery-review.ts"),
  ]);
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.match(route, /authorization/i);
  assert.match(route, /INGEST_TOKEN/);
  assert.match(route, /status:\s*401/);
  assert.match(route, /stage:\$\{batchId\}:\$\{requestedCount\}/);
  assert.match(route, /action === "approve"/);
  assert.match(route, /\$\{action\}:\$\{batchId\}/);
  assert.match(review, /publication:\s*"none"/);
  assert.match(review, /expectedFingerprints/);
  assert.match(review, /canonical_board_changed_since_review/);
  assert.match(review, /sourceEnabled:\s*false/);
});

test("canonical quarantine review is protected and explicit", async () => {
  const [route, review] = await Promise.all([
    read("app/api/internal/canonical/snapshots/route.ts"),
    read("lib/canonical-snapshot-review.ts"),
  ]);
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.match(route, /authorization/i);
  assert.match(route, /INGEST_TOKEN/);
  assert.match(route, /status:\s*401/);
  assert.match(route, /idempotency-key/i);
  assert.match(route, /apply:\$\{snapshotId\}:\$\{expectedFingerprint\}/);
  assert.match(review, /retryCanonicalFetch/);
  assert.match(review, /exact_membership_unavailable/);
  assert.match(review, /application_statement|applicationStatementIndex/i);
});

test("startup-domain pilot import is protected and cannot activate records", async () => {
  const source = await read("app/api/internal/discovery/domains/route.ts");
  assert.match(source, /export async function POST/);
  assert.match(source, /authorization/i);
  assert.match(source, /INGEST_TOKEN/);
  assert.match(source, /status:\s*401/);
  assert.match(source, /persistStartupDomainPilot/);
  assert.match(source, /activation:\s*"none"/);
  assert.match(source, /activityState:\s*"unknown"/);
  assert.match(source, /reviewStatus:\s*"pending"/);
  assert.doesNotMatch(source, /INSERT INTO (?:companies|jobs)/);
});

test("hiring-signal import is protected and explicitly cannot mutate jobs", async () => {
  const [route, store, canonicalStore] = await Promise.all([
    read("app/api/internal/signals/import/route.ts"),
    read("lib/signal-store.ts"),
    read("lib/canonical-refresh-store.ts"),
  ]);
  assert.match(route, /export async function POST/);
  assert.match(route, /authorization/i);
  assert.match(route, /INGEST_TOKEN/);
  assert.match(route, /status:\s*401/);
  assert.match(route, /jobs_mutated:\s*0/);
  assert.doesNotMatch(store, /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+jobs\b/i);
  assert.doesNotMatch(canonicalStore, /hiring_signals/i);
});

test("signal promotion is protected and requires canonical re-verification", async () => {
  const [route, promotion, publicRoute] = await Promise.all([
    read("app/api/internal/signals/promote/route.ts"),
    read("lib/signal-promotion.ts"),
    read("app/api/v1/off-board-openings/route.ts"),
  ]);
  assert.match(route, /export async function POST/);
  assert.match(route, /authorization/i);
  assert.match(route, /INGEST_TOKEN/);
  assert.match(route, /status:\s*401/);
  assert.match(promotion, /findExactPromotionJob/);
  assert.match(promotion, /retryCanonicalFetch/);
  assert.match(promotion, /persistCanonicalSource/);
  assert.match(promotion, /status='active' AND expires_at > \?/);
  assert.match(publicRoute, /off_board_verified_opening/);
  assert.match(publicRoute, /listOffBoardVerifiedOpenings/);
});

test("off-board signals remain distinct public API surfaces without an empty homepage section", async () => {
  const [route, board] = await Promise.all([
    read("app/api/v1/signals/route.ts"),
    read("app/components/JobBoard.tsx"),
  ]);
  assert.match(route, /hiring_signal_not_verified_opening/);
  assert.match(route, /listActiveHiringSignals/);
  assert.doesNotMatch(board, />Off the radar</);
  assert.doesNotMatch(board, /offBoardOpenings/);
});

test("all public job surfaces use the shared bounded server query", async () => {
  const [data, intelligence, board, dashboard, compatibility, search] = await Promise.all([
    read("lib/data.ts"),
    read("app/api/v1/intelligence/route.ts"),
    read("app/components/JobBoard.tsx"),
    read("app/api/v1/dashboard/jobs/route.ts"),
    read("app/api/v1/jobs/route.ts"),
    read("lib/job-search.ts"),
  ]);
  assert.match(data, /buildJobSearchSql/);
  assert.match(intelligence, /searchJobs\(query\)/);
  assert.match(dashboard, /searchJobs\(query\)/);
  assert.match(compatibility, /searchJobs\(query\)/);
  assert.match(search, /ROW_NUMBER\(\) OVER/);
  assert.match(search, /jobs\.id ASC/);
  assert.match(search, /natural\?\.filters\.status \|\| "verified_open"/);
  assert.match(search, /includeClosedRaw !== null/);
  assert.doesNotMatch(board, /const rows = jobs\.filter\(/);
  assert.match(board, /\/api\/v1\/dashboard\/jobs\?/);
});
