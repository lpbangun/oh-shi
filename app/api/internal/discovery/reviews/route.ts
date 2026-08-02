import { env } from "cloudflare:workers";
import {
  activateDiscoveryReviewCandidates,
  createDiscoveryReviewBatch,
  processDiscoveryReviewBatch,
  readDiscoveryReviewBatch,
  rejectDiscoveryReviewCandidates,
} from "@/lib/discovery-review";

export const dynamic = "force-dynamic";

function authenticate(request: Request) {
  const runtime = env as typeof env & { INGEST_TOKEN?: string };
  if (!runtime.INGEST_TOKEN) {
    return Response.json(
      { error: "Discovery review is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${runtime.INGEST_TOKEN}`) {
    return Response.json(
      { error: "Unauthorized." },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  return null;
}

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

function candidateIds(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
      .map((item) => item.trim()).filter(Boolean)
    : [];
}

function fingerprintMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, fingerprint]) =>
    typeof fingerprint === "string" ? [[key, fingerprint.trim()]] : []
  ));
}

export async function GET(request: Request) {
  const denied = authenticate(request);
  if (denied) return denied;
  const batchId = new URL(request.url).searchParams.get("batchId")?.trim() || "";
  try {
    const review = await readDiscoveryReviewBatch(batchId);
    return Response.json(
      review || { error: "Review batch was not found." },
      {
        status: review ? 200 : 404,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Review lookup failed." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function POST(request: Request) {
  const denied = authenticate(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Body must be valid JSON." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  const input = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const action = text(input.action);
  const batchId = text(input.batchId);
  try {
    if (action === "create") {
      const requestedCount = Number(input.requestedCount);
      if (text(input.confirmation) !== `stage:${batchId}:${requestedCount}`) {
        return Response.json(
          { error: "The exact stage confirmation phrase is required." },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
      const batch = await createDiscoveryReviewBatch({ batchId, requestedCount });
      return Response.json(
        { batch, activation: "none", publication: "none" },
        { status: 202, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (action === "process") {
      const result = await processDiscoveryReviewBatch({
        batchId,
        limit: input.limit === undefined ? 25 : Number(input.limit),
      });
      return Response.json(result, {
        status: result.hasMore ? 202 : 200,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (action === "approve" || action === "reject") {
      const ids = candidateIds(input.candidateIds);
      const confirmation = `${action}:${batchId}:${new Set(ids).size}`;
      if (text(input.confirmation) !== confirmation) {
        return Response.json(
          { error: `The exact ${action} confirmation phrase is required.` },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
      const reason = text(input.reason);
      const result = action === "approve"
        ? await activateDiscoveryReviewCandidates({
          batchId,
          candidateIds: ids,
          expectedFingerprints: fingerprintMap(input.expectedFingerprints),
          reason,
        })
        : await rejectDiscoveryReviewCandidates({
          batchId,
          candidateIds: ids,
          reason,
        });
      return Response.json(result, {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return Response.json(
      { error: "Action must be create, process, approve, or reject." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Review operation failed.";
    const status = /not found/i.test(message) ? 404 : 400;
    return Response.json(
      { error: message },
      { status, headers: { "Cache-Control": "no-store" } }
    );
  }
}
