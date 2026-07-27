import assert from "node:assert/strict";
import test from "node:test";
import {
  companyDayMovements,
  companyDeltas,
  facetValues,
  sectorDayMovements,
  sectorStats,
} from "../lib/derive";
import { seedChanges, seedCompanies, seedJobs } from "../lib/seed";
import {
  SECTOR_TAXONOMY,
  normalizeSector,
  type ChangeEvent,
  type Company,
  type Job,
} from "../lib/types";

const DAY = "2026-07-23T12:00:00.000Z";

test("sector normalization is broad, deterministic, and source labels remain intact", () => {
  assert.ok(SECTOR_TAXONOMY.length >= 12);
  assert.equal(normalizeSector("AI / Precision medicine"), "Healthcare");
  assert.equal(normalizeSector("EdTech / Learning"), "Education Technology");
  assert.equal(normalizeSector("Payments and banking"), "Financial Technology");
  assert.equal(normalizeSector("Carbon removal"), "Climate & Energy");
  assert.equal(normalizeSector("Unknown emerging category"), "Other");

  const represented = new Set(seedCompanies.map((company) => company.sector));
  assert.ok(represented.size >= 8, "tracked canonical boards span at least eight sectors");
  assert.ok(seedCompanies.length >= 12, "at least twelve canonical boards are tracked");
  for (const company of seedCompanies) {
    assert.equal(company.sector, normalizeSector(company.industry));
    assert.ok(company.industry.length > 0, "verbatim source industry is preserved");
    assert.match(company.careersUrl, /^https:\/\/jobs\.ashbyhq\.com\//);
  }
});

test("company/day movements aggregate openings, deduplicate retries, and remain stable", () => {
  const cognitionJobs = seedJobs.filter((job) => job.companyId === "company_cognition");
  const changes: ChangeEvent[] = cognitionJobs.flatMap((job, index) => [
    {
      id: `opened_${index}`,
      entityType: "job",
      entityId: job.id,
      changeType: "job_opened",
      title: `${job.title} opened`,
      description: "Canonical posting verified open for this focused evaluation.",
      occurredAt: DAY,
      sourceUrl: job.canonicalUrl,
    },
    ...(index === 0
      ? [{
          id: "retry_with_different_id",
          entityType: "job",
          entityId: job.id,
          changeType: "job_opened",
          title: `${job.title} opened`,
          description: "A refresh retry must not inflate the aggregate.",
          occurredAt: DAY,
          sourceUrl: job.canonicalUrl,
        }]
      : []),
  ]);

  const first = companyDayMovements(seedCompanies, seedJobs, changes);
  const reordered = companyDayMovements(
    [...seedCompanies].reverse(),
    [...seedJobs].reverse(),
    [...changes].reverse()
  );
  assert.equal(first.length, 1);
  assert.equal(first[0].openedCount, cognitionJobs.length);
  assert.equal(first[0].evidenceCount, cognitionJobs.length);
  assert.equal(first[0].netChange, cognitionJobs.length);
  assert.match(first[0].title, /Cognition opened 3 roles/);
  assert.equal(first[0].href, "/companies/cognition");
  assert.deepEqual(first, reordered);
});

test("sector/day movements combine companies while retaining canonical evidence", () => {
  const baseCompany = seedCompanies[0];
  const baseJob = seedJobs.find((job) => job.companyId === baseCompany.id) as Job;
  const peer: Company = {
    ...baseCompany,
    id: "company_health_peer",
    slug: "health-peer",
    name: "Health Peer",
    domain: "health-peer.example",
  };
  const peerJob: Job = {
    ...baseJob,
    id: "job_health_peer",
    externalId: "health-peer-opening",
    companyId: peer.id,
    title: "Clinical Operations Lead",
    canonicalUrl: "https://jobs.ashbyhq.com/health-peer/health-peer-opening",
  };
  const changes: ChangeEvent[] = [baseJob, peerJob].map((job) => ({
    id: `change_${job.id}`,
    entityType: "job",
    entityId: job.id,
    changeType: "job_opened",
    title: `${job.title} opened`,
    description: "Canonical posting verified open for this focused evaluation.",
    occurredAt: DAY,
    sourceUrl: job.canonicalUrl,
  }));

  const result = sectorDayMovements(
    [baseCompany, peer],
    [baseJob, peerJob],
    changes
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].sector, "Healthcare");
  assert.equal(result[0].openedCount, 2);
  assert.equal(result[0].companyId, null);
  assert.equal(result[0].jobs.length, 2);
  assert.equal(result[0].sourceUrls.length, 2);
  assert.match(result[0].href, /sector=Healthcare/);
});

test("deltas, sector totals, and facets are derived from the same records", () => {
  const now = Date.parse("2026-07-24T00:00:00.000Z");
  const deltas = companyDeltas(seedCompanies, seedJobs, seedChanges, now);
  assert.equal(deltas.get("company_cognition"), 1);

  const sectors = sectorStats(seedCompanies, deltas);
  assert.equal(
    sectors.reduce((sum, sector) => sum + sector.openRoles, 0),
    seedCompanies.reduce((sum, company) => sum + company.openJobCount, 0)
  );
  assert.equal(
    sectors.find((sector) => sector.name === "Developer Tools")?.delta30d,
    1
  );

  const jobsWithCompanies = seedJobs.map((job) => ({
    ...job,
    company: seedCompanies.find((company) => company.id === job.companyId),
  }));
  const facets = facetValues(jobsWithCompanies);
  assert.ok(facets.locations.includes("New York City"));
  assert.ok(facets.departments.includes("Engineering"));
  assert.deepEqual(facets.sectors, [...new Set(facets.sectors)].sort());
  assert.ok(facets.sectors.includes("Healthcare"));
});
