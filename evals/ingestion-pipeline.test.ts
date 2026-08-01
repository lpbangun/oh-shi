import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAshby,
  normalizeGreenhouse,
  normalizeLever,
  normalizePersonio,
  normalizeRecruitee,
  normalizeSmartRecruiters,
  normalizeWorkable,
  isCompleteProviderPayload,
  detectAtsCandidatesFromLinks,
  detectAtsFromLinks,
} from "../lib/ats-adapters";
import { companyDiverseJobs } from "../lib/derive";
import {
  changeEventId,
  jobIdentity,
  jobsToCloseAfterFetch,
  mergeDiscoveryCandidates,
  portfolioWindow,
  processSequentiallyIsolated,
  groupSourcesByCompany,
  refreshOutcome,
  assessCanonicalSnapshot,
  planCanonicalClosures,
  snapshotFingerprint,
  attemptWithFallback,
} from "../lib/ingestion-core";
import {
  buildStartupDomainPilot,
  careerFingerprint,
  registrableDomain,
  resolveCanonicalRegistryDomain,
} from "../lib/domain-registry";
import { INVESTOR_SOURCE_SEEDS, normalizeDomain } from "../lib/source-registry";
import type { Company, Job } from "../lib/types";

test("documented ATS adapters normalize canonical US jobs", () => {
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
    location: { location_str: "Austin, TX" },
    url: "https://apply.workable.com/j/w4",
    application_url: "https://apply.workable.com/j/w4/apply",
    published_on: "2026-07-03", description: "<p>Build the sales pipeline.</p>",
  }] });
  const workableResults = normalizeWorkable({ results: [{
    shortcode: "w5", title: "Customer Success Manager", department: "Operations",
    location: { location_str: "Remote - US" }, remote: true,
    url: "https://apply.workable.com/j/w5",
    application_url: "https://apply.workable.com/j/w5/apply",
    published_on: "2026-07-03", description: "<p>Support customers.</p>",
  }] });
  const recruitee = normalizeRecruitee({ offers: [{
    id: 5,
    title: "Platform Engineer",
    status: "published",
    department: "Engineering",
    locations: [{
      name: "Remote US",
      city: "Remote",
      country: "United States",
      country_code: "US",
    }],
    remote: true,
    employment_type_code: "fulltime_permanent",
    salary: { min: 180000, max: 220000, currency: "USD" },
    careers_url: "https://acme.recruitee.com/o/platform-engineer",
    careers_apply_url: "https://acme.recruitee.com/o/platform-engineer/c/new",
    published_at: "2026-07-29 12:00:00 UTC",
    description: "<p>Build the platform.</p>",
    requirements: "<p>Production experience.</p>",
  }] });
  const personio = normalizePersonio(`<?xml version="1.0" encoding="UTF-8"?>
    <workzag-jobs>
      <position>
        <id>42</id>
        <subcompany>Acme Inc</subcompany>
        <office>Remote - United States</office>
        <department>Engineering</department>
        <name>Infrastructure Engineer</name>
        <jobDescriptions>
          <jobDescription>
            <name>What you will do</name>
            <value><![CDATA[<p>Build reliable systems.</p>]]></value>
          </jobDescription>
        </jobDescriptions>
        <employmentType>permanent</employmentType>
        <schedule>full-time</schedule>
        <createdAt>2026-07-29T12:00:00+00:00</createdAt>
        <salaryInformation>
          <min>180000.00</min>
          <max>220000.00</max>
          <currencyCode>USD</currencyCode>
          <type>yearly</type>
        </salaryInformation>
      </position>
    </workzag-jobs>`, "acme.jobs.personio.com");
  const smartRecruiters = normalizeSmartRecruiters([{
    id: "smart-42",
    uuid: "c62752e2-e7b2-4a1b-bfe4-f4210218ca7d",
    name: "Security Engineer",
    company: { identifier: "Acme", name: "Acme" },
    location: {
      city: "Boston",
      region: "MA",
      country: "us",
      remote: false,
      hybrid: true,
      fullLocation: "Boston, MA, United States",
    },
    releasedDate: "2026-07-30T12:00:00.000Z",
    postingUrl: "https://jobs.smartrecruiters.com/Acme/smart-42-security-engineer",
    applyUrl: "https://jobs.smartrecruiters.com/Acme/smart-42-security-engineer?oga=true",
    jobAd: {
      sections: {
        jobDescription: {
          title: "Job Description",
          text: "<p>Protect production systems.</p>",
        },
        qualifications: {
          title: "Qualifications",
          text: "<p>Cloud security experience.</p>",
        },
      },
    },
    compensation: { min: 160000, max: 200000, currency: "USD", period: "YEARLY" },
    active: true,
    visibility: "PUBLIC",
    department: { id: "engineering", label: "Engineering" },
    typeOfEmployment: { id: "permanent", label: "Full-time" },
  }]);
  for (const jobs of [
    ashby,
    greenhouse,
    lever,
    workable,
    workableResults,
    recruitee,
    personio,
    smartRecruiters,
  ]) {
    assert.equal(jobs.length, 1);
    assert.match(jobs[0].canonicalUrl, /^https:\/\//);
    assert.ok(jobs[0].externalId);
  }
});

