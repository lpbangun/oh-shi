import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import { claimDiscoveryCandidate, selectDiscoveryCandidates } from "../lib/discovery-scheduler";
import { discoveryAttemptDue, discoveryEmptyBoardRecheckAt } from "../lib/discovery-policy";

const now = "2026-09-30T12:00:00.000Z";
let serial = 0;
async function setup(t: import("node:test").TestContext) {
  const mf = new Miniflare({ modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `scheduler-${++serial}` } });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB") as unknown as D1Database;
  await db.batch([
    db.prepare(`CREATE TABLE discovery_queue (id TEXT PRIMARY KEY,
      normalized_domain TEXT NOT NULL UNIQUE, company_name TEXT NOT NULL,
      website_url TEXT NOT NULL, status TEXT NOT NULL,
      first_discovered_at TEXT NOT NULL, last_attempted_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
      last_outcome TEXT, discovery_version TEXT)`),
    db.prepare(`CREATE TABLE discovery_queue_investors (candidate_id TEXT,
      investor_source_id TEXT, evidence_url TEXT)`),
    db.prepare(`CREATE TABLE startup_domain_evidence (canonical_domain TEXT,
      permission_status TEXT, source_kind TEXT NOT NULL DEFAULT 'other',
      permission_provenance_json TEXT)`),
    db.prepare(`CREATE TABLE discovery_candidate_reviews (candidate_id TEXT,
      status TEXT)`),
  ]);
  return db;
}
async function add(db: D1Database, id: string, options: {
  status?: string; attempts?: number; permission?: string; next?: string | null;
  last?: string | null; outcome?: string | null;
} = {}) {
  const domain = `${id}.example`;
  await db.prepare(`INSERT INTO discovery_queue (id, normalized_domain,
    company_name, website_url, status, first_discovered_at,
    last_attempted_at, attempt_count, next_attempt_at, last_outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, domain, id,
      `https://${domain}/`, options.status || "discovered", now,
      options.last || null, options.attempts || 0, options.next || null,
      options.outcome || null).run();
  await db.prepare(`INSERT INTO startup_domain_evidence
    (canonical_domain, permission_status) VALUES (?, ?)`)
    .bind(domain, options.permission || "permitted").run();
}

test("two overlapping invocations lease one candidate once and reclaim stale work", async (t) => {
  const db = await setup(t);
  await add(db, "one");
  const [a, b] = await Promise.all([
    claimDiscoveryCandidate(db, "one", now),
    claimDiscoveryCandidate(db, "one", now),
  ]);
  assert.equal([a, b].filter((value) => value === 1).length, 1);
  assert.equal([a, b].filter((value) => value === null).length, 1);
  assert.equal(await claimDiscoveryCandidate(db, "one", now), null);
  const later = "2026-09-30T13:01:00.000Z";
  assert.equal(await claimDiscoveryCandidate(db, "one", later), 2);
  await db.prepare("UPDATE discovery_queue SET status='active' WHERE id='one'").run();
  assert.equal(await claimDiscoveryCandidate(db, "one", "2026-10-01T15:00:00.000Z"), null);
});

test("bounded selection gives due retries room and respects permission and review", async (t) => {
  const db = await setup(t);
  for (let index = 0; index < 20; index += 1) await add(db, `fresh-${index}`);
  for (let index = 0; index < 5; index += 1) {
    await add(db, `retry-${index}`, { attempts: 1 });
  }
  await add(db, "denied", { permission: "awaiting_permission" });
  await add(db, "reviewed");
  await db.prepare("INSERT INTO discovery_candidate_reviews VALUES ('reviewed','ready')").run();
  const selected = await selectDiscoveryCandidates(db, now, 10);
  assert.equal(selected.length, 10);
  assert.equal(selected.filter((row) => row.id.startsWith("fresh-")).length, 7);
  assert.equal(selected.filter((row) => row.id.startsWith("retry-")).length, 3);
  assert.equal(selected.some((row) => row.id === "denied" || row.id === "reviewed"), false);
});

test("shared local tick due/lease decisions match D1 claims and finite selection", async t => {
  const db = await setup(t);
  for (const [id, next, last, resolving] of [
    ["due", now, undefined, false],
    ["future", "2026-10-01T00:00:00.000Z", undefined, false],
    ["leased", undefined, now, true],
    ["boundary", undefined, "2026-09-30T11:00:00.000Z", true],
    ["stale", undefined, "2026-09-30T10:59:59.999Z", true],
  ] as const) {
    await add(db, id, { next, last, status: resolving ? "resolving" : "discovered" });
    const due = discoveryAttemptDue(now, next, resolving, last);
    assert.equal((await claimDiscoveryCandidate(db, id, now)) !== null, due, id);
  }
  for (let index = 0; index < 30; index++) await add(db, `cap-${index}`);
  assert.equal((await selectDiscoveryCandidates(db, now, 999)).length, 25);
  for (const limit of [NaN, Infinity, -1, 0]) assert.equal((await selectDiscoveryCandidates(db, now, limit)).length, 0);
});

test("empty boards recheck on due date only and explicit reviews still block", async (t) => {
  const db = await setup(t);
  const due = discoveryEmptyBoardRecheckAt("2026-09-23T12:00:00.000Z", 1);
  assert.equal(due, now);
  await add(db, "empty", { status: "needs_review", attempts: 1,
    outcome: "no_us_openings", next: due });
  assert.equal((await selectDiscoveryCandidates(db, "2026-09-30T11:59:59.000Z", 10)).length, 0);
  assert.equal((await selectDiscoveryCandidates(db, now, 10)).length, 1);
  await db.prepare("INSERT INTO discovery_candidate_reviews VALUES ('empty','queued')").run();
  assert.equal((await selectDiscoveryCandidates(db, now, 10)).length, 0);
});
