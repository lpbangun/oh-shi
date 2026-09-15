import { apiEnvelope, listOffBoardVerifiedOpenings } from "@/lib/data";
import { conditionalJsonResponse } from "@/lib/conditional-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const openings = await listOffBoardVerifiedOpenings();
  const availability = {
    status: openings.length > 0 ? "available" : "dormant",
    verifiedOpenCount: openings.length,
    reason: openings.length > 0
      ? "Verified-open jobs promoted from permitted off-board evidence are published."
      : "The promotion surface is configured but currently has no verified-open records.",
  };
  const payload = apiEnvelope({
    availability,
    classification: "off_board_verified_opening",
    inclusion_rule:
      "Off-board evidence linked to one exact role on a complete current canonical source.",
    openings,
  });
  return conditionalJsonResponse(request, payload, {
    cacheControl: "public, max-age=180, s-maxage=600",
    validator: JSON.stringify({ availability, openings }),
  });
}
