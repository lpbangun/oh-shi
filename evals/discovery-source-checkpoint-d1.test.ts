import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import { checkpointPortfolioCandidates } from "../lib/discovery-source-checkpoint";
import { persistDiscoverySourcePage } from "../lib/discovery-source-store";

const candidates = ["one", "two", "three"].map((name) => ({
  name, websiteUrl: `https://${name}.example/`,
  evidenceUrl: `https://investor.example/${name}`,
}));

test("partial page failure keeps cursor, and replay counts only new D1 rows", async (t) => {
  const mf = new Miniflare({ modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: "portfolio-checkpoint" } });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB") as unknown as D1Database;
  await db.prepare("CREATE TABLE candidates (domain TEXT PRIMARY KEY, evidence_url TEXT NOT NULL)").run();
  let fail = "two";
  const enqueue = async (candidate: typeof candidates[number]) => {
    if (candidate.name === fail) throw new Error("simulated_write_failure");
    const result = await db.prepare(`INSERT OR IGNORE INTO candidates
      (domain, evidence_url) VALUES (?, ?)`).bind(candidate.name, candidate.evidenceUrl).run();
    return { created: Number(result.meta.changes || 0) === 1 };
  };
  const partial = await checkpointPortfolioCandidates(candidates, 5, 8, [], enqueue);
  assert.equal(partial.status, "failed");
  assert.equal(partial.nextCursor, 5);
  assert.equal(partial.discovered, 2);
  assert.equal(partial.processed, 2);
  assert.match(partial.error || "", /simulated_write_failure/);
  fail = "";
  const replay = await checkpointPortfolioCandidates(candidates, partial.nextCursor, 8, [], enqueue);
  assert.equal(replay.status, "completed");
  assert.equal(replay.nextCursor, 8);
  assert.equal(replay.discovered, 1);
  assert.equal(replay.processed, 3);
  const count = await db.prepare("SELECT COUNT(*) as count FROM candidates").first<{ count: number }>();
  assert.equal(count?.count, 3);
  const detailsFailed = await checkpointPortfolioCandidates(candidates, 8, 11,
    [{ url: "https://investor.example/four", error: "timeout" }], enqueue);
  assert.equal(detailsFailed.nextCursor, 8);
  assert.equal(detailsFailed.discovered, 0);
});

test("crash before and after durable source checkpoint replays without losing rows", async (t) => {
  const mf = new Miniflare({ modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: "portfolio-cursor-replay" } });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB") as unknown as D1Database;
  await db.batch([
    db.prepare("CREATE TABLE candidates (domain TEXT PRIMARY KEY)"),
    db.prepare(`CREATE TABLE investor_sources (id TEXT PRIMARY KEY,
      discovery_cursor INTEGER NOT NULL, last_attempted_at TEXT,
      last_successful_at TEXT, last_error TEXT)`),
    db.prepare(`CREATE TABLE ingestion_source_results (
      run_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
      status TEXT NOT NULL, attempted_at TEXT NOT NULL, completed_at TEXT,
      discovered_count INTEGER NOT NULL DEFAULT 0, error_code TEXT, error_message TEXT,
      PRIMARY KEY(run_id, source_kind, source_id))`),
    db.prepare("INSERT INTO investor_sources (id, discovery_cursor) VALUES ('investor', 5)"),
  ]);
  const enqueue = async (candidate: typeof candidates[number]) => {
    const result = await db.prepare("INSERT OR IGNORE INTO candidates VALUES (?)")
      .bind(candidate.name).run();
    return { created: Number(result.meta.changes || 0) === 1 };
  };
  const page = await checkpointPortfolioCandidates(candidates, 5, 8, [], enqueue);
  assert.equal(page.discovered, 3);
  // Simulate a crash after candidate writes but before the source transaction.
  assert.equal((await db.prepare("SELECT discovery_cursor as cursor FROM investor_sources")
    .first<{ cursor: number }>())?.cursor, 5);
  const replay = await checkpointPortfolioCandidates(candidates, 5, 8, [], enqueue);
  assert.equal(replay.discovered, 0);
  assert.equal(replay.processed, 3);
  await persistDiscoverySourcePage(db, "run-one", "investor", "2026-09-30T12:00:00.000Z", replay);
  assert.equal((await db.prepare("SELECT discovery_cursor as cursor FROM investor_sources")
    .first<{ cursor: number }>())?.cursor, 8);
  // A crash after the checkpoint can replay the same transaction and run id.
  await persistDiscoverySourcePage(db, "run-one", "investor", "2026-09-30T12:00:00.000Z", replay);
  assert.equal((await db.prepare("SELECT COUNT(*) as count FROM candidates")
    .first<{ count: number }>())?.count, 3);
  assert.equal((await db.prepare("SELECT COUNT(*) as count FROM ingestion_source_results")
    .first<{ count: number }>())?.count, 1);
  await db.prepare(`CREATE TRIGGER fail_receipt BEFORE INSERT ON ingestion_source_results
    WHEN NEW.run_id='run-two' BEGIN SELECT RAISE(ABORT, 'receipt_write_failed'); END`).run();
  const next = await checkpointPortfolioCandidates(candidates, 8, 11, [], enqueue);
  await assert.rejects(persistDiscoverySourcePage(db, "run-two", "investor",
    "2026-09-30T14:00:00.000Z", next), /receipt_write_failed/);
  assert.equal((await db.prepare("SELECT discovery_cursor as cursor FROM investor_sources")
    .first<{ cursor: number }>())?.cursor, 8);
});
