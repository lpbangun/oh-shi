import { apiEnvelope, listChanges } from "@/lib/data";
import { conditionalJsonResponse } from "@/lib/conditional-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const changes = await listChanges();
  return conditionalJsonResponse(request, apiEnvelope(changes), {
    cacheControl: "public, max-age=60, s-maxage=180",
    validator: JSON.stringify(changes),
  });
}
