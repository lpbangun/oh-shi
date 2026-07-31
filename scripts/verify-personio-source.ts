import { canonicalEndpoint, fetchCanonicalBoard } from "../lib/ats-adapters";
import { boundedText } from "../lib/public-web";

const boardId = (
  process.argv.slice(2).find((argument) => argument !== "--") ||
  "cyted.jobs.personio.com"
).toLowerCase();
const sourceUrl = canonicalEndpoint("personio", boardId);
const result = await fetchCanonicalBoard("personio", boardId);
if (!result.jobs.length) {
  throw new Error(`No actionable US roles verified from Personio board ${boardId}`);
}
for (const job of result.jobs) {
  const detail = await fetch(job.canonicalUrl, {
    headers: { "User-Agent": "OH-SHI/1.0 canonical-job-verifier" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!detail.ok) {
    throw new Error(`Personio detail ${job.canonicalUrl} returned ${detail.status}`);
  }
  const html = await boundedText(detail);
  if (!/apply for this job|apply now|bewerben|application/i.test(html)) {
    throw new Error(`Personio detail ${job.canonicalUrl} has no application action`);
  }
}
process.stdout.write(`${JSON.stringify({
  provider: "personio",
  board_id: boardId,
  source_url: sourceUrl,
  verified_jobs: result.jobs.length,
  actionable_detail_pages: result.jobs.length,
  sample: result.jobs.slice(0, 5).map((job) => ({
    external_id: job.externalId,
    title: job.title,
    location: job.location,
    canonical_url: job.canonicalUrl,
  })),
}, null, 2)}\n`);
