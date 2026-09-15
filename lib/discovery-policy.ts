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

export function isTransientDiscoveryError(error: unknown) {
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; name?: unknown; message?: unknown };
  if (candidate.name === "AbortError" || candidate.name === "TimeoutError") return true;
  if (typeof candidate.status === "number") {
    return candidate.status === 408 || candidate.status === 425 ||
      candidate.status === 429 || candidate.status >= 500;
  }
  return typeof candidate.message === "string" &&
    /timeout|timed out|abort|network|fetch failed|robots|429|5\d\d/i.test(candidate.message);
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
