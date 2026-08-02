const baseUrlValue = process.env.OH_SHI_BASE_URL?.trim();
const ingestToken = process.env.OH_SHI_INGEST_TOKEN?.trim();
const batchId = process.env.OH_SHI_REVIEW_BATCH_ID?.trim() || "";
const candidateIds = [...new Set(
  (process.env.OH_SHI_REVIEW_CANDIDATE_IDS || "")
    .split(",").map((value) => value.trim()).filter(Boolean)
)];
const reason = process.env.OH_SHI_REVIEW_REASON?.trim() || "";
const confirmation = process.env.OH_SHI_REVIEW_CONFIRMATION?.trim() || "";

if (!baseUrlValue || !ingestToken) {
  throw new Error("OH_SHI_BASE_URL and OH_SHI_INGEST_TOKEN are required.");
}
if (!/^[a-z0-9][a-z0-9._:-]{7,159}$/i.test(batchId)) {
  throw new Error("OH_SHI_REVIEW_BATCH_ID is invalid.");
}
if (!candidateIds.length || candidateIds.length > 25) {
  throw new Error("Provide 1 to 25 comma-separated candidate IDs.");
}
if (confirmation !== `approve:${batchId}:${candidateIds.length}`) {
  throw new Error("OH_SHI_REVIEW_CONFIRMATION does not match the selected candidates.");
}
if (reason.length < 12 || reason.length > 500) {
  throw new Error("OH_SHI_REVIEW_REASON must contain 12 to 500 characters.");
}
const baseUrl = new URL(baseUrlValue);
if (baseUrl.protocol !== "https:") throw new Error("OH_SHI_BASE_URL must use HTTPS.");
const endpoint = new URL("/api/internal/discovery/reviews", baseUrl);
const headers = {
  Authorization: `Bearer ${ingestToken}`,
  "Content-Type": "application/json",
  "User-Agent": "OH-SHI-Discovery-Review/1.0",
};
endpoint.searchParams.set("batchId", batchId);
const reviewResponse = await fetch(endpoint, {
  headers,
  cache: "no-store",
  signal: AbortSignal.timeout(60_000),
});
const review = await reviewResponse.json();
if (!reviewResponse.ok) {
  throw new Error(`Review lookup failed: ${review.error || reviewResponse.status}`);
}
const byId = new Map(review.candidates.map((candidate) => [candidate.candidateId, candidate]));
const expectedFingerprints = {};
for (const candidateId of candidateIds) {
  const candidate = byId.get(candidateId);
  if (!candidate || candidate.status !== "ready" || !candidate.fingerprint) {
    throw new Error(`Candidate ${candidateId} is not ready for approval.`);
  }
  expectedFingerprints[candidateId] = candidate.fingerprint;
}
endpoint.search = "";
const response = await fetch(endpoint, {
  method: "POST",
  headers,
  body: JSON.stringify({
    action: "approve",
    batchId,
    candidateIds,
    expectedFingerprints,
    reason,
    confirmation,
  }),
  cache: "no-store",
  signal: AbortSignal.timeout(600_000),
});
const result = await response.json();
if (!response.ok) {
  throw new Error(`Review approval failed: ${result.error || response.status}`);
}
if (result.rejected?.length) {
  throw new Error(`Some candidates were not activated: ${JSON.stringify(result.rejected)}`);
}
console.log(
  `Activated ${result.activated.length} explicitly approved candidates. ` +
  "Their jobs will publish only after the next canonical refresh."
);
