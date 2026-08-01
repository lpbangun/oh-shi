import { canonicalEndpoint, fetchCanonicalBoard } from "../lib/ats-adapters";

const boardId = process.argv.slice(2).find((argument) => argument !== "--") || "Nexthink";
if (!/^[a-z0-9_-]{1,100}$/i.test(boardId)) {
  throw new Error("Invalid SmartRecruiters board ID.");
}

const sourceUrl = canonicalEndpoint("smartrecruiters", boardId);
const listResponse = await fetch(sourceUrl, {
  headers: {
    "User-Agent": "OH-SHI/1.0 canonical-job-verifier",
    Accept: "application/json",
  },
  signal: AbortSignal.timeout(15_000),
});
if (!listResponse.ok) {
  throw new Error(`SmartRecruiters list ${sourceUrl} returned ${listResponse.status}`);
}
const listPayload = await listResponse.json() as { totalFound?: unknown };
const observedTotal = Number(listPayload.totalFound);
if (!Number.isInteger(observedTotal) || observedTotal < 1) {
  throw new Error(`SmartRecruiters board ${boardId} returned no valid totalFound`);
}

const result = await fetchCanonicalBoard("smartrecruiters", boardId);
if (!result.jobs.length) {
  throw new Error(`No actionable US roles verified from SmartRecruiters board ${boardId}`);
}

process.stdout.write(`${JSON.stringify({
  provider: "smartrecruiters",
  board_id: boardId,
  source_url: sourceUrl,
  observed_published_postings: observedTotal,
  verified_us_jobs: result.jobs.length,
  application_actions_verified: result.jobs.length,
  sample: result.jobs.slice(0, 5).map((job) => ({
    external_id: job.externalId,
    title: job.title,
    location: job.location,
    canonical_url: job.canonicalUrl,
  })),
}, null, 2)}\n`);
