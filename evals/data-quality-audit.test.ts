import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedJob } from "../lib/ats-adapters";
import {
  auditDataQuality,
  selectDeterministicAuditSample,
  type QualityAuditJob,
} from "../lib/data-quality-audit";

function job(
  id: string,
  companyId: string,
  externalId = id
): QualityAuditJob {
  return {
    id,
    companyId,
    externalId,
    title: "Platform Engineer",
    location: "New York, NY",
    employmentType: "FullTime",
    canonicalUrl: `https://jobs.ashbyhq.com/${companyId}/${externalId}`,
    source: "Ashby",
    status: "verified_open",
    lastVerifiedAt: "2026-07-30T20:00:00.000Z",
    company: {
      name: companyId,
      careersUrl: `https://jobs.ashbyhq.com/${companyId}`,
    },
  };
}

function current(externalId: string, companyId: string): NormalizedJob {
  return {
    externalId,
    title: "Platform Engineer",
    roleFamily: "Engineering",
    location: "New York, NY",
    remoteStatus: "See posting",
    employmentType: "FullTime",
    compensation: "See posting",
    canonicalUrl: `https://jobs.ashbyhq.com/${companyId}/${externalId}`,
    publishedAt: null,
    summary: "Current role.",
  };
}

test("quality sample is deterministic, bounded, and covers every company when possible", () => {
  const inventory = [
    ...Array.from({ length: 20 }, (_, index) => job(`acme-${index}`, "acme")),
    job("small-1", "small"),
    job("tiny-1", "tiny"),
  ];
  const first = selectDeterministicAuditSample(inventory, 10);
  const reordered = selectDeterministicAuditSample([...inventory].reverse(), 10);
  assert.deepEqual(first.map(({ id }) => id), reordered.map(({ id }) => id));
  assert.equal(first.length, 10);
  assert.deepEqual(
    [...new Set(first.map(({ companyId }) => companyId))].sort(),
    ["acme", "small", "tiny"]
  );
  assert.deepEqual(selectDeterministicAuditSample(inventory, 0), []);
});

test("quality audit fails closed and counts only exact duplicate identities", async () => {
  const inventory = [
    job("fresh", "acme"),
    job("url-match", "acme", "changed-id"),
    job("stale", "acme"),
    job("duplicate", "acme", "fresh"),
    job("ineligible", "acme"),
    {
      ...job("unsupported", "unknown"),
      canonicalUrl: "https://unknown.example/jobs/1",
      company: { name: "Unknown", careersUrl: "https://unknown.example/careers" },
    },
    {
      ...job("same-title-not-duplicate", "acme"),
      canonicalUrl: "https://jobs.ashbyhq.com/acme/other",
      externalId: "other",
    },
  ];
  const fetched: string[] = [];
  const result = await auditDataQuality(inventory, {
    sampleSize: inventory.length,
    fetchSource: async (source) => {
      fetched.push(`${source.provider}:${source.boardId}`);
      return {
        complete: true,
        jobs: [
          current("fresh", "acme"),
          {
            ...current("canonical-current-id", "acme"),
            canonicalUrl: inventory[1].canonicalUrl,
          },
          current("other", "acme"),
        ],
        observedJobs: [
          current("fresh", "acme"),
          {
            ...current("canonical-current-id", "acme"),
            canonicalUrl: inventory[1].canonicalUrl,
          },
          current("other", "acme"),
          current("ineligible", "acme"),
        ],
      };
    },
  });

  assert.deepEqual(fetched, ["ashby:acme"]);
  assert.equal(result.fresh, 4);
  assert.equal(result.stale, 1);
  assert.equal(result.ineligible, 1);
  assert.equal(result.inconclusive, 1);
  assert.equal(result.exactDuplicates, 1);
  assert.equal(result.auditedSourceEligibleObservations, 3);
  assert.equal(result.auditedSourceEligibleNotInInventory, 0);
  assert.equal(result.rows.find((row) => row.id === "duplicate")?.duplicateOf, "fresh");
  assert.equal(
    result.rows.find((row) => row.id === "same-title-not-duplicate")?.duplicateOf,
    null
  );
  assert.equal(result.rows.find((row) => row.id === "unsupported")?.freshness, "inconclusive");
  assert.equal(result.rows.find((row) => row.id === "ineligible")?.freshness, "ineligible");
});

test("source failure makes every affected row inconclusive rather than stale", async () => {
  const result = await auditDataQuality(
    [job("one", "acme"), job("two", "acme")],
    {
      fetchSource: async () => {
        throw new Error("upstream unavailable");
      },
    }
  );
  assert.equal(result.stale, 0);
  assert.equal(result.ineligible, 0);
  assert.equal(result.inconclusive, 2);
  assert.equal(result.auditedSourceEligibleObservations, 0);
  assert.equal(result.auditedSourceEligibleNotInInventory, 0);
  assert.equal(result.staleRate, null);
  assert.deepEqual(result.sourceErrors, [
    { source: "ashby:acme", reason: "upstream unavailable" },
  ]);
});
