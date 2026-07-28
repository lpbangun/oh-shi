import { apiEnvelope, getCoverageMetrics } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(apiEnvelope(await getCoverageMetrics()), {
    headers: { "Cache-Control": "public, max-age=180, s-maxage=600" },
  });
}
