import type { NormalizedJob } from "./ats-adapters";
import { retryCanonicalFetch } from "./canonical-fetch-retry";
import {
  persistCanonicalSource,
  type CanonicalCompanySource,
} from "./canonical-refresh-store";
import { registrableDomain } from "./domain-registry";
import { normalizeCanonicalJobUrl } from "./job-canonicalization";
import type { AtsProvider } from "./source-registry";
import type { HiringSignal } from "./types";

type PromotionSignal = HiringSignal;

export type SignalPromotionResult = {
  status:
    | "promoted"
    | "already_promoted"
    | "not_promotable"
    | "verification_failed";
  signalId: string;
  jobId: string | null;
  verifiedSources: number;
  reason: string | null;
};

const supportedProviders = new Set<AtsProvider>([
  "ashby",
  "greenhouse",
  "lever",
  "workable",
  "recruitee",
  "personio",
  "smartrecruiters",
  "structured",
]);

function urlVariants(value: string | null) {
  if (!value) return [];
  const normalized = normalizeCanonicalJobUrl(value);
  const variants = new Set([normalized]);
  try {
    const url = new URL(normalized);
    const stripped = url.pathname
      .replace(/\/(?:apply|application)$/i, "")
      .replace(/\/c\/new$/i, "");
    if (stripped !== url.pathname) {
      url.pathname = stripped || "/";
      variants.add(normalizeCanonicalJobUrl(url.toString()));
    }
  } catch {
    // Invalid URLs are rejected when the signal is imported.
  }
  return [...variants];
}

export function promotionTargetUrls(
  signal: Pick<PromotionSignal, "sourceUrl" | "evidenceUrl" | "applicationUrl">
) {
  return new Set([
    ...urlVariants(signal.sourceUrl),
    ...urlVariants(signal.evidenceUrl),
    ...urlVariants(signal.applicationUrl),
  ]);
}

function hostname(value: string) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function hasEligibleOffBoardEvidence(
  signal: Pick<
    PromotionSignal,
    | "companyDomain"
    | "sourceKind"
    | "sourceUrl"
    | "evidenceUrl"
    | "permissionStatus"
  >
) {
  const sourceHost = hostname(signal.sourceUrl);
  const evidenceHost = hostname(signal.evidenceUrl);
  if (!sourceHost || !evidenceHost) return false;
  if (signal.sourceKind === "company_blog" || signal.sourceKind === "rss") {
    const companyDomain = registrableDomain(signal.companyDomain);
    return registrableDomain(sourceHost) === companyDomain &&
      registrableDomain(evidenceHost) === companyDomain;
  }
  if (signal.sourceKind === "github") {
    return ["github.com", "api.github.com"].includes(sourceHost) &&
      ["github.com", "api.github.com"].includes(evidenceHost);
  }
  if (signal.sourceKind === "hacker_news") {
    const allowed = new Set([
      "news.ycombinator.com",
      "hacker-news.firebaseio.com",
    ]);
    return allowed.has(sourceHost) && allowed.has(evidenceHost);
  }
  if (signal.sourceKind === "authorized_api") {
    return signal.permissionStatus === "authorized";
  }
  return signal.sourceKind === "submission" &&
    ["authorized", "manual_reviewed"].includes(signal.permissionStatus);
}

export function findExactPromotionJob(
  signal: Pick<PromotionSignal, "sourceUrl" | "evidenceUrl" | "applicationUrl">,
  jobs: NormalizedJob[]
) {
  const targets = promotionTargetUrls(signal);
  const matches = jobs.filter((job) =>
    targets.has(normalizeCanonicalJobUrl(job.canonicalUrl))
  );
  return matches.length === 1 ? matches[0] : null;
}

export async function recordSignalPromotion(
  database: D1Database,
  signal: PromotionSignal,
  source: CanonicalCompanySource,
  job: NormalizedJob,
  jobId: string,
  now: string,
  runId: string
) {
  await database.batch([
    database.prepare(`INSERT OR IGNORE INTO hiring_signal_promotions (
      signal_id, job_id, company_id, provider, source_id, external_id,
      canonical_url, evidence_url, source_rights_url, discovery_source_kind,
      verified_at, run_id
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM hiring_signals
        WHERE id=? AND status='active' AND expires_at > ?
      )`).bind(
        signal.id,
        jobId,
        source.companyId,
        source.provider,
        source.id,
        job.externalId,
        job.canonicalUrl,
        signal.evidenceUrl,
        signal.sourceRightsUrl,
        signal.sourceKind,
        now,
        runId,
        signal.id,
        now
      ),
    database.prepare(`UPDATE hiring_signals
      SET status='promoted', promoted_job_id=?, last_verified_at=?
      WHERE id=? AND status='active' AND expires_at > ?
        AND EXISTS (
          SELECT 1 FROM hiring_signal_promotions promotion
          WHERE promotion.signal_id=hiring_signals.id
        )`).bind(jobId, now, signal.id, now),
  ]);
  return database.prepare(`SELECT job_id as jobId
    FROM hiring_signal_promotions WHERE signal_id=?`)
    .bind(signal.id)
    .first<{ jobId: string }>();
}

