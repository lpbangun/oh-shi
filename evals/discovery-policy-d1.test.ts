import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  discoveryActivationDueAt,
  discoveryPermissionSql,
  discoveryRetryAt,
  discoveryRunnableSql,
  isTransientDiscoveryError,
} from "../lib/discovery-policy";

async function applyStatements(database: D1Database, sql: string) {
  for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
  }
}

test("discovery retry metadata migrates and runnable work is permission- and time-gated", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: "discovery-policy-migration" },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  await database.prepare(`CREATE TABLE discovery_queue (
    id TEXT PRIMARY KEY, normalized_domain TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL, first_discovered_at TEXT NOT NULL,
    last_attempted_at TEXT, discovery_version TEXT
  )`).run();
  await database.prepare(`CREATE TABLE startup_domain_evidence (
    canonical_domain TEXT NOT NULL, permission_status TEXT NOT NULL
  )`).run();
  await database.prepare(`CREATE TABLE discovery_candidate_reviews (
    candidate_id TEXT NOT NULL, status TEXT NOT NULL
  )`).run();
  await applyStatements(database, await readFile(
    "drizzle/0013_discovery_retry_outcomes.sql", "utf8"
  ));

  const firstSeen = "2026-09-01T00:00:00.000Z";
  const rows = [
    ["due", "due.example", "discovered", null, null],
    ["excluded", "excluded.example", "discovered", null, null],
    ["deferred", "deferred.example", "discovered", null, "2026-09-16T00:00:00.000Z"],
    ["stale-review", "stale.example", "needs_review", "old-version", null],
    ["current-review", "current.example", "needs_review", "current-version", null],
    ["rejected", "rejected.example", "rejected", null, null],
    ["active", "active.example", "active", null, null],
    ["stale-resolving", "resolving.example", "resolving", null, null],
    ["under-review", "review.example", "discovered", null, null],
  ] as const;
  for (const [id, domain, status, version, nextAttemptAt] of rows) {
    await database.prepare(`INSERT INTO discovery_queue (
      id, normalized_domain, status, first_discovered_at, last_attempted_at,
      discovery_version, next_attempt_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
      id,
      domain,
      status,
      firstSeen,
      id === "stale-resolving" ? "2026-09-14T00:00:00.000Z" : null,
      version,
      nextAttemptAt
    ).run();
    if (id !== "excluded") {
      await database.prepare(`INSERT INTO startup_domain_evidence
        (canonical_domain, permission_status) VALUES (?, 'permitted')`).bind(domain).run();
    }
  }
  await database.prepare(`INSERT INTO discovery_candidate_reviews
    (candidate_id, status) VALUES ('under-review', 'processing')`).run();

  const runnable = await database.prepare(`SELECT q.id FROM discovery_queue q
    WHERE ${discoveryRunnableSql("q")} ORDER BY q.id`).bind(
      "current-version",
      "2026-09-15T11:00:00.000Z",
      "2026-09-15T12:00:00.000Z"
    ).all<{ id: string }>();
  assert.deepEqual(runnable.results.map((row) => row.id), [
    "due", "stale-resolving", "stale-review",
  ]);

  await database.prepare(`UPDATE discovery_queue SET last_outcome='probe_failed',
    attempt_count=2, next_attempt_at='2026-09-16T00:00:00.000Z' WHERE id='due'`).run();
  const persisted = await database.prepare(`SELECT last_outcome as lastOutcome,
    attempt_count as attemptCount, next_attempt_at as nextAttemptAt
    FROM discovery_queue WHERE id='due'`).first();
  assert.deepEqual(persisted, {
    lastOutcome: "probe_failed",
    attemptCount: 2,
    nextAttemptAt: "2026-09-16T00:00:00.000Z",
  });

  const permissionSql = discoveryPermissionSql("q");
  const funnel = await database.prepare(`SELECT COUNT(*) as total,
    SUM(CASE WHEN ${permissionSql} THEN 1 ELSE 0 END) as autoEligible,
    SUM(CASE WHEN NOT ${permissionSql} THEN 1 ELSE 0 END) as permissionExcluded,
    SUM(CASE WHEN ${discoveryRunnableSql("q")} THEN 1 ELSE 0 END) as readyToProcess,
    SUM(CASE WHEN ${permissionSql} AND q.next_attempt_at > ?
      THEN 1 ELSE 0 END) as retryDeferred
    FROM discovery_queue q`).bind(
      "current-version",
      "2026-09-15T11:00:00.000Z",
      "2026-09-15T12:00:00.000Z",
      "2026-09-15T12:00:00.000Z"
    ).first<{
      total: number;
      autoEligible: number;
      permissionExcluded: number;
      readyToProcess: number;
      retryDeferred: number;
    }>();
  assert.ok(funnel);
  assert.equal(funnel.autoEligible + funnel.permissionExcluded, funnel.total);
  assert.ok(funnel.readyToProcess <= funnel.autoEligible);
  assert.ok(funnel.retryDeferred <= funnel.autoEligible);
  const outcomes = await database.prepare(`SELECT COALESCE(last_outcome, 'unattempted') as outcome,
    COUNT(*) as count FROM discovery_queue q WHERE ${permissionSql}
    GROUP BY COALESCE(last_outcome, 'unattempted')`).all<{ outcome: string; count: number }>();
  assert.equal(
    outcomes.results.reduce((sum, row) => sum + Number(row.count), 0),
    funnel.autoEligible
  );
});

test("discovery retry policy backs off exponentially and classifies transient failures", () => {
  assert.equal(
    discoveryActivationDueAt("2026-09-15T00:00:00.000Z"),
    "2026-09-15T02:00:00.000Z"
  );
  assert.equal(
    discoveryRetryAt("2026-09-15T00:00:00.000Z", 1),
    "2026-09-15T06:00:00.000Z"
  );
  assert.equal(
    discoveryRetryAt("2026-09-15T00:00:00.000Z", 3),
    "2026-09-16T00:00:00.000Z"
  );
  assert.equal(isTransientDiscoveryError(new TypeError("fetch failed")), true);
  assert.equal(isTransientDiscoveryError({ status: 429 }), true);
  assert.equal(isTransientDiscoveryError({ status: 404 }), false);
});
