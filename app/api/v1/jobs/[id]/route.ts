import { apiEnvelope, getJobById } from "@/lib/data";
import { JobSearchError } from "@/lib/job-search";
import { parseJobFields, projectJob } from "@/lib/job-fields";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const fields = parseJobFields(new URL(request.url).searchParams);
    const { id } = await params;
    const job = await getJobById(id);
    if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
    return Response.json(apiEnvelope(fields ? projectJob(job, fields) : job), {
      headers: { "Cache-Control": "public, max-age=180, s-maxage=600" },
    });
  } catch (error) {
    if (error instanceof JobSearchError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400 });
    }
    throw error;
  }
}
