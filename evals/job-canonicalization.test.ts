import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedJob } from "../lib/ats-adapters";
import {
  normalizeCanonicalJobUrl,
  selectCanonicalJobMatch,
  type CanonicalJobCandidate,
} from "../lib/job-canonicalization";

const incoming: NormalizedJob = {
  externalId: "alternate-42",
  title: "Senior Software Engineer",
  roleFamily: "Engineering",
  location: "Remote; United States",
  remoteStatus: "Remote",
  employmentType: "Full-time",
  compensation: "See posting",
  canonicalUrl: "https://apply.example.com/jobs/42?utm_source=board#apply",
  publishedAt: "2026-07-20T00:00:00.000Z",
  summary: "Build distributed payment systems with TypeScript and reliable cloud services.",
};

const candidate: CanonicalJobCandidate = {
  id: "canonical-42",
  companyId: "company-a",
  provider: "ashby",
  sourceId: "ashby:company-a",
  externalId: "primary-42",
  canonicalUrl: "https://jobs.example.com/primary-42",
  title: "Senior Software Engineer",
  location: "United States - Remote",
  employmentType: "Permanent",
  summary: "Build reliable distributed payment systems and cloud services using TypeScript.",
  publishedAt: "2026-07-18T00:00:00.000Z",
  status: "verified_open",
};

const source = {
  companyId: "company-a",
  provider: "workable" as const,
  sourceId: "workable:company-a",
};

test("canonical job matching follows stable ID, normalized URL, then conservative cross-source evidence", () => {
  assert.equal(
    normalizeCanonicalJobUrl("https://APPLY.example.com:443/jobs/42/?utm_source=x#apply"),
    "https://apply.example.com/jobs/42"
  );
  assert.deepEqual(
    selectCanonicalJobMatch(source, incoming, [{
      ...candidate,
      provider: "workable",
      sourceId: source.sourceId,
      externalId: incoming.externalId,
    }]),
    { jobId: candidate.id, method: "stable_id", score: 1 }
  );
  assert.deepEqual(
    selectCanonicalJobMatch(source, incoming, [{
      ...candidate,
      canonicalUrl: "https://apply.example.com/jobs/42/",
    }]),
    { jobId: candidate.id, method: "canonical_url", score: 1 }
  );
  assert.equal(
    selectCanonicalJobMatch(source, incoming, [candidate])?.method,
    "high_confidence"
  );
});

test("company and title alone never merge canonical openings", () => {
  const mismatch = {
    ...candidate,
    location: "London, United Kingdom",
    employmentType: "Part-time",
    summary: "Maintain an unrelated internal reporting tool.",
    publishedAt: "2025-01-01T00:00:00.000Z",
  };
  assert.equal(selectCanonicalJobMatch(source, incoming, [mismatch]), null);
  assert.equal(
    selectCanonicalJobMatch(source, incoming, [{
      ...candidate,
      location: "Remote - United Kingdom",
    }]),
    null
  );
});

test("high-confidence matching is cross-source only and rejects ambiguity", () => {
  assert.equal(
    selectCanonicalJobMatch(
      { companyId: "company-a", provider: "ashby", sourceId: "ashby:company-a" },
      incoming,
      [candidate]
    ),
    null
  );
  assert.equal(
    selectCanonicalJobMatch(source, incoming, [
      candidate,
      { ...candidate, id: "canonical-43", externalId: "primary-43" },
    ]),
    null
  );
});
