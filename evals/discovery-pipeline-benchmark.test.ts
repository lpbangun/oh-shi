import assert from "node:assert/strict";
import test from "node:test";
import {
  boardNameMatches,
  probeAtsBySlug,
  slugCandidates,
} from "../lib/ats-slug-probe";
import {
  employerJobConcentration,
  largestEmployerShareWithinLimit,
} from "../lib/data-quality-audit";
import {
  buildStartupDomainPilot,
  MAX_PILOT_DOMAINS,
  type StartupDomainEvidenceInput,
} from "../lib/domain-registry";
import {
  type YcCompany,
  ycEvidenceInputs,
} from "../lib/startup-directory";

const OBSERVED_AT = "2026-07-31T12:00:00.000Z";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function notFound() {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

function greenhouseJobs() {
  return {
    jobs: [{
      id: 101,
      title: "Platform Engineer",
      absolute_url: "https://boards.greenhouse.io/acme/jobs/101",
    }],
  };
}

function leverJobs() {
  return [{
    id: "lev-1",
    text: "Platform Engineer",
    hostedUrl: "https://jobs.lever.co/acme/lev-1",
  }];
}

function ashbyJobs() {
  return {
    jobs: [{
      id: "ash-1",
      title: "Platform Engineer",
      jobUrl: "https://jobs.ashbyhq.com/acme/ash-1",
    }],
  };
}

// ---------------------------------------------------------------------------
// A. ycEvidenceInputs
// ---------------------------------------------------------------------------

test("ycEvidenceInputs drops non-active companies and incomplete entries", () => {
  const companies: YcCompany[] = [
    {
      name: "Active Co",
      slug: "active-co",
      website: "https://active.co",
      status: "Active",
      batch: "W24",
    },
    {
      name: "Dead Co",
      slug: "dead-co",
      website: "https://dead.co",
      status: "Inactive",
      batch: "W20",
    },
    {
      name: "Acquired Co",
      slug: "acquired-co",
      website: "https://acquired.co",
      status: "Acquired",
      batch: "S19",
    },
    {
      name: "No Slug",
      website: "https://noslug.co",
      status: "Active",
    },
    {
      slug: "no-name",
      website: "https://noname.co",
      status: "Active",
    },
    {
      name: "No Website",
      slug: "no-website",
      status: "Active",
    },
    {
      name: "Blank Fields",
      slug: "   ",
      website: "https://blank.co",
      status: "Active",
    },
  ];
  const inputs = ycEvidenceInputs(companies, OBSERVED_AT);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].companyName, "Active Co");
  assert.equal(inputs[0].sourceId, "yc:active-co");
});

test("ycEvidenceInputs upgrades http to https, rejects non-https, and dedups by slug", () => {
  const companies: YcCompany[] = [
    {
      name: "Http Co",
      slug: "http-co",
      website: "http://http.co/careers",
      status: "active",
    },
    {
      name: "Ftp Co",
      slug: "ftp-co",
      website: "ftp://ftp.co",
      status: "active",
    },
    {
      name: "Relative Co",
      slug: "relative-co",
      website: "relative.co",
      status: "active",
    },
    {
      name: "First",
      slug: "duped",
      website: "https://first.example",
      status: "active",
    },
    {
      name: "Second",
      slug: "duped",
      website: "https://second.example",
      status: "active",
    },
  ];
  const inputs = ycEvidenceInputs(companies, OBSERVED_AT);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].websiteUrl, "https://http.co/careers");
  assert.equal(inputs[1].companyName, "First");
  assert.equal(inputs[1].sourceId, "yc:duped");
});

