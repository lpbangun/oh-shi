import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file: string) => readFile(path.join(root, file), "utf8");

test("starter artifacts and mojibake are absent", async () => {
  const files = [
    "app/layout.tsx",
    "app/components/JobBoard.tsx",
    "app/globals.css",
    "lib/seed.ts",
    "README.md",
    "package.json",
    "worker/index.ts",
  ];
  const forbidden = /vinext-starter|SkeletonPreview|react-loading-skeleton|â|Â|Ã/;
  for (const file of files) {
    assert.doesNotMatch(await read(file), forbidden, `${file} contains stale or corrupted copy`);
  }
  const previewDirectory = path.join(root, "app", "_sites-preview");
  const previewFiles = await readdir(previewDirectory).catch(() => []);
  assert.deepEqual(previewFiles, [], "starter preview directory must contain no artifacts");
});

test("social and legal assets are production-ready", async () => {
  const image = await readFile(path.join(root, "public", "og.png"));
  assert.equal(image.toString("hex", 0, 8), "89504e470d0a1a0a", "og.png must be a PNG");
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  assert.ok(width >= 1200 && height >= 600, `social card is too small: ${width}x${height}`);
  assert.ok(width / height > 1.8 && width / height < 2, "social card must be landscape");
  const layout = await read("app/layout.tsx");
  assert.ok(layout.includes("/og.png"));
  await Promise.all([
    access(path.join(root, "LICENSE")),
    access(path.join(root, "DATA-LICENSE.md")),
  ]);
});

test("Sites configuration is bound to the public project and D1", async () => {
  const hosting = JSON.parse(await read(".openai/hosting.json"));
  assert.match(hosting.project_id, /^appgprj_[a-f0-9]+$/);
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, null);
});

test("homepage cold starts avoid write storms and defer the full job index", async () => {
  const data = await read("lib/data.ts");
  const homepage = await read("app/page.tsx");
  const worker = await read("worker/index.ts");

  assert.match(data, /EXISTS\(SELECT 1 FROM companies LIMIT 1\) as hasCompanies/);
  assert.match(data, /EXISTS\(SELECT fingerprint FROM discovery_candidate_reviews LIMIT 0\)/);
  assert.match(data, /isMissingDatabaseSchema/);
  assert.match(data, /initialization \?\?= prepareDatabase\(\)/);
  assert.match(data, /getHomepageData/);
  assert.match(homepage, /getHomepageData\(\)/);
  assert.doesNotMatch(homepage, /listJobs\(true\)/);
  assert.match(data, /const dashboardJobColumns/);
  assert.match(data, /export async function listDashboardJobs/);
  assert.match(data, /listDashboardJobs\(100\)/);
  assert.match(data, /listMovementJobs\(since\)/);
  assert.match(data, /listHomepageChanges\(since\)/);
  assert.match(data, /getHomepageCoverageMetrics\(now\)/);
  assert.match(homepage, /jobs\.slice\(0, HOMEPAGE_JOB_LIMIT\)/);
  assert.match(homepage, /changes\.slice\(0, HOMEPAGE_CHANGE_LIMIT\)/);
  assert.match(homepage, /movements\.slice\(0, HOMEPAGE_MOVEMENT_LIMIT\)/);
  assert.doesNotMatch(worker, /caches\.default/);
  assert.match(worker, /max-age=0, s-maxage=300/);
  assert.match(worker, /request\.headers\.get\("rsc"\) !== "1"/);
});

test("quality script enforces the intended gate order", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.equal(
    pkg.scripts.quality,
    "pnpm run typecheck && pnpm run eval && pnpm run build"
  );
  assert.ok(pkg.scripts.eval);
  assert.ok(pkg.scripts["eval:live"]);
  assert.match(pkg.scripts.eval, /scripts\/run-evals\.mjs/);
  assert.match(pkg.scripts["eval:live"], /scripts\/run-evals\.mjs/);
});

test("CI enforces frozen quality and browser gates on pushes and pull requests", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const workflow = await read(".github/workflows/ci.yml");

  assert.equal(pkg.dependencies.next, "16.2.12");
  assert.equal(pkg.devDependencies["eslint-config-next"], "16.2.12");
  assert.equal(pkg.packageManager, "pnpm@11.17.0");
  assert.ok(pkg.devDependencies["@playwright/test"]);
  assert.ok(pkg.devDependencies["@axe-core/playwright"]);
  for (const command of ["lint", "typecheck", "eval", "build", "e2e"]) {
    assert.match(pkg.scripts["quality:ci"], new RegExp(`pnpm run ${command}\\b`));
  }
  assert.match(workflow, /\n\s+push:/);
  assert.match(workflow, /\n\s+pull_request:/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  for (const command of ["lint", "typecheck", "eval", "build", "e2e"]) {
    assert.match(workflow, new RegExp(`pnpm run ${command}\\b`));
  }
});