test("Workable collapses repeated location rows by stable shortcode", () => {
  const base = {
    shortcode: "F10CB13E5C",
    title: "GTM Engineer",
    department: "Engineering",
    employment_type: "Full-time",
    telecommuting: true,
    url: "https://apply.workable.com/j/F10CB13E5C",
    shortlink: "https://apply.workable.com/j/F10CB13E5C",
    application_url: "https://apply.workable.com/j/F10CB13E5C/apply",
    published_on: "2026-07-13",
    description: "<p>Build reliable go-to-market systems.</p>",
  };
  const payload = { jobs: [
    {
      ...base,
      country: "United States",
      city: "Atlanta",
      state: "Georgia",
      locations: [{
        country: "United States", countryCode: "US",
        city: "Atlanta", region: "Georgia", hidden: false,
      }],
    },
    {
      ...base,
      country: "Canada",
      city: "Toronto",
      state: "Ontario",
      locations: [{
        country: "Canada", countryCode: "CA",
        city: "Toronto", region: "Ontario", hidden: false,
      }],
    },
    {
      ...base,
      country: "United States",
      city: "New York",
      state: "New York",
      locations: [{
        country: "United States", countryCode: "US",
        city: "New York", region: "New York", hidden: false,
      }],
    },
    {
      ...base,
      shortcode: "POOL123",
      title: "General Application",
      url: "https://apply.workable.com/j/POOL123",
      shortlink: "https://apply.workable.com/j/POOL123",
      application_url: "https://apply.workable.com/j/POOL123/apply",
      description: "<p>Apply if you don't see an active job opening.</p>",
      country: "United States",
      city: "",
      state: "",
      locations: [{
        country: "United States", countryCode: "US",
        city: "", region: null, hidden: false,
      }],
    },
  ] };
  assert.equal(isCompleteProviderPayload("workable", payload), true);
  const jobs = normalizeWorkable(payload);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].externalId, "F10CB13E5C");
  assert.match(jobs[0].location, /Atlanta, Georgia, United States/);
  assert.match(jobs[0].location, /New York, New York, United States/);
  assert.doesNotMatch(jobs[0].location, /Canada|Toronto/);
  assert.equal(
    jobs[0].canonicalUrl,
    "https://apply.workable.com/j/F10CB13E5C"
  );

  assert.equal(isCompleteProviderPayload("workable", {
    jobs: [
      payload.jobs[0],
      { ...payload.jobs[1], title: "A different role" },
    ],
  }), false, "one shortcode cannot describe two identities");
  assert.equal(isCompleteProviderPayload("workable", {
    jobs: [{ ...payload.jobs[0], application_url: undefined }],
  }), false, "a published row without an application action is incomplete");
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
    detectAtsFromLinks([
      "https://job-boards.greenhouse.io/embed/job_board?for=lokalise",
    ]),
    {
      provider: "greenhouse",
      boardId: "lokalise",
      careersUrl: "https://job-boards.greenhouse.io/lokalise",
    },
    "Greenhouse's employer embed form stores the board identity in `for`"
  );
  assert.deepEqual(
    detectAtsFromLinks(["https://jobs.lever.co/acme/job-id"]),
    {
      provider: "lever",
      boardId: "acme",
      careersUrl: "https://jobs.lever.co/acme",
    }
  );
  assert.deepEqual(
    detectAtsFromLinks(["https://Acme.recruitee.com/o/platform-engineer"]),
    {
      provider: "recruitee",
      boardId: "acme",
      careersUrl: "https://acme.recruitee.com/",
    }
  );
  assert.deepEqual(
    detectAtsFromLinks(["https://Acme.jobs.personio.com/job/42?language=en"]),
    {
      provider: "personio",
      boardId: "acme.jobs.personio.com",
      careersUrl: "https://acme.jobs.personio.com/",
    }
  );
  assert.deepEqual(
    detectAtsFromLinks([
      "https://jobs.smartrecruiters.com/Acme/smart-42-security-engineer",
    ]),
    {
      provider: "smartrecruiters",
      boardId: "Acme",
      careersUrl: "https://careers.smartrecruiters.com/Acme",
    }
  );
});

