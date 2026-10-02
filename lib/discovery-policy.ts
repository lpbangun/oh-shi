export const DISCOVERY_RETRY_BASE_MS = 6 * 60 * 60 * 1_000;
export const DISCOVERY_RETRY_MAX_MS = 7 * 24 * 60 * 60 * 1_000;
export const DISCOVERY_ACTIVATION_DEFER_MS = 2 * 60 * 60 * 1_000;
export const DISCOVERY_CLASSIFICATION_VERSION = "2";

export type DiscoveryOutcome =
  | "activated"
  | "activation_write_race"
  | "ambiguous"
  | "canonical_fetch_failed"
  | "canonical_source_found"
  | "no_ats_detected"
  | "no_us_openings"
  | "probe_blocked"
  | "probe_failed"
  | "unsupported";

export function discoveryEvidencePermissionSql(alias = "permission_evidence") {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error("invalid_sql_alias");
  return `${alias}.permission_status='permitted' AND (
    ${alias}.source_kind!='curated_cohort' OR (
      CASE WHEN json_valid(${alias}.permission_provenance_json)=1
        THEN json_extract(${alias}.permission_provenance_json, '$.scope')
        ELSE NULL END='automated_access_and_reuse'
    )
  )`;
}

/** Evidence must explicitly permit automated access before a candidate is fetched. */
export function discoveryPermissionSql(queueAlias = "q") {
  if (!/^[a-z][a-z0-9_]*$/i.test(queueAlias)) throw new Error("invalid_sql_alias");
  return `EXISTS (
    SELECT 1 FROM startup_domain_evidence permission_evidence
    WHERE permission_evidence.canonical_domain=${queueAlias}.normalized_domain
      AND ${discoveryEvidencePermissionSql("permission_evidence")}
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
      OR (${queueAlias}.status='needs_review'
        AND ${queueAlias}.last_outcome='no_us_openings'
        AND ${queueAlias}.next_attempt_at IS NOT NULL)
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

/** Registry promotion: newest evidence first; directory-ranked only as a tie-break. */
export function discoveryPromotionOrderSql(domainsAlias = "domains") {
  if (!/^[a-z][a-z0-9_]*$/i.test(domainsAlias)) throw new Error("invalid_sql_alias");
  return `${domainsAlias}.first_seen_at DESC, directoryRanked DESC, ${domainsAlias}.canonical_domain`;
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
    /timeout|timed out|abort|network|fetch failed|robots|subrequests?|429|5\d\d/i.test(candidate.message);
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

export function discoveryEmptyBoardRecheckAt(attemptedAt: string, attemptCount: number) {
  const weeks = Math.min(4, 2 ** Math.max(0, Math.trunc(attemptCount) - 1));
  return new Date(Date.parse(attemptedAt) + weeks * 7 * 86_400_000).toISOString();
}

export function companySlugFromDomain(domain: string) {
  return domain.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function resolveDiscoveredCompanySlug(domain: string, occupantDomain: string | null) {
  const base = companySlugFromDomain(domain);
  if (base && (!occupantDomain || occupantDomain.toLowerCase() === domain.toLowerCase())) {
    return base;
  }
  let hash = 2166136261;
  for (const character of domain) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${base || "company"}-${(hash >>> 0).toString(36)}`;
}
