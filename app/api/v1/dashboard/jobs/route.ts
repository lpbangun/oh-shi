import { apiEnvelope, searchJobs } from "@/lib/data";
import { JOB_SEARCH_PARAMETERS, JobSearchError, parseJobSearch } from "@/lib/job-search";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    for (const name of params.keys()) {
      if (!JOB_SEARCH_PARAMETERS.has(name) || ["view", "include_closed"].includes(name)) {
        throw new JobSearchError(`Unknown dashboard job parameter "${name}".`);
      }
    }
    const query = parseJobSearch(params, { defaultLimit: 50, allowPage: true });
    const result = await searchJobs(query);
    return Response.json({
      ...apiEnvelope(result.jobs),
      applied_filters: query,
      page: {
        limit: result.limit,
        offset: result.offset,
        number: Math.floor(result.offset / result.limit) + 1,
        returned: result.jobs.length,
        total: result.total,
        company_count: result.companyCount,
        next_cursor: result.nextOffset === null ? null : `v2.jobs.${result.nextOffset}`,
      },
    }, { headers: { "Cache-Control": "public, max-age=60, s-maxage=300" } });
  } catch (error) {
    if (error instanceof JobSearchError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400 });
    }
    throw error;
  }
}
