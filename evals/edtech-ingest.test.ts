import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CanonicalHttpError,
  normalizeAshby,
  normalizeGreenhouse,
  normalizeLever,
} from "../lib/ats-adapters";
import { DISALLOWED_PACK_HOSTS } from "../lib/edtech-pack";
import {
  edtechJobId,
  filterCompactJobs,
  ingestEdtechBoardSnapshot,
  loadPreviousEdtechSnapshot,
  resolveEdtechFetch,
  toCompactEdtechJob,
  type CompactEdtechJob,
  type EdtechBoardSnapshotStore,
} from "../lib/edtech-ingest";
import type { EdtechPackRow } from "../lib/edtech-pack";

const root = process.cwd();
const fixtures = path.join(root, "evals", "fixtures", "edtech-ingest");
const readJson = async (name: string) =>
  JSON.parse(await readFile(path.join(fixtures, name), "utf8")) as unknown;

const greenhouseBoard: EdtechPackRow = {
  name: "Edtech Demo",
  website: "https://example-edtech.test/",
  provider: "greenhouse",
  board_id: "edtech-demo",
  evidence_url: "https://boards-api.greenhouse.io/v1/boards/edtech-demo/jobs?content=true",
  vertical: "edtech",
  employer_kind: "lms",
};

const now = "2026-09-20T00:00:00.000Z";
const runId = "edtech-ingest-test";

async function greenhouseSnapshot() {
  return normalizeGreenhouse(await readJson("greenhouse-mixed.json"));
}

test("mixed-role greenhouse fixture ingest stores every hiring lane", async () => {
  const payload = await readJson("greenhouse-mixed.json");
  const jobs = normalizeGreenhouse(payload);
  const fetch = resolveEdtechFetch({ jobs }, null);
  assert.equal(fetch.complete, true);
  const result = ingestEdtechBoardSnapshot({
    board: greenhouseBoard,
    previous: { jobs: [] },
    fetch,
    now,
    runId,
  });
  assert.equal(result.status, "success");
  const titles = result.jobs.map((job) => job.title).sort();
  assert.deepEqual(titles, [
    "Account Executive",
    "Curriculum Specialist",
    "Customer Success Manager",
    "Design Intern",
    "Operations Manager",
    "Software Engineer",
  ]);
  const families = new Set(result.jobs.map((job) => job.role_family));
  assert.ok(families.has("GTM"));
  assert.ok(families.has("Other"));
  assert.ok(families.has("Operations"));
  assert.ok(families.has("Engineering"));
  assert.ok(families.has("Product"));
  assert.equal(
    result.jobs.find((job) => job.title === "Instructional Designer"),
    undefined,
    "fixture is greenhouse-first; instructional titles are covered in lever fixture"
  );
});

test("lever and ashby fixtures normalize mixed edtech roles", async () => {
  const leverJobs = normalizeLever(await readJson("lever-mixed.json"));
  assert.ok(leverJobs.some((job) => job.title === "Instructional Designer"));
  assert.equal(
    leverJobs.find((job) => job.title === "Instructional Designer")?.roleFamily,
    "Other"
  );
  const ashbyJobs = normalizeAshby(await readJson("ashby-mixed.json"));
  assert.deepEqual(
    ashbyJobs.map((job) => job.title).sort(),
    ["Operations Manager", "Software Engineer"]
  );
});

test("duplicate provider board external id collapses to one compact row", async () => {
  const jobs = await greenhouseSnapshot();
  const duplicate = { ...jobs[0] };
  const fetch = resolveEdtechFetch({ jobs: [...jobs, duplicate] }, null);
  assert.equal(fetch.complete, true);
  assert.equal(fetch.observedExternalIds?.length, jobs.length);
  const result = ingestEdtechBoardSnapshot({
    board: greenhouseBoard,
    previous: { jobs: [] },
    fetch,
    now,
    runId,
  });
  const openForBoard = result.jobs.filter(
    (job) => job.board_id === greenhouseBoard.board_id && job.status === "verified_open"
  );
  assert.equal(openForBoard.length, jobs.length);
});