test("ATS detection rejects ambiguity and unsafe board identifiers", () => {
  const ambiguous = [
    "https://jobs.ashbyhq.com/acme/role-1",
    "https://jobs.lever.co/other-company/role-2",
    "https://jobs.ashbyhq.com/acme/role-3",
  ];
  assert.deepEqual(
    detectAtsCandidatesFromLinks(ambiguous).map(
      (item) => `${item.provider}:${item.boardId}`
    ),
    ["ashby:acme", "lever:other-company"]
  );
  assert.equal(detectAtsFromLinks(ambiguous), null);
  assert.equal(
    detectAtsFromLinks(["https://jobs.ashbyhq.com/%2Fadmin/role"]),
    null
  );
});

test("Recruitee excludes talent-pool applications without weakening payload completeness", () => {
  const common = {
    status: "published",
    remote: true,
    locations: [{ name: "Remote US", country: "United States" }],
    careers_apply_url: "https://acme.recruitee.com/o/role/c/new",
  };
  const payload = { offers: [
    {
      ...common,
      id: 1,
      title: "Backend Engineer",
      careers_url: "https://acme.recruitee.com/o/backend-engineer",
      description: "Build production software.",
    },
    {
      ...common,
      id: 2,
      title: "General Application",
      careers_url: "https://acme.recruitee.com/o/general-application",
      description: "Apply if you don't see an active job opening.",
    },
  ] };
  assert.equal(isCompleteProviderPayload("recruitee", payload), true);
  assert.deepEqual(
    normalizeRecruitee(payload).map((job) => job.externalId),
    ["1"]
  );
  assert.equal(isCompleteProviderPayload("recruitee", { offers: [{
    id: 1,
    title: "Engineer",
    status: "published",
    careers_url: "https://acme.recruitee.com/o/engineer",
  }] }), false);
  assert.equal(isCompleteProviderPayload("recruitee", { offers: [] }), true);
});

