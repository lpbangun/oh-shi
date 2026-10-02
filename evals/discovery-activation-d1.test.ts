import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  ActivationIdentityConflict,
  activateDiscoveredCandidateInDatabase,
  type ActivationCandidate,
} from "../lib/discovery-activation";
import { discoveryRunnableSql } from "../lib/discovery-policy";
import { DISCOVERY_PIPELINE_VERSION } from "../lib/discovery-version";
import { fetchCanonicalBoard } from "../lib/ats-adapters";

const now = "2026-09-30T12:00:00.000Z";
let serial = 0;
async function fixture(t: import("node:test").TestContext) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `activation-${++serial}` },
  });
  t.after(() => miniflare.dispose());
  const db = await miniflare.getD1Database("DB") as unknown as D1Database;
  await db.batch([
    db.prepare(`CREATE TABLE companies (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      domain TEXT NOT NULL UNIQUE, description TEXT NOT NULL, founded_year INTEGER,
      headquarters TEXT NOT NULL, employee_range TEXT NOT NULL, industry TEXT NOT NULL,
      sector TEXT NOT NULL, stage TEXT NOT NULL, funding_mode TEXT NOT NULL,
      lifecycle_status TEXT NOT NULL, hiring_score INTEGER NOT NULL,
      evidence_confidence INTEGER NOT NULL, latest_funding_label TEXT NOT NULL,
      latest_funding_date TEXT, careers_url TEXT NOT NULL, source_url TEXT NOT NULL,
      open_job_count INTEGER NOT NULL, last_verified_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE company_sources (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, provider TEXT NOT NULL,
      board_id TEXT NOT NULL, careers_url TEXT NOT NULL, enabled INTEGER NOT NULL,
      discovery_status TEXT NOT NULL, first_discovered_at TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL, review_notes TEXT NOT NULL,
      UNIQUE(provider, board_id))`),
    db.prepare(`CREATE TABLE company_investors (
      company_id TEXT NOT NULL, investor_source_id TEXT NOT NULL,
      first_discovered_at TEXT NOT NULL, evidence_url TEXT NOT NULL,
      PRIMARY KEY(company_id, investor_source_id))`),
    db.prepare(`CREATE TABLE discovery_queue (
      id TEXT PRIMARY KEY, normalized_domain TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, first_discovered_at TEXT NOT NULL,
      last_attempted_at TEXT, last_error TEXT, last_outcome TEXT,
      discovery_version TEXT, next_attempt_at TEXT, review_notes TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE TABLE discovery_queue_investors (
      candidate_id TEXT NOT NULL, investor_source_id TEXT NOT NULL,
      evidence_url TEXT NOT NULL, first_discovered_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE startup_domains (
      canonical_domain TEXT PRIMARY KEY, company_id TEXT,
      review_status TEXT NOT NULL, activity_state TEXT NOT NULL,
      careers_url TEXT, ats_provider TEXT, ats_board_id TEXT,
      career_fingerprint TEXT, last_discovery_attempt_at TEXT, last_seen_at TEXT)`),
    db.prepare(`CREATE TABLE startup_domain_evidence (
      canonical_domain TEXT NOT NULL, permission_status TEXT NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'other', permission_provenance_json TEXT)`),
    db.prepare(`CREATE TABLE discovery_candidate_reviews (
      batch_id TEXT NOT NULL, candidate_id TEXT NOT NULL, status TEXT NOT NULL)`),
  ]);
  return db;
}

