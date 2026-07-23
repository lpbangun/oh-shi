import { apiEnvelope, listChanges } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const after = url.searchParams.get("after");
  const changes = await listChanges();
  const filtered = after ? changes.filter((change) => change.occurredAt > after) : changes;
  return Response.json(apiEnvelope(filtered), {
    headers: { "Cache-Control": "public, max-age=180, s-maxage=600" },
  });
}
