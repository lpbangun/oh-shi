import { apiEnvelope, listCompanies } from "@/lib/data";
import { conditionalJsonResponse } from "@/lib/conditional-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const companies = await listCompanies();
  return conditionalJsonResponse(request, apiEnvelope(companies), {
    cacheControl: "public, max-age=300, s-maxage=900",
    validator: JSON.stringify(companies),
  });
}