test("ycEvidenceInputs always emits activity unknown and review pending", () => {
  const companies: YcCompany[] = [
    {
      name: "Recent",
      slug: "recent",
      website: "https://recent.example",
      status: "Active",
      batch: "S23",
    },
    {
      name: "Legacy",
      slug: "legacy",
      website: "https://legacy.example",
      status: "Active",
      batch: "W12",
    },
  ];
  const inputs = ycEvidenceInputs(companies, OBSERVED_AT);
  assert.equal(inputs.length, 2);
  for (const input of inputs) {
    assert.equal(input.activityState, "unknown");
    assert.equal(input.reviewStatus, "pending");
    assert.equal(input.permissionStatus, "permitted");
    assert.equal(input.sourceKind, "ycombinator-oss");
    assert.match(input.evidenceUrl, /^https:\/\/www\.ycombinator\.com\/companies\//);
    assert.match(input.sourceTermsUrl || "", /^https:\/\//);
  }
  assert.equal(inputs[0].sourceClassification, "recent_yc_startup");
  assert.equal(inputs[1].sourceClassification, "yc_startup");
});

// ---------------------------------------------------------------------------
// B. slugCandidates
// ---------------------------------------------------------------------------

test("slugCandidates rejects short and ambiguous tokens, strips hyphens, and dedups", () => {
  assert.deepEqual(slugCandidates("ab.com"), []);
  assert.deepEqual(slugCandidates("ai.com"), []);
  assert.deepEqual(slugCandidates("app.com"), []);
  assert.deepEqual(slugCandidates("labs.com"), []);
  assert.deepEqual(slugCandidates("io.com", ["api", "the", "hq"]), []);

  const hyphenated = slugCandidates("my-startup.com");
  assert.ok(hyphenated.includes("my-startup"));
  assert.ok(hyphenated.includes("mystartup"));
  assert.equal(new Set(hyphenated).size, hyphenated.length);

  const withExtras = slugCandidates("acme.com", ["Acme Inc", "acme", "ACME", "xx"]);
  assert.deepEqual(withExtras, ["acmeinc", "acme"]);
});

// ---------------------------------------------------------------------------
// C. boardNameMatches
// ---------------------------------------------------------------------------

test("boardNameMatches accepts exact and prefix matches; rejects empty and unrelated", () => {
  assert.equal(boardNameMatches("Acme", "Acme Corp", "acme"), true);
  assert.equal(boardNameMatches("Acme Inc", "Other", "acme"), true);
  assert.equal(boardNameMatches("ac", "Other", "acme"), true);
  assert.equal(boardNameMatches("Acme Robotics", "Acme Robotics LLC", "acmerobotics"), true);
  assert.equal(boardNameMatches("Stripe", "Stripe, Inc.", "stripe"), true);

  assert.equal(boardNameMatches("", "Acme", "acme"), false);
  assert.equal(boardNameMatches("   ", "Acme", "acme"), false);
  assert.equal(boardNameMatches("Unrelated Board", "Acme", "acme"), false);
  assert.equal(boardNameMatches("Harvey", "Acme", "acme"), false);
});

// ---------------------------------------------------------------------------
// D. probeAtsBySlug
// ---------------------------------------------------------------------------

test("probeAtsBySlug returns Greenhouse only when the board name corroborates", async () => {
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/v1/boards/acme/jobs")) return jsonResponse(greenhouseJobs());
    if (url === "https://boards-api.greenhouse.io/v1/boards/acme") {
      return jsonResponse({ name: "Acme" });
    }
    return notFound();
  }) as typeof fetch;

  const match = await probeAtsBySlug("acme.com", "Acme", { fetcher });
  assert.deepEqual(match, {
    provider: "greenhouse",
    boardId: "acme",
    careersUrl: "https://job-boards.greenhouse.io/acme",
    confirmedBy: "board_name",
  });
});

test("probeAtsBySlug rejects Greenhouse when the board name is a collision", async () => {
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/v1/boards/acme/jobs")) return jsonResponse(greenhouseJobs());
    if (url === "https://boards-api.greenhouse.io/v1/boards/acme") {
      return jsonResponse({ name: "Unrelated Employer" });
    }
    return notFound();
  }) as typeof fetch;

  const match = await probeAtsBySlug("acme.com", "Acme", { fetcher });
  assert.equal(match, null);
});

test("probeAtsBySlug never matches an empty Greenhouse board name", async () => {
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/v1/boards/acme/jobs")) return jsonResponse(greenhouseJobs());
    if (url === "https://boards-api.greenhouse.io/v1/boards/acme") {
      return jsonResponse({ name: "" });
    }
    return notFound();
  }) as typeof fetch;

  assert.equal(await probeAtsBySlug("acme.com", "Acme", { fetcher }), null);
});

