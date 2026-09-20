import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildEdtechAgentJobsPayload,
  parseEdtechAgentParams,
  queryEdtechAgent,
  toEdtechAgentPublicJob,
} from "../lib/edtech-agent";
import {
  ingestEdtechBoardSnapshot,
  resolveEdtechFetch,
  toCompactEdtechJob,
} from "../lib/edtech-ingest";
import {
  assertValidEdtechPack,
  containsDisallowedHost,
  DISALLOWED_PACK_HOSTS,
  loadOtherPack,
  validateEdtechPack,
} from "../lib/edtech-pack";
import { normalizeAshby } from "../lib/ats-adapters";
import type { EdtechPackRow } from "../lib/edtech-pack";

const root = process.cwd();
const fixtures = path.join(root, "evals", "fixtures", "edtech-ingest");
const read = (file: string) => readFile(path.join(root, file), "utf8");
const readJson = async (name: string) =>
  JSON.parse(await readFile(path.join(fixtures, name), "utf8")) as unknown;

const courseraBoard: EdtechPackRow = {
  name: "Coursera",
  website: "https://example.test/coursera",
  provider: "greenhouse",
  board_id: "coursera",
  evidence_url: "https://boards-api.greenhouse.io/v1/boards/coursera/jobs?content=true",
  vertical: "edtech",
};

const rampBoard: EdtechPackRow = {
  name: "Ramp",
  website: "https://ramp.com/",
  provider: "ashby",
  board_id: "ramp",
  evidence_url: "https://api.ashbyhq.com/posting-api/job-board/ramp",
  vertical: "other",
  employer_kind: "fintech",
};

const now = "2026-09-20T00:00:00.000Z";
const runId = "all-types-ingest-test";

function compactJob(
  board: EdtechPackRow,
  externalId: string,
  title: string,
  roleFamily: string
) {
  return toCompactEdtechJob(
    {
      externalId,
      title,
      roleFamily,
      location: "Remote - US",
      remoteStatus: "Remote",
      employmentType: "Full-time",
      compensation: "See posting",
      canonicalUrl: `https://jobs.ashbyhq.com/${board.board_id}/${externalId}`,
      publishedAt: now,
      description: "Posting body that must not leak into compact rows.",
      summary: "Summary",
    },
    board
  );
}

