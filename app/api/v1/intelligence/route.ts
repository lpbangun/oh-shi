import {
  companyDayMovements,
  companyDeltas,
  fundingMovements,
  sectorForCompany,
  sectorDayMovements,
  sectorStats,
} from "@/lib/derive";
import {
  companyScoreReceipts,
  EVIDENCE_CONFIDENCE_METHODOLOGY_VERSION,
  HIRING_SCORE_METHODOLOGY_VERSION,
} from "@/lib/hiring-score";
import {
  enumFilter,
  IntelligenceQueryError,
  pageData,
  parseCursor,
  parseIsoFilter,
  parseLimit,
  parseNumberFilter,
  parseView,
  stringFilter,
  validateParameters,
  type IntelligenceView,
} from "@/lib/intelligence-query";
import { getCoverageMetrics, listChanges, listCompanies, listJobs, searchJobs } from "@/lib/data";
import { conditionalJsonResponse } from "@/lib/conditional-cache";
import { JobSearchError, parseJobSearch } from "@/lib/job-search";
import { ROLE_FAMILIES, ROLE_FAMILY_ALIASES } from "@/lib/job-normalization";
import { isBoardTracked } from "@/lib/tracked-boards";
import type { ChangeEvent, Company, Job } from "@/lib/types";

export const dynamic = "force-dynamic";

const SCHEMA_VERSION = "1.1";
const LICENSE =
  "CC BY 4.0 applies only to project-owned material; source rights remain with their owners.";
const MOVEMENT_GROUPS = ["company_day", "sector_day", "none"] as const;
const MOVEMENT_TYPES = ["opened", "updated", "closed", "funding", "mixed"] as const;

const capabilities = {
  preferred_entrypoint: "/api/v1/intelligence",
  documentation: "/llms.txt",
  views: {
    jobs: {
      default_limit: 25,
      default_order: "company-diverse ranked round-robin with stable job id tie-breaker",
      filters: [
        "q",
        "status",
        "company",
        "sector",
        "role_family",
        "location",
        "remote_status",
        "provider",
        "investor",
        "new_since",
        "sort",
        "limit",
        "cursor",
      ],
      filter_availability: {
        investor: "See availability.investorFiltering; unavailable means the filter returns no matches.",
      },
      filter_values: {
        role_family: {
          canonical: ROLE_FAMILIES,
          aliases: ROLE_FAMILY_ALIASES,
        },
      },
    },
    companies: {
      default_limit: 10,
      filters: ["q", "sector", "investor", "provider", "min_signal", "min_confidence", "limit", "cursor"],
    },
    movements: {
      default_limit: 25,
      filters: [
        "q",
        "after",
        "before",
        "type",
        "company",
        "sector",
        "group",
        "limit",
        "cursor",
      ],
      groups: MOVEMENT_GROUPS,
    },
    sectors: {
      default_limit: 25,
      filters: ["q", "limit", "cursor"],
    },
  },
  cursor: "Pass page.next_cursor unchanged to the same view and filters.",
  compatibility_endpoints: ["/api/v1/jobs", "/api/v1/companies", "/api/v1/changes"],
  coverage_endpoint: "/api/v1/coverage",
  conditional_requests: "This capabilities representation returns ETag and honors If-None-Match.",
};

const lower = (value: string | null | undefined) => value?.trim().toLowerCase() || "";
const contains = (value: string | null | undefined, query: string | null) =>
  !query || lower(value).includes(lower(query));

function latestTimestamp(companies: Company[], jobs: Job[], changes: ChangeEvent[]) {
  const timestamps = [
    ...companies.map((item) => item.lastVerifiedAt),
    ...jobs.map((item) => item.lastVerifiedAt),
    ...changes.map((item) => item.occurredAt),
  ].filter((value) => Number.isFinite(Date.parse(value)));
  return timestamps.sort().at(-1) || new Date(0).toISOString();
}

function companyReceipts(
  company: Company,
  jobs: Job[],
  changes: ChangeEvent[],
  dataAsOf: string
) {
  const receipts = companyScoreReceipts(
    company,
    jobs,
    changes,
    dataAsOf,
    isBoardTracked(company.id)
  );
  return { signal: receipts.hiring, confidence: receipts.evidence };
}

function movementType(item: {
  openedCount: number;
  closedCount: number;
  jobs: unknown[];
  type?: string;
}) {
  if (item.type === "updated") return "updated";
  if (item.jobs.length === 0) return "funding";
  if (item.openedCount > 0 && item.closedCount > 0) return "mixed";
  return item.openedCount > 0 ? "opened" : "closed";
}

