import { fetchStructuredCareerSource } from "../lib/structured-career-page";

const sourceUrl = process.argv.slice(2).find((argument) => argument !== "--") ||
  "https://www.mozilla.org/en-US/careers/listings/";
const result = await fetchStructuredCareerSource(sourceUrl);
if (!result.jobs.length) {
  throw new Error(`No actionable US roles verified from ${sourceUrl}`);
}
process.stdout.write(`${JSON.stringify({
  source_url: sourceUrl,
  verified_jobs: result.jobs.length,
  sample: result.jobs.slice(0, 5).map((job) => ({
    external_id: job.externalId,
    title: job.title,
    location: job.location,
    canonical_url: job.canonicalUrl,
  })),
}, null, 2)}\n`);
