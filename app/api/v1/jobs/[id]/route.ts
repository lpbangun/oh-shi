import { apiEnvelope, getJobById } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getJobById(id);
  if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
  return Response.json(apiEnvelope(job), {
    headers: { "Cache-Control": "public, max-age=180, s-maxage=600" },
  });
}
