import { apiEnvelope, listJobs } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const includeClosed = url.searchParams.get("include_closed") === "true";
  return Response.json(apiEnvelope(await listJobs(includeClosed)), {
    headers: { "Cache-Control": "public, max-age=180, s-maxage=600" },
  });
}