async function candidate(db: D1Database, domain: string, permission = "permitted") {
  const id = `candidate-${domain}`;
  await db.batch([
    db.prepare(`INSERT INTO discovery_queue (id, normalized_domain, status,
      first_discovered_at, review_notes) VALUES (?, ?, 'canonical_source_found', ?, '')`)
      .bind(id, domain, now),
    db.prepare(`INSERT INTO startup_domains (canonical_domain, company_id,
      review_status, activity_state) VALUES (?, NULL, 'pending', 'unknown')`).bind(domain),
    db.prepare(`INSERT INTO startup_domain_evidence (canonical_domain,
      permission_status) VALUES (?, ?)`).bind(domain, permission),
    db.prepare(`INSERT INTO discovery_queue_investors (candidate_id,
      investor_source_id, evidence_url, first_discovered_at) VALUES (?, 'investor', ?, ?)`)
      .bind(id, `https://${domain}/evidence`, now),
  ]);
  return { id, normalizedDomain: domain, companyName: domain,
    websiteUrl: `https://${domain}/`, evidenceUrl: `https://${domain}/evidence` } satisfies ActivationCandidate;
}

const board = (boardId: string) => ({
  provider: "greenhouse" as const,
  boardId,
  careersUrl: `https://boards.greenhouse.io/${boardId}`,
});

async function state(db: D1Database) {
  const [companies, sources, queue, domains, investors] = await Promise.all([
    db.prepare("SELECT id, slug, domain FROM companies ORDER BY domain").all(),
    db.prepare("SELECT id, company_id as companyId FROM company_sources ORDER BY id").all(),
    db.prepare("SELECT id, status FROM discovery_queue ORDER BY id").all(),
    db.prepare("SELECT canonical_domain as domain, company_id as companyId FROM startup_domains ORDER BY canonical_domain").all(),
    db.prepare("SELECT company_id as companyId FROM company_investors ORDER BY company_id").all(),
  ]);
  return { companies: companies.results, sources: sources.results, queue: queue.results,
    domains: domains.results, investors: investors.results };
}

test("activation persists the whole identity and replays once", async (t) => {
  const db = await fixture(t);
  const first = await candidate(db, "alpha.example");
  const result = await activateDiscoveredCandidateInDatabase(db, first, board("alpha"), now);
  assert.deepEqual(await activateDiscoveredCandidateInDatabase(db, first, board("alpha"), now), result);
  const persisted = await state(db);
  assert.equal(persisted.companies.length, 1);
  assert.equal(persisted.sources.length, 1);
  assert.equal(persisted.investors.length, 1);
  assert.equal((persisted.queue[0] as { status: string }).status, "active");
  assert.equal((persisted.domains[0] as { companyId: string }).companyId, result.companyId);
});

test("shared board needs identity review and cannot publish a ghost", async (t) => {
  const db = await fixture(t);
  const first = await candidate(db, "alpha.example");
  const second = await candidate(db, "beta.example");
  await activateDiscoveredCandidateInDatabase(db, first, board("shared"), now);
  const before = await state(db);
  await assert.rejects(
    activateDiscoveredCandidateInDatabase(db, second, board("shared"), now),
    ActivationIdentityConflict,
  );
  assert.deepEqual(await state(db), before);
});

test("colliding slugs remain distinct and a mid-write error rolls back", async (t) => {
  const db = await fixture(t);
  const first = await candidate(db, "acme.co.uk");
  const second = await candidate(db, "acme-co.uk");
  await activateDiscoveredCandidateInDatabase(db, first, board("acme-one"), now);
  await activateDiscoveredCandidateInDatabase(db, second, board("acme-two"), now);
  const slugs = (await db.prepare("SELECT slug FROM companies ORDER BY slug").all<{ slug: string }>())
    .results.map((row) => row.slug);
  assert.equal(new Set(slugs).size, 2);
  const third = await candidate(db, "failure.example");
  const before = await state(db);
  await db.prepare(`CREATE TRIGGER fail_activation BEFORE INSERT ON company_sources
    WHEN NEW.board_id='fail' BEGIN SELECT RAISE(ABORT, 'simulated_mid_write'); END`).run();
  await assert.rejects(activateDiscoveredCandidateInDatabase(db, third, board("fail"), now), /simulated_mid_write/);
  assert.deepEqual(await state(db), before);
});

