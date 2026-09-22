import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file: string) => readFile(path.join(root, file), "utf8");

const EDTECH_ROWS = [
  "Legal sources",
  "Company identity",
  "Coverage vs Edtech.com",
  "Role mix",
  "Open/close honesty",
  "Board × title filters",
  "Agent ingest",
  "Tests",
  "Benchmark writeup",
  "Growth hook",
] as const;

const ALL_TYPES_ROWS = [
  "Same legal-source bar",
  "Non-edtech same ingest",
  "Filters with vertical=all",
  "Compact agent contract",
  "Tests cover non-edtech + edtech regression",
  "No LinkedIn/Indeed adapters",
  "Daily refresh bounded",
  "Closures still set-diff",
  "README / llms.txt",
  "Edtech not regressed below 9",
] as const;

const TRACKED_ARTIFACT_MARKDOWNS = [
  "artifacts/scorecard.md",
  "artifacts/edtech-benchmark.md",
  "artifacts/goal-stop.md",
] as const;

test("package.json test script runs deterministic evals", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const testScript = pkg.scripts?.test;
  assert.ok(testScript, "package.json must define scripts.test");
  assert.match(
    testScript,
    /\beval\b/,
    "scripts.test must invoke evals (for example pnpm run eval)"
  );
  assert.match(
    pkg.scripts.eval,
    /run-evals\.mjs evals\//,
    "scripts.eval must route through the eval harness"
  );
});

test("scorecard template exists with all named rows and gate metadata", async () => {
  const scorecardPath = path.join(root, "artifacts", "scorecard.md");
  await access(scorecardPath);
  const scorecard = await read("artifacts/scorecard.md");

  for (const row of [...EDTECH_ROWS, ...ALL_TYPES_ROWS]) {
    assert.match(
      scorecard,
      new RegExp(`\\|\\s*${row.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|`),
      `scorecard is missing row: ${row}`
    );
  }

  assert.match(scorecard, /9\/10.*per.*row|each named row/i);
  assert.match(scorecard, /command output/i);
  assert.match(scorecard, /Validator verdict/i);
  assert.match(scorecard, /`continue`\s*\|\s*`pass`\s*\|\s*`stop-cap`/);
  assert.match(scorecard, /Iteration.*0/i);
});

test("committed artifact markdown templates are not gitignored", async () => {
  const gitignore = await read(".gitignore");
  assert.doesNotMatch(
    gitignore,
    /^\/artifacts\/\s*$/m,
    ".gitignore must not ignore the entire artifacts/ directory"
  );

  for (const file of TRACKED_ARTIFACT_MARKDOWNS) {
    assert.match(
      gitignore,
      new RegExp(`!/${file.replace(/\//g, "\\/")}`),
      `.gitignore must whitelist ${file}`
    );

    const check = spawnSync("git", ["check-ignore", "-q", file], {
      cwd: root,
      encoding: "utf8",
    });
    if (file === "artifacts/scorecard.md") {
      assert.notEqual(
        check.status,
        0,
        `${file} must not be ignored by git`
      );
    }
  }
});
