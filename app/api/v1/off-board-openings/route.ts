import { apiEnvelope, listOffBoardVerifiedOpenings } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  const openings = await listOffBoardVerifiedOpenings();
  return Response.json(apiEnvelope({
    classification: "off_board_verified_opening",
    inclusion_rule:
      "Off-board evidence linked to one exact role on a complete current canonical source.",
    openings,
  }), {
    headers: { "Cache-Control": "public, max-age=180, s-maxage=600" },
  });
}