test("Personio XML is complete only when the full published-position schema is intact", () => {
  const payload = `<workzag-jobs>
    <position>
      <id>7</id>
      <office>New York, NY</office>
      <department>Product</department>
      <name>Product Manager</name>
      <jobDescriptions>
        <jobDescription>
          <name>Role</name>
          <value><![CDATA[<p>Build the product.</p>]]></value>
        </jobDescription>
      </jobDescriptions>
      <employmentType>permanent</employmentType>
      <schedule>full-time</schedule>
      <createdAt>2026-07-30T00:00:00+00:00</createdAt>
    </position>
    <position>
      <id>8</id>
      <office>Remote - United States</office>
      <department>People</department>
      <name>Initiativbewerbung / General Application</name>
      <jobDescriptions>
        <jobDescription><name>Pool</name><value>There is no active role.</value></jobDescription>
      </jobDescriptions>
      <employmentType>permanent</employmentType>
      <schedule>full-time</schedule>
    </position>
  </workzag-jobs>`;
  assert.equal(isCompleteProviderPayload("personio", payload), true);
  assert.deepEqual(
    normalizePersonio(payload, "acme.jobs.personio.de").map((job) => job.externalId),
    ["7"]
  );
  assert.equal(
    normalizePersonio(payload, "acme.jobs.personio.de")[0].canonicalUrl,
    "https://acme.jobs.personio.de/job/7?language=en"
  );
  assert.equal(isCompleteProviderPayload("personio", "<workzag-jobs />"), true);
  assert.equal(isCompleteProviderPayload(
    "personio",
    "<html><body>Sign in</body></html>"
  ), false);
  assert.equal(isCompleteProviderPayload(
    "personio",
    "<workzag-jobs><position><id>7</id><name>Missing close</name></workzag-jobs>"
  ), false);
  assert.equal(isCompleteProviderPayload(
    "personio",
    "<!DOCTYPE jobs [<!ENTITY x 'bad'>]><workzag-jobs />"
  ), false);
  assert.equal(isCompleteProviderPayload(
    "personio",
    "<workzag-jobs><unexpected /></workzag-jobs>"
  ), false);
  assert.equal(isCompleteProviderPayload(
    "personio",
    "<workzag-jobs>&unresolved;</workzag-jobs>"
  ), false);
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
  assert.equal(isCompleteProviderPayload("workable", { results: [{
    shortcode: "ROLE2", title: "Engineer",
    url: "https://apply.workable.com/j/ROLE2",
    application_url: "https://apply.workable.com/j/ROLE2/apply",
    published_on: "2026-07-30",
    description: "<p>Build production systems.</p>",
    location: { location_str: "Remote - US" },
  }] }), true);
  assert.equal(isCompleteProviderPayload("workable", {
    jobs: [],
    results: [{ malformed: true }],
  }), true, "an explicit empty jobs array is a complete board and must not fall through");
  assert.equal(isCompleteProviderPayload("recruitee", { error: "rate limited" }), false);
  assert.equal(isCompleteProviderPayload("personio", "<workzag-jobs><position /></workzag-jobs>"), false);
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

test("startup registry uses registrable domains and preserves rights evidence", () => {
  assert.equal(registrableDomain("https://jobs.example.co.uk/openings"), "example.co.uk");
  assert.equal(registrableDomain("https://www.example.com."), "example.com");
  assert.equal(registrableDomain("https://careers.acme.github.io/jobs"), "acme.github.io");
  assert.equal(registrableDomain("http://127.0.0.1/jobs"), "");
  assert.equal(registrableDomain("https://localhost/jobs"), "");

  const pilot = buildStartupDomainPilot([
    {
      companyName: "Example",
      websiteUrl: "https://www.example.co.uk/",
      aliases: [{
        aliasDomain: "https://careers.example.com",
        evidenceUrl: "https://example.co.uk/official-aliases",
        permissionStatus: "permitted",
        sourceTermsUrl: "https://example.co.uk/terms",
        observedAt: "2026-07-30T00:00:00.000Z",
      }],
      sourceId: "Q1",
      sourceKind: "wikidata",
      sourceClassification: "explicit_startup",
      evidenceUrl: "https://www.wikidata.org/wiki/Q1",
      permissionStatus: "permitted",
      sourceTermsUrl: "https://www.wikidata.org/wiki/Wikidata:Copyright",
      observedAt: "2026-07-30T00:00:00.000Z",
    },
    {
      companyName: "Example Ltd",
      websiteUrl: "https://example.co.uk/about",
      sourceId: "Q2",
      sourceKind: "authorized_feed",
      sourceClassification: "portfolio_candidate",
      evidenceUrl: "https://evidence.example/Q2",
      permissionStatus: "manual_only",
      sourceTermsUrl: "https://evidence.example/terms",
      observedAt: "2026-07-30T01:00:00.000Z",
    },
  ], 500, "pilot-2026-07-30");

  assert.equal(pilot.entries.length, 1);
  assert.equal(pilot.entries[0].canonicalDomain, "example.co.uk");
  assert.deepEqual(pilot.entries[0].aliases, [{
    aliasDomain: "example.com",
    evidenceUrl: "https://example.co.uk/official-aliases",
    permissionStatus: "permitted",
    sourceTermsUrl: "https://example.co.uk/terms",
    observedAt: "2026-07-30T00:00:00.000Z",
  }]);
  assert.equal(pilot.entries[0].evidence.length, 2);
  assert.deepEqual(pilot.entries[0].evidence.map((item) => item.permissionStatus).sort(), [
    "manual_only",
    "permitted",
  ]);
  assert.equal(pilot.receipt.accepted, 1);
  assert.equal(pilot.receipt.reconciled, true);
  assert.equal(pilot.receipt.identityGraphValid, true);
});

test("acquisition relations are retained without silently merging company identity", () => {
  const pilot = buildStartupDomainPilot([{
    companyName: "Old Company",
    websiteUrl: "https://oldcompany.com/",
    acquisitions: [{
      relatedDomain: "https://acquirer.com/",
      relation: "acquired_by",
      evidenceUrl: "https://oldcompany.com/acquisition",
      permissionStatus: "permitted",
      sourceTermsUrl: "https://oldcompany.com/terms",
      observedAt: "2026-07-30T00:00:00.000Z",
    }],
    sourceId: "reviewed-import",
    sourceKind: "company_submission",
    sourceClassification: "reviewed_company",
    evidenceUrl: "https://oldcompany.com/about",
    permissionStatus: "permitted",
    sourceTermsUrl: "https://oldcompany.com/terms",
    observedAt: "2026-07-30T00:00:00.000Z",
  }], 500, "pilot-2026-07-30");
  assert.equal(
    resolveCanonicalRegistryDomain("oldcompany.com", pilot.entries),
    "oldcompany.com"
  );
  assert.equal(
    resolveCanonicalRegistryDomain("acquirer.com", pilot.entries),
    "acquirer.com",
    "acquisitions are provenance relations, never aliases"
  );
  assert.deepEqual(pilot.entries[0].acquisitions, [{
    relatedDomain: "acquirer.com",
    relation: "acquired_by",
    evidenceUrl: "https://oldcompany.com/acquisition",
    permissionStatus: "permitted",
    sourceTermsUrl: "https://oldcompany.com/terms",
    observedAt: "2026-07-30T00:00:00.000Z",
  }]);
  assert.equal(
    careerFingerprint("greenhouse", "Acme", "https://job-boards.greenhouse.io/acme"),
    "greenhouse:acme:job-boards.greenhouse.io"
  );
});

test("registry rejects ambiguous alias ownership instead of merging identities", () => {
  const common = {
    sourceKind: "company_submission",
    sourceClassification: "reviewed_company",
    permissionStatus: "permitted" as const,
    sourceTermsUrl: "https://registry.example.com/terms",
    observedAt: "2026-07-30T00:00:00.000Z",
  };
  const alias = {
    aliasDomain: "https://shared-alias.com",
    evidenceUrl: "https://registry.example.com/alias-evidence",
    permissionStatus: "permitted" as const,
    sourceTermsUrl: "https://registry.example.com/terms",
    observedAt: "2026-07-30T00:00:00.000Z",
  };
  const canonicalCollision = buildStartupDomainPilot([
    {
      ...common,
      companyName: "One",
      websiteUrl: "https://one-company.com",
      aliases: [alias],
      sourceId: "one",
      evidenceUrl: "https://registry.example.com/one",
    },
    {
      ...common,
      companyName: "Shared",
      websiteUrl: "https://shared-alias.com",
      sourceId: "shared",
      evidenceUrl: "https://registry.example.com/shared",
    },
  ]);
  assert.equal(canonicalCollision.receipt.identityGraphValid, false);
  assert.deepEqual(canonicalCollision.identityConflicts, [
    "alias_is_canonical:shared-alias.com",
  ]);

  const multipleOwners = buildStartupDomainPilot([
    {
      ...common,
      companyName: "One",
      websiteUrl: "https://one-company.com",
      aliases: [alias],
      sourceId: "one",
      evidenceUrl: "https://registry.example.com/one",
    },
    {
      ...common,
      companyName: "Two",
      websiteUrl: "https://two-company.com",
      aliases: [alias],
      sourceId: "two",
      evidenceUrl: "https://registry.example.com/two",
    },
  ]);
  assert.equal(multipleOwners.receipt.identityGraphValid, false);
  assert.deepEqual(multipleOwners.identityConflicts, [
    "alias_has_multiple_owners:shared-alias.com",
  ]);
});

test("additional source website claims remain observations, not aliases", () => {
  const pilot = buildStartupDomainPilot([{
    companyName: "Regional Example",
    websiteUrl: "https://regional-example.com",
    observedWebsiteUrls: [
      "https://regional-example.co.uk",
      "https://product-example.com",
    ],
    sourceId: "Q100",
    sourceKind: "wikidata",
    sourceClassification: "explicit_startup",
    evidenceUrl: "https://www.wikidata.org/wiki/Q100",
    permissionStatus: "permitted",
    sourceTermsUrl: "https://www.wikidata.org/wiki/Wikidata:Copyright",
    observedAt: "2026-07-30T00:00:00.000Z",
  }]);
  assert.deepEqual(pilot.entries[0].aliases, []);
  assert.deepEqual(pilot.entries[0].evidence[0].observedWebsiteUrls, [
    "https://product-example.com/",
    "https://regional-example.co.uk/",
  ]);
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

test("candidate failures are isolated and discovery failures do not block later work", async () => {
  const attempted: number[] = [];
  const failureBookkeeping: number[] = [];
  const processed = await processSequentiallyIsolated(
    [1, 2, 3],
    async (value) => {
      attempted.push(value);
      if (value === 2) throw new Error("transient D1 failure");
      return value * 10;
    },
    async (value) => {
      failureBookkeeping.push(value);
    }
  );
  assert.deepEqual(attempted, [1, 2, 3]);
  assert.deepEqual(processed.results, [10, 30]);
  assert.equal(processed.failures.length, 1);
  assert.deepEqual(failureBookkeeping, [2]);

  let refreshRan = false;
  const discovery = await attemptWithFallback(
    async () => { throw new Error("discovery unavailable"); },
    () => ({ overall_status: "failed" as const })
  );
  const refresh = await (async () => {
    refreshRan = true;
    return { overall_status: "success" as const };
  })();
  assert.equal(discovery.overall_status, "failed");
  assert.equal(refresh.overall_status, "success");
  assert.equal(refreshRan, true);
});

test("alternate sources for one employer share a sequential refresh group", () => {
  assert.deepEqual(
    groupSourcesByCompany([
      { id: "ashby:a", companyId: "a" },
      { id: "greenhouse:b", companyId: "b" },
      { id: "workable:a", companyId: "a" },
    ]),
    [
      [
        { id: "ashby:a", companyId: "a" },
        { id: "workable:a", companyId: "a" },
      ],
      [{ id: "greenhouse:b", companyId: "b" }],
    ]
  );
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

test("large authoritative count decreases are quarantined before closure", () => {
  assert.deepEqual(assessCanonicalSnapshot(100, 1), {
    status: "quarantined",
    existingOpenCount: 100,
    observedOpenCount: 1,
    missingCount: 99,
    missingRatio: 0.99,
    reason: "mass_deletion_guard",
  });
  assert.equal(assessCanonicalSnapshot(10, 9).status, "accepted");
  assert.equal(
    assessCanonicalSnapshot(20, 10).status,
    "accepted",
    "the ratio boundary is deterministic and does not quarantine"
  );
  assert.equal(assessCanonicalSnapshot(20, 9).status, "quarantined");
  assert.equal(assessCanonicalSnapshot(100, 95).status, "accepted");

  const largeBoard = Array.from({ length: 100 }, (_, index) => ({
    id: `job-${index}`,
    externalId: String(index),
    status: "verified_open",
  }));
  const quarantined = planCanonicalClosures(largeBoard, ["0"]);
  assert.equal(quarantined.assessment.status, "quarantined");
  assert.deepEqual(quarantined.closingJobIds, []);
  assert.deepEqual(quarantined.closingExternalIds, []);

  const ordinaryBoard = largeBoard.slice(0, 10);
  const ordinary = planCanonicalClosures(
    ordinaryBoard,
    ordinaryBoard.slice(0, 9).map((job) => job.externalId)
  );
  assert.equal(ordinary.assessment.status, "accepted");
  assert.deepEqual(ordinary.closingJobIds, ["job-9"]);
  assert.deepEqual(ordinary.closingExternalIds, ["9"]);
});

test("new source IDs cannot disguise a mass disappearance of existing jobs", () => {
  const existing = Array.from({ length: 100 }, (_, index) => ({
    id: `job-existing-${index}`,
    externalId: `existing-${index}`,
    status: "verified_open",
  }));
  const observed = [
    "existing-0",
    ...Array.from({ length: 99 }, (_, index) => `replacement-${index}`),
  ];
  const plan = planCanonicalClosures(existing, observed);
  assert.equal(plan.assessment.status, "quarantined");
  assert.equal(plan.assessment.observedOpenCount, 100);
  assert.equal(plan.assessment.missingCount, 99);
  assert.equal(plan.assessment.missingRatio, 0.99);
  assert.deepEqual(plan.closingJobIds, []);
});

test("snapshot fingerprints are stable, order-independent, and identity-set-sensitive", () => {
  assert.equal(snapshotFingerprint(["b", "a", "a"]), snapshotFingerprint(["a", "b"]));
  assert.notEqual(snapshotFingerprint(["a", "b"]), snapshotFingerprint(["a", "c"]));
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
  assert.equal(
    INVESTOR_SOURCE_SEEDS.filter((source) => source.access === "public_page").length,
    0,
    "current terms review leaves no investor portfolio approved for automated ingestion"
  );
  for (const sourceId of ["general-catalyst", "sequoia"]) {
    const source = INVESTOR_SOURCE_SEEDS.find((item) => item.id === sourceId);
    assert.equal(source?.access, "awaiting_permission");
    assert.match(source?.termsUrl || "", /^https:\/\//);
  }
});