test("complete snapshot set-diff closes missing jobs and keeps survivors open", async () => {
  const firstFetch = resolveEdtechFetch({ jobs: await greenhouseSnapshot() }, null);
  const first = ingestEdtechBoardSnapshot({
    board: greenhouseBoard,
    previous: { jobs: [] },
    fetch: firstFetch,
    now,
    runId,
  });
  const secondJobs = (await greenhouseSnapshot()).filter((job) => job.externalId !== "106");
  const secondFetch = resolveEdtechFetch({ jobs: secondJobs }, null);
  const second = ingestEdtechBoardSnapshot({
    board: greenhouseBoard,
    previous: { jobs: first.jobs },
    fetch: secondFetch,
    now: "2026-09-21T00:00:00.000Z",
    runId: "edtech-ingest-close",
  });
  assert.equal(second.status, "success");
  assert.equal(second.closed, 1);
  const closed = second.jobs.find((job) => job.external_id === "106");
  assert.equal(closed?.status, "verified_closed");
  assert.equal(
    second.jobs.find((job) => job.external_id === "105")?.status,
    "verified_open"
  );
});

test("incomplete fetch and null observed ids quarantine without closures", async () => {
  const seeded = ingestEdtechBoardSnapshot({
    board: greenhouseBoard,
    previous: { jobs: [] },
    fetch: resolveEdtechFetch({ jobs: await greenhouseSnapshot() }, null),
    now,
    runId,
  });
  const incomplete = ingestEdtechBoardSnapshot({
    board: greenhouseBoard,
    previous: { jobs: seeded.jobs },
    fetch: resolveEdtechFetch(
      null,
      new Error("greenhouse board edtech-demo returned an incomplete payload")
    ),
    now: "2026-09-21T00:00:00.000Z",
    runId: "edtech-ingest-incomplete",
  });
  assert.equal(incomplete.status, "quarantined");
  assert.equal(incomplete.closed, 0);
  assert.equal(
    incomplete.jobs.filter((job) => job.status === "verified_open").length,
    seeded.jobs.length
  );

  const forbidden = ingestEdtechBoardSnapshot({
    board: greenhouseBoard,
    previous: { jobs: seeded.jobs },
    fetch: {
      complete: false,
      status: "quarantined",
      reason: "http_403",
      observedExternalIds: null,
      error: "403",
    },
    now: "2026-09-21T00:00:00.000Z",
    runId: "edtech-ingest-403",
  });
  assert.equal(forbidden.status, "quarantined");
  assert.equal(forbidden.closed, 0);
  const resolved403 = resolveEdtechFetch(null, new CanonicalHttpError(403, null, "forbidden"));
  assert.equal(resolved403.complete, false);
  if (!resolved403.complete) {
    assert.equal(resolved403.status, "quarantined");
  }
});

test("mass-delete guard quarantines large disappearance without closures", () => {
  const previousJobs: CompactEdtechJob[] = Array.from({ length: 25 }, (_, index) =>
    toCompactEdtechJob(
      {
        externalId: String(index),
        title: `Role ${index}`,
        roleFamily: "Other",
        location: "Remote - US",
        remoteStatus: "Remote",
        employmentType: "Full-time",
        compensation: "See posting",
        canonicalUrl: `https://boards.greenhouse.io/edtech-demo/jobs/${index}`,
        publishedAt: now,
        description: "Body that must not appear in compact rows.",
        summary: "Summary",
      },
      greenhouseBoard
    )
  );
  const fetch = resolveEdtechFetch(
    {
      jobs: previousJobs.slice(0, 2).map((job) => ({
        externalId: job.external_id,
        title: job.title,
        roleFamily: job.role_family,
        location: job.location,
        remoteStatus: "Remote",
        employmentType: job.employment_type,
        compensation: "See posting",
        canonicalUrl: job.canonical_url,
        publishedAt: now,
        description: "Posting body",
        summary: "Summary",
      })),
    },
    null
  );
  const result = ingestEdtechBoardSnapshot({
    board: greenhouseBoard,
    previous: { jobs: previousJobs },
    fetch,
    now,
    runId: "edtech-ingest-mass-delete",
  });
  assert.equal(result.status, "quarantined");
  assert.equal(result.quarantineReason, "mass_deletion_guard");
  assert.equal(result.closed, 0);
  assert.equal(result.jobs.filter((job) => job.status === "verified_open").length, 25);
});

