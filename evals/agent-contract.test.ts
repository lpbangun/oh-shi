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

test("canonical refresh is protected", async () => {
  const source = await read("app/api/internal/refresh/route.ts");
  assert.match(source, /export function GET/);
  assert.match(source, /export async function POST/);
  assert.match(source, /authorization/i);
  assert.match(source, /INGEST_TOKEN/);
  assert.match(source, /status:\s*401/);
  assert.match(source, /idempotency-key/i);
  assert.match(source, /executeRefreshOnce/);
});

test("manual discovery import is protected by the ingestion credential", async () => {
  const source = await read("app/api/internal/discovery/import/route.ts");
  assert.match(source, /export async function POST/);
  assert.match(source, /authorization/i);
  assert.match(source, /INGEST_TOKEN/);
  assert.match(source, /status:\s*401/);
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

test("all default public job surfaces use the shared company-diverse order", async () => {
  const [data, intelligence, board] = await Promise.all([
    read("lib/data.ts"),
    read("app/api/v1/intelligence/route.ts"),
    read("app/components/JobBoard.tsx"),
  ]);
  assert.match(data, /includeClosed \? jobs : companyDiverseJobs\(jobs, companies\)/);
  assert.match(intelligence, /companyDiverseJobs\(/);
  assert.match(board, /companyDiverseJobs\(rows, companies\)/);
});
