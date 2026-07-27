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
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
}

async function refresh() {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        new URL("/api/internal/refresh", baseUrl),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ingestToken}`,
            "User-Agent": "OH-SHI-GitHub-Refresh/1.0",
          },
        }
      );
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`Refresh returned HTTP ${response.status}: ${body.slice(0, 500)}`);
      }
      const result = JSON.parse(body);
      if (
        typeof result.refreshed_at !== "string" ||
        !Number.isInteger(result.boards) ||
        result.boards < 1 ||
        !Number.isInteger(result.verified) ||
        result.verified < 1 ||
        Date.parse(result.refreshed_at) < startedAt - 120_000
      ) {
        throw new Error("Refresh response did not prove that a canonical board was refreshed.");
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 1_000);
    }
  }
  throw lastError;
}

async function verifyFreshness(refreshedAt) {
  let lastReason = "No response received.";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const url = new URL("/api/v1/jobs", baseUrl);
      url.searchParams.set("include_closed", "true");
      url.searchParams.set("refresh_run", `${startedAt}-${attempt}`);
      const response = await fetchWithTimeout(url, {
        headers: { "User-Agent": "OH-SHI-GitHub-Refresh/1.0" },
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
        if (freshRecords.length > 0) {
          return freshRecords.length;
        }
        lastReason = `${records.length} records returned, but none were freshly verified`;
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 6) await delay(10_000);
  }
  throw new Error(
    `Post-refresh freshness check failed after refresh ${refreshedAt}: ${lastReason}.`
  );
}

const result = await refresh();
const freshRecords = await verifyFreshness(result.refreshed_at);
console.log(
  `Refresh verified: ${result.boards} boards, ${result.verified} roles checked, ` +
    `${result.opened} opened, ${result.closed} closed, ${freshRecords} fresh API records.`
);
