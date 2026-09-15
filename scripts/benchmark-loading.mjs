#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const DEFAULT_URL = "http://127.0.0.1:3000/";
const DEFAULT_RUNS = 5;
const DEFAULT_SETTLE_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 60_000;

function usage() {
  return `Usage: pnpm benchmark:loading [options]

Options:
  --url [label=]URL     Target to measure (repeatable; default: ${DEFAULT_URL})
  --runs N             Cold and warm samples per target (default: ${DEFAULT_RUNS})
  --settle-ms N        Time after load to observe LCP/long tasks (default: ${DEFAULT_SETTLE_MS})
  --timeout-ms N       Navigation timeout (default: ${DEFAULT_TIMEOUT_MS})
  --json PATH          Also write the complete result as JSON
  --help               Show this help

"Cold" means a fresh browser context with an empty client cache. "Warm" means
the same target after one priming navigation in a persistent browser context.
Neither mode purges a CDN or server-side cache.`;
}

function positiveInteger(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer, received ${raw}`);
  }
  return value;
}

function parseTarget(raw, index) {
  const separator = raw.indexOf("=");
  const hasLabel = separator > 0 && !raw.slice(0, separator).includes("://");
  const label = hasLabel ? raw.slice(0, separator) : `target-${index + 1}`;
  const value = hasLabel ? raw.slice(separator + 1) : raw;
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`--url must use http or https, received ${value}`);
  }
  return { label, url: url.toString() };
}

function parseArgs(argv) {
  const rawTargets = [];
  const options = {
    runs: DEFAULT_RUNS,
    settleMs: DEFAULT_SETTLE_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    jsonPath: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === "--url") rawTargets.push(value);
    else if (flag === "--runs") options.runs = positiveInteger(value, flag);
    else if (flag === "--settle-ms") options.settleMs = positiveInteger(value, flag);
    else if (flag === "--timeout-ms") options.timeoutMs = positiveInteger(value, flag);
    else if (flag === "--json") options.jsonPath = value;
    else throw new Error(`Unknown option: ${flag}`);
    index += 1;
  }

  const targets = (rawTargets.length ? rawTargets : [DEFAULT_URL]).map(parseTarget);
  return { ...options, targets, help: false };
}

const round = (value) => value == null ? null : Math.round(value * 10) / 10;

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.ceil((sorted.length - 1) * fraction)];
}

function summarize(samples) {
  const metrics = [
    "ttfbMs", "domContentLoadedMs", "loadMs", "fcpMs", "lcpMs",
    "requestCount", "transferBytes", "decodedBytes", "jsBytes", "cssBytes",
    "dataBytes", "longTaskCount", "mainThreadBlockingMs",
  ];
  return Object.fromEntries(metrics.map((metric) => {
    const values = samples.map((sample) => sample[metric]);
    return [metric, {
      median: round(percentile(values, 0.5)),
      p75: round(percentile(values, 0.75)),
      min: round(percentile(values, 0)),
      max: round(percentile(values, 1)),
    }];
  }));
}

function classifyBytes(resources) {
  const totals = { transferBytes: 0, jsBytes: 0, cssBytes: 0, dataBytes: 0 };
  for (const resource of resources.values()) {
    const bytes = resource.encodedDataLength || 0;
    totals.transferBytes += bytes;
    if (resource.type === "Script") totals.jsBytes += bytes;
    if (resource.type === "Stylesheet") totals.cssBytes += bytes;
    if (resource.type === "Fetch" || resource.type === "XHR") totals.dataBytes += bytes;
  }
  return totals;
}

async function installObservers(page) {
  await page.addInitScript(() => {
    globalThis.__loadingBenchmark = { lcpMs: null, longTasks: [] };
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries.at(-1);
        if (last) globalThis.__loadingBenchmark.lcpMs = last.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          globalThis.__loadingBenchmark.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      }).observe({ type: "longtask", buffered: true });
    } catch {}
  });
}

async function measureNavigation(context, target, options) {
  const page = await context.newPage();
  await installObservers(page);
  const session = await context.newCDPSession(page);
  const resources = new Map();

  session.on("Network.requestWillBeSent", ({ requestId, request, type }) => {
    resources.set(requestId, { url: request.url, type, encodedDataLength: 0 });
  });
  session.on("Network.responseReceived", ({ requestId, type, response }) => {
    const resource = resources.get(requestId) || { url: response.url, encodedDataLength: 0 };
    resource.type = type || resource.type;
    resource.status = response.status;
    resource.fromDiskCache = response.fromDiskCache;
    resource.fromServiceWorker = response.fromServiceWorker;
    resources.set(requestId, resource);
  });
  session.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => {
    const resource = resources.get(requestId);
    if (resource) resource.encodedDataLength = encodedDataLength;
  });
  await session.send("Network.enable");

  const startedAt = Date.now();
  let response;
  try {
    response = await page.goto(target.url, {
      waitUntil: "load",
      timeout: options.timeoutMs,
    });
    await page.waitForTimeout(options.settleMs);

    const browserMetrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      const paint = performance.getEntriesByName("first-contentful-paint")[0];
      const state = globalThis.__loadingBenchmark || { lcpMs: null, longTasks: [] };
      const blockingTasks = state.longTasks.filter((task) =>
        task.startTime >= (paint?.startTime || 0)
      );
      return {
        ttfbMs: navigation ? navigation.responseStart - navigation.requestStart : null,
        domContentLoadedMs: navigation?.domContentLoadedEventEnd || null,
        loadMs: navigation?.loadEventEnd || null,
        fcpMs: paint?.startTime || null,
        lcpMs: state.lcpMs,
        decodedBytes: (navigation?.decodedBodySize || 0) + performance
          .getEntriesByType("resource")
          .reduce((sum, entry) => sum + (entry.decodedBodySize || 0), 0),
        longTaskCount: blockingTasks.length,
        mainThreadBlockingMs: blockingTasks.reduce(
          (sum, task) => sum + Math.max(0, task.duration - 50),
          0,
        ),
      };
    });
    const bytes = classifyBytes(resources);
    return {
      status: response?.status() ?? null,
      wallTimeMs: Date.now() - startedAt,
      ...Object.fromEntries(Object.entries(browserMetrics).map(([key, value]) => [key, round(value)])),
      requestCount: resources.size,
      ...Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, round(value)])),
    };
  } finally {
    await session.detach().catch(() => {});
    await page.close();
  }
}

async function benchmarkTarget(browser, target, options) {
  const cold = [];
  for (let index = 0; index < options.runs; index += 1) {
    const context = await browser.newContext();
    cold.push(await measureNavigation(context, target, options));
    await context.close();
  }

  const warm = [];
  const warmContext = await browser.newContext();
  await measureNavigation(warmContext, target, options);
  for (let index = 0; index < options.runs; index += 1) {
    warm.push(await measureNavigation(warmContext, target, options));
  }
  await warmContext.close();

  return {
    label: target.label,
    url: target.url,
    cold: { samples: cold, summary: summarize(cold) },
    warm: { samples: warm, summary: summarize(warm) },
  };
}

function formatNumber(value) {
  return value == null ? "n/a" : value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function printSummary(results) {
  for (const result of results) {
    console.log(`\n${result.label}: ${result.url}`);
    console.log("mode  ttfb  DCL   load  FCP   LCP   reqs  transfer  JS      CSS     data    blocking");
    for (const mode of ["cold", "warm"]) {
      const summary = result[mode].summary;
      const mb = (key) => summary[key].median == null ? null : summary[key].median / 1_000_000;
      console.log([
        mode.padEnd(5),
        `${formatNumber(summary.ttfbMs.median)}ms`.padEnd(6),
        `${formatNumber(summary.domContentLoadedMs.median)}ms`.padEnd(6),
        `${formatNumber(summary.loadMs.median)}ms`.padEnd(6),
        `${formatNumber(summary.fcpMs.median)}ms`.padEnd(6),
        `${formatNumber(summary.lcpMs.median)}ms`.padEnd(6),
        String(summary.requestCount.median).padEnd(5),
        `${formatNumber(mb("transferBytes"))}MB`.padEnd(8),
        `${formatNumber(mb("jsBytes"))}MB`.padEnd(7),
        `${formatNumber(mb("cssBytes"))}MB`.padEnd(7),
        `${formatNumber(mb("dataBytes"))}MB`.padEnd(7),
        `${formatNumber(summary.mainThreadBlockingMs.median)}ms`,
      ].join(" "));
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const target of options.targets) {
      console.error(`Benchmarking ${target.label} (${target.url})...`);
      results.push(await benchmarkTarget(browser, target, options));
    }
  } finally {
    await browser.close();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    runsPerMode: options.runs,
    settleMs: options.settleMs,
    definitions: {
      cold: "Fresh browser context; empty client HTTP cache.",
      warm: "Persistent browser context after one priming navigation.",
      transferBytes: "CDP Network.loadingFinished encoded bytes, including protocol overhead.",
      mainThreadBlockingMs: "Sum of long-task duration over 50 ms after FCP through the settle window; a TBT approximation.",
    },
    results,
  };
  printSummary(results);
  if (options.jsonPath) {
    await writeFile(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    console.error(`Wrote ${options.jsonPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
