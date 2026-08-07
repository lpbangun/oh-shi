import {
  normalizeSector,
  type ChangeEvent,
  type Company,
  type DashboardJob,
  type Job,
  type MarketMovement,
  type MovementJobEvidence,
  type SectorName,
} from "./types";

export { normalizeSector } from "./types";
export type { MarketMovement } from "./types";

/**
 * Values the homepage needs that are not columns on any table.
 *
 * Everything here is derived from records we actually hold. Nothing is
 * estimated. Where the evidence does not exist yet the value is zero and the
 * UI renders a dash rather than inventing a number.
 */

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export type SectorStat = {
  key: string;
  name: string;
  companies: number;
  openRoles: number;
  meanScore: number;
  delta30d: number;
  /** Share of all tracked open roles, 0-100. */
  share: number;
};

export type CompanyDelta = {
  /** Net roles opened minus closed in the last 30 days, from the change feed. */
  delta30d: number;
};

export function sectorKey(industry: string) {
  return industry.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Prefer a deterministic reclassification from the source evidence. Keep a
 * previously stored non-Other sector only when the source has no usable
 * industry or company-context signal at all (for example a legacy row whose
 * source industry was never published).
 */
export function sectorForCompany(company: Company): SectorName {
  const inferred = normalizeSector(company.industry, company);
  return inferred === "Other" && company.sector !== "Other" ? company.sector : inferred;
}

/**
 * Net open-role movement per company over the last 30 days.
 *
 * The companies table stores only a current `openJobCount`, so a real
 * 30-day delta has to come from the change feed. A company with no change
 * events in the window is flat, which is the truth, not a placeholder.
 */
export function companyDeltas(
  companies: Company[],
  jobs: Pick<Job, "id" | "companyId">[],
  changes: ChangeEvent[],
  now = Date.now()
): Map<string, number> {
  const companyIdByJobId = new Map(jobs.map((job) => [job.id, job.companyId]));
  const deltas = new Map<string, number>(companies.map((company) => [company.id, 0]));
  const cutoff = now - THIRTY_DAYS_MS;

  for (const change of changes) {
    const direction =
      change.changeType === "job_opened" ? 1 : change.changeType === "job_closed" ? -1 : 0;
    if (direction === 0) continue;

    const occurred = Date.parse(change.occurredAt);
    if (!Number.isFinite(occurred) || occurred < cutoff || occurred > now) continue;

    const companyId =
      change.entityType === "company"
        ? change.entityId
        : companyIdByJobId.get(change.entityId);
    if (!companyId || !deltas.has(companyId)) continue;

    deltas.set(companyId, (deltas.get(companyId) as number) + direction);
  }

  return deltas;
}

/**
 * One row per normalized sector present in the data. The source industry is
 * retained on each company, while the stable sector keeps near-duplicate
 * labels together for aggregation and filtering.
 */
export function sectorStats(
  companies: Company[],
  deltas: Map<string, number>
): SectorStat[] {
  const totalOpen = companies.reduce((sum, company) => sum + company.openJobCount, 0);
  const buckets = new Map<string, Company[]>();

  for (const company of companies) {
    const name = sectorForCompany(company);
    const bucket = buckets.get(name);
    if (bucket) bucket.push(company);
    else buckets.set(name, [company]);
  }

  return Array.from(buckets.entries())
    .map(([name, members]) => {
      const openRoles = members.reduce((sum, company) => sum + company.openJobCount, 0);
      const scoreSum = members.reduce((sum, company) => sum + company.hiringScore, 0);
      const delta30d = members.reduce((sum, company) => sum + (deltas.get(company.id) || 0), 0);
      return {
        key: sectorKey(name),
        name,
        companies: members.length,
        openRoles,
        meanScore: Math.round(scoreSum / members.length),
        delta30d,
        share: totalOpen > 0 ? Math.round((openRoles / totalOpen) * 100) : 0,
      };
    })
    .sort((a, b) => b.openRoles - a.openRoles || a.name.localeCompare(b.name));
}

/** Distinct, sorted values for the column filter menus. */
export function facetValues(
  jobs: Array<DashboardJob & { company?: Company }>,
  companies: Company[] = []
) {
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const companyOf = (job: DashboardJob & { company?: Company }) =>
    job.company || companyById.get(job.companyId);
  const collect = (pick: (job: DashboardJob) => string) =>
    Array.from(new Set(jobs.map(pick).filter(Boolean))).sort((a, b) => a.localeCompare(b));

  return {
    departments: collect((job) => job.roleFamily),
    locations: collect((job) => job.location),
    employmentTypes: collect((job) => job.employmentType),
    providers: collect((job) => job.provider || job.source),
    companies: Array.from(new Set(jobs.map((job) => companyOf(job)?.name || "").filter(Boolean))).sort(),
    investors: Array.from(new Set(jobs.flatMap((job) => companyOf(job)?.investors || []))).sort(),
    sectors: Array.from(
      new Set(
        jobs
          .map((job) => {
            const company = companyOf(job);
            return company ? sectorForCompany(company) : "";
          })
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Default ordering uses ranked round-robin passes through company buckets.
 * This preserves hiring-signal priority while preventing a large board from
 * filling the first page. Explicit user sorts bypass this function.
 */
export function companyDiverseJobs<T extends Pick<Job, "id" | "companyId" | "title" | "firstSeenAt">>(
  jobs: T[],
  companies: Company[]
) {
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const buckets = new Map<string, T[]>();
  for (const job of jobs) {
    const bucket = buckets.get(job.companyId) || [];
    bucket.push(job);
    buckets.set(job.companyId, bucket);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) =>
      b.firstSeenAt.localeCompare(a.firstSeenAt) ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id)
    );
  }
  const companyIds = [...buckets.keys()].sort((a, b) =>
    (companyById.get(b)?.hiringScore || 0) - (companyById.get(a)?.hiringScore || 0) ||
    (companyById.get(a)?.name || a).localeCompare(companyById.get(b)?.name || b) ||
    a.localeCompare(b)
  );
  const output: T[] = [];
  for (let round = 0; output.length < jobs.length; round += 1) {
    let added = false;
    for (const companyId of companyIds) {
      const job = buckets.get(companyId)?.[round];
      if (job) {
        output.push(job);
        added = true;
      }
    }
    if (!added) break;
  }
  return output;
}

type MovementBucket = {
  date: string;
  sector: SectorName;
  company: Company | null;
  evidence: MovementJobEvidence[];
};

function movementDay(occurredAt: string) {
  const parsed = Date.parse(occurredAt);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function roleSummary(jobs: MovementJobEvidence[], limit = 3) {
  const titles = jobs.map((job) => job.title);
  if (titles.length <= limit) return titles.join(", ");
  return `${titles.slice(0, limit).join(", ")} +${titles.length - limit} more`;
}

function movementCounts(evidence: MovementJobEvidence[]) {
  const openedCount = evidence.filter((item) => item.changeType === "job_opened").length;
  const closedCount = evidence.filter((item) => item.changeType === "job_closed").length;
  return { openedCount, closedCount, netChange: openedCount - closedCount };
}

function movementDescription(evidence: MovementJobEvidence[]) {
  const { openedCount, closedCount } = movementCounts(evidence);
  if (openedCount > 0 && closedCount > 0) {
    return `${openedCount} opened and ${closedCount} closed: ${roleSummary(evidence)}.`;
  }
  if (openedCount > 0) return `${openedCount} opened: ${roleSummary(evidence)}.`;
  return `${closedCount} closed: ${roleSummary(evidence)}.`;
}

function companyMovementTitle(company: Company, evidence: MovementJobEvidence[]) {
  const { openedCount, closedCount } = movementCounts(evidence);
  if (openedCount > 0 && closedCount === 0) {
    return `${company.name} opened ${openedCount} ${openedCount === 1 ? "role" : "roles"}`;
  }
  if (closedCount > 0 && openedCount === 0) {
    return `${company.name} closed ${closedCount} ${closedCount === 1 ? "role" : "roles"}`;
  }
  return `${company.name} changed ${evidence.length} ${evidence.length === 1 ? "role" : "roles"}`;
}

function sectorMovementTitle(sector: SectorName, evidence: MovementJobEvidence[]) {
  const { openedCount, closedCount } = movementCounts(evidence);
  if (openedCount > 0 && closedCount === 0) {
    return `${openedCount} new ${sector} ${openedCount === 1 ? "posting" : "postings"}`;
  }
  if (closedCount > 0 && openedCount === 0) {
    return `${closedCount} ${sector} ${closedCount === 1 ? "posting" : "postings"} closed`;
  }
  return `${sector} hiring changed across ${evidence.length} roles`;
}

function movementEvidence(
  companies: Company[],
  jobs: Pick<Job, "id" | "companyId" | "title" | "canonicalUrl">[],
  changes: ChangeEvent[]
) {
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const seen = new Set<string>();
  const result: Array<{
    date: string;
    company: Company;
    evidence: MovementJobEvidence;
  }> = [];

  for (const change of changes) {
    if (change.changeType !== "job_opened" && change.changeType !== "job_closed") continue;
    const job = jobById.get(change.entityId);
    const company = job ? companyById.get(job.companyId) : undefined;
    const date = movementDay(change.occurredAt);
    if (!job || !company || !date) continue;

    // One canonical job can only open or close once per UTC day. This prevents
    // refresh retries from inflating movement totals even if event ids differ.
    const evidenceKey = `${date}:${job.id}:${change.changeType}`;
    if (seen.has(evidenceKey)) continue;
    seen.add(evidenceKey);
    result.push({
      date,
      company,
      evidence: {
        id: job.id,
        title: job.title,
        changeType: change.changeType,
        canonicalUrl: job.canonicalUrl,
        sourceUrl: change.sourceUrl,
      },
    });
  }

  return result;
}

function sortMovements(movements: MarketMovement[]) {
  return movements.sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      Math.abs(b.netChange) - Math.abs(a.netChange) ||
      a.id.localeCompare(b.id)
  );
}

/** Aggregate canonical job changes into one movement per company per UTC day. */
export function companyDayMovements(
  companies: Company[],
  jobs: Pick<Job, "id" | "companyId" | "title" | "canonicalUrl">[],
  changes: ChangeEvent[]
): MarketMovement[] {
  const buckets = new Map<string, MovementBucket>();
  for (const item of movementEvidence(companies, jobs, changes)) {
    const key = `${item.date}:${item.company.id}`;
    const bucket = buckets.get(key) || {
      date: item.date,
      sector: sectorForCompany(item.company),
      company: item.company,
      evidence: [],
    };
    bucket.evidence.push(item.evidence);
    buckets.set(key, bucket);
  }

  return sortMovements(
    Array.from(buckets.values()).map((bucket) => {
      const company = bucket.company as Company;
      const jobs = bucket.evidence.sort(
        (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
      );
      const counts = movementCounts(jobs);
      return {
        id: `movement:company:${bucket.date}:${company.id}`,
        group: "company" as const,
        type: counts.openedCount > 0 && counts.closedCount > 0
          ? "mixed" as const
          : counts.openedCount > 0 ? "opened" as const : "closed" as const,
        date: bucket.date,
        title: companyMovementTitle(company, jobs),
        description: movementDescription(jobs),
        sector: bucket.sector,
        companyId: company.id,
        companySlug: company.slug,
        ...counts,
        jobs,
        evidenceCount: jobs.length,
        sourceUrls: Array.from(new Set(jobs.map((job) => job.sourceUrl))).sort(),
        hiringScore: company.hiringScore,
        href: `/company/${encodeURIComponent(company.slug)}`,
      };
    })
  );
}

/** Aggregate canonical job changes into one movement per normalized sector/day. */
export function sectorDayMovements(
  companies: Company[],
  jobs: Pick<Job, "id" | "companyId" | "title" | "canonicalUrl">[],
  changes: ChangeEvent[]
): MarketMovement[] {
  const buckets = new Map<string, MovementBucket>();
  for (const item of movementEvidence(companies, jobs, changes)) {
    const sector = sectorForCompany(item.company);
    const key = `${item.date}:${sector}`;
    const bucket = buckets.get(key) || {
      date: item.date,
      sector,
      company: null,
      evidence: [],
    };
    bucket.evidence.push(item.evidence);
    buckets.set(key, bucket);
  }

  return sortMovements(
    Array.from(buckets.values()).map((bucket) => {
      const jobs = bucket.evidence.sort(
        (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
      );
      const counts = movementCounts(jobs);
      return {
        id: `movement:sector:${bucket.date}:${sectorKey(bucket.sector)}`,
        group: "sector" as const,
        type: counts.openedCount > 0 && counts.closedCount > 0
          ? "mixed" as const
          : counts.openedCount > 0 ? "opened" as const : "closed" as const,
        date: bucket.date,
        title: sectorMovementTitle(bucket.sector, jobs),
        description: movementDescription(jobs),
        sector: bucket.sector,
        companyId: null,
        companySlug: null,
        ...counts,
        jobs,
        evidenceCount: jobs.length,
        sourceUrls: Array.from(new Set(jobs.map((job) => job.sourceUrl))).sort(),
        hiringScore: null,
        href: `/?sector=${encodeURIComponent(bucket.sector)}`,
      };
    })
  );
}

/** Funding announcements stay standalone company movements with source links. */
export function fundingMovements(
  companies: Company[],
  changes: ChangeEvent[]
): MarketMovement[] {
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const seen = new Set<string>();
  const movements: MarketMovement[] = [];
  for (const change of changes) {
    if (change.changeType !== "funding_announced" || change.entityType !== "company") continue;
    const company = companyById.get(change.entityId);
    const date = movementDay(change.occurredAt);
    if (!company || !date || seen.has(change.id)) continue;
    seen.add(change.id);
    movements.push({
      id: change.id,
      group: "company",
      type: "funding",
      date,
      title: change.title,
      description: change.description,
      sector: sectorForCompany(company),
      companyId: company.id,
      companySlug: company.slug,
      openedCount: 0,
      closedCount: 0,
      netChange: 0,
      jobs: [],
      evidenceCount: 1,
      sourceUrls: [change.sourceUrl],
      hiringScore: company.hiringScore,
      href: `/company/${encodeURIComponent(company.slug)}`,
    });
  }
  return sortMovements(movements);
}

export function deriveMarketMovements(
  companies: Company[],
  jobs: Job[],
  changes: ChangeEvent[],
  group: "company" | "sector" | "all" = "all"
): MarketMovement[] {
  if (group === "company") return sortMovements([
    ...companyDayMovements(companies, jobs, changes),
    ...fundingMovements(companies, changes),
  ]);
  if (group === "sector") return sectorDayMovements(companies, jobs, changes);
  return sortMovements([
    ...companyDayMovements(companies, jobs, changes),
    ...sectorDayMovements(companies, jobs, changes),
    ...fundingMovements(companies, changes),
  ]);
}
