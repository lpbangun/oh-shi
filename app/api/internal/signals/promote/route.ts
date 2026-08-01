import { env } from "cloudflare:workers";
import { promoteSignal } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const runtime = env as typeof env & { INGEST_TOKEN?: string };
  if (!runtime.INGEST_TOKEN) {
    return Response.json(
      { error: "Hiring-signal promotion is not configured." },
      { status: 503 }
    );
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
  const signalId = body && typeof body === "object" && !Array.isArray(body) &&
    typeof (body as Record<string, unknown>).signalId === "string"
    ? ((body as Record<string, unknown>).signalId as string).trim()
    : "";
  if (!/^[a-z0-9][a-z0-9._:-]{2,159}$/i.test(signalId)) {
    return Response.json(
      { error: "A valid signalId is required." },
      { status: 400 }
    );
  }

  const result = await promoteSignal(signalId);
  const status = result.status === "promoted" ||
    result.status === "already_promoted"
    ? 200
    : result.status === "not_promotable"
      ? 422
      : 502;
  return Response.json({
    ...result,
    classification: result.jobId
      ? "off_board_verified_opening"
      : "hiring_signal_not_verified_opening",
    note: result.jobId
      ? "The off-board evidence is linked to an exact role on a complete current canonical source."
      : "No verified opening was created from this signal.",
  }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
