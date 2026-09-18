import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  discoveryActivationDueAt,
  discoveryPermissionSql,
  discoveryPromotionOrderSql,
  discoveryQueueOrderSql,
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

test("discovery queue processes never-attempted newest leads before older misses", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: "discovery-queue-order" },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  await database.prepare(`CREATE TABLE discovery_queue (
    id TEXT PRIMARY KEY, normalized_domain TEXT NOT NULL UNIQUE,
    company_name TEXT, website_url TEXT,
    status TEXT NOT NULL, first_discovered_at TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
    discovery_version TEXT, last_attempted_at TEXT
  )`).run();
  await database.prepare(`CREATE TABLE discovery_queue_investors (
    candidate_id TEXT NOT NULL, investor_source_id TEXT, evidence_url TEXT
  )`).run();
  await database.prepare(`CREATE TABLE startup_domain_evidence (
    canonical_domain TEXT NOT NULL, permission_status TEXT NOT NULL,
    source_kind TEXT
  )`).run();
  await database.prepare(`CREATE TABLE discovery_candidate_reviews (
    candidate_id TEXT NOT NULL, status TEXT NOT NULL
  )`).run();
  await database.prepare(`CREATE TABLE startup_domains (
    canonical_domain TEXT PRIMARY KEY, company_name TEXT, website_url TEXT,
    review_status TEXT, company_id TEXT, first_seen_at TEXT
  )`).run();

  const insertQueue = async (
    id: string,
    domain: string,
    firstSeen: string,
    attempts: number,
    status = "discovered",
    version: string | null = null
  ) => {
    await database.prepare(`INSERT INTO discovery_queue (
      id, normalized_domain, company_name, website_url, status,
      first_discovered_at, attempt_count, discovery_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id, domain, id, `https://${domain}`, status, firstSeen, attempts, version
    ).run();
    await database.prepare(`INSERT INTO startup_domain_evidence
      (canonical_domain, permission_status, source_kind) VALUES (?, 'permitted', 'other')`).bind(domain).run();
  };

  for (let index = 0; index < 40; index += 1) {
    const stamp = String(index).padStart(2, "0");
    await insertQueue(
      `old-miss-${stamp}`,
      `old${stamp}.example`,
      `2026-01-01T00:00:${stamp}.000Z`,
      3
    );
  }
  await insertQueue("today-yc", "today-yc.example", "2026-09-18T18:00:00.000Z", 0);
  await insertQueue("yesterday-news", "news.example", "2026-09-17T12:00:00.000Z", 0);
  await insertQueue(
    "stale-review",
    "stale.example",
    "2026-02-01T00:00:00.000Z",
    1,
    "needs_review",
    "old-version"
  );

  const bindRunnable = [
    "current-version",
    "2026-09-15T11:00:00.000Z",
    "2026-09-18T20:00:00.000Z",
  ] as const;
  const fifo = await database.prepare(`SELECT q.id FROM discovery_queue q
    WHERE ${discoveryRunnableSql("q")}
    ORDER BY q.first_discovered_at, q.id LIMIT 10`).bind(...bindRunnable).all<{ id: string }>();
  assert.equal(fifo.results.length, 10);
  assert.ok(fifo.results.every((row) => row.id.startsWith("old-miss-")));

  const productionShaped = await database.prepare(`SELECT q.id
    FROM discovery_queue q LEFT JOIN discovery_queue_investors qi ON qi.candidate_id=q.id
    WHERE ${discoveryRunnableSql("q")}
    GROUP BY q.id
    ORDER BY ${discoveryQueueOrderSql("q")} LIMIT 10`).bind(...bindRunnable)
    .all<{ id: string }>();
  assert.deepEqual(productionShaped.results.map((row) => row.id), [
    "today-yc",
    "yesterday-news",
    "stale-review",
    "old-miss-39",
    "old-miss-38",
    "old-miss-37",
    "old-miss-36",
    "old-miss-35",
    "old-miss-34",
    "old-miss-33",
  ]);

  await database.prepare(`INSERT INTO startup_domains
    (canonical_domain, company_name, website_url, review_status, first_seen_at)
    VALUES
      ('ancient-yc.example', 'Ancient YC', 'https://ancient-yc.example', 'pending', '2024-01-01T00:00:00.000Z'),
      ('today-wiki.example', 'Today Wiki', 'https://today-wiki.example', 'pending', '2026-09-18T19:00:00.000Z')`).run();
  await database.prepare(`INSERT INTO startup_domain_evidence
    (canonical_domain, permission_status, source_kind) VALUES
      ('ancient-yc.example', 'permitted', 'ycombinator-oss'),
      ('today-wiki.example', 'permitted', 'wikidata')`).run();
  const rankedFifo = await database.prepare(`SELECT domains.canonical_domain as canonicalDomain,
      MAX(CASE WHEN evidence.source_kind=? THEN 1 ELSE 0 END) as directoryRanked
    FROM startup_domains domains
    JOIN startup_domain_evidence evidence
      ON evidence.canonical_domain=domains.canonical_domain
    LEFT JOIN discovery_queue queue
      ON queue.normalized_domain=domains.canonical_domain
    WHERE evidence.permission_status='permitted'
      AND domains.review_status='pending'
      AND domains.company_id IS NULL
      AND queue.id IS NULL
    GROUP BY domains.canonical_domain
    ORDER BY directoryRanked DESC, domains.first_seen_at, domains.canonical_domain
    LIMIT 1`).bind("ycombinator-oss").all<{ canonicalDomain: string }>();
  assert.deepEqual(rankedFifo.results.map((row) => row.canonicalDomain), [
    "ancient-yc.example",
  ]);
  const promoted = await database.prepare(`SELECT domains.canonical_domain as canonicalDomain,
      MAX(CASE WHEN evidence.source_kind=? THEN 1 ELSE 0 END) as directoryRanked
    FROM startup_domains domains
    JOIN startup_domain_evidence evidence
      ON evidence.canonical_domain=domains.canonical_domain
    LEFT JOIN discovery_queue queue
      ON queue.normalized_domain=domains.canonical_domain
    WHERE evidence.permission_status='permitted'
      AND domains.review_status='pending'
      AND domains.company_id IS NULL
      AND queue.id IS NULL
    GROUP BY domains.canonical_domain
    ORDER BY ${discoveryPromotionOrderSql("domains")}
    LIMIT 1`).bind("ycombinator-oss").all<{ canonicalDomain: string }>();
  assert.deepEqual(promoted.results.map((row) => row.canonicalDomain), [
    "today-wiki.example",
  ]);
  assert.throws(() => discoveryQueueOrderSql("q;drop"));
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
