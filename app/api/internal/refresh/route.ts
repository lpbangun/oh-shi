import { env } from "cloudflare:workers";
import { refreshCanonicalBoards } from "@/lib/refresh";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const runtime = env as typeof env & { INGEST_TOKEN?: string };
  if (!runtime.INGEST_TOKEN) return Response.json({ error: "Refresh is not configured." }, { status: 503 });
  const supplied = request.headers.get("authorization");
  if (supplied !== `Bearer ${runtime.INGEST_TOKEN}`) return Response.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return Response.json(await refreshCanonicalBoards(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Refresh failed." }, { status: 502 });
  }
}
