import { fetchCanonicalBoard } from "../lib/ats-adapters";

const boardId = process.argv.slice(2).find((argument) => argument !== "--") || "make";
if (!/^[a-z0-9-]+$/i.test(boardId)) throw new Error("Invalid Recruitee board ID.");
const result = await fetchCanonicalBoard("recruitee", boardId);
if (!result.jobs.length) {
  throw new Error(`No actionable US roles verified from Recruitee board ${boardId}`);
}
process.stdout.write(`${JSON.stringify({
  provider: "recruitee",
  board_id: boardId,
  source_url: `https://${boardId}.recruitee.com/api/offers/`,
  verified_jobs: result.jobs.length,
  sample: result.jobs.slice(0, 5).map((job) => ({
    external_id: job.externalId,
    title: job.title,
    location: job.location,
    canonical_url: job.canonicalUrl,
  })),
}, null, 2)}\n`);
