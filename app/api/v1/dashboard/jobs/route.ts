import { apiEnvelope, listDashboardJobs } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(apiEnvelope(await listDashboardJobs()), {
    headers: { "Cache-Control": "public, max-age=60, s-maxage=300" },
  });
}
