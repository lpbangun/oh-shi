import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrlValue = process.env.OH_SHI_BASE_URL?.trim();
const ingestToken = process.env.OH_SHI_INGEST_TOKEN?.trim();
const requestedCount = Number(process.env.OH_SHI_REVIEW_COUNT || "500");
const batchId = process.env.OH_SHI_REVIEW_BATCH_ID?.trim() ||
  `review-${process.env.GITHUB_RUN_ID || Date.now()}`;

if (!baseUrlValue || !ingestToken) {
  throw new Error("OH_SHI_BASE_URL and OH_SHI_INGEST_TOKEN are required.");
}
if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 500) {
  throw new Error("OH_SHI_REVIEW_COUNT must be an integer from 1 to 500.");
}
if (!/^[a-z0-9][a-z0-9._:-]{7,159}$/i.test(batchId)) {
  throw new Error("OH_SHI_REVIEW_BATCH_ID is invalid.");
}
const baseUrl = new URL(baseUrlValue);
if (baseUrl.protocol !== "https:") throw new Error("OH_SHI_BASE_URL must use HTTPS.");
baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");
const endpoint = new URL("/api/internal/discovery/reviews", baseUrl);
const headers = {
  Authorization: `Bearer ${ingestToken}`,
  "Content-Type": "application/json",
  "User-Agent": "OH-SHI-Discovery-Review/1.0",
};

async function request(method, body) {
  const response = await fetch(endpoint, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(600_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Review API returned HTTP ${response.status}: ${payload.error || "unknown error"}`);
  }
  return payload;
}

await request("POST", {
  action: "create",
  batchId,
  requestedCount,
  confirmation: `stage:${batchId}:${requestedCount}`,
});

let previousProcessed = -1;
for (let requestNumber = 1; requestNumber <= 25; requestNumber += 1) {
  const result = await request("POST", {
    action: "process",
    batchId,
    limit: 25,
  });
  const batch = result.batch;
  console.log(
    `Review ${batchId}: ${batch.processedCount}/${batch.assignedCount} processed; ` +
    `${batch.readyCount} ready, ${batch.needsReviewCount} need review, ` +
    `${batch.failedCount} failed; publication none.`
  );
  if (!result.hasMore) break;
  if (batch.processedCount === previousProcessed || result.processedThisRequest === 0) {
    throw new Error("Review batch made no progress and was stopped safely.");
  }
  previousProcessed = batch.processedCount;
  if (requestNumber === 25) {
    throw new Error("Review batch exceeded the bounded request count.");
  }
}

endpoint.searchParams.set("batchId", batchId);
const review = await request("GET");
if (review.batch.assignedCount !== requestedCount) {
  throw new Error(
    `Only ${review.batch.assignedCount} of ${requestedCount} candidates could be assigned.`
  );
}
if (["queued", "processing"].includes(review.batch.status)) {
  throw new Error("Review batch is still processing.");
}
if (review.publication !== "none") {
  throw new Error("Review API did not preserve the no-publication contract.");
}

const csv = (value) => {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
};
const candidateRows = [
  [
    "candidate_id", "status", "company_name", "domain", "website_url",
    "provider", "board_id", "careers_url", "job_count", "fingerprint",
    "observed_at", "last_error",
  ],
  ...review.candidates.map((candidate) => [
    candidate.candidateId,
    candidate.status,
    candidate.companyName,
    candidate.normalizedDomain,
    candidate.websiteUrl,
    candidate.provider,
    candidate.boardId,
    candidate.careersUrl,
    candidate.jobCount,
    candidate.fingerprint,
    candidate.observedAt,
    candidate.lastError,
  ]),
];
const jobRows = [
  [
    "candidate_id", "company_name", "domain", "fingerprint", "external_id",
    "title", "role_family", "location", "remote_status", "employment_type",
    "compensation", "canonical_url", "published_at",
  ],
  ...review.candidates.flatMap((candidate) => candidate.jobs.map((job) => [
    candidate.candidateId,
    candidate.companyName,
    candidate.normalizedDomain,
    candidate.fingerprint,
    job.externalId,
    job.title,
    job.roleFamily,
    job.location,
    job.remoteStatus,
    job.employmentType,
    job.compensation,
    job.canonicalUrl,
    job.publishedAt,
  ])),
];
const artifactDirectory = path.resolve("artifacts");
await mkdir(artifactDirectory, { recursive: true });
await Promise.all([
  writeFile(
    path.join(artifactDirectory, `discovery-review-${batchId}.json`),
    `${JSON.stringify(review, null, 2)}\n`,
    "utf8"
  ),
  writeFile(
    path.join(artifactDirectory, `discovery-review-${batchId}-candidates.csv`),
    `${candidateRows.map((row) => row.map(csv).join(",")).join("\n")}\n`,
    "utf8"
  ),
  writeFile(
    path.join(artifactDirectory, `discovery-review-${batchId}-jobs.csv`),
    `${jobRows.map((row) => row.map(csv).join(",")).join("\n")}\n`,
    "utf8"
  ),
]);
console.log(
  `Review artifacts created for ${review.batch.assignedCount} candidates and ` +
  `${jobRows.length - 1} staged jobs. No companies or jobs were published.`
);
