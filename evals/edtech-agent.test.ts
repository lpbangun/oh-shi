import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildEdtechAgentJobsPayload,
  EdtechAgentError,
  parseEdtechAgentParams,
  queryEdtechAgent,
  toEdtechAgentPublicJob,
} from "../lib/edtech-agent";
import { toCompactEdtechJob } from "../lib/edtech-ingest";
import type { EdtechPackRow } from "../lib/edtech-pack";

const root = process.cwd();
const read = (file: string) => readFile(path.join(root, file), "utf8");

const courseraBoard: EdtechPackRow = {
  name: "Coursera",
  website: "https://example.test/coursera",
  provider: "greenhouse",
  board_id: "coursera",
  evidence_url: "https://boards-api.greenhouse.io/v1/boards/coursera/jobs?content=true",
  vertical: "edtech",
};

const duolingoBoard: EdtechPackRow = {
  name: "Duolingo",
  website: "https://example.test/duolingo",
  provider: "greenhouse",
  board_id: "duolingo",
  evidence_url: "https://boards-api.greenhouse.io/v1/boards/duolingo/jobs?content=true",
  vertical: "edtech",
};

const khanBoard: EdtechPackRow = {
  name: "Khan Academy",
  website: "https://example.test/khan",
  provider: "greenhouse",
  board_id: "khanacademy",
  evidence_url: "https://boards-api.greenhouse.io/v1/boards/khanacademy/jobs?content=true",
  vertical: "edtech",
};

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
      canonicalUrl: `https://boards.greenhouse.io/${board.board_id}/jobs/${externalId}`,
      publishedAt: "2026-09-20T00:00:00.000Z",
      description: "Posting body that must not leak into compact rows.",
      summary: "Summary",
    },
    board
  );
}

const fixtureStore = {
  jobs: [
    compactJob(courseraBoard, "1", "Curriculum Specialist", "Other"),
    compactJob(courseraBoard, "2", "Software Engineer", "Engineering"),
    compactJob(duolingoBoard, "3", "Account Executive", "GTM"),
    compactJob(khanBoard, "4", "Software Engineer", "Engineering"),
  ],
};

test("queryEdtechAgent returns count first and excludes unrequested boards", () => {
  const result = queryEdtechAgent(fixtureStore, {
    boardIds: ["coursera", "duolingo"],
    titles: [],
    roleFamilies: [],
  });
  assert.equal(result.count, 3);
  assert.equal(result.jobs.length, 3);
  assert.deepEqual(
    [...new Set(result.jobs.map((job) => job.boardId))].sort(),
    ["coursera", "duolingo"]
  );
  assert.ok(!result.jobs.some((job) => job.boardId === "khanacademy"));
});

test("queryEdtechAgent filters by title and role family", () => {
  const byTitle = queryEdtechAgent(fixtureStore, {
    boardIds: ["coursera", "duolingo"],
    titles: ["engineer"],
    roleFamilies: [],
  });
  assert.equal(byTitle.count, 1);
  assert.equal(byTitle.jobs[0]?.title, "Software Engineer");

  const byFamily = queryEdtechAgent(fixtureStore, {
    boardIds: ["coursera", "duolingo"],
    titles: [],
    roleFamilies: ["GTM"],
  });
  assert.equal(byFamily.count, 1);
  assert.equal(byFamily.jobs[0]?.title, "Account Executive");
});

test("compact agent rows omit description and keep employer ATS URLs", () => {
  const job = toEdtechAgentPublicJob(fixtureStore.jobs[0]);
  assert.equal("description" in job, false);
  assert.match(job.canonicalUrl, /^https:\/\/boards\.greenhouse\.io\//);
  assert.equal(job.applyUrl, job.canonicalUrl);
  assert.equal(job.vertical, "edtech");
});

test("buildEdtechAgentJobsPayload returns empty results for empty boards", () => {
  const payload = buildEdtechAgentJobsPayload(
    new URLSearchParams("boards="),
    fixtureStore,
    "2026-09-20T00:00:00.000Z"
  );
  assert.equal(payload.count, 0);
  assert.deepEqual(payload.jobs, []);
  assert.equal(payload.incremental.changes_url, "/api/v1/changes?after=2026-09-20T00%3A00%3A00.000Z");
});

test("buildEdtechAgentJobsPayload rejects unknown and invalid parameters", () => {
  assert.throws(
    () => buildEdtechAgentJobsPayload(new URLSearchParams("boards=coursera&bogus=1"), fixtureStore),
    (error: unknown) => error instanceof EdtechAgentError && /Unknown parameter/.test(error.message)
  );
  assert.throws(
    () => parseEdtechAgentParams(new URLSearchParams("boards=bad board")),
    (error: unknown) => error instanceof EdtechAgentError && /Invalid board id/.test(error.message)
  );
  assert.throws(
    () => buildEdtechAgentJobsPayload(new URLSearchParams("titles=engineer"), fixtureStore),
    (error: unknown) => error instanceof EdtechAgentError && /boards/.test(error.message)
  );
});

test("buildEdtechAgentJobsPayload supports comma and repeated board parameters", () => {
  const comma = buildEdtechAgentJobsPayload(
    new URLSearchParams("boards=coursera,duolingo&titles=engineer,account"),
    fixtureStore,
    "2026-09-20T00:00:00.000Z"
  );
  assert.equal(comma.count, 2);
  const repeated = buildEdtechAgentJobsPayload(
    new URLSearchParams("boards=coursera&boards=duolingo"),
    fixtureStore,
    "2026-09-20T00:00:00.000Z"
  );
  assert.equal(repeated.count, 3);
});

test("daily edtech pack workflow exists with bounded daily ingest", async () => {
  const workflow = await read(".github/workflows/daily-edtech-pack.yml");
  assert.match(workflow, /cron:\s*["']15 8 \* \* \*["']/);
  assert.doesNotMatch(workflow, /\*\/2 \* \* \*/);
  assert.match(workflow, /timeout-minutes:\s*(?:30|45|60)/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm ingest:edtech --concurrency=6/);
  assert.match(workflow, /upload-artifact@v(?:[4-9]|\d{2,})/);
});

test("ingest CLI still avoids cloudflare worker refresh imports", async () => {
  const scriptSource = await read("scripts/ingest-edtech-pack.ts");
  assert.doesNotMatch(scriptSource, /lib\/refresh/);
  assert.doesNotMatch(scriptSource, /cloudflare:workers/);
});

test("agent jobs route is a public GET surface without auth", async () => {
  const source = await read("app/api/v1/agent/jobs/route.ts");
  assert.match(source, /export async function GET/);
  assert.doesNotMatch(source, /authorization|INGEST_TOKEN/i);
  assert.match(source, /buildEdtechAgentJobsPayload/);
  assert.match(source, /conditionalJsonResponse/);
});
