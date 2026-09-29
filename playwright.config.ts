import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const ci = Boolean(process.env.CI);
const port = Number(process.env.PLAYWRIGHT_PORT || 3000);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  // The Vinext development worker can drop concurrent page-render streams.
  // Keep tests within each file sequential while still parallelizing files.
  fullyParallel: false,
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  workers: ci ? 2 : 4,
  reporter: ci
    ? [["line"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  expect: {
    timeout: 8_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 720 },
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 320, height: 800 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: `pnpm exec vinext dev --hostname 127.0.0.1 --port ${port}`,
    env: {
      // Per-run, repo-local state keeps the seeded D1 fixture deterministic.
      // Never derive it from a home-directory layout: CI runners cannot create
      // a foreign HOME path and miniflare fails the mkdir with EACCES.
      OHSHI_E2E_STATE_DIR:
        process.env.OHSHI_E2E_STATE_DIR ??
        path.join(process.cwd(), ".wrangler", `e2e-state-${process.pid}`),
      OHSHI_E2E_FIXED_CLOCK: "2026-09-27T00:00:00.000Z",
    },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
