export const DISCOVERY_RETRY_BASE_MS = 6 * 60 * 60 * 1_000;
export const DISCOVERY_RETRY_MAX_MS = 7 * 24 * 60 * 60 * 1_000;
export const DISCOVERY_ACTIVATION_DEFER_MS = 2 * 60 * 60 * 1_000;

export type DiscoveryOutcome =
  | "activated"
  | "ambiguous"
  | "canonical_fetch_failed"
  | "canonical_source_found"
  | "no_ats_detected"
  | "no_us_openings"
  | "probe_blocked"
  | "probe_failed"
  | "unsupported";

/** Evidence must explicitly permit automated access before a candidate is fetched. */
export function discoveryPermissionSql(queueAlias = "q") {
  if (!/^[a-z][a-z0-9_]*$/i.test(queueAlias)) throw new Error("invalid_sql_alias");
  return `EXISTS (
    SELECT 1 FROM startup_domain_evidence permission_evidence
    WHERE permission_evidence.canonical_domain=${queueAlias}.normalized_domain
      AND permission_evidence.permission_status='permitted'
  )`;
}

/**
 * Runnable-candidate predicate. Positional bindings are pipeline version,
 * stale-resolving cutoff, and current time, in that order.
 */
export function discoveryRunnableSql(queueAlias = "q") {
  const permission = discoveryPermissionSql(queueAlias);
  return `(
    (
      ${queueAlias}.status IN ('discovered','canonical_source_found')
      OR (${queueAlias}.status='needs_review'
        AND COALESCE(${queueAlias}.discovery_version, '') <> ?)
      OR (${queueAlias}.status='resolving' AND (
        ${queueAlias}.last_attempted_at IS NULL OR ${queueAlias}.last_attempted_at < ?
      ))
    )
    AND ${permission}
    AND (${queueAlias}.next_attempt_at IS NULL OR ${queueAlias}.next_attempt_at <= ?)
    AND NOT EXISTS (
      SELECT 1 FROM discovery_candidate_reviews active_review
      WHERE active_review.candidate_id=${queueAlias}.id
        AND active_review.status NOT IN ('rejected','activated')
    )
  )`;
}

/**
 * Newest, never-attempted leads first. Oldest FIFO was burying today's YC/news
 * domains behind thousands of prior `needs_review` misses, so the watchlist
 * stopped growing even when the directory had new companies.
 */
export function discoveryQueueOrderSql(queueAlias = "q") {
  if (!/^[a-z][a-z0-9_]*$/i.test(queueAlias)) throw new Error("invalid_sql_alias");
  return `COALESCE(${queueAlias}.attempt_count, 0) ASC, ${queueAlias}.first_discovered_at DESC, ${queueAlias}.id DESC`;
}

/**
 * The registry's enqueue gate. Promotion is the only path from the domain
 * registry into `discovery_queue`, and it admits a row only when the row is
 * pending, unowned, not yet queued, and carries at least one `permitted`
 * evidence row. `manual_only` and `awaiting_permission` leads stay in the
 * registry: permission is refused here, not deferred into the queue.
 */
export function discoveryPromotionGateSql(options: {
  domainsAlias?: string;
  evidenceAlias?: string;
  queueAlias?: string;
} = {}) {
  const domains = options.domainsAlias || "domains";
  const evidence = options.evidenceAlias || "evidence";
  const queue = options.queueAlias || "queue";
  for (const alias of [domains, evidence, queue]) {
    if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error("invalid_sql_alias");
  }
  return `${evidence}.permission_status='permitted'
      AND ${domains}.review_status='pending'
      AND ${domains}.company_id IS NULL
      AND ${queue}.id IS NULL`;
}

/**
 * The other enqueue path is an investor portfolio, and a source whose access
 * mode is not `public_page` is never fetched at all — its candidates cannot be
 * enqueued, so `manual_only` and `awaiting_permission` portfolios stay leads.
 * Returns the non-fetching receipt status, or `null` when the source may run.
 */
export function discoverySourceFetchRefusal(
  accessMode: string
): "manual" | "blocked" | null {
  if (accessMode === "public_page") return null;
  return accessMode === "manual_import" ? "manual" : "blocked";
}

/** Registry promotion: newest evidence first; directory-ranked only as a tie-break. */
export function discoveryPromotionOrderSql(domainsAlias = "domains") {
  if (!/^[a-z][a-z0-9_]*$/i.test(domainsAlias)) throw new Error("invalid_sql_alias");
  return `${domainsAlias}.first_seen_at DESC, directoryRanked DESC, ${domainsAlias}.canonical_domain`;
}

/**
 * The Workers platform refuses further fetches once a single invocation has
 * spent its subrequest budget ("Too many subrequests by single Worker
 * invocation"). That is a per-invocation capacity limit, not evidence about
 * the employer: the candidate never received a full attempt, so it must be
 * deferred, never stamped terminal. One discovery candidate costs several
 * fetches (website probe + ATS slug probes + canonical board), so the default
 * 50-subrequest budget can burn most of a batch.
 */
const SUBREQUEST_CEILING = /\bsubrequests?\b/i;

/**
 * Version of the error-classification behavior above. Raising it is part of
 * the composite `DISCOVERY_PIPELINE_VERSION` (lib/discovery-version.ts), which
 * is the designed re-check trigger: rows stamped at an older version become
 * runnable again through the pipeline's own predicate instead of any direct
 * data surgery.
 */
export const DISCOVERY_CLASSIFICATION_VERSION = "2";

export function isTransientDiscoveryError(error: unknown) {
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; name?: unknown; message?: unknown };
  if (candidate.name === "AbortError" || candidate.name === "TimeoutError") return true;
  if (typeof candidate.status === "number") {
    return candidate.status === 408 || candidate.status === 425 ||
      candidate.status === 429 || candidate.status >= 500;
  }
  if (typeof candidate.message !== "string") return false;
  if (SUBREQUEST_CEILING.test(candidate.message)) return true;
  return /timeout|timed out|abort|network|fetch failed|robots|429|5\d\d/i.test(candidate.message);
}

export function discoveryRetryAt(
  attemptedAt: string,
  attemptCount: number,
  retryAfterMs: number | null = null
) {
  const exponential = Math.min(
    DISCOVERY_RETRY_MAX_MS,
    DISCOVERY_RETRY_BASE_MS * 2 ** Math.max(0, Math.trunc(attemptCount) - 1)
  );
  const delay = Math.max(exponential, Math.max(0, retryAfterMs || 0));
  return new Date(Date.parse(attemptedAt) + delay).toISOString();
}

export function discoveryActivationDueAt(verifiedAt: string) {
  return new Date(Date.parse(verifiedAt) + DISCOVERY_ACTIVATION_DEFER_MS).toISOString();
}
