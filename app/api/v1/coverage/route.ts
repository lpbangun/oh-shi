import { apiEnvelope, getCoverageMetrics } from "@/lib/data";
import { conditionalJsonResponse } from "@/lib/conditional-cache";
import { deployedSha, REFRESH_CONTRACT_VERSION } from "@/lib/refresh-contract";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const coverage = await getCoverageMetrics();
  const payload = {
    contract_version: REFRESH_CONTRACT_VERSION,
    deployed_sha: deployedSha(),
    ...apiEnvelope(coverage),
  };
  return conditionalJsonResponse(request, payload, {
    cacheControl: "public, max-age=180, s-maxage=600",
    validator: JSON.stringify({
      contract_version: REFRESH_CONTRACT_VERSION,
      deployed_sha: payload.deployed_sha,
      coverage,
    }),
  });
}
