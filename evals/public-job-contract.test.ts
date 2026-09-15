import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildJobSearchSql,
  JobSearchError,
  parseJobSearch,
} from "../lib/job-search";
import {
  dedupeNormalizedJobs,
  isCompleteProviderPayload,
  type NormalizedJob,
} from "../lib/ats-adapters";

test("job search defaults open and builds bounded deterministic SQL", () => {
  const query = parseJobSearch(new URLSearchParams("q=engineer&limit=25&page=2&sort=recent"), {
    allowPage: true,
  });
  assert.equal(query.status, "verified_open");
  assert.equal(query.offset, 25);
  const plan = buildJobSearchSql(query, "jobs.id");
  assert.match(plan.countSql, /COUNT\(\*\)/);
  assert.match(plan.dataSql, /LIMIT \? OFFSET \?/);
  assert.match(plan.dataSql, /jobs\.last_verified_at DESC, jobs\.id ASC/);
  assert.ok(plan.bindings.includes("verified_open"));
  assert.throws(
    () => parseJobSearch(new URLSearchParams("sort=random")),
    JobSearchError
  );
});

test("compatibility include_closed maps to an explicit all-status query", () => {
  const query = parseJobSearch(new URLSearchParams("include_closed=true"));
  assert.equal(query.status, "all");
  const plan = buildJobSearchSql(query, "jobs.id");
  assert.doesNotMatch(plan.countSql, /jobs\.status = \?/);
});

test("provider completeness rejects URLs normalization would discard", () => {
  assert.equal(isCompleteProviderPayload("ashby", {
    jobs: [{ id: "1", title: "Engineer", jobUrl: "http://example.test/job/1" }],
  }), false);
  assert.equal(isCompleteProviderPayload("greenhouse", {
    jobs: [{ id: 1, title: "Engineer", absolute_url: "not-a-url" }],
  }), false);
  assert.equal(isCompleteProviderPayload("lever", [
    { id: "1", text: "Engineer", hostedUrl: "http://example.test/job/1" },
  ]), false);
});

test("normalization deduplicates exact source identities and rejects conflicts", () => {
  const base: NormalizedJob = {
    externalId: "Exact-ID",
    title: "Engineer",
    roleFamily: "Engineering",
    location: "New York, NY, United States",
    remoteStatus: "On-site",
    employmentType: "Full-time",
    compensation: "See posting",
    canonicalUrl: "https://example.test/job/1",
    publishedAt: null,
    summary: "Build things.",
  };
  assert.deepEqual(dedupeNormalizedJobs([base, { ...base }]), [base]);
  assert.throws(
    () => dedupeNormalizedJobs([base, { ...base, canonicalUrl: "https://example.test/job/2" }]),
    /conflicting duplicate external id/
  );
});

test("browser URL state and incremental feed contracts are explicit", async () => {
  const root = process.cwd();
  const [board, feed, route, intelligence, store] = await Promise.all([
    readFile(path.join(root, "app/components/JobBoard.tsx"), "utf8"),
    readFile(path.join(root, "lib/change-feed.ts"), "utf8"),
    readFile(path.join(root, "app/api/v1/changes/route.ts"), "utf8"),
    readFile(path.join(root, "app/api/v1/intelligence/route.ts"), "utf8"),
    readFile(path.join(root, "lib/canonical-refresh-store.ts"), "utf8"),
  ]);
  assert.match(board, /popstate/);
  assert.match(board, /history\.pushState/);
  assert.match(board, /View posting/);
  assert.match(feed, /occurred_at > \? OR \(occurred_at = \? AND id > \?\)/);
  assert.match(feed, /ORDER BY occurred_at ASC, id ASC/);
  assert.match(route, /checkpoint_expired|error\.code/);
  assert.match(intelligence, /"opened", "updated", "closed"/);
  assert.match(intelligence, /change\.changeType === "job_updated"/);
  assert.match(store, /'job_updated'/);
  assert.match(store, /stableIdentityHash/);
});
