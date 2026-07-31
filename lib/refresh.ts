import { env } from "cloudflare:workers";
import { retryCanonicalFetch } from "./canonical-fetch-retry";
import {
  persistCanonicalFailure,
  persistCanonicalSource,
  type CanonicalCompanySource,
  type SourceRefreshResult as PersistedSourceRefreshResult,
} from "./canonical-refresh-store";
import { ensureDatabase } from "./data";
import { GROWTH_WINDOW_DAYS, computeEvidenceConfidence, computeHiringScore } from "./hiring-score";
import { groupSourcesByCompany } from "./ingestion-core";
import { normalizeSector } from "./types";

export { TRACKED_BOARDS, isBoardTracked } from "./tracked-boards";
export { retryCanonicalFetch } from "./canonical-fetch-retry";

export type ActiveCompanySource = CanonicalCompanySource;
export type SourceRefreshResult = PersistedSourceRefreshResult;

export async function mapBounded<T, R>(
  values: T[],
  concurrency: number,
  work: (value: T) => Promise<R>
) {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await work(values[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

async function rescoreCompanies(
  database: D1Database,
  now: string,
  successfulCompanyIds: Set<string>
) {
  const windowStart = new Date(Date.parse(now) - GROWTH_WINDOW_DAYS * 86_400_000).toISOString();
  const profiles = await database.prepare(`SELECT id, industry, stage, founded_year as foundedYear,
    latest_funding_date as latestFundingDate, source_url as sourceUrl, careers_url as careersUrl,
    last_verified_at as lastVerifiedAt FROM companies`).all<{
      id: string; industry: string; stage: string; foundedYear: number | null;
      latestFundingDate: string | null; sourceUrl: string; careersUrl: string; lastVerifiedAt: string;
    }>();
  for (const company of profiles.results) {
    const stats = await database.prepare(`SELECT
      SUM(CASE WHEN status='verified_open' THEN 1 ELSE 0 END) AS openCount,
      SUM(CASE WHEN status='verified_open' AND last_verified_at=? THEN 1 ELSE 0 END) AS freshOpen
      FROM jobs WHERE company_id=?`).bind(now, company.id)
      .first<{ openCount: number; freshOpen: number }>();
    const growth = await database.prepare(`SELECT
      SUM(CASE WHEN changes.change_type='job_opened' THEN 1 ELSE 0 END) AS opened90,
      SUM(CASE WHEN changes.change_type='job_closed' THEN 1 ELSE 0 END) AS closed90
      FROM changes JOIN jobs ON jobs.id = changes.entity_id
      WHERE jobs.company_id = ?
        AND changes.occurred_at >= ?
        AND changes.occurred_at <= ?`)
      .bind(company.id, windowStart, now).first<{ opened90: number; closed90: number }>();
    const boardVerified = successfulCompanyIds.has(company.id);
    const lastVerifiedAt = boardVerified ? now : company.lastVerifiedAt;
    const openJobCount = Number(stats?.openCount || 0);
    const hiringScore = computeHiringScore({
      openJobCount, openedLast90: Number(growth?.opened90 || 0),
      closedLast90: Number(growth?.closed90 || 0), stage: company.stage,
      latestFundingDate: company.latestFundingDate, lastVerifiedAt, now,
    });
    const evidenceConfidence = computeEvidenceConfidence({
      openJobCount, freshlyVerifiedOpenCount: Number(stats?.freshOpen || 0),
      boardVerified, foundedYear: company.foundedYear,
      latestFundingDate: company.latestFundingDate, sourceUrl: company.sourceUrl,
      careersUrl: company.careersUrl, lastVerifiedAt, now,
    });
    await database.prepare(`UPDATE companies SET sector=?, open_job_count=?,
      last_verified_at=?, hiring_score=?, evidence_confidence=? WHERE id=?`)
      .bind(normalizeSector(company.industry), openJobCount, lastVerifiedAt,
        hiringScore, evidenceConfidence, company.id).run();
  }
  return profiles.results.length;
}

export async function refreshCanonicalBoards(options: {
  fetcher?: typeof fetch;
  concurrency?: number;
  minimumSuccessRatio?: number;
  database?: D1Database;
  now?: string;
  runId?: string;
} = {}) {
  if (!options.database) await ensureDatabase();
  const database = options.database || env.DB;
  const now = options.now || new Date().toISOString();
  const runId = options.runId || `canonical_${crypto.randomUUID()}`;
  const sourcesResult = await database.prepare(`SELECT id, company_id as companyId,
    provider, board_id as boardId FROM company_sources
    WHERE enabled=1 AND provider IN (
      'ashby','greenhouse','lever','workable','recruitee','personio',
      'smartrecruiters','structured'
    )
    AND discovery_status!='applying_quarantine'
    ORDER BY id`).all<ActiveCompanySource>();
  const sources = sourcesResult.results;
  const groupedResults = await mapBounded(
    groupSourcesByCompany(sources),
    options.concurrency || 4,
    async (companySources) => {
      const companyResults: SourceRefreshResult[] = [];
      // Alternate sources for one employer must observe each other's committed
      // identity decisions. Concurrency remains bounded across employers.
      for (const source of companySources) {
        try {
          const complete = await retryCanonicalFetch(source, options.fetcher);
          companyResults.push(
            await persistCanonicalSource(database, source, complete.jobs, now, runId)
          );
        } catch (error) {
          companyResults.push(
            await persistCanonicalFailure(database, source, now, runId, error)
          );
        }
      }
      return companyResults;
    }
  );
  const results = groupedResults.flat();
  const successful = results.filter((result) => result.status === "success");
  const quarantined = results.filter((result) => result.status === "quarantined");
  const scored = await rescoreCompanies(
    database,
    now,
    new Set(successful.map((item) => item.companyId))
  );
  const ratio = sources.length ? successful.length / sources.length : 0;
  const threshold = options.minimumSuccessRatio ?? 0.5;
  const summary = {
    run_id: runId,
    refreshed_at: now,
    boards: sources.length,
    successful_sources: successful.length,
    failed_sources: results.length - successful.length,
    quarantined_sources: quarantined.length,
    partial_success: successful.length > 0 && successful.length < results.length,
    verified: results.reduce((sum, item) => sum + item.verified, 0),
    opened: results.reduce((sum, item) => sum + item.opened, 0),
    closed: results.reduce((sum, item) => sum + item.closed, 0),
    scored,
    success_ratio: ratio,
    required_success_ratio: threshold,
    overall_status: (!sources.length || ratio < threshold)
      ? "failed"
      : successful.length < sources.length ? "partial_success" : "success",
    sources: results,
  };
  return summary;
}
