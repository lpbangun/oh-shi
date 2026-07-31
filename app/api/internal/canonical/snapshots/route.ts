import { env } from "cloudflare:workers";
import {
  applyCanonicalSnapshot,
  inspectCanonicalSnapshot,
} from "@/lib/canonical-snapshot-review";
import { ensureDatabase } from "@/lib/data";

export const dynamic = "force-dynamic";

function authenticate(request: Request) {
  const runtime = env as typeof env & { INGEST_TOKEN?: string };
  if (!runtime.INGEST_TOKEN) {
    return Response.json(
      { error: "Canonical snapshot review is not configured." },
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

function validIdentifier(value: string) {
  return /^[a-z0-9][a-z0-9._:-]{2,199}$/i.test(value);
}

export async function GET(request: Request) {
  const denied = authenticate(request);
  if (denied) return denied;
  const snapshotId = new URL(request.url).searchParams.get("snapshotId")?.trim() || "";
  if (!validIdentifier(snapshotId)) {
    return Response.json(
      { error: "A valid snapshotId query parameter is required." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  await ensureDatabase();
  const inspection = await inspectCanonicalSnapshot(env.DB, snapshotId);
  return Response.json(inspection, {
    status: inspection.found ? 200 : 404,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const denied = authenticate(request);
  if (denied) return denied;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
  if (!/^[a-z0-9][a-z0-9._:-]{7,159}$/i.test(idempotencyKey)) {
    return Response.json(
      { error: "A valid Idempotency-Key header is required." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
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
  const snapshotId = typeof input.snapshotId === "string" ? input.snapshotId.trim() : "";
  const expectedFingerprint = typeof input.expectedFingerprint === "string"
    ? input.expectedFingerprint.trim()
    : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  const confirmation = typeof input.confirmation === "string"
    ? input.confirmation.trim()
    : "";
  if (!validIdentifier(snapshotId) || !/^fnv1a32:[0-9a-f]{8}:\d+$/i.test(expectedFingerprint)) {
    return Response.json(
      { error: "Valid snapshotId and expectedFingerprint values are required." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (confirmation !== `apply:${snapshotId}:${expectedFingerprint}`) {
    return Response.json(
      { error: "The exact snapshot-and-fingerprint confirmation phrase is required." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (reason.length < 12 || reason.length > 500) {
    return Response.json(
      { error: "A review reason between 12 and 500 characters is required." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  await ensureDatabase();
  try {
    const result = await applyCanonicalSnapshot({
      database: env.DB,
      snapshotId,
      idempotencyKey,
      expectedFingerprint,
      reason,
    });
    const status = result.status === "applied"
      ? 200
      : result.status === "running"
        ? 202
        : result.status === "rejected"
          ? 409
          : result.status === "failed"
            ? 502
            : 500;
    return Response.json(result, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Snapshot application failed.";
    // Conflict-class failures (state mismatch, lease contention, confirmability)
    // are 409; infrastructure failures (D1 errors, missing audit rows) are 5xx.
    const isConflict = /already bound to another snapshot|is not confirmable|fingerprint does not match|lease could not be acquired/i.test(
      message
    );
    return Response.json(
      { error: message },
      { status: isConflict ? 409 : 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
