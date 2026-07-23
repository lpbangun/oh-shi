import { apiEnvelope, listCompanies } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(apiEnvelope(await listCompanies()), {
    headers: { "Cache-Control": "public, max-age=300, s-maxage=900" },
  });
}