export async function promoteHiringSignal(
  database: D1Database,
  signalId: string,
  options: {
    now?: string;
    runId?: string;
    fetchSource?: (
      source: CanonicalCompanySource
    ) => Promise<{ complete: true; jobs: NormalizedJob[] }>;
    persistSource?: typeof persistCanonicalSource;
  } = {}
): Promise<SignalPromotionResult> {
  const now = options.now || new Date().toISOString();
  const runId = options.runId || `signal_promotion_${crypto.randomUUID()}`;
  const signal = await database.prepare(`SELECT
    id, company_id as companyId, company_name as companyName,
    company_domain as companyDomain, role_function as roleFunction, summary,
    source_kind as sourceKind, source_url as sourceUrl, evidence_url as evidenceUrl,
    source_rights_url as sourceRightsUrl, application_url as applicationUrl,
    permission_status as permissionStatus, confidence, status,
    observed_at as observedAt, last_verified_at as lastVerifiedAt,
    expires_at as expiresAt, promoted_job_id as promotedJobId
    FROM hiring_signals WHERE id=?`).bind(signalId).first<PromotionSignal>();
  if (!signal) {
    return {
      status: "not_promotable",
      signalId,
      jobId: null,
      verifiedSources: 0,
      reason: "signal_not_found",
    };
  }
  if (signal.status === "promoted" && signal.promotedJobId) {
    return {
      status: "already_promoted",
      signalId,
      jobId: signal.promotedJobId,
      verifiedSources: 0,
      reason: null,
    };
  }
  if (
    signal.status !== "active" ||
    Date.parse(signal.expiresAt) <= Date.parse(now) ||
    !signal.companyId
  ) {
    return {
      status: "not_promotable",
      signalId,
      jobId: null,
      verifiedSources: 0,
      reason: !signal.companyId
        ? "canonical_company_required"
        : "signal_inactive_or_expired",
    };
  }
  if (!hasEligibleOffBoardEvidence(signal)) {
    return {
      status: "not_promotable",
      signalId,
      jobId: null,
      verifiedSources: 0,
      reason: "off_board_evidence_mismatch",
    };
  }
  const company = await database.prepare(
    "SELECT domain FROM companies WHERE id=?"
  ).bind(signal.companyId).first<{ domain: string }>();
  if (
    !company ||
    registrableDomain(company.domain) !== registrableDomain(signal.companyDomain)
  ) {
    return {
      status: "not_promotable",
      signalId,
      jobId: null,
      verifiedSources: 0,
      reason: "employer_domain_mismatch",
    };
  }
  const sourceRows = await database.prepare(`SELECT id, company_id as companyId,
    provider, board_id as boardId FROM company_sources
    WHERE company_id=? AND enabled=1 AND discovery_status='active'
    ORDER BY id`).bind(signal.companyId).all<CanonicalCompanySource>();
  const sources = sourceRows.results.filter((source) =>
    supportedProviders.has(source.provider)
  );
  if (!sources.length) {
    return {
      status: "not_promotable",
      signalId,
      jobId: null,
      verifiedSources: 0,
      reason: "canonical_source_required",
    };
  }

  const fetchSource = options.fetchSource || ((source: CanonicalCompanySource) =>
    retryCanonicalFetch(source));
  const persistSource = options.persistSource || persistCanonicalSource;
  let verifiedSources = 0;
  let failedSources = 0;
  for (const source of sources) {
    let complete: { complete: true; jobs: NormalizedJob[] };
    try {
      complete = await fetchSource(source);
      verifiedSources += 1;
    } catch {
      failedSources += 1;
      continue;
    }
    const matched = findExactPromotionJob(signal, complete.jobs);
    if (!matched) continue;
    const result = await persistSource(database, source, complete.jobs, now, runId);
    if (result.status !== "success") {
      return {
        status: "verification_failed",
        signalId,
        jobId: null,
        verifiedSources,
        reason: `canonical_persistence_${result.status}`,
      };
    }
    const canonical = await database.prepare(`SELECT observation.job_id as jobId
      FROM job_observations observation
      JOIN jobs ON jobs.id=observation.job_id
      WHERE observation.provider=? AND observation.source_id=?
        AND observation.external_id=? AND observation.status='verified_open'
        AND jobs.status='verified_open'`).bind(
          source.provider,
          source.id,
          matched.externalId
        ).first<{ jobId: string }>();
    if (!canonical) {
      return {
        status: "verification_failed",
        signalId,
        jobId: null,
        verifiedSources,
        reason: "canonical_observation_missing_after_refresh",
      };
    }
    const promotion = await recordSignalPromotion(
      database,
      signal,
      source,
      matched,
      canonical.jobId,
      now,
      runId
    );
    if (!promotion) {
      return {
        status: "verification_failed",
        signalId,
        jobId: null,
        verifiedSources,
        reason: "signal_changed_before_promotion",
      };
    }
    return {
      status: "promoted",
      signalId,
      jobId: promotion.jobId,
      verifiedSources,
      reason: null,
    };
  }
  return {
    status: failedSources === sources.length
      ? "verification_failed"
      : "not_promotable",
    signalId,
    jobId: null,
    verifiedSources,
    reason: failedSources === sources.length
      ? "all_canonical_sources_failed"
      : "exact_current_role_not_found",
  };
}