test("two-hour discovery and refresh schedule proves reconciled source receipts and API freshness", async () => {
  const workflow = await read(".github/workflows/daily-refresh.yml");
  const refreshRunner = await read("scripts/run-canonical-refresh.mjs");
  const refreshClient = await read("lib/refresh-client.mjs");
  const homepage = await read("app/components/JobBoard.tsx");
  const ticker = await read("app/components/Ticker.tsx");
  const readme = await read("README.md");

  assert.match(workflow, /cron: "30 \*\/2 \* \* \*"/);
  assert.match(workflow, /OH_SHI_BASE_URL/);
  assert.match(workflow, /OH_SHI_INGEST_TOKEN/);
  assert.match(workflow, /id: directory_sync/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /steps\.directory_sync\.outcome == 'failure'/);
  assert.match(workflow, /node scripts\/run-canonical-refresh\.mjs/);
  assert.match(refreshRunner, /Preflight failed/);
  assert.match(refreshRunner, /refresh_run/);
  assert.match(refreshRunner, /lastVerifiedAt/);
  assert.match(refreshRunner, /source_counts/);
  assert.match(refreshClient, /Idempotency-Key/);
  assert.match(refreshRunner, /runVersionedRefresh/);
  assert.match(refreshRunner, /companiesAddedLast1Day/);
  assert.match(refreshRunner, /jobsAddedLast24Hours/);
  assert.match(refreshRunner, /Canonical source failure/);
  assert.match(refreshRunner, /Company growth warning/);
  assert.match(homepage, /verified every two hours/);
  assert.match(ticker, /setUTCHours\(next\.getUTCHours\(\) \+ 2\)/);
  assert.match(readme, /minute 30 every two hours/);
  assert.doesNotMatch(homepage, /once a day|verified every day/);
});

test("terminal review candidates cannot starve newly discovered queue work", async () => {
  const discovery = await read("lib/discovery.ts");
  const review = await read("lib/discovery-review.ts");
  assert.match(discovery, /q\.status IN \('discovered','canonical_source_found'\)/);
  assert.doesNotMatch(
    discovery,
    /q\.status IN \('discovered','needs_review','canonical_source_found'\)/
  );
  assert.match(discovery, /discovery_cursor as discoveryCursor/);
  assert.match(discovery, /discovery_candidate_reviews review/);
  assert.match(discovery, /review\.status NOT IN \('rejected','activated'\)/);
  assert.match(review, /activation: "none"/);
  assert.match(review, /publication: "none"/);
  assert.match(review, /canonical_board_changed_since_review/);
  assert.match(review, /snapshotFingerprint/);
});

test("manual candidate review workflow stages privately and requires exact approval", async () => {
  const workflow = await read(".github/workflows/daily-refresh.yml");
  const route = await read("app/api/internal/discovery/reviews/route.ts");
  const stageScript = await read("scripts/stage-discovery-review.mjs");
  const approvalScript = await read("scripts/approve-discovery-review.mjs");

  assert.match(workflow, /stage_review/);
  assert.match(workflow, /approve_review/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /OH_SHI_REVIEW_COUNT/);
  assert.match(route, /stage:\$\{batchId\}:\$\{requestedCount\}/);
  assert.match(route, /approve[\s\S]*batchId/);
  assert.match(route, /expectedFingerprints/);
  assert.match(stageScript, /requestedCount > 500/);
  assert.match(stageScript, /limit: 25/);
  assert.match(stageScript, /No companies or jobs were published/);
  assert.match(approvalScript, /candidateIds\.length > 25/);
  assert.match(approvalScript, /expectedFingerprints/);
});

