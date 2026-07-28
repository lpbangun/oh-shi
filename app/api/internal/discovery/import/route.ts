import { env } from "cloudflare:workers";
import { enqueueCandidate } from "@/lib/discovery";

export const dynamic = "force-dynamic";

type ImportCandidate = {
  name?: unknown;
  website_url?: unknown;
  investor_source_id?: unknown;
  evidence_url?: unknown;
};

export async function POST(request: Request) {
  const runtime = env as typeof env & { INGEST_TOKEN?: string };
  if (!runtime.INGEST_TOKEN) {
    return Response.json({ error: "Discovery import is not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${runtime.INGEST_TOKEN}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  const records = Array.isArray(body) ? body as ImportCandidate[] : [];
  if (!records.length || records.length > 250) {
    return Response.json({ error: "Provide an array of 1 to 250 candidates." }, { status: 400 });
  }
  let accepted = 0;
  const errors: Array<{ index: number; reason: string }> = [];
  for (const [index, record] of records.entries()) {
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const websiteUrl = typeof record.website_url === "string" ? record.website_url.trim() : "";
    const investorSourceId =
      typeof record.investor_source_id === "string" ? record.investor_source_id.trim() : "";
    const evidenceUrl = typeof record.evidence_url === "string" ? record.evidence_url.trim() : "";
    if (!name || !websiteUrl || !investorSourceId || !evidenceUrl) {
      errors.push({ index, reason: "name, website_url, investor_source_id, and evidence_url are required" });
      continue;
    }
    try {
      const result = await enqueueCandidate({ name, websiteUrl, investorSourceId, evidenceUrl });
      if (result.accepted) accepted += 1;
      else errors.push({
        index,
        reason: "URLs must be valid HTTPS URLs and investor_source_id must be configured",
      });
    } catch (error) {
      errors.push({
        index,
        reason: error instanceof Error ? error.message.slice(0, 200) : "import failed",
      });
    }
  }
  return Response.json(
    { accepted, rejected: errors.length, errors },
    { status: accepted ? 202 : 400, headers: { "Cache-Control": "no-store" } }
  );
}
