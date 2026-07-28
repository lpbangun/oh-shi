import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAshby,
  normalizeGreenhouse,
  normalizeLever,
  normalizeWorkable,
  isCompleteProviderPayload,
  detectAtsFromLinks,
} from "../lib/ats-adapters";
import { companyDiverseJobs } from "../lib/derive";
import {
  changeEventId,
  jobIdentity,
  jobsToCloseAfterFetch,
  mergeDiscoveryCandidates,
  portfolioWindow,
  refreshOutcome,
} from "../lib/ingestion-core";
import { INVESTOR_SOURCE_SEEDS, normalizeDomain } from "../lib/source-registry";
import type { Company, Job } from "../lib/types";

test("Ashby, Greenhouse, Lever, and Workable normalize canonical US jobs", () => {
  const ashby = normalizeAshby({ jobs: [{
    id: "a1", title: "Engineer", department: "Engineering", location: "Remote",
    isRemote: true, employmentType: "Full-time", jobUrl: "https://jobs.ashbyhq.com/acme/a1",
    publishedAt: "2026-07-01T00:00:00Z",
  }] });
  const greenhouse = normalizeGreenhouse({ jobs: [{
    id: 2, title: "Product Manager", location: { name: "New York, NY" },
    departments: [{ name: "Product" }], absolute_url: "https://boards.greenhouse.io/acme/jobs/2",
    updated_at: "2026-07-02T00:00:00Z",
  }] });
  const lever = normalizeLever([{
    id: "l3", text: "Data Scientist", categories: { team: "Data", location: "Remote - US", commitment: "Full-time" },
    workplaceType: "remote", hostedUrl: "https://jobs.lever.co/acme/l3", createdAt: 1_772_323_200_000,
  }]);
  const workable = normalizeWorkable({ jobs: [{
    shortcode: "w4", title: "Account Executive", department: "Sales",
    location: { location_str: "Austin, TX" }, url: "https://apply.workable.com/acme/j/w4/",
    published_on: "2026-07-03",
  }] });
  for (const jobs of [ashby, greenhouse, lever, workable]) {
    assert.equal(jobs.length, 1);
    assert.match(jobs[0].canonicalUrl, /^https:\/\//);
    assert.ok(jobs[0].externalId);
  }
});

test("ATS detection stores canonical board roots rather than individual job URLs", () => {
  assert.deepEqual(
    detectAtsFromLinks(["https://job-boards.greenhouse.io/acme/jobs/123"]),
    {
      provider: "greenhouse",
      boardId: "acme",
      careersUrl: "https://job-boards.greenhouse.io/acme",
    }
  );
  assert.deepEqual(
    detectAtsFromLinks(["https://jobs.lever.co/acme/job-id"]),
    {
      provider: "lever",
      boardId: "acme",
      careersUrl: "https://jobs.lever.co/acme",
    }
  );
});

test("remote does not override explicit non-US evidence", async () => {
  const { isUsEligible } = await import("../lib/job-normalization");
  assert.equal(isUsEligible({ title: "Engineer", location: "Remote", isRemote: true }), true);
  assert.equal(isUsEligible({ title: "Engineer", location: "Remote - Canada", isRemote: true }), false);
  assert.equal(isUsEligible({
    title: "Engineer", location: "Toronto", isRemote: true,
    address: { postalAddress: { addressCountry: "Canada" } },
  }), false);
});

test("malformed successful responses are incomplete and cannot prove absence", () => {
  assert.equal(isCompleteProviderPayload("ashby", { error: "rate limited" }), false);
  assert.equal(isCompleteProviderPayload("ashby", { jobs: [{}] }), false);
  assert.equal(isCompleteProviderPayload("greenhouse", {
    jobs: [{ id: 1, title: "Engineer" }],
  }), false);
  assert.equal(isCompleteProviderPayload("lever", [{
    id: "role-1", text: "Engineer",
  }]), false);
  assert.equal(isCompleteProviderPayload("workable", {
    jobs: [{ shortcode: "ROLE1", title: "Engineer" }],
  }), false);
  assert.equal(isCompleteProviderPayload("greenhouse", { jobs: [] }), true);
  assert.equal(isCompleteProviderPayload("lever", []), true);
  assert.equal(isCompleteProviderPayload("workable", { jobs: [] }), true);
});

test("company domains normalize and cross-investor discovery is idempotent", () => {
  assert.equal(normalizeDomain("HTTPS://WWW.Example.COM/path?q=1"), "example.com");
  assert.equal(normalizeDomain("not a domain"), "");
  const input = [
    { name: "Example", websiteUrl: "https://www.example.com", investorId: "a16z", evidenceUrl: "https://a16z.com/portfolio/" },
    { name: "Example Inc", websiteUrl: "https://example.com/about", investorId: "sequoia", evidenceUrl: "https://sequoiacap.com/our-companies/" },
  ];
  const first = mergeDiscoveryCandidates(input);
  const retry = mergeDiscoveryCandidates([...input, ...input]);
  assert.deepEqual(retry, first);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].investors.map((item) => item.investorId), ["a16z", "sequoia"]);
});