test("probeAtsBySlug returns Lever or Ashby only when slug equals the domain label", async () => {
  const leverFetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://api.lever.co/v0/postings/acme?")) {
      return jsonResponse(leverJobs());
    }
    return notFound();
  }) as typeof fetch;
  const lever = await probeAtsBySlug("acme.com", "Acme", { fetcher: leverFetcher });
  assert.deepEqual(lever, {
    provider: "lever",
    boardId: "acme",
    careersUrl: "https://jobs.lever.co/acme",
    confirmedBy: "board_url",
  });

  const ashbyFetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.ashbyhq.com/posting-api/job-board/acme")) {
      return jsonResponse(ashbyJobs());
    }
    return notFound();
  }) as typeof fetch;
  const ashby = await probeAtsBySlug("acme.com", "Acme", { fetcher: ashbyFetcher });
  assert.deepEqual(ashby, {
    provider: "ashby",
    boardId: "acme",
    careersUrl: "https://jobs.ashbyhq.com/acme",
    confirmedBy: "board_url",
  });

  // Alias slug that is not the domain label must not activate Lever/Ashby.
  const aliasOnly = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("postings/acmeinc") || url.includes("job-board/acmeinc")) {
      return jsonResponse(leverJobs());
    }
    return notFound();
  }) as typeof fetch;
  assert.equal(
    await probeAtsBySlug("acme.com", "Acme", {
      fetcher: aliasOnly,
      extraSlugs: ["acmeinc"],
    }),
    null
  );
});

test("probeAtsBySlug returns null when every endpoint 404s", async () => {
  const fetcher = (async () => notFound()) as typeof fetch;
  assert.equal(await probeAtsBySlug("missing.com", "Missing", { fetcher }), null);
});

// ---------------------------------------------------------------------------
// E. buildStartupDomainPilot scale + MAX_PILOT_DOMAINS
// ---------------------------------------------------------------------------

function pilotInput(index: number): StartupDomainEvidenceInput {
  return {
    companyName: `Scale Co ${index}`,
    websiteUrl: `https://scale-co-${index}.com/`,
    sourceId: `yc:scale-co-${index}`,
    sourceKind: "ycombinator-oss",
    sourceClassification: "recent_yc_startup",
    evidenceUrl: `https://www.ycombinator.com/companies/scale-co-${index}`,
    permissionStatus: "permitted",
    sourceTermsUrl: "https://github.com/yc-oss/api",
    observedAt: OBSERVED_AT,
    activityState: "unknown",
    reviewStatus: "pending",
  };
}

test("buildStartupDomainPilot accepts more than 500 domains and honors MAX_PILOT_DOMAINS", () => {
  const inputs = Array.from({ length: 600 }, (_, index) => pilotInput(index));
  const pilot = buildStartupDomainPilot(inputs, 600, "benchmark-cohort");
  assert.equal(pilot.receipt.accepted, 600);
  assert.equal(pilot.entries.length, 600);
  assert.equal(pilot.receipt.limit, 600);
  assert.equal(pilot.receipt.identityGraphValid, true);
  assert.ok(pilot.receipt.accepted > 500, "old hard cap of 500 must not apply");

  const overMax = buildStartupDomainPilot(inputs, 100_000, "benchmark-cohort");
  assert.equal(overMax.receipt.limit, MAX_PILOT_DOMAINS);
  assert.equal(MAX_PILOT_DOMAINS, 25_000);
  assert.ok(MAX_PILOT_DOMAINS > 500);
  assert.equal(overMax.receipt.accepted, 600);

  const emptyOverMax = buildStartupDomainPilot([], 50_000);
  assert.equal(emptyOverMax.receipt.limit, MAX_PILOT_DOMAINS);
  assert.equal(emptyOverMax.receipt.accepted, 0);
});

// ---------------------------------------------------------------------------
// F. Yield benchmark — fixed synthetic cohort, exact detection count
// ---------------------------------------------------------------------------

type SyntheticCompany = {
  domain: string;
  companyName: string;
  /** Public board the fake ATS world exposes for this company, if any. */
  board: null | {
    provider: "greenhouse" | "lever" | "ashby";
    slug: string;
    /** Greenhouse display name; ignored for Lever/Ashby. */
    boardName?: string;
  };
};

/**
 * Fixed 50-company fixture. Boards are intentionally mixed so the slug probe
 * must apply Greenhouse name corroboration and Lever/Ashby domain-label rules.
 *
 * Detectable (exact expected count):
 *   - greenhouse matching name: 12
 *   - lever domain-label: 8
 *   - ashby domain-label: 5
 * Total expected detections: 25
 *
 * Intentionally not detectable:
 *   - greenhouse name collision: 5
 *   - lever/ashby only under non-domain alias: 4
 *   - no board at all: 16
 */
