import {
  REFRESH_CONTRACT_VERSION,
  runVersionedRefresh,
} from "../lib/refresh-client.mjs";

const baseUrlValue = process.env.OH_SHI_BASE_URL?.trim();
const ingestToken = process.env.OH_SHI_INGEST_TOKEN?.trim();

if (!baseUrlValue) {
  throw new Error("Preflight failed: repository variable OH_SHI_BASE_URL is not configured.");
}
if (!ingestToken) {
  throw new Error("Preflight failed: repository secret OH_SHI_INGEST_TOKEN is not configured.");
}

const baseUrl = new URL(baseUrlValue);
if (baseUrl.protocol !== "https:") {
  throw new Error("Preflight failed: OH_SHI_BASE_URL must use HTTPS.");
}
if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  throw new Error("Preflight failed: OH_SHI_BASE_URL must be a plain deployment origin.");
}
baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");

const startedAt = Date.now();
const runKey = process.env.OH_SHI_RUN_KEY?.trim() ||
  (process.env.GITHUB_RUN_ID
    ? `github-${process.env.GITHUB_RUN_ID}`
    : `manual-${startedAt}-${crypto.randomUUID()}`);
const headers = {
  Authorization: `Bearer ${ingestToken}`,
  "User-Agent": `OH-SHI-GitHub-Refresh/${REFRESH_CONTRACT_VERSION}`,
};

async function fetchWithTimeout(url, init = {}, timeoutMs = 60_000) {
  return fetch(url, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

const refreshUrl = new URL("/api/internal/refresh", baseUrl);
const { preflight, result } = await runVersionedRefresh(
  refreshUrl,
  headers,
  runKey,
  {
    attempts: 3,
    // Discovery now probes board APIs per candidate, so a run legitimately
    // takes several minutes; 240s cut off runs that were still succeeding.
    fetchImpl: (url, init) => fetchWithTimeout(url, init, 600_000),
  }
);

async function verifyFreshness(refreshedAt) {
  let lastReason = "No response received.";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const url = new URL("/api/v1/jobs", baseUrl);
      url.searchParams.set("include_closed", "true");
      url.searchParams.set("refresh_run", `${runKey}-${attempt}`);
      const response = await fetchWithTimeout(url, {
        headers: { "User-Agent": `OH-SHI-GitHub-Refresh/${REFRESH_CONTRACT_VERSION}` },
      });
      if (!response.ok) {
        lastReason = `jobs endpoint returned HTTP ${response.status}`;
      } else {
        const payload = await response.json();
        const records = Array.isArray(payload.data) ? payload.data : [];
        const freshRecords = records.filter(
          (record) =>
            typeof record.lastVerifiedAt === "string" &&
            Date.parse(record.lastVerifiedAt) >= startedAt - 120_000
        );
        if (freshRecords.length > 0) return freshRecords.length;
        lastReason = `${records.length} records returned, but none were freshly verified`;
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(
    `Post-refresh freshness check failed after refresh ${refreshedAt}: ${lastReason}.`
  );
}

const freshRecords = await verifyFreshness(result.canonical.refreshed_at);
const discoveryCounts = result.discovery.source_counts;
console.log(
  `Contract ${preflight.contract_version} at ${preflight.deployed_sha}; run ${result.run_key}.`
);
console.log(
  `Discovery sources: ${discoveryCounts.configured} configured, ` +
    `${discoveryCounts.fetched} fetched, ${discoveryCounts.manual} manual, ` +
    `${discoveryCounts.blocked} blocked, ${discoveryCounts.failed} failed, ` +
    `${discoveryCounts.completed} completed.`
);
console.log(
  `Refresh verified ${result.canonical.successful_sources}/${result.canonical.boards} boards, ` +
    `${result.canonical.verified} roles checked, ${result.canonical.opened} opened, ` +
    `${result.canonical.closed} closed, ${freshRecords} fresh API records.`
);
console.log(
  `Coverage: ${result.coverage.activeCompanies} companies with verified-open jobs; ` +
    `${result.coverage.companiesAddedLast1Day} companies added in 1d, ` +
    `${result.coverage.companiesAddedLast7Days} in 7d, ` +
    `${result.coverage.jobsAddedLast24Hours} jobs added in 24h.`
);
for (const source of result.source_receipts.canonical.filter((item) => item.status === "failed")) {
  console.warn(
    `Canonical source failure: ${source.provider}/${source.sourceId} (${source.error || "unknown error"}).`
  );
}
for (const source of result.source_receipts.discovery.filter((item) => item.status === "failed")) {
  console.warn(`Discovery source failure: ${source.source_id} (${source.error || "unknown error"}).`);
}
if (result.coverage.companyGrowthWarning) {
  console.warn(
    `Company growth warning: below 50 active companies with ` +
      `${result.coverage.consecutiveDaysWithoutCompanyGrowth} consecutive days without growth.`
  );
}
