import { canonicalEndpoint, fetchCanonicalBoard } from "../lib/ats-adapters";

const boardId = process.argv.slice(2).find((argument) => argument !== "--") || "uncapped";
if (!/^[a-z0-9-]+$/i.test(boardId)) throw new Error("Invalid Workable board ID.");

const sourceUrl = canonicalEndpoint("workable", boardId);
const result = await fetchCanonicalBoard("workable", boardId);
if (!result.jobs.length) {
  throw new Error(`No actionable US roles verified from Workable board ${boardId}`);
}

await new Promise((resolve) => setTimeout(resolve, 1_000));
const rawResponse = await fetch(sourceUrl, {
  headers: {
    "User-Agent": "OH-SHI/1.0 canonical-job-verifier",
    Accept: "application/json",
  },
  signal: AbortSignal.timeout(15_000),
});
if (!rawResponse.ok) {
  throw new Error(`Workable source ${sourceUrl} returned ${rawResponse.status}`);
}
const raw = await rawResponse.json() as {
  jobs?: Array<{ shortcode?: unknown; application_url?: unknown }>;
};
if (!Array.isArray(raw.jobs)) {
  throw new Error(`Workable source ${sourceUrl} returned no jobs collection`);
}

const verifiedIds = new Set(result.jobs.map((job) => job.externalId));
const applications = new Map<string, string>();
for (const row of raw.jobs) {
  const externalId = String(row.shortcode || "").trim();
  const applicationUrl = String(row.application_url || "").trim();
  if (verifiedIds.has(externalId) && applicationUrl) {
    applications.set(externalId, applicationUrl);
  }
}
if (applications.size !== verifiedIds.size) {
  throw new Error("A normalized Workable role is missing its application action");
}

for (const [externalId, applicationUrl] of applications) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const action = await fetch(applicationUrl, {
    headers: { "User-Agent": "OH-SHI/1.0 canonical-job-verifier" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!action.ok || !/\bhtml\b/i.test(action.headers.get("content-type") || "")) {
    throw new Error(`Workable application ${externalId} is not actionable`);
  }
  await action.body?.cancel();
}

process.stdout.write(`${JSON.stringify({
  provider: "workable",
  board_id: boardId,
  source_url: sourceUrl,
  published_location_rows: raw.jobs.length,
  verified_unique_us_jobs: result.jobs.length,
  actionable_application_pages: applications.size,
  sample: result.jobs.slice(0, 5).map((job) => ({
    external_id: job.externalId,
    title: job.title,
    location: job.location,
    canonical_url: job.canonicalUrl,
  })),
}, null, 2)}\n`);
