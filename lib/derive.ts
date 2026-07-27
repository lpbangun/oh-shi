import type { ChangeEvent, Company, Job } from "./types";

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
 * Net open-role movement per company over the last 30 days.
 *
 * The companies table stores only a current `openJobCount`, so a real
 * 30-day delta has to come from the change feed. A company with no change
 * events in the window is flat, which is the truth, not a placeholder.
 */
export function companyDeltas(
  companies: Company[],
  jobs: Job[],
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
 * One row per industry present in the data. We do not impose a taxonomy the
 * database does not have: the sector is the company's own `industry` value.
 */
export function sectorStats(
  companies: Company[],
  deltas: Map<string, number>
): SectorStat[] {
  const totalOpen = companies.reduce((sum, company) => sum + company.openJobCount, 0);
  const buckets = new Map<string, Company[]>();

  for (const company of companies) {
    const name = company.industry || "Unclassified";
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
export function facetValues(jobs: Job[]) {
  const collect = (pick: (job: Job) => string) =>
    Array.from(new Set(jobs.map(pick).filter(Boolean))).sort((a, b) => a.localeCompare(b));

  return {
    departments: collect((job) => job.roleFamily),
    locations: collect((job) => job.location),
    employmentTypes: collect((job) => job.employmentType),
  };
}
