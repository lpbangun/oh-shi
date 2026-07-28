import { env } from "cloudflare:workers";
import { refreshCanonicalBoards } from "@/lib/refresh";
import { runDiscovery } from "@/lib/discovery";
import { getCoverageMetrics } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const runtime = env as typeof env & { INGEST_TOKEN?: string };
  if (!runtime.INGEST_TOKEN) return Response.json({ error: "Refresh is not configured." }, { status: 503 });
  const supplied = request.headers.get("authorization");
  if (supplied !== `Bearer ${runtime.INGEST_TOKEN}`) return Response.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const discovery = await runDiscovery();
    const refresh = await refreshCanonicalBoards();
    const coverage = await getCoverageMetrics();
    return Response.json(
      { ...refresh, discovery, coverage },
      {
        status: refresh.overall_status === "failed" ? 502 : 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Refresh failed." }, { status: 502 });
  }
}