test("non-edtech ashby fixture ingests through the same ingestEdtechBoardSnapshot path", async () => {
  const jobs = normalizeAshby(await readJson("ashby-mixed.json"));
  const fetch = resolveEdtechFetch({ jobs }, null);
  assert.equal(fetch.complete, true);
  const result = ingestEdtechBoardSnapshot({
    board: rampBoard,
    previous: { jobs: [] },
    fetch,
    now,
    runId,
  });
  assert.equal(result.status, "success");
  assert.equal(result.jobs.length, jobs.length);
  for (const job of result.jobs) {
    assert.equal(job.vertical, "other");
    assert.equal(job.board_id, "ramp");
    assert.equal("description" in job, false);
    assert.match(job.canonical_url, /^https:\/\/jobs\.ashbyhq\.com\//);
    assert.equal(job.apply_url, job.canonical_url);
  }
});

test("other pack parses with LastRound-confirmed non-education employers", async () => {
  const pack = await loadOtherPack();
  assert.equal(pack.vertical, "other");
  assert.equal(pack.rows.length, 4);
  const boardIds = new Set(pack.rows.map((row) => row.board_id));
  assert.ok(boardIds.has("ramp"));
  assert.ok(boardIds.has("vanta"));
  assert.ok(boardIds.has("cognition"));
  assert.ok(boardIds.has("harvey"));
  for (const row of pack.rows) {
    assert.equal(row.vertical, "other");
    assert.equal(containsDisallowedHost(row.website), false);
    assert.equal(containsDisallowedHost(row.evidence_url), false);
  }
  assertValidEdtechPack(pack);
});

test("queryEdtechAgent with vertical=all returns edtech and other boards", () => {
  const store = {
    jobs: [
      compactJob(courseraBoard, "1", "Curriculum Specialist", "Other"),
      compactJob(rampBoard, "ashby-eng", "Software Engineer", "Engineering"),
    ],
  };
  const result = queryEdtechAgent(store, {
    boardIds: ["coursera", "ramp"],
    titles: [],
    roleFamilies: [],
    vertical: "all",
  });
  assert.equal(result.count, 2);
  assert.deepEqual(
    [...new Set(result.jobs.map((job) => job.vertical))].sort(),
    ["edtech", "other"]
  );
});

test("queryEdtechAgent with default vertical=edtech excludes other boards", () => {
  const store = {
    jobs: [
      compactJob(courseraBoard, "1", "Curriculum Specialist", "Other"),
      compactJob(rampBoard, "ashby-eng", "Software Engineer", "Engineering"),
    ],
  };
  const filters = parseEdtechAgentParams(
    new URLSearchParams("boards=coursera,ramp&titles=engineer")
  );
  assert.equal(filters.vertical, "edtech");
  const result = queryEdtechAgent(store, filters);
  assert.equal(result.count, 0);
  assert.ok(!result.jobs.some((job) => job.boardId === "ramp"));
});

test("buildEdtechAgentJobsPayload applies vertical=all across board and title filters", () => {
  const store = {
    jobs: [
      compactJob(courseraBoard, "1", "Software Engineer", "Engineering"),
      compactJob(rampBoard, "ashby-eng", "Software Engineer", "Engineering"),
    ],
  };
  const payload = buildEdtechAgentJobsPayload(
    new URLSearchParams("boards=coursera,ramp&titles=engineer&vertical=all"),
    store,
    now
  );
  assert.equal(payload.count, 2);
  assert.equal(payload.vertical, "all");
  assert.equal(payload.applied_filters.vertical, "all");
  for (const job of payload.jobs) {
    assert.equal("description" in job, false);
    assert.equal(job.applyUrl, job.canonicalUrl);
  }
});

test("non-edtech snapshot set-diff still closes missing jobs via planCanonicalClosures", async () => {
  const jobs = normalizeAshby(await readJson("ashby-mixed.json"));
  const first = ingestEdtechBoardSnapshot({
    board: rampBoard,
    previous: { jobs: [] },
    fetch: resolveEdtechFetch({ jobs }, null),
    now,
    runId,
  });
  const secondJobs = jobs.filter((job) => job.externalId !== "ashby-ops");
  const second = ingestEdtechBoardSnapshot({
    board: rampBoard,
    previous: { jobs: first.jobs },
    fetch: resolveEdtechFetch({ jobs: secondJobs }, null),
    now: "2026-09-21T00:00:00.000Z",
    runId: "all-types-close",
  });
  assert.equal(second.status, "success");
  assert.equal(second.closed, 1);
  assert.equal(
    second.jobs.find((job) => job.external_id === "ashby-ops")?.status,
    "verified_closed"
  );
});

test("ingest CLI accepts --pack=edtech|other|all without a second crawler", async () => {
  const scriptSource = await read("scripts/ingest-edtech-pack.ts");
  assert.match(scriptSource, /--pack=\(edtech\|other\|all\)/);
  assert.match(scriptSource, /loadIngestPack/);
  assert.doesNotMatch(scriptSource, /linkedin\.com|indeed\.com|glassdoor\.com|wellfound\.com|crunchbase\.com/i);
});

test("gate 5 code and other pack avoid disallowed scrape hosts", async () => {
  const otherPack = await loadOtherPack();
  for (const row of otherPack.rows) {
    assert.equal(containsDisallowedHost(row.website), false);
    assert.equal(containsDisallowedHost(row.evidence_url), false);
  }
  const ingestSource = await read("lib/edtech-ingest.ts");
  const agentSource = await read("lib/edtech-agent.ts");
  for (const host of DISALLOWED_PACK_HOSTS) {
    const pattern = new RegExp(host.replace(/\./g, "\\."), "i");
    assert.doesNotMatch(ingestSource, pattern, `edtech-ingest must not reference ${host}`);
    assert.doesNotMatch(agentSource, pattern, `edtech-agent must not reference ${host}`);
  }
});

test("other pack validation rejects wrong vertical rows", () => {
  const issues = validateEdtechPack({
    schemaVersion: "1.0",
    vertical: "other",
    generatedAt: now,
    reviewRule: "test",
    attribution: {
      lastround: "test",
      lastroundLicense: "CC BY 4.0",
      lastroundUrl: "https://example.com",
    },
    rows: [{
      name: "Ramp",
      website: "https://ramp.com/",
      provider: "ashby",
      board_id: "ramp",
      evidence_url: "https://api.ashbyhq.com/posting-api/job-board/ramp",
      vertical: "edtech",
    }],
  });
  assert.ok(issues.some((issue) => issue.code === "vertical"));
});

test("README and llms.txt document boards, titles, and vertical filters", async () => {
  const readme = await read("README.md");
  const llms = await read("app/llms.txt/route.ts");
  assert.match(readme, /vertical=edtech\|other\|all/);
  assert.match(readme, /packs\/other\.json/);
  assert.match(readme, /ramp|vanta|cognition|harvey/i);
  assert.match(llms, /vertical=edtech\|other\|all/);
  assert.match(llms, /boards=coursera,duolingo/);
  assert.match(llms, /titles=/);
});

test("daily edtech pack workflow stays bounded and can ingest all reviewed packs", async () => {
  const workflow = await read(".github/workflows/daily-edtech-pack.yml");
  assert.match(workflow, /cron:\s*["']15 8 \* \* \*["']/);
  assert.doesNotMatch(workflow, /\*\/2 \* \* \*/);
  assert.match(workflow, /timeout-minutes:\s*(?:30|45|60)/);
  assert.match(workflow, /pnpm ingest:edtech --pack=all --concurrency=6/);
});

test("compact other vertical agent rows omit description", () => {
  const job = toEdtechAgentPublicJob(compactJob(rampBoard, "ashby-eng", "Software Engineer", "Engineering"));
  assert.equal("description" in job, false);
  assert.equal(job.vertical, "other");
  assert.equal(job.applyUrl, job.canonicalUrl);
});
