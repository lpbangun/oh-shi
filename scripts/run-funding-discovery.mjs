const baseUrlValue = process.env.OH_SHI_BASE_URL?.trim();
const ingestToken = process.env.OH_SHI_INGEST_TOKEN?.trim();

if (!baseUrlValue) throw new Error("OH_SHI_BASE_URL is not configured.");
if (!ingestToken) throw new Error("OH_SHI_INGEST_TOKEN is not configured.");
const baseUrl = new URL(baseUrlValue);
if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  throw new Error("OH_SHI_BASE_URL must be a plain HTTPS deployment origin.");
}

const runKey = process.env.OH_SHI_FUNDING_RUN_KEY?.trim() ||
  (process.env.GITHUB_RUN_ID
    ? `github-${process.env.GITHUB_RUN_ID}`
    : `manual-${Date.now()}-${crypto.randomUUID()}`);
const response = await fetch(new URL("/api/internal/funding/refresh", baseUrl), {
  method: "POST",
  headers: {
    Authorization: `Bearer ${ingestToken}`,
    "Idempotency-Key": runKey,
    "User-Agent": "OH-SHI-GitHub-Funding/1.0",
  },
  cache: "no-store",
  signal: AbortSignal.timeout(600_000),
});
const payload = await response.json();
if (!response.ok) {
  throw new Error(`Funding discovery returned HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 800)}`);
}
if (
  payload.contract_version !== "1.0" ||
  payload.run_key !== runKey ||
  !["success", "partial_success"].includes(payload.status) ||
  !Number.isInteger(payload.announcements_added) ||
  !Number.isInteger(payload.scores_recomputed)
) {
  throw new Error("Funding discovery returned an incompatible response.");
}
console.log(
  `Funding discovery checked ${payload.sources.completed}/${payload.sources.configured} sources, ` +
  `found ${payload.candidates_found} current raises, published ${payload.announcements_added}, ` +
  `and recomputed ${payload.scores_recomputed} company scores.`
);
for (const receipt of payload.receipts.filter((item) => item.status === "failed")) {
  console.warn(`Funding source failure: ${receipt.sourceId} (${receipt.error || "unknown error"}).`);
}
