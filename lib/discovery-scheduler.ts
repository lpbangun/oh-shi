import { DISCOVERY_PIPELINE_VERSION } from "./discovery-version";
import { discoveryLeaseCutoff, discoveryRunnableSql } from "./discovery-policy";

export const DISCOVERY_SCHEDULE_MAX_ITEMS = 25;

/** Invalid/non-finite limits fail closed rather than leaking NaN/Infinity to SQL. */
export function boundedDiscoveryScheduleLimit(requestedLimit: number) {
  return Number.isFinite(requestedLimit)
    ? Math.min(DISCOVERY_SCHEDULE_MAX_ITEMS, Math.max(0, Math.trunc(requestedLimit))) : 0;
}

export type ScheduledCandidate = {
  id: string;
  normalizedDomain: string;
  companyName: string;
  websiteUrl: string;
  status: string;
  attemptCount: number;
  investorSourceId?: string;
  evidenceUrl?: string;
};

const runnable = discoveryRunnableSql("q");

/** Reserve a share of each bounded page for retries so fresh arrivals cannot starve them. */
export async function selectDiscoveryCandidates(database: D1Database, now: string, requestedLimit: number) {
  const limit = boundedDiscoveryScheduleLimit(requestedLimit);
  if (!limit) return [] as ScheduledCandidate[];
  const load = (fresh: boolean) => database.prepare(`SELECT q.id,
    q.normalized_domain as normalizedDomain, q.company_name as companyName,
    q.website_url as websiteUrl, q.status, q.attempt_count as attemptCount,
    qi.investor_source_id as investorSourceId, qi.evidence_url as evidenceUrl
    FROM discovery_queue q LEFT JOIN discovery_queue_investors qi ON qi.candidate_id=q.id
    WHERE ${runnable} AND q.attempt_count ${fresh ? "= 0" : "> 0"}
    GROUP BY q.id
    ORDER BY ${fresh
      ? "q.first_discovered_at DESC, q.id DESC"
      : "COALESCE(q.next_attempt_at, q.first_discovered_at) ASC, q.id ASC"}
    LIMIT ?`).bind(DISCOVERY_PIPELINE_VERSION, discoveryLeaseCutoff(now), now, limit)
    .all<ScheduledCandidate>();
  const [fresh, retry] = await Promise.all([load(true), load(false)]);
  const freshQuota = Math.max(1, Math.ceil(limit * 0.7));
  const retryQuota = limit - freshQuota;
  const selected = [
    ...fresh.results.slice(0, freshQuota),
    ...retry.results.slice(0, retryQuota),
    ...fresh.results.slice(freshQuota),
    ...retry.results.slice(retryQuota),
  ];
  return selected.slice(0, limit);
}

/** One atomic lease per item; a stale resolving lease is reclaimed after an hour. */
export async function claimDiscoveryCandidate(
  database: D1Database,
  candidateId: string,
  now: string
) {
  const result = await database.prepare(`UPDATE discovery_queue AS q SET
    status='resolving', last_attempted_at=?, attempt_count=attempt_count+1,
    next_attempt_at=NULL WHERE id=? AND ${runnable}`)
    .bind(now, candidateId, DISCOVERY_PIPELINE_VERSION, discoveryLeaseCutoff(now), now).run();
  if (Number(result.meta.changes || 0) !== 1) return null;
  const claimed = await database.prepare("SELECT attempt_count as attemptCount FROM discovery_queue WHERE id=?")
    .bind(candidateId).first<{ attemptCount: number }>();
  return claimed?.attemptCount || null;
}
