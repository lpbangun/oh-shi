import { defineConfig, devices } from "@playwright/test";

const ci = Boolean(process.env.CI);
const port = Number(process.env.PLAYWRIGHT_PORT || 3000);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
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
    url: baseURL,
    reuseExistingServer: !ci,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
