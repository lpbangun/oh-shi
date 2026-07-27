import assert from "node:assert/strict";
import test from "node:test";
import { seedChanges, seedCompanies, seedJobs } from "../lib/seed";
import { companyScoreReceipts } from "../lib/hiring-score";

const currentYear = new Date().getUTCFullYear();
const validJobStates = new Set(["verified_open", "verified_closed"]);

function unique(values: string[], label: string) {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
}

function validDate(value: string | null, label: string) {
  if (value === null) return;
  assert.ok(Number.isFinite(Date.parse(value)), `${label} must be an ISO-compatible date`);
}

test("seed companies meet the intelligence contract", () => {
  assert.ok(seedCompanies.length >= 12, "tracked coverage must include at least twelve companies");
  unique(seedCompanies.map((company) => company.id), "company ids");
  unique(seedCompanies.map((company) => company.slug), "company slugs");
  unique(seedCompanies.map((company) => company.domain), "company domains");

  for (const company of seedCompanies) {
    assert.match(company.id, /^company_[a-z0-9_]+$/);
    assert.match(company.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(company.description.length >= 30);
    assert.ok(company.foundedYear === null || (company.foundedYear >= 2010 && company.foundedYear <= currentYear));
    assert.ok(company.stage.length > 0);
    assert.ok(company.fundingMode.length > 0);
    assert.ok(company.latestFundingLabel.length > 0);
    assert.ok(company.sector.length > 0);
    assert.ok(company.hiringScore >= 0 && company.hiringScore <= 100);
    assert.ok(company.evidenceConfidence >= 0 && company.evidenceConfidence <= 100);
    assert.match(company.careersUrl, /^https:\/\//);
    assert.match(company.sourceUrl, /^https:\/\//);
    validDate(company.latestFundingDate, `${company.name} funding date`);
    validDate(company.lastVerifiedAt, `${company.name} verification date`);
  }
  assert.ok(
    new Set(seedCompanies.map((company) => company.sector)).size >= 8,
    "tracked companies must span at least eight normalized sectors"
  );
});

test("seed counts and published scores are computed from canonical facts", () => {
  for (const company of seedCompanies) {
    const receipts = companyScoreReceipts(
      company,
      seedJobs,
      seedChanges,
      company.lastVerifiedAt
    );
    assert.equal(company.hiringScore, receipts.hiring.value);
    assert.equal(company.evidenceConfidence, receipts.evidence.value);
  }
});

test("seed jobs preserve canonical truth and company relationships", () => {
  assert.ok(seedJobs.length >= 8, "pilot must include at least eight verified jobs");
  unique(seedJobs.map((job) => job.id), "job ids");
  unique(seedJobs.map((job) => job.externalId), "external job ids");
  unique(seedJobs.map((job) => job.canonicalUrl), "canonical job urls");
  const companyIds = new Set(seedCompanies.map((company) => company.id));

  for (const job of seedJobs) {
    assert.ok(companyIds.has(job.companyId), `${job.id} must reference a known company`);
    assert.ok(validJobStates.has(job.status), `${job.id} has an invalid truth state`);
    assert.match(job.canonicalUrl, /^https:\/\/jobs\.ashbyhq\.com\//);
    assert.ok(job.title.length >= 3);
    assert.ok(job.roleFamily.length >= 3);
    assert.ok(job.location.length >= 2);
    assert.ok(job.summary.length >= 20);
    assert.ok(job.summary.length <= 240);
    validDate(job.firstSeenAt, `${job.id} first seen`);
    validDate(job.lastVerifiedAt, `${job.id} last verified`);
    if (job.status === "verified_open") assert.equal(job.closedAt, null);
  }

  for (const company of seedCompanies) {
    const actual = seedJobs.filter(
      (job) => job.companyId === company.id && job.status === "verified_open"
    ).length;
    assert.equal(company.openJobCount, actual, `${company.name} open-job count is stale`);
  }
});

test("change events are unique, dated, and reference known entities", () => {
  unique(seedChanges.map((change) => change.id), "change ids");
  const entityIds = new Set([
    ...seedCompanies.map((company) => company.id),
    ...seedJobs.map((job) => job.id),
  ]);
  for (const change of seedChanges) {
    assert.ok(entityIds.has(change.entityId), `${change.id} must reference a known entity`);
    assert.ok(change.title.length >= 8);
    assert.ok(change.description.length >= 20);
    assert.match(change.sourceUrl, /^https:\/\//);
    validDate(change.occurredAt, `${change.id} occurred at`);
  }
});
