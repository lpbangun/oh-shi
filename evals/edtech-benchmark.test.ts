import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DISALLOWED_PACK_HOSTS } from "../lib/edtech-pack";
import {
  computeSnapshotDiff,
  EDTECH_COM_BENCHMARK,
  type EdtechBenchmarkArtifact,
} from "../scripts/measure-edtech-yield";

const root = process.cwd();
const fixtureDir = path.join(root, "evals", "fixtures", "edtech-benchmark");
const read = (file: string) => readFile(path.join(root, file), "utf8");

async function loadFixture(name: string): Promise<EdtechBenchmarkArtifact> {
  return JSON.parse(await readFile(path.join(fixtureDir, name), "utf8")) as EdtechBenchmarkArtifact;
}

test("edtech benchmark markdown exists with required coverage sections", async () => {
  const markdown = await read("artifacts/edtech-benchmark.md");
  assert.match(markdown, /Edtech\.com/i);
  assert.match(markdown, /~756/);
  assert.match(markdown, /~2,?003/);
  assert.match(markdown, /not scrape/i);
  assert.match(markdown, /companies/i);
  assert.match(markdown, /open jobs/i);
  assert.match(markdown, /boards attempted/i);
  assert.match(markdown, /\*\*91\*\*/);
  assert.match(markdown, /\(all\)/i);
  assert.match(markdown, /gaps/i);
  assert.match(markdown, /role mix/i);
});

test("edtech benchmark receipts fixture parses and counts complete boards", async () => {
  const artifact = await loadFixture("receipts.json");
  assert.equal(artifact.schemaVersion, "1.0");
  assert.equal(artifact.packRows, 91);
  assert.equal(artifact.selection, "all");
  assert.equal(artifact.boardsAttempted, artifact.packRows);
  assert.equal(artifact.receipts.length, artifact.boardsAttempted);
  assert.equal(artifact.boardsComplete, artifact.receipts.filter((row) => row.live_complete).length);
  assert.equal(
    artifact.boardsComplete + artifact.boardsQuarantined + artifact.boardsFailed,
    artifact.boardsAttempted
  );
  assert.equal(
    artifact.totalOpenJobs,
    artifact.receipts
      .filter((row) => row.live_complete)
      .reduce((sum, row) => sum + row.observed_open_jobs, 0)
  );
  assert.deepEqual(artifact.edtech_com_benchmark, EDTECH_COM_BENCHMARK);
});

test("benchmark receipts attempt coursera and duolingo", async () => {
  const artifact = await loadFixture("receipts.json");
  const boardIds = new Set(artifact.receipts.map((row) => row.board_id.toLowerCase()));
  assert.ok(boardIds.has("coursera"), "coursera must be attempted in benchmark receipts");
  assert.ok(boardIds.has("duolingo"), "duolingo must be attempted in benchmark receipts");
});

test("benchmark fixtures avoid disallowed scrape hosts", async () => {
  const files = ["receipts.json", "snapshot-diff-prior.json", "snapshot-diff-after.json"];
  for (const name of files) {
    const text = await readFile(path.join(fixtureDir, name), "utf8");
    for (const host of DISALLOWED_PACK_HOSTS) {
      const pattern = new RegExp(host.replace(/\./g, "\\."), "i");
      assert.doesNotMatch(text, pattern, `${name} must not reference ${host}`);
    }
  }
  const measureSource = await read("scripts/measure-edtech-yield.ts");
  for (const host of DISALLOWED_PACK_HOSTS) {
    const pattern = new RegExp(`https?://[^\\s"']*${host.replace(/\./g, "\\.")}`, "i");
    assert.doesNotMatch(measureSource, pattern, `measure script must not fetch ${host}`);
  }
});

test("recorded snapshot diff fixture shows opened and closed jobs", async () => {
  const prior = await loadFixture("snapshot-diff-prior.json");
  const after = await loadFixture("snapshot-diff-after.json");
  const diff = computeSnapshotDiff(prior, after.receipts);
  assert.ok(diff.boards_compared >= 1);
  assert.ok(diff.jobs_opened > 0);
  assert.ok(diff.jobs_closed > 0);
  assert.ok(diff.per_board.some((row) => row.opened > 0));
  assert.ok(diff.per_board.some((row) => row.closed > 0));
});

test("live receipts separate pack identity from live complete boards", async () => {
  const artifact = await loadFixture("receipts.json");
  for (const receipt of artifact.receipts) {
    assert.equal(receipt.pack_identity, true);
    if (!receipt.live_complete) {
      assert.equal(receipt.observed_open_jobs, 0);
      assert.equal(receipt.external_ids.length, 0);
    }
  }
  const incomplete = artifact.receipts.filter((row) => !row.live_complete);
  if (incomplete.length) {
    assert.ok(
      incomplete.every((row) => row.fetch_status === "failed" || row.fetch_status === "quarantined"),
      "non-complete boards must be failed or quarantined, not silently success"
    );
  }
});
