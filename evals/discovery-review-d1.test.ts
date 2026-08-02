import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";

test("candidate-review migration creates constrained, indexed private staging tables", async (t) => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: "discovery-review-migration" },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  const migration = await readFile(
    "drizzle/0011_discovery_candidate_reviews.sql",
    "utf8"
  );
  for (
    const statement of migration.split(";").map((value) => value.trim()).filter(Boolean)
  ) {
    await database.prepare(statement).run();
  }

  await database.prepare(`INSERT INTO discovery_review_batches (
    id, requested_count, assigned_count, status, created_at
  ) VALUES ('review-test', 500, 1, 'queued', '2026-08-02T00:00:00.000Z')`).run();
  await database.prepare(`INSERT INTO discovery_candidate_reviews (
    batch_id, candidate_id, company_name, normalized_domain, website_url
  ) VALUES ('review-test', 'candidate-one', 'Example', 'example.com',
    'https://example.com')`).run();

  const staged = await database.prepare(`SELECT status, job_count as jobCount,
    jobs_json as jobsJson FROM discovery_candidate_reviews
    WHERE batch_id='review-test'`).first<{
      status: string;
      jobCount: number;
      jobsJson: string;
    }>();
  assert.deepEqual(staged, { status: "queued", jobCount: 0, jobsJson: "[]" });
  await assert.rejects(
    database.prepare(`UPDATE discovery_candidate_reviews SET status='published'
      WHERE batch_id='review-test'`).run(),
    /constraint/i
  );
  const indexes = (await database.prepare(
    "PRAGMA index_list(discovery_candidate_reviews)"
  ).all<{ name: string }>()).results.map((index) => index.name);
  assert.ok(indexes.includes("discovery_candidate_reviews_batch_status_idx"));
  assert.ok(indexes.includes("discovery_candidate_reviews_candidate_status_idx"));
});
