import { apiEnvelope, listActiveHiringSignals } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  const signals = await listActiveHiringSignals();
  return Response.json(apiEnvelope({
    classification: "hiring_signal_not_verified_opening",
    inclusion_rule: "Active, permitted evidence with an unexpired verification window.",
    signals,
  }), {
    headers: { "Cache-Control": "public, max-age=180, s-maxage=600" },
  });
}