function rawMovements(
  changes: ChangeEvent[],
  jobs: Job[],
  companies: Company[]
) {
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const companyById = new Map(companies.map((company) => [company.id, company]));
  return changes.map((change) => {
    const job = change.entityType === "job" ? jobById.get(change.entityId) : undefined;
    const company = companyById.get(job?.companyId || change.entityId);
    return {
      id: change.id,
      group: "none",
      date: change.occurredAt.slice(0, 10),
      occurredAt: change.occurredAt,
      title: change.title,
      description: change.description,
      type:
        change.changeType === "job_opened"
          ? "opened"
          : change.changeType === "job_closed"
            ? "closed"
            : change.changeType === "job_updated"
              ? "updated"
              : "funding",
      sector: company ? sectorForCompany(company) : "Other",
      companyId: company?.id || null,
      companySlug: company?.slug || null,
      openedCount: change.changeType === "job_opened" ? 1 : 0,
      closedCount: change.changeType === "job_closed" ? 1 : 0,
      netChange:
        change.changeType === "job_opened" ? 1 : change.changeType === "job_closed" ? -1 : 0,
      jobs: job
        ? [
            {
              id: job.id,
              title: job.title,
              changeType: change.changeType,
              canonicalUrl: job.canonicalUrl,
              sourceUrl: change.sourceUrl,
            },
          ]
        : [],
      evidenceCount: 1,
      sourceUrls: [change.sourceUrl],
      hiringScore: company?.hiringScore || null,
      href: job ? `/job/${job.id}` : company ? `/company/${company.slug}` : change.sourceUrl,
    };
  });
}

