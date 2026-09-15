import { apiEnvelope, listActiveHiringSignals } from "@/lib/data";
import { conditionalJsonResponse } from "@/lib/conditional-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const signals = await listActiveHiringSignals();
  const availability = {
    status: signals.length > 0 ? "available" : "dormant",
    activeCount: signals.length,
    reason: signals.length > 0
      ? "Active, unexpired off-board hiring signals are published."
      : "The evidence surface is configured but currently has no active, unexpired records.",
  };
  const payload = apiEnvelope({
    availability,
    classification: "hiring_signal_not_verified_opening",
    inclusion_rule: "Active, permitted evidence with an unexpired verification window.",
    signals,
  });
  return conditionalJsonResponse(request, payload, {
    cacheControl: "public, max-age=180, s-maxage=600",
    validator: JSON.stringify({ availability, signals }),
  });
}
