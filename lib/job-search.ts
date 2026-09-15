export const JOB_SORTS = [
  "signal", "title", "title_desc", "company", "company_desc", "sector",
  "dept", "loc", "comp_low", "comp_high", "recent", "oldest",
] as const;

export type JobSort = (typeof JOB_SORTS)[number];

export type JobSearchInput = {
  q: string | null;
  status: "verified_open" | "verified_closed" | "all";
  company: string | null;
  sector: string | null;
  roleFamily: string | null;
  location: string | null;
  remoteStatus: string | null;
  provider: string | null;
  investor: string | null;
  newSince: string | null;
  sort: JobSort;
  limit: number;
  offset: number;
};

export class JobSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobSearchError";
  }
}

function one(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  if (values.length > 1) throw new JobSearchError(`Parameter "${name}" may appear only once.`);
  return values[0]?.trim() || null;
}

function boundedInteger(
  params: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
) {
  const raw = one(params, name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new JobSearchError(`${name} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new JobSearchError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

export const JOB_SEARCH_PARAMETERS = new Set([
  "q", "status", "company", "sector", "role_family", "location",
  "remote_status", "provider", "investor", "new_since", "sort",
  "limit", "offset", "page", "cursor", "include_closed", "view",
]);

export function parseJobSearch(
  params: URLSearchParams,
  options: { defaultLimit?: number; allowPage?: boolean; allowOffset?: boolean } = {}
): JobSearchInput {
  const statusRaw = one(params, "status");
  const includeClosedRaw = one(params, "include_closed");
  if (
    params.has("include_closed") &&
    !["true", "false"].includes(includeClosedRaw || "")
  ) {
    throw new JobSearchError("include_closed must be true or false.");
  }
  const includeClosed = includeClosedRaw === "true";
  const status = includeClosed && statusRaw === null ? "all" : statusRaw || "verified_open";
  if (!["verified_open", "verified_closed", "all"].includes(status)) {
    throw new JobSearchError("status must be verified_open, verified_closed, or all.");
  }
  const sortRaw = one(params, "sort") || "signal";
  if (!(JOB_SORTS as readonly string[]).includes(sortRaw)) {
    throw new JobSearchError(`sort must be one of: ${JOB_SORTS.join(", ")}.`);
  }
  const limit = boundedInteger(params, "limit", options.defaultLimit || 50, 1, 100);
  const page = options.allowPage ? boundedInteger(params, "page", 1, 1, 100_000) : 1;
  const cursor = one(params, "cursor");
  if (cursor && (params.has("offset") || params.has("page"))) {
    throw new JobSearchError("Use cursor, offset, or page; do not combine pagination modes.");
  }
  let cursorOffset = 0;
  if (cursor) {
    const match = /^v2\.jobs\.(\d+)$/.exec(cursor);
    if (!match) throw new JobSearchError("Invalid cursor for jobs.");
    cursorOffset = Number(match[1]);
    if (!Number.isSafeInteger(cursorOffset) || cursorOffset < 0) {
      throw new JobSearchError("Invalid cursor for jobs.");
    }
  }
  const explicitOffset = options.allowOffset ? boundedInteger(params, "offset", 0, 0, 10_000_000) : 0;
  const newSince = one(params, "new_since");
  if (newSince && (!/^\d{4}-\d{2}-\d{2}T/.test(newSince) || !Number.isFinite(Date.parse(newSince)))) {
    throw new JobSearchError("new_since must be an ISO-8601 timestamp.");
  }
  return {
    q: one(params, "q"),
    status: status as JobSearchInput["status"],
    company: one(params, "company"),
    sector: one(params, "sector"),
    roleFamily: one(params, "role_family"),
    location: one(params, "location"),
    remoteStatus: one(params, "remote_status"),
    provider: one(params, "provider"),
    investor: one(params, "investor"),
    newSince: newSince ? new Date(Date.parse(newSince)).toISOString() : null,
    sort: sortRaw as JobSort,
    limit,
    offset: cursorOffset || explicitOffset || (page - 1) * limit,
  };
}

const ORDER_BY: Record<JobSort, string> = {
  signal: `ROW_NUMBER() OVER (
    PARTITION BY jobs.company_id
    ORDER BY jobs.first_seen_at DESC, jobs.id ASC
  ) ASC, companies.hiring_score DESC, companies.name COLLATE NOCASE ASC, jobs.id ASC`,
  title: "jobs.title COLLATE NOCASE ASC, jobs.id ASC",
  title_desc: "jobs.title COLLATE NOCASE DESC, jobs.id ASC",
  company: "companies.name COLLATE NOCASE ASC, jobs.title COLLATE NOCASE ASC, jobs.id ASC",
  company_desc: "companies.name COLLATE NOCASE DESC, jobs.title COLLATE NOCASE ASC, jobs.id ASC",
  sector: "companies.sector COLLATE NOCASE ASC, jobs.title COLLATE NOCASE ASC, jobs.id ASC",
  dept: "jobs.role_family COLLATE NOCASE ASC, jobs.title COLLATE NOCASE ASC, jobs.id ASC",
  loc: "jobs.location COLLATE NOCASE ASC, jobs.title COLLATE NOCASE ASC, jobs.id ASC",
  comp_low: "CASE WHEN jobs.compensation LIKE '$%' THEN jobs.compensation ELSE '~~~~' END ASC, jobs.id ASC",
  comp_high: "CASE WHEN jobs.compensation LIKE '$%' THEN jobs.compensation ELSE '' END DESC, jobs.id ASC",
  recent: "jobs.last_verified_at DESC, jobs.id ASC",
  oldest: "jobs.last_verified_at ASC, jobs.id ASC",
};

export function buildJobSearchSql(input: JobSearchInput, columns: string) {
  const where: string[] = [];
  const bindings: unknown[] = [];
  const equalInsensitive = (column: string, value: string | null) => {
    if (!value) return;
    where.push(`LOWER(${column}) = LOWER(?)`);
    bindings.push(value);
  };
  if (input.status !== "all") {
    where.push("jobs.status = ?");
    bindings.push(input.status);
  }
  if (input.q) {
    const needle = `%${input.q.toLowerCase()}%`;
    where.push(`(LOWER(jobs.title) LIKE ? OR LOWER(companies.name) LIKE ? OR
      LOWER(jobs.role_family) LIKE ? OR LOWER(jobs.location) LIKE ? OR
      LOWER(jobs.employment_type) LIKE ? OR LOWER(companies.sector) LIKE ? OR
      LOWER(companies.industry) LIKE ?)`);
    bindings.push(needle, needle, needle, needle, needle, needle, needle);
  }
  if (input.company) {
    where.push("(LOWER(companies.id)=LOWER(?) OR LOWER(companies.slug)=LOWER(?) OR LOWER(companies.name)=LOWER(?))");
    bindings.push(input.company, input.company, input.company);
  }
  equalInsensitive("companies.sector", input.sector);
  equalInsensitive("jobs.role_family", input.roleFamily);
  equalInsensitive("jobs.location", input.location);
  equalInsensitive("jobs.remote_status", input.remoteStatus);
  if (input.provider) {
    where.push("LOWER(COALESCE(jobs.provider, jobs.source)) = LOWER(?)");
    bindings.push(input.provider);
  }
  if (input.investor) {
    where.push(`EXISTS (SELECT 1 FROM company_investors ci
      JOIN investor_sources i ON i.id=ci.investor_source_id
      WHERE ci.company_id=jobs.company_id AND LOWER(i.name)=LOWER(?))`);
    bindings.push(input.investor);
  }
  if (input.newSince) {
    where.push("jobs.first_seen_at >= ?");
    bindings.push(input.newSince);
  }
  const predicate = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const from = " FROM jobs JOIN companies ON companies.id=jobs.company_id";
  return {
    countSql: `SELECT COUNT(*) AS total${from}${predicate}`,
    dataSql: `SELECT ${columns}${from}${predicate} ORDER BY ${ORDER_BY[input.sort]} LIMIT ? OFFSET ?`,
    bindings,
  };
}