test("portfolio discovery advances through durable bounded windows", () => {
  const links = Array.from({ length: 45 }, (_, index) => `company-${index}`);
  const first = portfolioWindow(links, 0);
  const second = portfolioWindow(links, first.nextCursor);
  const third = portfolioWindow(links, second.nextCursor);
  assert.deepEqual(first.items, links.slice(0, 20));
  assert.deepEqual(second.items, links.slice(20, 40));
  assert.deepEqual(third.items, links.slice(40));
  assert.equal(third.nextCursor, 0);
  assert.deepEqual(portfolioWindow(links, 999).items, links.slice(0, 20));
});

test("provider/source identity and closing are strictly scoped", () => {
  assert.notEqual(jobIdentity("ashby", "one", "42"), jobIdentity("greenhouse", "one", "42"));
  assert.notEqual(jobIdentity("ashby", "one", "42"), jobIdentity("ashby", "two", "42"));
  const existing = [
    { id: "a", provider: "ashby" as const, sourceId: "one", externalId: "42", status: "verified_open" },
    { id: "b", provider: "greenhouse" as const, sourceId: "two", externalId: "42", status: "verified_open" },
    { id: "c", provider: "ashby" as const, sourceId: "three", externalId: "99", status: "verified_open" },
  ];
  assert.deepEqual(jobsToCloseAfterFetch(existing, { provider: "ashby", sourceId: "one" }, null), []);
  assert.deepEqual(jobsToCloseAfterFetch(existing, { provider: "ashby", sourceId: "one" }, []), ["a"]);
  assert.deepEqual(jobsToCloseAfterFetch(existing, { provider: "greenhouse", sourceId: "two" }, []), ["b"]);
});

test("partial refresh succeeds at threshold and change IDs deduplicate retries", () => {
  const outcome = refreshOutcome([{ status: "success" }, { status: "failed" }], 0.5);
  assert.deepEqual(outcome, { successes: 1, failures: 1, partialSuccess: true, meetsThreshold: true });
  assert.equal(
    changeEventId("open", "job_1", "2026-07-28T01:00:00Z"),
    changeEventId("open", "job_1", "2026-07-28T23:00:00Z")
  );
});

test("default ordering is deterministic and company-diverse", () => {
  const companies = [
    { id: "a", name: "A", hiringScore: 90 },
    { id: "b", name: "B", hiringScore: 80 },
    { id: "c", name: "C", hiringScore: 70 },
  ] as Company[];
  const jobs = [
    ...Array.from({ length: 8 }, (_, index) => ({ id: `a${index}`, companyId: "a", title: `A${index}`, firstSeenAt: "2026-07-01" })),
    { id: "b1", companyId: "b", title: "B", firstSeenAt: "2026-07-01" },
    { id: "c1", companyId: "c", title: "C", firstSeenAt: "2026-07-01" },
  ] as Job[];
  const ordered = companyDiverseJobs(jobs, companies);
  assert.deepEqual(ordered.slice(0, 3).map((job) => job.companyId), ["a", "b", "c"]);
  assert.deepEqual(companyDiverseJobs([...jobs].reverse(), companies), ordered);
});

test("all ten reviewed investor sources remain configured", () => {
  assert.equal(INVESTOR_SOURCE_SEEDS.length, 10);
  assert.deepEqual(
    INVESTOR_SOURCE_SEEDS.filter((source) => source.mandatory).map((source) => source.id),
    ["a16z", "general-catalyst", "khosla-ventures", "y-combinator"]
  );
});
