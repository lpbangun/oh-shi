import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the characterization clock cannot enter a production build", async () => {
  const config = await readFile("vite.config.ts", "utf8");
  assert.match(config, /command === "build" && \(process\.env\.OHSHI_E2E_FIXED_CLOCK \|\| process\.env\.OHSHI_E2E_STATE_DIR\)/);
  assert.match(config, /throw new Error\("E2E-only clock\/state cannot be used in builds\."\)/);
});

test("Playwright never reuses a server with the wrong D1 or clock", async () => {
  const config = await readFile("playwright.config.ts", "utf8");
  assert.match(config, /reuseExistingServer: false/);
});

test("the local Worker clock freezes constructor and function-call forms", async () => {
  const worker = await readFile("worker/index.ts", "utf8");
  assert.match(worker, /if \(env\.TEST_FIXED_CLOCK && !clockFrozen\)/);
  assert.match(worker, /apply\(\) \{\s*return new NativeDate\(fixed\)\.toString\(\);\s*\}/);
});