test("runtime, migration, and Drizzle discovery schemas stay aligned", async () => {
  const [
    schema,
    runtime,
    migration,
    idempotencyMigration,
    registryMigration,
    snapshotMigration,
    provenanceMigration,
    observationMigration,
    promotionMigration,
    refreshRoute,
    canonicalRefresh,
    canonicalRefreshStore,
    snapshotReviewMigration,
    snapshotReview,
    snapshotReviewRoute,
    discoveryReviewMigration,
    discoveryReview,
    discoveryReviewRoute,
  ] = await Promise.all([
    read("db/schema.ts"),
    read("lib/data.ts"),
    read("drizzle/0001_discovery_pipeline.sql"),
    read("drizzle/0002_refresh_idempotency.sql"),
    read("drizzle/0003_startup_domain_registry.sql"),
    read("drizzle/0004_canonical_snapshot_guard.sql"),
    read("drizzle/0005_job_provenance.sql"),
    read("drizzle/0008_job_observations.sql"),
    read("drizzle/0009_hiring_signal_promotions.sql"),
    read("app/api/internal/refresh/route.ts"),
    read("lib/refresh.ts"),
    read("lib/canonical-refresh-store.ts"),
    read("drizzle/0010_canonical_snapshot_reviews.sql"),
    read("lib/canonical-snapshot-review.ts"),
    read("app/api/internal/canonical/snapshots/route.ts"),
    read("drizzle/0011_discovery_candidate_reviews.sql"),
    read("lib/discovery-review.ts"),
    read("app/api/internal/discovery/reviews/route.ts"),
  ]);
  for (const table of [
    "discovery_queue_investors",
    "ingestion_source_results",
  ]) {
    assert.ok(schema.includes(`sqliteTable("${table}"`), `Drizzle schema is missing ${table}`);
    assert.ok(runtime.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.ok(migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(schema, /company_sources_provider_board_unique/);
  assert.match(schema, /primaryKey\(\{ columns: \[table\.candidateId, table\.investorSourceId\] \}\)/);
  assert.match(schema, /discovery_queue_status_check/);
  assert.match(runtime, /status TEXT NOT NULL CHECK\(status IN/);
  assert.equal(
    (runtime.match(/WHERE s\.company_id=jobs\.company_id ORDER BY s\.id LIMIT 1/g) || []).length,
    2,
    "legacy provider and source id must select the same deterministic source row"
  );
  assert.match(refreshRoute, /attemptWithFallback/);
  assert.match(refreshRoute, /const canonical = await refreshCanonicalBoards\(\)/);
  assert.ok(schema.includes('sqliteTable("refresh_runs"'));
  assert.ok(runtime.includes("CREATE TABLE IF NOT EXISTS refresh_runs"));
  assert.ok(idempotencyMigration.includes("CREATE TABLE IF NOT EXISTS refresh_runs"));
  for (const table of [
    "startup_domains",
    "startup_domain_aliases",
    "startup_domain_acquisitions",
    "startup_domain_evidence",
    "startup_domain_imports",
    "startup_domain_cohorts",
  ]) {
    assert.ok(schema.includes(`sqliteTable("${table}"`), `Drizzle schema is missing ${table}`);
    assert.ok(runtime.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.ok(registryMigration.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(schema, /startup_domains_activity_state_check/);
  assert.match(schema, /startup_domain_aliases_relation_check/);
  assert.match(schema, /startup_domain_acquisitions_relation_check/);
  assert.match(runtime, /pilot_cohort/);
  assert.match(runtime, /career_fingerprint/);
  assert.match(runtime, /observed_website_urls_json/);
  assert.match(runtime, /alias_has_existing_owner/);
  assert.ok(schema.includes('sqliteTable("canonical_source_snapshots"'));
  assert.ok(runtime.includes("CREATE TABLE IF NOT EXISTS canonical_source_snapshots"));
  assert.ok(snapshotMigration.includes("CREATE TABLE IF NOT EXISTS canonical_source_snapshots"));
  assert.match(schema, /canonical_source_snapshots_status_check/);
  assert.match(canonicalRefresh, /persistCanonicalSource/);
  assert.match(canonicalRefreshStore, /planCanonicalClosures/);
  assert.match(canonicalRefreshStore, /status === "quarantined"/);
  assert.match(canonicalRefreshStore, /discovery_status='quarantined'/);
  assert.match(canonicalRefreshStore, /canonical_source_snapshots/);
  assert.match(canonicalRefreshStore, /last_successful_at=\?, last_error=NULL/);
  for (const table of [
    "canonical_snapshot_members",
    "canonical_snapshot_applications",
  ]) {
    assert.ok(schema.includes(`sqliteTable("${table}"`), `Drizzle schema is missing ${table}`);
    assert.ok(runtime.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.ok(snapshotReviewMigration.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(snapshotReviewMigration, /quarantine_snapshot_id/);
  assert.match(snapshotReviewMigration, /quarantine_application_id/);
  assert.match(snapshotReview, /exact_membership_unavailable/);
  assert.match(snapshotReview, /discovery_status='applying_quarantine'/);
  assert.match(snapshotReviewRoute, /Idempotency-Key/);
  assert.match(snapshotReviewRoute, /confirmation/);
  assert.match(canonicalRefresh, /discovery_status!='applying_quarantine'/);
  for (const table of [
    "discovery_review_batches",
    "discovery_candidate_reviews",
  ]) {
    assert.ok(schema.includes(`sqliteTable("${table}"`));
    assert.ok(runtime.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.ok(discoveryReviewMigration.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(discoveryReviewMigration, /PRAGMA optimize/);
  assert.match(discoveryReview, /MAX_REVIEW_BATCH_SIZE = 500/);
  assert.match(discoveryReviewRoute, /confirmation/);
  for (const column of [
    "last_seen_at",
    "source_updated_at",
    "raw_url",
    "discovery_channel",
    "evidence_url",
    "parser_version",
    "snapshot_run_id",
    "linkedin_presence_state",
    "linkedin_evidence_url",
    "linkedin_checked_at",
  ]) {
    assert.ok(schema.includes(`"${column}"`), `Drizzle jobs schema is missing ${column}`);
    assert.ok(runtime.includes(column), `runtime jobs schema is missing ${column}`);
    assert.ok(provenanceMigration.includes(column), `job provenance migration is missing ${column}`);
  }
  assert.match(schema, /jobs_linkedin_presence_state_check/);
  assert.match(schema, /jobs_linkedin_evidence_required_check/);
  assert.match(canonicalRefreshStore, /discovery_channel/);
  assert.match(canonicalRefreshStore, /snapshot_run_id/);
  for (const [table, forwardMigration] of [
    ["job_observations", observationMigration],
    ["hiring_signal_promotions", promotionMigration],
  ]) {
    assert.ok(schema.includes(`sqliteTable("${table}"`));
    assert.ok(runtime.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.ok(forwardMigration.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
});
