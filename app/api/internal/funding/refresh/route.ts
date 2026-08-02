import { env } from "cloudflare:workers";
import {
  claimRefreshRun,
  completeRefreshRun,
  listCompanies,
  persistFundingDiscoveries,
  readRefreshRun,
} from "@/lib/data";
import {
  discoverFundingUpdates,
  FUNDING_DISCOVERY_VERSION,
} from "@/lib/funding-discovery";
import {
  executeRefreshOnce,
  validRunKey,
  type StoredRefreshResponse,
} from "@/lib/refresh-idempotency";

export const dynamic = "force-dynamic";

function authenticate(request: Request) {
  const runtime = env as typeof env & { INGEST_TOKEN?: string };
  if (!runtime.INGEST_TOKEN) {
    return Response.json({ error: "Funding discovery is not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${runtime.INGEST_TOKEN}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  return null;
}

export function GET(request: Request) {
  const denied = authenticate(request);
  if (denied) return denied;
  return Response.json({
    contract_version: "1.0",
    discovery_version: FUNDING_DISCOVERY_VERSION,
    cadence: "daily",
    mutation: { method: "POST", idempotency_header: "Idempotency-Key" },
  }, { headers: { "Cache-Control": "no-store" } });
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
    claim: (key: string) => claimRefreshRun(`funding:${key}`, new Date().toISOString()),
    read: (key: string) => readRefreshRun<unknown>(`funding:${key}`),
    complete: (key: string, response: StoredRefreshResponse<unknown>) =>
      completeRefreshRun(`funding:${key}`, response),
  };

  try {
    const execution = await executeRefreshOnce(runKey, store, async () => {
      const companies = await listCompanies();
      const discovery = await discoverFundingUpdates(companies);
      const persisted = await persistFundingDiscoveries(discovery.discoveries);
      const failedSources = discovery.receipts.filter((receipt) => receipt.status === "failed").length;
      const body = {
        contract_version: "1.0",
        discovery_version: discovery.version,
        run_key: runKey,
        completed_at: discovery.completedAt,
        status:
          failedSources === discovery.receipts.length
            ? "failed"
            : failedSources > 0
              ? "partial_success"
              : "success",
        sources: {
          configured: discovery.receipts.length,
          completed: discovery.receipts.length - failedSources,
          failed: failedSources,
        },
        candidates_found: discovery.discoveries.length,
        announcements_added: persisted.announcementsAdded,
        companies_updated: persisted.companiesUpdated,
        scores_recomputed: persisted.scoresUpdated,
        receipts: discovery.receipts,
      };
      return { completed: true, httpStatus: body.status === "failed" ? 502 : 200, body };
    });
    if (execution.kind === "duplicate_in_progress") {
      return Response.json(
        { error: "This funding discovery run is already in progress.", run_key: runKey },
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
      { error: error instanceof Error ? error.message : "Funding discovery failed." },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
