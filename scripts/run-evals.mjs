import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const testFile = process.argv[2];
if (!testFile) {
  throw new Error("Usage: node scripts/run-evals.mjs <test-file>");
}

const environment = { ...process.env };
const hasMountedWindowsTemp = [environment.TMPDIR, environment.TMP, environment.TEMP].some(
  (value) => value?.startsWith("/mnt/")
);
if (process.platform === "linux" && hasMountedWindowsTemp) {
  environment.TMPDIR = "/tmp";
  environment.TMP = "/tmp";
  environment.TEMP = "/tmp";
}

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const result = spawnSync(process.execPath, [tsxCli, "--test", testFile], {
  env: environment,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
