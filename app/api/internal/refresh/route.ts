import { env } from "cloudflare:workers";
import { refreshCanonicalBoards } from "@/lib/refresh";
import { runDiscovery } from "@/lib/discovery";
import { getCoverageMetrics } from "@/lib/data";
import { attemptWithFallback } from "@/lib/ingestion-core";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const runtime = env as typeof env & { INGEST_TOKEN?: string };
  if (!runtime.INGEST_TOKEN) return Response.json({ error: "Refresh is not configured." }, { status: 503 });
  const supplied = request.headers.get("authorization");
  if (supplied !== `Bearer ${runtime.INGEST_TOKEN}`) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const discovery = await attemptWithFallback(
    () => runDiscovery(),
    (error) => ({
      run_id: "discovery_failed",
      completed_at: new Date().toISOString(),
      overall_status: "failed" as const,
      investor_sources_attempted: 0,
      candidates_discovered: 0,
      candidates_processed: 0,
      canonical_boards_detected: 0,
      companies_activated: 0,
      failed_sources: [{
        id: "discovery-run",
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      }],
      failed_candidates: [],
      blocked_sources: [],
    })
  );
  try {
    const refresh = await refreshCanonicalBoards();
    const coverage = await getCoverageMetrics();
    return Response.json(
      { ...refresh, discovery, coverage },
      {
        status:
          refresh.overall_status === "failed" || discovery.overall_status === "failed"
            ? 502
            : 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Refresh failed." }, { status: 502 });
  }
}