test("compact rows omit description and keep employer ATS URLs", async () => {
  const result = ingestEdtechBoardSnapshot({
    board: greenhouseBoard,
    previous: { jobs: [] },
    fetch: resolveEdtechFetch({ jobs: await greenhouseSnapshot() }, null),
    now,
    runId,
  });
  for (const job of result.jobs) {
    assert.equal("description" in job, false);
    assert.match(job.canonical_url, /^https:\/\/boards\.greenhouse\.io\//);
    assert.equal(job.apply_url, job.canonical_url);
    assert.equal(job.vertical, "edtech");
    assert.equal(
      job.id,
      edtechJobId(job.provider, job.board_id, job.external_id)
    );
  }
});

test("filterCompactJobs supports board and title filters for internal queries", async () => {
  const store: EdtechBoardSnapshotStore = {
    jobs: ingestEdtechBoardSnapshot({
      board: greenhouseBoard,
      previous: { jobs: [] },
      fetch: resolveEdtechFetch({ jobs: await greenhouseSnapshot() }, null),
      now,
      runId,
    }).jobs,
  };
  const filtered = filterCompactJobs(store.jobs, {
    boardIds: [greenhouseBoard.board_id],
    titles: ["engineer"],
  });
  assert.deepEqual(filtered.map((job) => job.title), ["Software Engineer"]);
});

test("ingest script avoids cloudflare worker refresh imports", async () => {
  const scriptSource = await readFile(path.join(root, "scripts", "ingest-edtech-pack.ts"), "utf8");
  assert.doesNotMatch(scriptSource, /lib\/refresh/);
  assert.doesNotMatch(scriptSource, /cloudflare:workers/);
});

test("loadPreviousEdtechSnapshot reads the newest edtech-ingest artifact jobs array", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "edtech-snapshot-"));
  const olderJob = toCompactEdtechJob(
    {
      externalId: "1",
      title: "Older Role",
      roleFamily: "Other",
      location: "Remote - US",
      remoteStatus: "Remote",
      employmentType: "Full-time",
      compensation: "See posting",
      canonicalUrl: "https://boards.greenhouse.io/edtech-demo/jobs/1",
      publishedAt: now,
      description: "hidden",
      summary: "hidden",
    },
    greenhouseBoard
  );
  await writeFile(
    path.join(dir, "edtech-ingest-2026-09-19T00-00-00-000Z.json"),
    `${JSON.stringify({ jobs: [olderJob] })}\n`,
    "utf8"
  );
  const newerJob = { ...olderJob, title: "Newer Role", external_id: "2", id: "edtech-newer" };
  await writeFile(
    path.join(dir, "edtech-ingest-2026-09-20T00-00-00-000Z.json"),
    `${JSON.stringify({ jobs: [newerJob] })}\n`,
    "utf8"
  );
  const loaded = await loadPreviousEdtechSnapshot(dir);
  assert.equal(loaded.jobs.length, 1);
  assert.equal(loaded.jobs[0]?.title, "Newer Role");
  assert.deepEqual(await loadPreviousEdtechSnapshot(path.join(dir, "missing")), { jobs: [] });
});

test("gate 2 code and fixtures avoid disallowed scrape hosts", async () => {
  const ingestSource = await readFile(path.join(root, "lib", "edtech-ingest.ts"), "utf8");
  const scriptSource = await readFile(path.join(root, "scripts", "ingest-edtech-pack.ts"), "utf8").catch(
    () => ""
  );
  const fixtureNames = ["greenhouse-mixed.json", "lever-mixed.json", "ashby-mixed.json"];
  for (const host of DISALLOWED_PACK_HOSTS) {
    const pattern = new RegExp(host.replace(/\./g, "\\."), "i");
    assert.doesNotMatch(ingestSource, pattern, `edtech-ingest must not reference ${host}`);
    if (scriptSource) {
      assert.doesNotMatch(scriptSource, pattern, `ingest script must not reference ${host}`);
    }
    for (const name of fixtureNames) {
      const fixture = await readFile(path.join(fixtures, name), "utf8");
      assert.doesNotMatch(fixture, pattern, `${name} must not reference ${host}`);
    }
  }
});
