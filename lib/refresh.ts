import { env } from "cloudflare:workers";
import { fetchCanonicalBoard, type NormalizedJob } from "./ats-adapters";
import { ensureDatabase } from "./data";
import { GROWTH_WINDOW_DAYS, computeEvidenceConfidence, computeHiringScore } from "./hiring-score";
import { sourceKey, type AtsProvider } from "./source-registry";
import { normalizeSector } from "./types";

export { TRACKED_BOARDS, isBoardTracked } from "./tracked-boards";

export type ActiveCompanySource = {
  id: string;
  companyId: string;
  provider: AtsProvider;
  boardId: string;
};

export type SourceRefreshResult = {
  sourceId: string;
  companyId: string;
  provider: AtsProvider;
  status: "success" | "failed";
  verified: number;
  opened: number;
  closed: number;
  error?: string;
};

const transient = (error: unknown) =>
  error instanceof TypeError ||
  (error instanceof Error && /timeout|abort|429|5\d\d/i.test(error.message));

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function retryCanonicalFetch(
  source: ActiveCompanySource,
  fetcher: typeof fetch = fetch,
  attempts = 3
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchCanonicalBoard(source.provider, source.boardId, fetcher);
    } catch (error) {
      lastError = error;
      if (!transient(error) || attempt === attempts) break;
      await delay(250 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

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

function stableJobId(source: ActiveCompanySource, externalId: string) {
  const safe = `${source.provider}_${source.boardId}_${externalId}`
    .toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 180);
  return `job_${safe}`;
}

async function persistSuccessfulSource(
  source: ActiveCompanySource,
  normalized: NormalizedJob[],
  now: string
): Promise<SourceRefreshResult> {
  const existing = await env.DB.prepare(`SELECT id, external_id as externalId, status
    FROM jobs WHERE provider=? AND source_id=?`).bind(source.provider, source.id)
    .all<{ id: string; externalId: string; status: string }>();
  const currentByExternal = new Map(existing.results.map((job) => [job.externalId, job]));
  const observed = new Set(normalized.map((job) => job.externalId));
  const statements: D1PreparedStatement[] = [];
  let opened = 0;
  let closed = 0;

  for (const job of normalized) {
    const current = currentByExternal.get(job.externalId);
    const id = current?.id || stableJobId(source, job.externalId);
    const wasOpen = current?.status === "verified_open";
    statements.push(env.DB.prepare(`INSERT INTO jobs (
      id, company_id, external_id, provider, source_id, title, role_family, location,
      remote_status, employment_type, compensation, canonical_url, source, status,
      first_seen_at, published_at, last_verified_at, closed_at, summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified_open', ?, ?, ?, NULL, ?)
    ON CONFLICT(provider, source_id, external_id) DO UPDATE SET
      title=excluded.title, role_family=excluded.role_family, location=excluded.location,
      remote_status=excluded.remote_status, employment_type=excluded.employment_type,
      compensation=excluded.compensation, canonical_url=excluded.canonical_url,
      status='verified_open', published_at=COALESCE(jobs.published_at, excluded.published_at),
      last_verified_at=excluded.last_verified_at, closed_at=NULL, summary=excluded.summary`)
      .bind(
        id, source.companyId, job.externalId, source.provider, source.id, job.title,
        job.roleFamily, job.location, job.remoteStatus, job.employmentType,
        job.compensation, job.canonicalUrl, source.provider, now,
        job.publishedAt, now, job.summary
      ));
    if (!wasOpen) {
      opened += 1;
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO changes (
        id, entity_type, entity_id, change_type, title, description, occurred_at, source_url
      ) VALUES (?, 'job', ?, 'job_opened', ?, ?, ?, ?)`).bind(
        `change_open_${id}_${now.slice(0, 10)}`, id, `${job.title} opened`,
        `Canonical ${source.provider} posting verified open.`, now, job.canonicalUrl
      ));
    }
  }

  // Absence is meaningful only because fetchCanonicalBoard returned complete=true.
  for (const job of existing.results) {
    if (job.status !== "verified_open" || observed.has(job.externalId)) continue;
    closed += 1;
    statements.push(env.DB.prepare(`UPDATE jobs SET status='verified_closed',
      closed_at=?, last_verified_at=? WHERE id=? AND provider=? AND source_id=?`)
      .bind(now, now, job.id, source.provider, source.id));
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO changes (
      id, entity_type, entity_id, change_type, title, description, occurred_at, source_url
    ) SELECT ?, 'job', id, 'job_closed', title || ' closed', ?,
      ?, canonical_url FROM jobs WHERE id=?`).bind(
      `change_close_${job.id}_${now.slice(0, 10)}`,
      `Canonical ${source.provider} source no longer lists this role.`, now, job.id
    ));
  }

  statements.push(env.DB.prepare(`UPDATE company_sources SET last_attempted_at=?,
    last_successful_at=?, last_error=NULL, consecutive_failures=0,
    discovery_status='active' WHERE id=?`).bind(now, now, source.id));
  if (statements.length) await env.DB.batch(statements);
  return {
    sourceId: source.id, companyId: source.companyId, provider: source.provider,
    status: "success", verified: normalized.length, opened, closed,
  };
}

