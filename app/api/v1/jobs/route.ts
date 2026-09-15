import { apiEnvelope, searchJobs } from "@/lib/data";
import { JOB_SEARCH_PARAMETERS, JobSearchError, parseJobSearch } from "@/lib/job-search";
import { conditionalJsonResponse } from "@/lib/conditional-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const changeFeedStart = new Date().toISOString();
    const params = new URL(request.url).searchParams;
    for (const name of params.keys()) {
      if (!JOB_SEARCH_PARAMETERS.has(name) || ["view", "page"].includes(name)) {
        throw new JobSearchError(`Unknown job parameter "${name}".`);
      }
    }
    const query = parseJobSearch(params, { defaultLimit: 100, allowOffset: true });
    const result = await searchJobs(query);
    const payload = {
      ...apiEnvelope(result.jobs),
      applied_filters: query,
      page: {
        limit: result.limit,
        offset: result.offset,
        returned: result.jobs.length,
        total: result.total,
        next_cursor: result.nextOffset === null ? null : `v2.jobs.${result.nextOffset}`,
      },
      incremental: {
        after: changeFeedStart,
        changes_url: `/api/v1/changes?after=${encodeURIComponent(changeFeedStart)}`,
        instruction: "Process every job event, refresh /api/v1/jobs/:id, then re-evaluate the search filters.",
      },
    };
    return conditionalJsonResponse(request, payload, {
      cacheControl: "public, max-age=180, s-maxage=600",
      validator: JSON.stringify({ query, jobs: result.jobs, total: result.total }),
    });
  } catch (error) {
    if (error instanceof JobSearchError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400 });
    }
    throw error;
  }
}
