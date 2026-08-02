import { fetchYcDirectory, ycEvidenceInputs } from "../lib/startup-directory";

/**
 * Keeps the deployed domain registry in step with the public startup directory
 * so newly funded companies enter discovery without a manual pilot rebuild.
 * Sending evidence only; the deployment decides which domains are canonical and
 * never activates a company from this step alone.
 */

const COHORT = process.env.OH_SHI_DIRECTORY_COHORT?.trim() || "startup-directory";
const BATCH_SIZE = 500;

const baseUrlValue = process.env.OH_SHI_BASE_URL?.trim();
const ingestToken = process.env.OH_SHI_INGEST_TOKEN?.trim();

if (!baseUrlValue) {
  throw new Error("Directory sync failed: OH_SHI_BASE_URL is not configured.");
}
if (!ingestToken) {
  throw new Error("Directory sync failed: OH_SHI_INGEST_TOKEN is not configured.");
}

const baseUrl = new URL(baseUrlValue);
if (baseUrl.protocol !== "https:") {
  throw new Error("Directory sync failed: OH_SHI_BASE_URL must use HTTPS.");
}

const observedAt = new Date().toISOString();
const companies = await fetchYcDirectory();
const records = ycEvidenceInputs(companies, observedAt);
if (!records.length) {
  throw new Error("Directory sync failed: the directory returned no usable companies.");
}

const importUrl = new URL("/api/internal/discovery/domains", baseUrl);
let persisted = 0;
let batches = 0;
const failures: string[] = [];

for (let index = 0; index < records.length; index += BATCH_SIZE) {
  const batchNumber = Math.floor(index / BATCH_SIZE) + 1;
  const batch = records.slice(index, index + BATCH_SIZE);
  const response = await fetch(importUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ingestToken}`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ cohort: COHORT, records: batch }),
  });
  const body = await response.text();
  if (response.status !== 202) {
    failures.push(`batch ${batchNumber} returned HTTP ${response.status}: ${body.slice(0, 200)}`);
    continue;
  }
  batches += 1;
  try {
    persisted += Number(JSON.parse(body).receipt?.accepted || 0);
  } catch {
    // A 202 without a parsable receipt still persisted; leave the count alone.
  }
}

console.log(
  `Directory sync: ${companies.length} directory companies, ${records.length} evidence records, ` +
    `${batches} batches accepted, ${persisted} domains persisted into cohort ${COHORT}.`
);

if (failures.length) {
  for (const failure of failures) console.warn(`Directory sync failure: ${failure}`);
  throw new Error(`Directory sync failed for ${failures.length} batch(es).`);
}
