import { apiEnvelope, getCoverageMetrics } from "@/lib/data";
import { deployedSha, REFRESH_CONTRACT_VERSION } from "@/lib/refresh-contract";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    contract_version: REFRESH_CONTRACT_VERSION,
    deployed_sha: deployedSha(),
    ...apiEnvelope(await getCoverageMetrics()),
  }, {
    headers: { "Cache-Control": "public, max-age=180, s-maxage=600" },
  });
}