const YIELD_FIXTURE: SyntheticCompany[] = [
  // 12 Greenhouse matches (name corroborates)
  ...Array.from({ length: 12 }, (_, i) => ({
    domain: `gh-match-${i}.com`,
    companyName: `GH Match ${i}`,
    board: {
      provider: "greenhouse" as const,
      slug: `gh-match-${i}`,
      boardName: `GH Match ${i}`,
    },
  })),
  // 5 Greenhouse collisions (live board, wrong employer name)
  ...Array.from({ length: 5 }, (_, i) => ({
    domain: `gh-collide-${i}.com`,
    companyName: `GH Collide ${i}`,
    board: {
      provider: "greenhouse" as const,
      slug: `gh-collide-${i}`,
      boardName: `Unrelated Board ${i}`,
    },
  })),
  // 8 Lever matches (slug == domain label)
  ...Array.from({ length: 8 }, (_, i) => ({
    domain: `lever-match-${i}.com`,
    companyName: `Lever Match ${i}`,
    board: { provider: "lever" as const, slug: `lever-match-${i}` },
  })),
  // 5 Ashby matches
  ...Array.from({ length: 5 }, (_, i) => ({
    domain: `ashby-match-${i}.com`,
    companyName: `Ashby Match ${i}`,
    board: { provider: "ashby" as const, slug: `ashby-match-${i}` },
  })),
  // 4 boards only under an alias slug (Lever/Ashby domain-label rule rejects)
  ...Array.from({ length: 4 }, (_, i) => ({
    domain: `alias-only-${i}.com`,
    companyName: `Alias Only ${i}`,
    board: {
      provider: (i % 2 === 0 ? "lever" : "ashby") as "lever" | "ashby",
      slug: `alias-board-${i}`,
    },
  })),
  // 16 with no board
  ...Array.from({ length: 16 }, (_, i) => ({
    domain: `no-board-${i}.com`,
    companyName: `No Board ${i}`,
    board: null,
  })),
];

const EXPECTED_YIELD_DETECTIONS = 12 + 8 + 5;

function fixtureBoardMap() {
  const map = new Map<string, SyntheticCompany["board"]>();
  for (const company of YIELD_FIXTURE) {
    if (!company.board) continue;
    map.set(`${company.board.provider}:${company.board.slug}`, company.board);
  }
  return map;
}

function yieldFetcher(): typeof fetch {
  const boards = fixtureBoardMap();
  return (async (input: string | URL | Request) => {
    const url = String(input);

    const greenhouseJobsMatch = url.match(
      /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs/
    );
    if (greenhouseJobsMatch) {
      const board = boards.get(`greenhouse:${decodeURIComponent(greenhouseJobsMatch[1])}`);
      return board?.provider === "greenhouse"
        ? jsonResponse(greenhouseJobs())
        : notFound();
    }
    const greenhouseBoardMatch = url.match(
      /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/?]+)$/
    );
    if (greenhouseBoardMatch) {
      const board = boards.get(`greenhouse:${decodeURIComponent(greenhouseBoardMatch[1])}`);
      return board?.provider === "greenhouse"
        ? jsonResponse({ name: board.boardName || "" })
        : notFound();
    }
    const leverMatch = url.match(
      /^https:\/\/api\.lever\.co\/v0\/postings\/([^?]+)/
    );
    if (leverMatch) {
      const board = boards.get(`lever:${decodeURIComponent(leverMatch[1])}`);
      return board?.provider === "lever" ? jsonResponse(leverJobs()) : notFound();
    }
    const ashbyMatch = url.match(
      /^https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/([^/?]+)/
    );
    if (ashbyMatch) {
      const board = boards.get(`ashby:${decodeURIComponent(ashbyMatch[1])}`);
      return board?.provider === "ashby" ? jsonResponse(ashbyJobs()) : notFound();
    }
    return notFound();
  }) as typeof fetch;
}

