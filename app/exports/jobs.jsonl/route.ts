import { listJobs } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  const body = (await listJobs(true)).map((item) => JSON.stringify(item)).join("\n") + "\n";
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": 'inline; filename="oh-shi-jobs.jsonl"',
    },
  });
}
