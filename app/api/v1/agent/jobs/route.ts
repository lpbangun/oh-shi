import { conditionalJsonResponse } from "@/lib/conditional-cache";
import {
  buildEdtechAgentJobsPayload,
  EdtechAgentError,
  loadEdtechAgentStore,
} from "@/lib/edtech-agent";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const store = await loadEdtechAgentStore();
    const payload = buildEdtechAgentJobsPayload(new URL(request.url).searchParams, store);
    return conditionalJsonResponse(request, payload, {
      cacheControl: "public, max-age=180, s-maxage=600",
      validator: JSON.stringify({
        filters: payload.applied_filters,
        count: payload.count,
        jobs: payload.jobs,
      }),
    });
  } catch (error) {
    if (error instanceof EdtechAgentError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400 }
      );
    }
    throw error;
  }
}