async function recordFailure(source: ActiveCompanySource, now: string, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  await env.DB.prepare(`UPDATE company_sources SET last_attempted_at=?, last_error=?,
    consecutive_failures=consecutive_failures+1 WHERE id=?`).bind(now, message, source.id).run();
  return {
    sourceId: source.id, companyId: source.companyId, provider: source.provider,
    status: "failed" as const, verified: 0, opened: 0, closed: 0, error: message,
  };
}

async function rescoreCompanies(now: string, successfulCompanyIds: Set<string>) {
  const windowStart = new Date(Date.parse(now) - GROWTH_WINDOW_DAYS * 86_400_000).toISOString();
  const profiles = await env.DB.prepare(`SELECT id, industry, stage, founded_year as foundedYear,
    latest_funding_date as latestFundingDate, source_url as sourceUrl, careers_url as careersUrl,
    last_verified_at as lastVerifiedAt FROM companies`).all<{
      id: string; industry: string; stage: string; foundedYear: number | null;
      latestFundingDate: string | null; sourceUrl: string; careersUrl: string; lastVerifiedAt: string;
    }>();
  for (const company of profiles.results) {
    const stats = await env.DB.prepare(`SELECT
      SUM(CASE WHEN status='verified_open' THEN 1 ELSE 0 END) AS openCount,
      SUM(CASE WHEN status='verified_open' AND last_verified_at=? THEN 1 ELSE 0 END) AS freshOpen
      FROM jobs WHERE company_id=?`).bind(now, company.id)
      .first<{ openCount: number; freshOpen: number }>();
    const growth = await env.DB.prepare(`SELECT
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
    await env.DB.prepare(`UPDATE companies SET sector=?, open_job_count=?,
      last_verified_at=?, hiring_score=?, evidence_confidence=? WHERE id=?`)
      .bind(normalizeSector(company.industry), openJobCount, lastVerifiedAt,
        hiringScore, evidenceConfidence, company.id).run();
  }
  return profiles.results.length;
}

export async function refreshCanonicalBoards(options: {
  fetcher?: typeof fetch; concurrency?: number; minimumSuccessRatio?: number;
} = {}) {
  await ensureDatabase();
  const now = new Date().toISOString();
  const sourcesResult = await env.DB.prepare(`SELECT id, company_id as companyId,
    provider, board_id as boardId FROM company_sources
    WHERE enabled=1 AND provider IN ('ashby','greenhouse','lever','workable')
    ORDER BY id`).all<ActiveCompanySource>();
  const sources = sourcesResult.results;
  const results = await mapBounded(sources, options.concurrency || 4, async (source) => {
    try {
      const complete = await retryCanonicalFetch(source, options.fetcher);
      return await persistSuccessfulSource(source, complete.jobs, now);
    } catch (error) {
      return recordFailure(source, now, error);
    }
  });
  const successful = results.filter((result) => result.status === "success");
  const scored = await rescoreCompanies(now, new Set(successful.map((item) => item.companyId)));
  const ratio = sources.length ? successful.length / sources.length : 0;
  const threshold = options.minimumSuccessRatio ?? 0.5;
  const summary = {
    refreshed_at: now,
    boards: sources.length,
    successful_sources: successful.length,
    failed_sources: results.length - successful.length,
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

export function canonicalIdentity(provider: AtsProvider, boardId: string, externalId: string) {
  return `${sourceKey(provider, boardId)}:${externalId}`;
}