function responseEnvelope(
  view: IntelligenceView | "capabilities",
  dataAsOf: string,
  appliedFilters: Record<string, string | number | null>,
  data: unknown,
  page: unknown = null
) {
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    data_as_of: dataAsOf,
    view,
    applied_filters: appliedFilters,
    page,
    methodology_version: {
      hiring_signal: HIRING_SCORE_METHODOLOGY_VERSION,
      evidence_confidence: EVIDENCE_CONFIDENCE_METHODOLOGY_VERSION,
    },
    license: LICENSE,
    data,
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const view = parseView(url.searchParams);
    validateParameters(url.searchParams, view);

    if (!view) {
      const coverage = await getCoverageMetrics();
      const dataAsOf = coverage.lastCanonicalRefresh || coverage.lastDiscoveryRun || new Date(0).toISOString();
      const data = {
        ...capabilities,
        availability: coverage.capabilityAvailability,
      };
      const payload = responseEnvelope("capabilities", dataAsOf, {}, data);
      return conditionalJsonResponse(request, payload, {
        cacheControl: "public, max-age=3600",
        validator: JSON.stringify({ schema: SCHEMA_VERSION, dataAsOf, data }),
      });
    }

    if (view === "jobs") {
      const changeFeedStart = new Date().toISOString();
      const query = parseJobSearch(url.searchParams, { defaultLimit: 25 });
      const [result, coverage] = await Promise.all([searchJobs(query), getCoverageMetrics()]);
      const dataAsOf = coverage.lastCanonicalRefresh || latestTimestamp([], result.jobs, []);
      const payload = {
        ...responseEnvelope("jobs", dataAsOf, {
          q: query.q,
          status: query.status,
          company: query.company,
          sector: query.sector,
          role_family: query.roleFamily,
          location: query.location,
          remote_status: query.remoteStatus,
          provider: query.provider,
          investor: query.investor,
          new_since: query.newSince,
          sort: query.sort,
          limit: query.limit,
        }, result.jobs, {
          limit: result.limit,
          returned: result.jobs.length,
          next_cursor: result.nextOffset === null ? null : `v2.jobs.${result.nextOffset}`,
          total: result.total,
        }),
        coverage,
        incremental: {
          after: changeFeedStart,
          changes_url: `/api/v1/changes?after=${encodeURIComponent(changeFeedStart)}`,
          instruction: "Process every job event, refresh /api/v1/jobs/:id, then re-evaluate this filter.",
        },
      };
      return conditionalJsonResponse(request, payload, {
        cacheControl: "public, max-age=180, s-maxage=600",
        validator: JSON.stringify({ query, result, coverage, dataAsOf }),
      });
    }

    const [companies, jobs, changes, coverage] = await Promise.all([
      listCompanies(),
      listJobs(true),
      listChanges(),
      getCoverageMetrics(),
    ]);
    const dataAsOf = latestTimestamp(companies, jobs, changes);
    const calculationTime = new Date().toISOString();
    const q = stringFilter(url.searchParams, "q");
    const limit = parseLimit(url.searchParams, view);
    const offset = parseCursor(url.searchParams, view);
    const companyById = new Map(companies.map((company) => [company.id, company]));
    const appliedFilters: Record<string, string | number | null> = { q, limit };

    let rows: unknown[];

    if (view === "companies") {
      const sector = stringFilter(url.searchParams, "sector");
      const minSignal = parseNumberFilter(url.searchParams, "min_signal");
      const minConfidence = parseNumberFilter(url.searchParams, "min_confidence");
      const investor = stringFilter(url.searchParams, "investor");
      const provider = stringFilter(url.searchParams, "provider");
      Object.assign(appliedFilters, {
        sector,
        min_signal: minSignal,
        min_confidence: minConfidence,
        investor,
        provider,
      });
      rows = companies
        .map((company) => {
          const receipts = companyReceipts(company, jobs, changes, calculationTime);
          return {
            ...company,
            hiringScore: receipts.signal.value,
            evidenceConfidence: receipts.confidence.value,
            ...receipts,
          };
        })
        .filter((company) => {
          if (sector && lower(sectorForCompany(company)) !== lower(sector)) return false;
          if (minSignal !== null && company.hiringScore < minSignal) return false;
          if (minConfidence !== null && company.evidenceConfidence < minConfidence) return false;
          if (investor && !company.investors?.some((value) => lower(value) === lower(investor))) return false;
          if (provider && !company.providers?.some((value) => lower(value) === lower(provider))) return false;
          return !q || [company.name, company.sector, company.industry, company.stage]
            .some((value) => contains(value, q));
        })
        .sort((a, b) => b.hiringScore - a.hiringScore || a.id.localeCompare(b.id));
    } else if (view === "movements") {
      const after = parseIsoFilter(url.searchParams, "after");
      const before = parseIsoFilter(url.searchParams, "before");
      const type = enumFilter(url.searchParams, "type", MOVEMENT_TYPES);
      const companyFilter = stringFilter(url.searchParams, "company");
      const sector = stringFilter(url.searchParams, "sector");
      const group = enumFilter(url.searchParams, "group", MOVEMENT_GROUPS) || "company_day";
      Object.assign(appliedFilters, { after, before, type, company: companyFilter, sector, group });
      const groupedMovements =
        group === "company_day"
          ? companyDayMovements(companies, jobs, changes)
          : group === "sector_day"
            ? sectorDayMovements(companies, jobs, changes)
            : rawMovements(changes, jobs, companies);
      const movements =
        group === "none"
          ? groupedMovements
          : [
              ...groupedMovements,
              ...fundingMovements(companies, changes),
            ];
      rows = movements
        .map((movement) => ({ ...movement, type: movementType(movement) }))
        .filter((movement) => {
          const occurredAt = "occurredAt" in movement
            ? String(movement.occurredAt)
            : `${movement.date}T23:59:59.999Z`;
          if (after && occurredAt <= after) return false;
          if (before && occurredAt >= before) return false;
          if (type && movement.type !== type) return false;
          const company = movement.companyId ? companyById.get(movement.companyId) : undefined;
          if (
            companyFilter &&
            ![movement.companyId, movement.companySlug, company?.name]
              .some((value) => contains(value, companyFilter))
          ) return false;
          if (sector && lower(movement.sector) !== lower(sector)) return false;
          return !q || [movement.title, movement.description, movement.sector, company?.name]
            .some((value) => contains(value, q));
        })
        .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    } else {
      const deltas = companyDeltas(companies, jobs, changes, Date.parse(dataAsOf));
      rows = sectorStats(companies, deltas)
        .filter((item) => !q || contains(item.name, q))
        .sort((a, b) => b.openRoles - a.openRoles || a.key.localeCompare(b.key));
    }

    const paged = pageData(rows, view, offset, limit);
    const payload = {
      ...responseEnvelope(view, dataAsOf, appliedFilters, paged.data, paged.page),
      coverage,
    };
    return conditionalJsonResponse(request, payload, {
      cacheControl: "public, max-age=180, s-maxage=600",
      validator: JSON.stringify({ view, dataAsOf, appliedFilters, page: paged, coverage }),
    });
  } catch (error) {
    if (error instanceof IntelligenceQueryError || error instanceof JobSearchError) {
      return Response.json(
        {
          schema_version: SCHEMA_VERSION,
          error: "invalid_request",
          message: error.message,
        },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }
    throw error;
  }
}
