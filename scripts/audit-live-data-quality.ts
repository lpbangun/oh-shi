import { writeFile } from "node:fs/promises";
import { retryCanonicalFetch } from "../lib/canonical-fetch-retry";
import {
  auditDataQuality,
  type QualityAuditJob,
} from "../lib/data-quality-audit";
import { boundedText } from "../lib/public-web";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const baseUrl = argument("--base-url") ||
  process.env.OH_SHI_BASE_URL ||
  "https://ohshi.work";
const outputPath = argument("--output") || null;
const rawRequestedSize = argument("--sample-size") || "200";
const requestedSize = rawRequestedSize === "all" ? 5_000 : Number(rawRequestedSize);
if (!Number.isInteger(requestedSize) || requestedSize < 1 || requestedSize > 5_000) {
  throw new Error("--sample-size must be \"all\" or an integer from 1 to 5000");
}
const parsedBase = new URL(baseUrl);
if (parsedBase.protocol !== "https:") {
  throw new Error("--base-url must use HTTPS");
}

const jobsUrl = new URL("/api/v1/jobs", parsedBase).href;
const response = await fetch(jobsUrl, {
  headers: {
    Accept: "application/json",
    "User-Agent": "OH-SHI/1.0 read-only-quality-auditor",
  },
  signal: AbortSignal.timeout(20_000),
});
if (!response.ok) {
  throw new Error(`Live jobs API returned ${response.status}`);
}

let envelope: unknown;
try {
  envelope = JSON.parse(await boundedText(response, 5_000_000));
} catch (error) {
  throw new Error(
    `Live jobs API returned invalid or oversized JSON: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}
if (
  !envelope ||
  typeof envelope !== "object" ||
  !Array.isArray((envelope as { data?: unknown }).data)
) {
  throw new Error("Live jobs API did not return the expected data collection");
}

const jobs = (envelope as { data: unknown[] }).data;
for (const [index, value] of jobs.entries()) {
  const job = value as Partial<QualityAuditJob>;
  if (
    !job ||
    typeof job !== "object" ||
    typeof job.id !== "string" ||
    typeof job.companyId !== "string" ||
    typeof job.externalId !== "string" ||
    typeof job.title !== "string" ||
    typeof job.location !== "string" ||
    typeof job.employmentType !== "string" ||
    typeof job.canonicalUrl !== "string" ||
    typeof job.status !== "string" ||
    typeof job.lastVerifiedAt !== "string"
  ) {
    throw new Error(`Live jobs API record ${index} is incompatible`);
  }
}

const result = await auditDataQuality(jobs as QualityAuditJob[], {
  sampleSize: requestedSize,
  fetchSource: (source) => retryCanonicalFetch(source),
});
const report = {
  generatedAt: new Date().toISOString(),
  baseUrl: parsedBase.origin,
  sourceGeneratedAt:
    typeof (envelope as { generated_at?: unknown }).generated_at === "string"
      ? (envelope as { generated_at: string }).generated_at
      : null,
  method: {
    sample: "deterministic hash sample with at least one record per represented company",
    stale:
      "stable source ID and canonical URL both absent from the complete raw current source collection",
    ineligible:
      "still published by the source but rejected by the current canonical eligibility rules",
    duplicate:
      "repeated provider/board/external ID or normalized canonical URL; weaker title/location clusters are review-only",
    mutation: "none",
    finalManualReview: "still required by the completion contract",
  },
  ...result,
};
const automatedQualityGateCandidate =
  result.sampleSize >= 200 &&
  result.inconclusive === 0 &&
  result.ineligible === 0 &&
  result.staleRate !== null &&
  result.staleRate < 0.02 &&
  result.exactDuplicateRate < 0.01;

if (outputPath) {
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify({
  generatedAt: report.generatedAt,
  baseUrl: report.baseUrl,
  inventorySize: report.inventorySize,
  sampleSize: report.sampleSize,
  sourceCollections: report.sourceCollections,
  sourceErrors: report.sourceErrors,
  auditedSourceEligibleObservations:
    report.auditedSourceEligibleObservations,
  auditedSourceEligibleNotInInventory:
    report.auditedSourceEligibleNotInInventory,
  fresh: report.fresh,
  stale: report.stale,
  ineligible: report.ineligible,
  inconclusive: report.inconclusive,
  exactDuplicates: report.exactDuplicates,
  reviewClusters: report.reviewClusters,
  staleRatePercent: report.staleRate === null
    ? null
    : Number((report.staleRate * 100).toFixed(2)),
  ineligibleRatePercent: report.ineligibleRate === null
    ? null
    : Number((report.ineligibleRate * 100).toFixed(2)),
  exactDuplicateRatePercent: Number(
    (report.exactDuplicateRate * 100).toFixed(2)
  ),
  automatedQualityGateCandidate,
  manualReviewStillRequired: true,
  outputPath,
}, null, 2)}\n`);
