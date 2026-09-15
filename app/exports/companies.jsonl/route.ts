import { listCompanies } from "@/lib/data";
import { conditionalResponse } from "@/lib/conditional-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const body = (await listCompanies()).map((item) => JSON.stringify(item)).join("\n") + "\n";
  return conditionalResponse(request, body, {
    validator: body,
    cacheControl: "public, max-age=300, s-maxage=900",
    contentType: "application/x-ndjson; charset=utf-8",
    headers: {
      "Content-Disposition": 'inline; filename="oh-shi-companies.jsonl"',
    },
  });
}
