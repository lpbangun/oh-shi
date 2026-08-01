import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateYield,
  assertCompatibleReceiptCohort,
  canonicalInputs,
  type YieldProbeConfig,
  type YieldReceipt,
} from "../scripts/measure-startup-domain-yield";

test("yield manifest keeps only permitted pending domains and merges evidence", () => {
  const inputs = canonicalInputs({
    records: [
      {
        companyName: "Acme",
        websiteUrl: "https://www.acme.com/",
        sourceId: "Q1",
        sourceClassification: "recent_software_candidate",
        permissionStatus: "permitted",
        reviewStatus: "pending",
      },
      {
        companyName: "Acme Inc",
        websiteUrl: "https://acme.com/careers",
        sourceId: "Q2",
        sourceClassification: "explicit_startup",
        permissionStatus: "permitted",
        reviewStatus: "pending",
      },
      {
        companyName: "Manual",
        websiteUrl: "https://manual.example/",
        sourceId: "Q3",
        sourceClassification: "explicit_startup",
        permissionStatus: "manual_only",
        reviewStatus: "pending",
      },
      {
        companyName: "Already reviewed",
        websiteUrl: "https://reviewed.example/",
        sourceId: "Q4",
        sourceClassification: "explicit_startup",
        permissionStatus: "permitted",
        reviewStatus: "verified",
      },
    ],
  });
  assert.deepEqual(inputs, [{
    inputIndex: 0,
    domain: "acme.com",
    companyName: "Acme",
    websiteUrl: "https://www.acme.com/",
    sourceClassification: "explicit_startup",
    sourceIds: ["Q1", "Q2"],
  }]);
});

const probeConfig: YieldProbeConfig = {
  includeStructured: true,
  maxPages: 8,
  structuredMaxPages: 10,
  structuredMaxDepth: 1,
  atsAdapterVersion: "1.0",
  atsDetectionVersion: "1.1",
  structuredAdapterVersion: "1.0",
  canonicalSourceProbeVersion: "1.1",
  userAgent: "test-agent",
  implementationHash: "implementation",
  asOf: "2026-07-31T00:00:00.000Z",
};

function receipt(overrides: Partial<YieldReceipt>): YieldReceipt {
  return {
    schemaVersion: "1.1",
    inputHash: "hash",
    probeConfigHash: "config",
    probeConfig,
    cohort: "pilot",
    inputIndex: 0,
    domain: "acme.com",
    companyName: "Acme",
    websiteUrl: "https://acme.com/",
    sourceClassification: "explicit_startup",
    sourceIds: ["Q1"],
    attempt: 1,
    startedAt: "2026-07-30T00:00:00.000Z",
    completedAt: "2026-07-30T00:00:01.000Z",
    elapsedMs: 1000,
    detectionStatus: "none",
    provider: null,
    boardId: null,
    careersUrl: null,
    candidates: [],
    pages: [],
    externalCareerLinks: [],
    probeDisposition: "no_source_on_reachable_pages",
    fetchedPages: 1,
    failedPages: 0,
    structuredError: null,
    canonicalFetchStatus: "not_attempted",
    canonicalObservedOpenings: null,
    canonicalUsVerifiedJobs: 0,
    canonicalZeroUs: false,
    verifiedStatus: "unverified",
    error: null,
    ...overrides,
  };
}

test("yield aggregation uses the latest attempt and never counts detection as jobs", () => {
  const inputs = [
    {
      inputIndex: 0,
      domain: "acme.com",
      companyName: "Acme",
      websiteUrl: "https://acme.com/",
      sourceClassification: "explicit_startup",
      sourceIds: ["Q1"],
    },
    {
      inputIndex: 1,
      domain: "beta.com",
      companyName: "Beta",
      websiteUrl: "https://beta.com/",
      sourceClassification: "recent_software_candidate",
      sourceIds: ["Q2"],
    },
  ];
  const summary = aggregateYield(inputs, [
    receipt({
      provider: "ashby",
      boardId: "acme",
      detectionStatus: "single",
      canonicalFetchStatus: "incomplete",
      error: "incomplete payload",
    }),
    receipt({
      attempt: 2,
      provider: "ashby",
      boardId: "acme",
      detectionStatus: "single",
      canonicalFetchStatus: "complete",
      canonicalObservedOpenings: 5,
      canonicalUsVerifiedJobs: 3,
      verifiedStatus: "verified_us_jobs",
    }),
    receipt({
      inputIndex: 1,
      domain: "beta.com",
      companyName: "Beta",
      websiteUrl: "https://beta.com/",
      provider: "lever",
      boardId: "beta",
      detectionStatus: "single",
      canonicalFetchStatus: "incomplete",
      error: "incomplete payload",
      externalCareerLinks: [{
        host: "jobs.unknown.test",
        registrableDomain: "unknown.test",
        evidencePages: ["https://beta.com/careers"],
        occurrenceCount: 2,
        signals: ["jobs_path"],
        sampleUrls: ["https://jobs.unknown.test/beta/jobs"],
      }],
    }),
  ], "hash", "config", "pilot");
  assert.equal(summary.measuredDomains, 2);
  assert.equal(summary.detectedCompanies, 2);
  assert.equal(summary.completeCanonicalCompanies, 1);
  assert.equal(summary.verifiedUsCompanies, 1);
  assert.equal(summary.verifiedUsJobs, 3);
  assert.deepEqual(summary.byProvider.ashby, {
    detectedCompanies: 1,
    completeCompanies: 1,
    verifiedUsCompanies: 1,
    verifiedUsJobs: 3,
  });
  assert.equal(summary.byProvider.lever.verifiedUsJobs, 0);
  assert.deepEqual(summary.unsupportedCareerHostLeads, [{
    host: "jobs.unknown.test",
    distinctInputDomains: 1,
    evidencePageCount: 1,
    occurrences: 2,
    signals: ["jobs_path"],
    sampleUrls: ["https://jobs.unknown.test/beta/jobs"],
  }]);
});

test("yield receipts fail closed across input, implementation, or schema drift", () => {
  const current = receipt({});
  assert.doesNotThrow(() =>
    assertCompatibleReceiptCohort([current], "hash", "config")
  );
  assert.throws(
    () => assertCompatibleReceiptCohort([current], "other-input", "config"),
    /different input, probe configuration, or schema/
  );
  assert.throws(
    () => assertCompatibleReceiptCohort([
      { ...current, schemaVersion: "1.0" as never },
    ], "hash", "config"),
    /different input, probe configuration, or schema/
  );
});