test("overlapping colliding activations leave no ghost and retry safely", async (t) => {
  const db = await fixture(t);
  const first = await candidate(db, "race.co.uk");
  const second = await candidate(db, "race-co.uk");
  await Promise.allSettled([
    activateDiscoveredCandidateInDatabase(db, first, board("race-one"), now),
    activateDiscoveredCandidateInDatabase(db, second, board("race-two"), now),
  ]);
  for (const [item, source] of [[first, "race-one"], [second, "race-two"]] as const) {
    await activateDiscoveredCandidateInDatabase(db, item, board(source), now);
  }
  const persisted = await state(db);
  assert.equal(persisted.companies.length, 2);
  assert.equal(persisted.sources.length, 2);
  assert.equal(new Set(persisted.companies.map((row) =>
    (row as { slug: string }).slug)).size, 2);
  assert.ok(persisted.queue.every((row) => (row as { status: string }).status === "active"));
});

test("a due empty board with a verified US opening activates once", async (t) => {
  const db = await fixture(t);
  const item = await candidate(db, "recovery.example");
  await db.prepare(`UPDATE discovery_queue SET status='needs_review',
    last_outcome='no_us_openings', next_attempt_at=? WHERE id=?`)
    .bind(now, item.id).run();
  const fetcher = (async () => new Response(JSON.stringify({ jobs: [{
    id: 42, title: "Engineer", absolute_url: "https://boards.greenhouse.io/recovery/jobs/42",
    location: { name: "Remote - US" }, content: "Build software",
  }] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const canonical = await fetchCanonicalBoard("greenhouse", "recovery", fetcher);
  assert.equal(canonical.jobs.length, 1);
  const first = await activateDiscoveredCandidateInDatabase(db, item, board("recovery"), now);
  assert.deepEqual(await activateDiscoveredCandidateInDatabase(db, item, board("recovery"), now), first);
  const persisted = await state(db);
  assert.equal(persisted.companies.length, 1);
  assert.equal(persisted.sources.length, 1);
  assert.equal((persisted.queue[0] as { status: string }).status, "active");
});

test("permission and 500 staged reviews block automatic activation", async (t) => {
  const db = await fixture(t);
  const denied = await candidate(db, "denied.example", "awaiting_permission");
  await assert.rejects(activateDiscoveredCandidateInDatabase(db, denied, board("denied"), now),
    /candidate_permission_missing/);
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < 500; index += 1) {
    const domain = `review-${index}.example`;
    const id = `candidate-${domain}`;
    statements.push(
      db.prepare(`INSERT INTO discovery_queue (id, normalized_domain, status,
        first_discovered_at, review_notes) VALUES (?, ?, 'canonical_source_found', ?, '')`)
        .bind(id, domain, now),
      db.prepare(`INSERT INTO startup_domains (canonical_domain, company_id,
        review_status, activity_state) VALUES (?, NULL, 'pending', 'unknown')`).bind(domain),
      db.prepare(`INSERT INTO startup_domain_evidence (canonical_domain,
        permission_status) VALUES (?, 'permitted')`).bind(domain),
      db.prepare(`INSERT INTO discovery_candidate_reviews (batch_id, candidate_id, status)
        VALUES ('review-batch', ?, 'ready')`).bind(id),
    );
  }
  for (let offset = 0; offset < statements.length; offset += 50) {
    await db.batch(statements.slice(offset, offset + 50));
  }
  const runnable = await db.prepare(`SELECT count(*) as count FROM discovery_queue q
    WHERE ${discoveryRunnableSql("q")}`).bind(
      DISCOVERY_PIPELINE_VERSION,
      "2026-09-30T11:00:00.000Z",
      now,
    ).first<{ count: number }>();
  assert.equal(runnable?.count, 0);
  const reviewed: ActivationCandidate = {
    id: "candidate-review-0.example", normalizedDomain: "review-0.example",
    companyName: "Review Zero", websiteUrl: "https://review-0.example/",
  };
  await assert.rejects(activateDiscoveredCandidateInDatabase(db, reviewed, board("review-zero"), now),
    /candidate_review_pending/);
  assert.equal((await db.prepare("SELECT count(*) as count FROM companies").first<{ count: number }>())?.count, 0);
});
