import { env } from "cloudflare:workers";
import { persistHiringSignals } from "@/lib/data";
import { parseHiringSignalImport, type HiringSignalImport } from "@/lib/hiring-signals";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const runtime = env as typeof env & { INGEST_TOKEN?: string };
  if (!runtime.INGEST_TOKEN) {
    return Response.json({ error: "Hiring-signal import is not configured." }, { status: 503 });
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
  const records = Array.isArray(body) ? body : [];
  if (!records.length || records.length > 250) {
    return Response.json({ error: "Provide an array of 1 to 250 signals." }, { status: 400 });
  }

  const now = new Date();
  const parsed: HiringSignalImport[] = [];
  const errors: Array<{ index: number; reason: string }> = [];
  for (const [index, record] of records.entries()) {
    const result = parseHiringSignalImport(record, now);
    if (result.signal) parsed.push(result.signal);
    else errors.push({ index, reason: result.reason || "invalid signal" });
  }
  if (errors.length) {
    return Response.json({
      error: "No records were written because one or more signals are invalid.",
      errors,
    }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const accepted = await persistHiringSignals(parsed);
  return Response.json({
    accepted,
    classification: "hiring_signal_not_verified_opening",
    jobs_mutated: 0,
    note: "Signals expire from active reads automatically and require canonical evidence before promotion to a verified opening.",
  }, {
    status: 202,
    headers: { "Cache-Control": "no-store" },
  });
}
