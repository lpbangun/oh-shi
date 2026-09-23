import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file: string) => readFile(path.join(root, file), "utf8");
const gitBlobId = (contents: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(contents, "utf8")}\0`)
    .update(contents, "utf8")
    .digest("hex");

const experimentWorkflow = ".github/workflows/daily-refresh-experimental.yml";

/**
 * Production control-plane files this lane must never touch: the two scheduled
 * refresh workflows and the Sites hosting pointer. The git blob ids below are
 * the blobs `origin/main` carries at the branch point (fd0b8cc); they hold the
 * frozen-state assertion in shallow checkouts where no `origin/main` ref
 * exists to diff against.
 */
const frozenProductionBlobs: Record<string, string> = {
  ".github/workflows/daily-refresh.yml":
    "ca373b2e1f96e32720d633899ce310f89ccd96f5",
  ".github/workflows/daily-funding-discovery.yml":
    "c20341679df896a79cb00d7058c6a76984414543",
  ".openai/hosting.json": "de52b07237b4e81a37d18184da00f3eede5f618c",
};

function productionDiffAgainstOriginMain(): string | null {
  const paths = ["--", ...Object.keys(frozenProductionBlobs)];
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "origin/main"], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    // Shallow CI checkouts fetch no `origin/main`; the blob pins still assert
    // the frozen state there.
    return null;
  }
  return execFileSync("git", ["diff", "origin/main", ...paths], {
    cwd: root,
    encoding: "utf8",
  });
}

test("experimental refresh workflow copy pins its isolation contract", async () => {
  const workflow = await read(experimentWorkflow);

  // Same cadence and manual escape hatch as production, own concurrency lane.
  assert.match(workflow, /cron: "30 \*\/2 \* \* \*"/);
  assert.match(workflow, /\n  workflow_dispatch:/);
  assert.match(workflow, /default: refresh/);
  assert.match(
    workflow,
    /concurrency:\s*\n\s+group: experimental-discovery-refresh\s*\n\s+cancel-in-progress: false/
  );
  assert.match(workflow, /timeout-minutes: 60/);

  // Step shapes mirror daily-refresh.yml so both lanes run the same phases.
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /id: directory_sync/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /name: Preflight, refresh, and verify freshness/);
  assert.match(workflow, /node scripts\/run-canonical-refresh\.mjs/);
  assert.match(workflow, /steps\.directory_sync\.outcome == 'failure'/);

  // Refresh run keys are namespaced away from production's.
  assert.match(workflow, /OH_SHI_RUN_KEY: exp-\$\{\{ github\.run_id \}\}/);

  // Credentials come only from the experimental variable/secret pair, and the
  // file must never source production's names.
  assert.match(
    workflow,
    /OH_SHI_BASE_URL: \$\{\{ vars\.OH_SHI_EXPERIMENTAL_BASE_URL \}\}/
  );
  assert.match(
    workflow,
    /OH_SHI_INGEST_TOKEN: \$\{\{ secrets\.OH_SHI_EXPERIMENTAL_INGEST_TOKEN \}\}/
  );
  assert.doesNotMatch(workflow, /vars\.OH_SHI_BASE_URL/);
  assert.doesNotMatch(workflow, /secrets\.OH_SHI_INGEST_TOKEN/);
});

test("production workflows and hosting pointer are unchanged vs origin/main", async (t) => {
  for (const [file, blob] of Object.entries(frozenProductionBlobs)) {
    assert.equal(
      gitBlobId(await read(file)),
      blob,
      `${file} must stay byte-identical to the blob origin/main carries`
    );
  }

  const diff = productionDiffAgainstOriginMain();
  if (diff === null) {
    t.diagnostic(
      "origin/main is not resolvable in this checkout; the blob pins carry the frozen-state assertion."
    );
    return;
  }
  assert.equal(
    diff,
    "",
    "production workflows and the hosting pointer must not differ from origin/main"
  );
});