test("yield benchmark: slug-probe detection count matches the fixture-derived floor exactly", async () => {
  assert.equal(YIELD_FIXTURE.length, 50, "fixture must stay a fixed 50-company cohort");
  assert.equal(EXPECTED_YIELD_DETECTIONS, 25);

  const fetcher = yieldFetcher();
  const detections: Array<{ domain: string; provider: string; boardId: string }> = [];
  for (const company of YIELD_FIXTURE) {
    const extraSlugs = company.board && company.board.slug !== company.domain.split(".")[0]
      ? [company.board.slug]
      : [];
    const match = await probeAtsBySlug(company.domain, company.companyName, {
      fetcher,
      extraSlugs,
    });
    if (match) {
      detections.push({
        domain: company.domain,
        provider: match.provider,
        boardId: match.boardId,
      });
    }
  }

  // Exact fixture-derived count — not a soft rate that can drift.
  assert.equal(detections.length, EXPECTED_YIELD_DETECTIONS);
  assert.equal(
    detections.filter((item) => item.provider === "greenhouse").length,
    12
  );
  assert.equal(detections.filter((item) => item.provider === "lever").length, 8);
  assert.equal(detections.filter((item) => item.provider === "ashby").length, 5);

  // Collision and alias-only companies must never activate.
  for (const company of YIELD_FIXTURE) {
    if (!company.board) continue;
    if (company.board.provider === "greenhouse" && company.board.boardName?.startsWith("Unrelated")) {
      assert.ok(
        !detections.some((item) => item.domain === company.domain),
        `collision board must not activate ${company.domain}`
      );
    }
    if (company.domain.startsWith("alias-only-")) {
      assert.ok(
        !detections.some((item) => item.domain === company.domain),
        `alias-only board must not activate ${company.domain}`
      );
    }
  }

  const detectionRate = detections.length / YIELD_FIXTURE.length;
  assert.ok(detectionRate >= 0.5, `detection rate ${detectionRate} below 50% floor`);
  assert.equal(detectionRate, EXPECTED_YIELD_DETECTIONS / 50);
});

// ---------------------------------------------------------------------------
// G. Concentration benchmark
// ---------------------------------------------------------------------------

test("employer concentration helper ranks shares and enforces a max single-company threshold", () => {
  // Mirrors the production failure mode: one employer holding ~47.6% of jobs.
  const concentrated = employerJobConcentration([
    { companyId: "harvey", jobCount: 476 },
    { companyId: "vanta", jobCount: 200 },
    { companyId: "ramp", jobCount: 150 },
    { companyId: "watershed", jobCount: 100 },
    { companyId: "other", jobCount: 74 },
  ]);
  assert.equal(concentrated.totalJobs, 1000);
  assert.equal(concentrated.companyCount, 5);
  assert.equal(concentrated.largest?.companyId, "harvey");
  assert.equal(concentrated.largest?.jobCount, 476);
  assert.ok(Math.abs((concentrated.largest?.share || 0) - 0.476) < 1e-12);
  assert.equal(largestEmployerShareWithinLimit(concentrated.shares, 0.2), false);
  assert.equal(largestEmployerShareWithinLimit([
    { companyId: "harvey", jobCount: 476 },
    { companyId: "vanta", jobCount: 200 },
    { companyId: "ramp", jobCount: 150 },
    { companyId: "watershed", jobCount: 100 },
    { companyId: "other", jobCount: 74 },
  ], 0.2), false);

  // Healthy breadth: no company above 20%.
  const healthyCounts = [
    { companyId: "a", jobCount: 18 },
    { companyId: "b", jobCount: 17 },
    { companyId: "c", jobCount: 16 },
    { companyId: "d", jobCount: 15 },
    { companyId: "e", jobCount: 14 },
    { companyId: "f", jobCount: 12 },
    { companyId: "g", jobCount: 8 },
  ];
  const healthy = employerJobConcentration(healthyCounts);
  assert.equal(healthy.totalJobs, 100);
  assert.ok((healthy.largest?.share || 1) <= 0.2);
  assert.equal(largestEmployerShareWithinLimit(healthyCounts, 0.2), true);
  assert.equal(largestEmployerShareWithinLimit(healthyCounts, 0.15), false);

  // Empty / invalid inputs fail closed to zero inventory.
  assert.deepEqual(employerJobConcentration([]), {
    totalJobs: 0,
    companyCount: 0,
    largest: null,
    shares: [],
  });
  assert.equal(largestEmployerShareWithinLimit([], 0.2), true);
  assert.equal(largestEmployerShareWithinLimit(healthyCounts, 0), false);
  assert.equal(largestEmployerShareWithinLimit(healthyCounts, Number.NaN), false);

  // Duplicate company rows merge before share calculation.
  const merged = employerJobConcentration([
    { companyId: "a", jobCount: 10 },
    { companyId: "a", jobCount: 15 },
    { companyId: "b", jobCount: 25 },
  ]);
  assert.equal(merged.totalJobs, 50);
  assert.equal(merged.companyCount, 2);
  assert.equal(merged.largest?.companyId, "a");
  assert.equal(merged.largest?.jobCount, 25);
  assert.equal(merged.largest?.share, 0.5);
});
