import { env } from "cloudflare:workers";
import { refreshCanonicalBoards } from "@/lib/refresh";
import { runDiscovery } from "@/lib/discovery";
import {
  claimRefreshRun,
  completeRefreshRun,
  getCoverageMetrics,
  readRefreshRun,
} from "@/lib/data";
import { attemptWithFallback } from "@/lib/ingestion-core";
import {
  refreshEnvelope,
  refreshPreflight,
} from "@/lib/refresh-contract";
import {
  executeRefreshOnce,
  validRunKey,
  type StoredRefreshResponse,
} from "@/lib/refresh-idempotency";

export const dynamic = "force-dynamic";

function authenticate(request: Request) {
  const runtime = env as typeof env & { INGEST_TOKEN?: string };
  if (!runtime.INGEST_TOKEN) {
    return Response.json({ error: "Refresh is not configured." }, { status: 503 });
  }
  const supplied = request.headers.get("authorization");
  if (supplied !== `Bearer ${runtime.INGEST_TOKEN}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  return null;
}

export function GET(request: Request) {
  const denied = authenticate(request);
  if (denied) return denied;
  return Response.json(refreshPreflight(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const denied = authenticate(request);
  if (denied) return denied;
  const runKey = request.headers.get("idempotency-key")?.trim() || "";
  if (!validRunKey(runKey)) {
    return Response.json(
      { error: "A valid Idempotency-Key header is required." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const store = {
    claim: (key: string) => claimRefreshRun(key, new Date().toISOString()),
    read: (key: string) => readRefreshRun<unknown>(key),
    complete: (
      key: string,
      response: StoredRefreshResponse<unknown>
    ) => completeRefreshRun(key, response),
  };

  try {
    const execution = await executeRefreshOnce(runKey, store, async () => {
      const discovery = await attemptWithFallback(
        () => runDiscovery(),
        (error) => ({
          run_id: "discovery_failed",
          completed_at: new Date().toISOString(),
          overall_status: "failed" as const,
          source_counts: {
            configured: 0, fetched: 0, manual: 0, blocked: 0,
            failed: 0, completed: 0, reconciled: false,
          },
          receipts: [],
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
        const canonical = await refreshCanonicalBoards();
        const coverage = await getCoverageMetrics();
        const body = refreshEnvelope({ runKey, canonical, discovery, coverage });
        return {
          completed: true,
          httpStatus:
            canonical.overall_status === "failed" || discovery.overall_status === "failed"
              ? 502
              : 200,
          body,
        };
      } catch (error) {
        return {
          completed: true,
          httpStatus: 502,
          body: {
            contract_version: refreshPreflight().contract_version,
            deployed_sha: refreshPreflight().deployed_sha,
            run_key: runKey,
            error: error instanceof Error ? error.message : "Refresh failed.",
          },
        };
      }
    });
    if (execution.kind === "duplicate_in_progress") {
      return Response.json(
        { error: "This refresh run is already in progress.", run_key: runKey },
        { status: 409, headers: { "Cache-Control": "no-store" } }
      );
    }
    return Response.json(execution.response.body, {
      status: execution.response.httpStatus,
      headers: {
        "Cache-Control": "no-store",
        "Idempotency-Replayed": execution.kind === "replayed" ? "true" : "false",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Refresh failed." },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
