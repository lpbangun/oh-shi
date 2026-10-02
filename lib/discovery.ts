import { env } from "cloudflare:workers";
import { CanonicalHttpError, fetchCanonicalBoard, type AtsDetection } from "./ats-adapters";
import { probeCanonicalSource } from "./canonical-source-discovery";
import { probeAtsBySlug } from "./ats-slug-probe";
import { registryProbeSlugs } from "./discovery-evidence-slugs";
import { YC_SOURCE_KIND } from "./startup-directory";
import {
  ensureDatabase,
  registerStartupDomainEvidence,
} from "./data";
import {
  registrableDomain,
  type DomainPermissionStatus,
} from "./domain-registry";
import { portfolioWindow } from "./ingestion-core";
import { checkpointPortfolioCandidates } from "./discovery-source-checkpoint";
import { persistDiscoverySourcePage } from "./discovery-source-store";
import { claimDiscoveryCandidate, selectDiscoveryCandidates } from "./discovery-scheduler";
import {
  summarizeDiscoveryReceipts,
  type DiscoverySourceReceipt,
} from "./refresh-contract";
import { linksFromHtml, permittedFetch } from "./public-web";
import { normalizeDomain } from "./source-registry";
import { DISCOVERY_PIPELINE_VERSION } from "./discovery-version";
import {
  discoveryActivationDueAt,
  discoveryEmptyBoardRecheckAt,
  discoveryEvidencePermissionSql,
  discoveryPromotionOrderSql,
  discoveryRetryAt,
  isTransientDiscoveryError,
} from "./discovery-policy";
import { ActivationIdentityConflict, ActivationWriteRace, activateDiscoveredCandidateInDatabase } from "./discovery-activation";

export type Candidate = {
  id: string;
  normalizedDomain: string;
  companyName: string;
  websiteUrl: string;
  status: string;
  investorSourceId?: string;
  evidenceUrl?: string;
  attemptCount?: number;
};

const hashId = (prefix: string, value: string) => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}_${(hash >>> 0).toString(36)}`;
};

const titleFromDomain = (domain: string) =>
  domain.split(".")[0].split(/[-_]/).map((part) =>
    part ? part[0].toUpperCase() + part.slice(1) : ""
  ).join(" ");

function explicitCompanyWebsiteLinks(html: string, baseUrl: string) {
  const links = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = match[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (!/(?:visit|view|company|official)\s+(?:the\s+)?(?:website|site)|^website$/i.test(label)) continue;
    try {
      const url = new URL(match[1], baseUrl);
      if (url.protocol === "https:") links.add(url.href);
    } catch {
      // Ignore malformed evidence links.
    }
  }
  return [...links];
}

function companyNameFromProfile(html: string, fallbackDomain: string) {
  const match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const heading = match?.[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || "";
  if (
    heading.length >= 2 &&
    heading.length <= 120 &&
    !/(?:portfolio|our companies|general catalyst|sequoia capital)/i.test(heading)
  ) return heading;
  return titleFromDomain(fallbackDomain);
}

export async function enqueueCandidate(candidate: {
  name: string; websiteUrl: string; investorSourceId: string; evidenceUrl: string;
}, now = new Date().toISOString()) {
  await ensureDatabase();
  try {
    if (
      new URL(candidate.websiteUrl).protocol !== "https:" ||
      new URL(candidate.evidenceUrl).protocol !== "https:"
    ) return { accepted: false, created: false };
  } catch {
    return { accepted: false, created: false };
  }
  const submittedDomain = registrableDomain(candidate.websiteUrl);
  if (!submittedDomain) return { accepted: false, created: false };
  const investor = await env.DB.prepare(`SELECT id, access_mode as accessMode,
    terms_url as termsUrl
    FROM investor_sources WHERE id=?`)
    .bind(candidate.investorSourceId).first<{
      id: string;
      accessMode: string;
      termsUrl: string | null;
    }>();
  if (!investor) return { accepted: false, created: false };
  const alias = await env.DB.prepare(`SELECT
    aliases.canonical_domain as canonicalDomain,
    domains.website_url as websiteUrl
    FROM startup_domain_aliases aliases
    JOIN startup_domains domains
      ON domains.canonical_domain=aliases.canonical_domain
    WHERE aliases.alias_domain=? AND aliases.relation='alias'`)
    .bind(submittedDomain)
    .first<{ canonicalDomain: string; websiteUrl: string }>();
  const domain = alias?.canonicalDomain || submittedDomain;
  const websiteUrl = alias?.websiteUrl || candidate.websiteUrl;
  const permissionStatus: DomainPermissionStatus =
    investor.accessMode === "public_page"
      ? "permitted"
      : investor.accessMode === "manual_import"
        ? "manual_only"
        : "awaiting_permission";
  await registerStartupDomainEvidence({
    companyName: candidate.name,
    websiteUrl,
    observedWebsiteUrls: alias ? [candidate.websiteUrl] : [],
    sourceId: candidate.investorSourceId,
    sourceKind: "investor_portfolio",
    sourceClassification: "official_portfolio_candidate",
    evidenceUrl: candidate.evidenceUrl,
    permissionStatus,
    sourceTermsUrl: investor.termsUrl || undefined,
    observedAt: now,
  });
  const id = hashId("candidate", domain);
  const existing = await env.DB.prepare(
    "SELECT id FROM discovery_queue WHERE normalized_domain=?"
  ).bind(domain).first<{ id: string }>();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO discovery_queue (
      id, normalized_domain, company_name, website_url, status, first_discovered_at, review_notes
    ) VALUES (?, ?, ?, ?, 'discovered', ?, '')
    ON CONFLICT(normalized_domain) DO UPDATE SET
      company_name=CASE WHEN discovery_queue.company_name='' THEN excluded.company_name ELSE discovery_queue.company_name END,
      website_url=excluded.website_url`).bind(
      id, domain, candidate.name.trim() || titleFromDomain(domain), websiteUrl, now
    ),
    env.DB.prepare(`INSERT OR IGNORE INTO discovery_queue_investors (
      candidate_id, investor_source_id, evidence_url, first_discovered_at
    ) VALUES (?, ?, ?, ?)`).bind(id, candidate.investorSourceId, candidate.evidenceUrl, now),
  ]);
  return { accepted: true, created: !existing };
}

const excludedDiscoveryDomain = (domain: string, sourceDomain: string) =>
  !domain || domain === sourceDomain || domain.endsWith(`.${sourceDomain}`) ||
  /(?:linkedin|twitter|x|facebook|instagram|youtube|cloudfront|google|getro)\.com$/.test(domain);

async function discoverInvestorSource(source: {
  id: string; portfolioUrl: string; accessMode: string; discoveryCursor: number;
}, fetcher: typeof fetch, now: string) {
  if (source.accessMode !== "public_page") {
    return {
      discovered: 0,
      processed: 0,
      nextCursor: source.discoveryCursor,
      status: source.accessMode === "manual_import" ? "manual" as const : "blocked" as const,
    };
  }
  const response = await permittedFetch(source.portfolioUrl, fetcher);
  const html = await response.text();
  const sourceDomain = normalizeDomain(source.portfolioUrl);
  const pageLinks = linksFromHtml(html, source.portfolioUrl);
  const allDetailLinks = pageLinks.filter((link) => {
    const parsed = new URL(link);
    return normalizeDomain(link) === sourceDomain &&
      parsed.href !== source.portfolioUrl &&
      /\/(?:companies|company|portfolio)\//i.test(parsed.pathname);
  });
  const { items: detailLinks, nextCursor } = portfolioWindow(
    allDetailLinks,
    source.discoveryCursor,
    5
  );
  const externalLinks: Array<{ websiteUrl: string; name: string; evidenceUrl: string }> = [];
  const itemFailures: Array<{ url: string; error: string }> = [];
  // Many official portfolios link to an internal company profile rather than
  // directly to the company. Follow a bounded single hop, never a crawl.
  for (let index = 0; index < detailLinks.length; index += 5) {
    const group = detailLinks.slice(index, index + 5);
    const pages = await Promise.all(group.map(async (link) => {
      try {
        const detail = await permittedFetch(link, fetcher);
        const detailHtml = await detail.text();
        const redirectedDomain = normalizeDomain(detail.url);
        if (redirectedDomain && redirectedDomain !== sourceDomain) {
          return [{
            websiteUrl: detail.url,
            name: titleFromDomain(redirectedDomain),
            evidenceUrl: link,
          }];
        }
        return explicitCompanyWebsiteLinks(detailHtml, detail.url).map((websiteUrl) => ({
          websiteUrl,
          name: companyNameFromProfile(detailHtml, normalizeDomain(websiteUrl)),
          evidenceUrl: link,
        }));
      } catch (error) {
        itemFailures.push({ url: link,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
        return [];
      }
    }));
    externalLinks.push(...pages.flat());
  }
  const candidates = externalLinks
    .map((candidate) => ({
      ...candidate,
      domain: normalizeDomain(candidate.websiteUrl),
    }))
    .filter(({ domain }) => !excludedDiscoveryDomain(domain, sourceDomain));
  return checkpointPortfolioCandidates(
    candidates.slice(0, 250), source.discoveryCursor, nextCursor, itemFailures,
    (candidate) => enqueueCandidate({
        name: candidate.name, websiteUrl: candidate.websiteUrl,
        investorSourceId: source.id, evidenceUrl: candidate.evidenceUrl,
      }, now)
  );
}

async function resolveCanonicalSourceResult(
  candidate: Candidate,
  fetcher: typeof fetch
): Promise<{
  detection: AtsDetection | null;
  outcome: "ambiguous" | "no_ats_detected" | "unsupported" | null;
}> {
  const probe = await probeCanonicalSource(candidate.websiteUrl, { fetcher });
  if (probe.detection) return { detection: probe.detection, outcome: null };
  // An ambiguous crawl means the site advertises more than one board; guessing
  // from the slug would only add a third answer, so leave it for review.
  if (probe.detectionStatus === "ambiguous") {
    return { detection: null, outcome: "ambiguous" };
  }
  const registrySlugs = await registryBoardSlugs(candidate.normalizedDomain);
  const slugMatch = await probeAtsBySlug(
    candidate.normalizedDomain,
    candidate.companyName,
    { fetcher, extraSlugs: registrySlugs.candidates,
      corroboratingSlugs: registrySlugs.corroborating }
  );
  if (!slugMatch || slugMatch.provider === "manual") {
    const allWebsiteFetchesBlocked = probe.pages.length > 0 && probe.pages.every(
      (page) => page.status === "robots_or_network_error"
    );
    if (allWebsiteFetchesBlocked) {
      const robotsBlocked = probe.pages.every((page) =>
        /robots_policy_disallows_discovery/i.test(page.error || "")
      );
      if (robotsBlocked) throw new Error("robots_policy_disallows_all_website_probes");
      throw new TypeError("website_probe_network_failure");
    }
    if (probe.externalCareerLinks.length > 0) {
      return { detection: null, outcome: "unsupported" };
    }
    return { detection: null, outcome: "no_ats_detected" };
  }
  return { detection: {
    provider: slugMatch.provider,
    boardId: slugMatch.boardId,
    careersUrl: slugMatch.careersUrl,
  }, outcome: null };
}

export async function resolveCanonicalSource(
  candidate: Candidate,
  fetcher: typeof fetch
): Promise<AtsDetection | null> {
  return (await resolveCanonicalSourceResult(candidate, fetcher)).detection;
}

/**
 * A directory records the employer's own identifier for itself, which is a
 * better slug guess than the domain label whenever the two differ.
 */
async function registryBoardSlugs(domain: string) {
  const evidence = await env.DB.prepare(`SELECT source_id as sourceId,
    source_kind as sourceKind, source_classification as sourceClassification,
    permission_status as permissionStatus, evidence_url as evidenceUrl
    ,permission_provenance_json as permissionProvenanceJson
    FROM startup_domain_evidence WHERE canonical_domain=?`)
    .bind(domain).all<{
      sourceId: string; sourceKind: string; sourceClassification: string;
      permissionStatus: string; evidenceUrl: string;
      permissionProvenanceJson: string | null;
    }>();
  return registryProbeSlugs(evidence.results);
}

export async function activateDiscoveredCandidate(
  candidate: Candidate,
  detection: AtsDetection,
  now: string,
  options: { sourceEnabled?: boolean; approvedReviewBatchId?: string } = {}
) {
  return activateDiscoveredCandidateInDatabase(env.DB, candidate, detection, now, options);
}

async function processCandidate(
  candidate: Candidate,
  fetcher: typeof fetch,
  now: string,
  allowActivation: boolean
) {
  const attemptCount = await claimDiscoveryCandidate(env.DB, candidate.id, now);
  if (!attemptCount) return { activated: false, boardDetected: false,
    attempted: false, outcome: "deferred" as const };
  await env.DB.prepare(`UPDATE startup_domains SET
    last_discovery_attempt_at=?, last_seen_at=? WHERE canonical_domain=?`)
    .bind(now, now, candidate.normalizedDomain).run();
  let resolution: Awaited<ReturnType<typeof resolveCanonicalSourceResult>>;
  try {
    resolution = await resolveCanonicalSourceResult(candidate, fetcher);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const blocked = /robots|permission|disallow/i.test(message);
    const retryable = !blocked && isTransientDiscoveryError(error);
    await env.DB.prepare(`UPDATE discovery_queue SET status=?, discovery_version=?,
      last_outcome=?, next_attempt_at=?, last_error=?, review_notes=? WHERE id=?`).bind(
        retryable ? "discovered" : "needs_review",
        DISCOVERY_PIPELINE_VERSION,
        blocked ? "probe_blocked" : "probe_failed",
        retryable ? discoveryRetryAt(now, attemptCount) : null,
        message,
        retryable
          ? "Transient board-discovery failure; retry deferred with exponential backoff."
          : "Automatic board discovery was blocked or failed non-transiently; manual review required.",
        candidate.id
      ).run();
    return { activated: false, boardDetected: false, attempted: true,
      outcome: blocked ? "blocked" as const : retryable ? "deferred" as const : "review" as const };
  }
  const detection = resolution.detection;
  if (!detection) {
    await env.DB.prepare(`UPDATE discovery_queue SET status=?,
      discovery_version=?, last_outcome=?, next_attempt_at=NULL,
      last_error=?, review_notes=? WHERE id=?`)
        .bind(
          resolution.outcome === "unsupported" ? "unsupported" : "needs_review",
          DISCOVERY_PIPELINE_VERSION,
          resolution.outcome,
          resolution.outcome === "ambiguous"
            ? "multiple_canonical_ats_candidates"
            : resolution.outcome === "unsupported"
              ? "unsupported_external_career_system"
              : "canonical_ats_not_detected",
          resolution.outcome === "ambiguous"
            ? "Official website advertised multiple canonical boards; manual review is required."
            : resolution.outcome === "unsupported"
              ? "Official website linked to an external career system without a supported canonical adapter."
            : "Official website checked; no supported public ATS or actionable first-party career page was detected.",
          candidate.id).run();
    return { activated: false, boardDetected: false, attempted: true,
      outcome: "review" as const };
  }
  try {
    const canonical = await fetchCanonicalBoard(detection.provider, detection.boardId, fetcher);
    if (!canonical.jobs.length) {
      await env.DB.prepare(`UPDATE discovery_queue SET status='needs_review',
        discovery_version=?, last_outcome='no_us_openings', next_attempt_at=?,
        last_error='no_verified_us_open_jobs', review_notes=? WHERE id=?`)
        .bind(DISCOVERY_PIPELINE_VERSION, discoveryEmptyBoardRecheckAt(now, attemptCount),
          "Canonical board fetched successfully but had no US-eligible open roles.", candidate.id).run();
      return { activated: false, boardDetected: true, attempted: true,
        outcome: "empty" as const };
    }
    if (!allowActivation) {
      await env.DB.prepare(`UPDATE discovery_queue SET status='canonical_source_found',
        discovery_version=?, last_outcome='canonical_source_found', last_error=NULL,
        next_attempt_at=?,
        review_notes='Canonical source verified; queued for a later activation slot.'
        WHERE id=?`).bind(
          DISCOVERY_PIPELINE_VERSION,
          discoveryActivationDueAt(now),
          candidate.id
        ).run();
      return { activated: false, boardDetected: true, attempted: true,
        outcome: "deferred" as const };
    }
    await activateDiscoveredCandidate(candidate, detection, now);
    return { activated: true, boardDetected: true, attempted: true,
      outcome: candidate.status === "needs_review" ? "recovered" as const : "activated" as const };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    if (error instanceof ActivationIdentityConflict) {
      await env.DB.prepare(`UPDATE discovery_queue SET status='needs_review',
        discovery_version=?, last_outcome='ambiguous', next_attempt_at=NULL,
        last_error=?, review_notes='Activation identity conflict; explicit review required.'
        WHERE id=?`).bind(DISCOVERY_PIPELINE_VERSION, message, candidate.id).run();
      return { activated: false, boardDetected: true, attempted: true,
        outcome: "review" as const };
    }
    const retryable = error instanceof ActivationWriteRace || isTransientDiscoveryError(error);
    const retryAfter = error instanceof CanonicalHttpError ? error.retryAfterMs : null;
    await env.DB.prepare(`UPDATE discovery_queue SET status=?,
      discovery_version=?, last_outcome=?, next_attempt_at=?, last_error=?,
      review_notes=? WHERE id=?`)
      .bind(
        retryable ? "discovered" : "needs_review",
        DISCOVERY_PIPELINE_VERSION,
        error instanceof ActivationWriteRace ? "activation_write_race" : "canonical_fetch_failed",
        retryable ? discoveryRetryAt(now, attemptCount, retryAfter) : null,
        message,
        retryable
          ? "Transient canonical verification failure; retry deferred with exponential backoff."
          : "ATS detected but canonical verification failed non-transiently; manual review required.",
        candidate.id
      ).run();
    return { activated: false, boardDetected: true, attempted: true,
      outcome: retryable ? "deferred" as const : "review" as const };
  }
}

/**
 * Throughput comes from running often, not from long runs: each candidate costs
 * several sequential fetches, so a large batch risks exceeding the refresh
 * client's request timeout and losing the whole run. A smaller batch on a
 * two-hourly schedule drains more per day than the previous 25/10 pair did in
 * six-hourly runs, and fails cheaply when it fails.
 */
// Keep the discovery phase comfortably inside the shared refresh request's
// platform deadline as the canonical source set grows. The two-hour schedule
// still processes up to 120 candidates per day while leaving enough time for
// every active board to be re-verified and the idempotency receipt persisted.
export const DEFAULT_PROCESS_LIMIT = 10;
export const DEFAULT_ACTIVATION_LIMIT = 25;

/** How many registry domains are moved into the queue per run. */
export const DEFAULT_PROMOTION_LIMIT = 150;
export const DEFAULT_DISCOVERY_REQUEST_LIMIT = 40;
export const DEFAULT_DISCOVERY_WORK_MS = 35_000;

/**
 * The domain registry used to be a dead end: imports populated `startup_domains`
 * but only investor-portfolio candidates ever reached `discovery_queue`, so an
 * open startup directory could never reach the board-detection stage. This moves
 * permitted, unreviewed registry domains onto the queue so discovery drains the
 * whole registry rather than just the portfolio crawl.
 */
export async function promoteRegistryDomains(
  limit = DEFAULT_PROMOTION_LIMIT,
  now = new Date().toISOString()
) {
  // Newest registry evidence first so today's YC/news domains are queued before
  // a years-old encyclopedia backlog. Directory-ranked is only a tie-break.
  const pending = await env.DB.prepare(`SELECT
      domains.canonical_domain as canonicalDomain,
      domains.company_name as companyName,
      domains.website_url as websiteUrl,
      MAX(CASE WHEN evidence.source_kind=? THEN 1 ELSE 0 END) as directoryRanked
    FROM startup_domains domains
    JOIN startup_domain_evidence evidence
      ON evidence.canonical_domain=domains.canonical_domain
    LEFT JOIN discovery_queue queue
      ON queue.normalized_domain=domains.canonical_domain
    WHERE ${discoveryEvidencePermissionSql("evidence")}
      AND domains.review_status='pending'
      AND domains.company_id IS NULL
      AND queue.id IS NULL
    GROUP BY domains.canonical_domain
    ORDER BY ${discoveryPromotionOrderSql("domains")}
    LIMIT ?`)
    .bind(YC_SOURCE_KIND, Math.max(0, Math.trunc(limit)))
    .all<{ canonicalDomain: string; companyName: string; websiteUrl: string }>();
  if (!pending.results.length) return 0;
  await env.DB.batch(pending.results.map((domain) =>
    env.DB.prepare(`INSERT INTO discovery_queue (
      id, normalized_domain, company_name, website_url, status, first_discovered_at, review_notes
    ) VALUES (?, ?, ?, ?, 'discovered', ?, 'Promoted from the startup domain registry.')
    ON CONFLICT(normalized_domain) DO NOTHING`).bind(
      hashId("candidate", domain.canonicalDomain),
      domain.canonicalDomain,
      domain.companyName.trim() || titleFromDomain(domain.canonicalDomain),
      domain.websiteUrl,
      now
    )
  ));
  return pending.results.length;
}

export async function runDiscovery(options: {
  fetcher?: typeof fetch;
  processLimit?: number;
  activationLimit?: number;
  promotionLimit?: number;
  requestLimit?: number;
  workBudgetMs?: number;
} = {}) {
  await ensureDatabase();
  const rawFetcher = options.fetcher || fetch;
  const started = performance.now();
  const workBudgetMs = Math.min(45_000, Math.max(0, options.workBudgetMs ?? DEFAULT_DISCOVERY_WORK_MS));
  const requestLimit = Math.min(40, Math.max(0, Math.trunc(options.requestLimit ?? DEFAULT_DISCOVERY_REQUEST_LIMIT)));
  let requests = 0;
  const withinBudget = () => performance.now() - started < workBudgetMs && requests < requestLimit;
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!withinBudget()) throw new TypeError("discovery_invocation_budget_exhausted");
    requests += 1;
    const remainingMs = Math.max(1, workBudgetMs - (performance.now() - started));
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(remainingMs)])
      : AbortSignal.timeout(remainingMs);
    return rawFetcher(input, { ...init, signal });
  }) as typeof fetch;
  const now = new Date().toISOString();
  const runId = `discovery_${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO ingestion_runs (id, started_at, status, metrics_json)
    VALUES (?, ?, 'running', '{}')`).bind(runId, now).run();
  const configured = await env.DB.prepare(`SELECT id, portfolio_url as portfolioUrl,
    access_mode as accessMode, discovery_cursor as discoveryCursor
    FROM investor_sources WHERE enabled=1 ORDER BY id`)
    .all<{ id: string; portfolioUrl: string; accessMode: string; discoveryCursor: number }>();
  let candidatesDiscovered = 0;
  const failedSources: Array<{ id: string; error: string }> = [];
  const blockedSources: string[] = [];
  const deferredSources: string[] = [];
  const receipts: DiscoverySourceReceipt[] = [];
  for (let index = 0; index < configured.results.length; index += 1) {
    if (!withinBudget()) {
      deferredSources.push(...configured.results.slice(index).map((source) => source.id));
      break;
    }
    const source = configured.results[index];
    const attemptedAt = new Date().toISOString();
    try {
      const result = await discoverInvestorSource(source, fetcher, attemptedAt);
      candidatesDiscovered += result.discovered;
      if (result.status === "blocked") blockedSources.push(source.id);
      await persistDiscoverySourcePage(env.DB, runId, source.id, attemptedAt, result);
      receipts.push({
        source_id: source.id,
        access_mode: source.accessMode,
        status: result.status,
        attempted: source.accessMode === "public_page",
        fetched: result.status === "completed" || result.status === "failed",
        discovered_count: result.discovered,
        processed_count: result.processed,
        ...("error" in result && result.error ? { error: result.error } : {}),
      });
      if (result.status === "failed") failedSources.push({ id: source.id, error: result.error || "source_page_incomplete" });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      failedSources.push({ id: source.id, error: message });
      receipts.push({
        source_id: source.id,
        access_mode: source.accessMode,
        status: "failed",
        attempted: source.accessMode === "public_page",
        fetched: false,
        discovered_count: 0,
        processed_count: 0,
        error: message,
      });
      await env.DB.batch([
        env.DB.prepare(`UPDATE investor_sources SET last_attempted_at=?, last_error=? WHERE id=?`)
          .bind(attemptedAt, message, source.id),
        env.DB.prepare(`INSERT INTO ingestion_source_results (
          run_id, source_kind, source_id, status, attempted_at, completed_at, error_code, error_message
        ) VALUES (?, 'investor', ?, 'failed', ?, ?, 'fetch_failed', ?)`)
          .bind(runId, source.id, attemptedAt, attemptedAt, message),
      ]);
    }
  }

  const promotionDeferred = !withinBudget();
  const promoted = promotionDeferred ? 0 : await promoteRegistryDomains(
    options.promotionLimit ?? DEFAULT_PROMOTION_LIMIT, now
  );
  candidatesDiscovered += promoted;

  const processLimit = Math.min(25, Math.max(0, Math.trunc(options.processLimit ?? DEFAULT_PROCESS_LIMIT)));
  const candidateSelectionDeferred = !withinBudget();
  const queued = candidateSelectionDeferred
    ? [] : await selectDiscoveryCandidates(env.DB, now, processLimit);
  let canonicalBoardsDetected = 0;
  let companiesActivated = 0;
  let candidatesAttempted = 0;
  let candidatesDeferred = 0;
  let candidatesReviewGated = 0;
  let candidatesRecovered = 0;
  const candidateReceipts: Array<{ id: string; outcome: string; attempted: boolean;
    retried: boolean; error?: string }> = [];
  const failedCandidates: Array<{ id: string; error: string }> = [];
  for (const candidate of queued) {
    if (!withinBudget()) {
      candidatesDeferred += 1;
      candidateReceipts.push({ id: candidate.id, outcome: "deferred_budget",
        attempted: false, retried: Number(candidate.attemptCount || 0) > 0 });
      continue;
    }
    const attemptedAt = new Date().toISOString();
    try {
      const result = await processCandidate(candidate, fetcher, attemptedAt,
        companiesActivated < (options.activationLimit ?? DEFAULT_ACTIVATION_LIMIT));
      if (result.attempted) candidatesAttempted += 1;
      if (result.boardDetected) canonicalBoardsDetected += 1;
      if (result.activated) companiesActivated += 1;
      if (result.outcome === "recovered") candidatesRecovered += 1;
      if (result.outcome === "deferred") candidatesDeferred += 1;
      if (result.outcome === "review") candidatesReviewGated += 1;
      candidateReceipts.push({ id: candidate.id, outcome: result.outcome,
        attempted: result.attempted, retried: Number(candidate.attemptCount || 0) > 0 });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      failedCandidates.push({ id: candidate.id, error: message });
      candidateReceipts.push({ id: candidate.id, outcome: "failed", attempted: true,
        retried: Number(candidate.attemptCount || 0) > 0, error: message });
      // A mutation may have committed before an unrelated response failed. Only
      // a still-owned resolving lease can be returned to the retry queue.
      const current = await env.DB.prepare(`SELECT attempt_count as attemptCount
        FROM discovery_queue WHERE id=? AND status='resolving' AND last_attempted_at=?`)
        .bind(candidate.id, attemptedAt).first<{ attemptCount: number }>();
      if (current) {
        await env.DB.prepare(`UPDATE discovery_queue SET status='discovered',
          discovery_version=?, last_outcome='probe_failed', next_attempt_at=?,
          last_error=?, review_notes='Candidate processing failed; retry deferred with backoff.'
          WHERE id=? AND status='resolving' AND last_attempted_at=?`).bind(
            DISCOVERY_PIPELINE_VERSION,
            discoveryRetryAt(new Date().toISOString(), current.attemptCount),
            message, candidate.id, attemptedAt
          ).run();
      }
    }
  }
  const completedAt = new Date().toISOString();
  const sourceCounts = summarizeDiscoveryReceipts(receipts);
  const allFetchedSourcesFailed =
    sourceCounts.failed > 0 && sourceCounts.completed === 0;
  const overallStatus = allFetchedSourcesFailed && candidatesAttempted === 0
    ? "failed"
    : failedSources.length || failedCandidates.length || candidatesDeferred ||
      deferredSources.length || promotionDeferred || candidateSelectionDeferred
      ? "partial_success"
      : "success";
  const metrics = {
    overall_status: overallStatus,
    source_counts: sourceCounts,
    receipts,
    candidates_discovered: candidatesDiscovered,
    candidates_processed: candidatesAttempted,
    candidates_selected: queued.length,
    candidates_deferred: candidatesDeferred,
    candidates_review_gated: candidatesReviewGated,
    candidates_recovered: candidatesRecovered,
    candidate_receipts: candidateReceipts,
    requests_used: requests,
    canonical_boards_detected: canonicalBoardsDetected,
    companies_activated: companiesActivated,
    failed_sources: failedSources,
    deferred_sources: deferredSources,
    registry_promotion_deferred: promotionDeferred,
    candidate_selection_deferred: candidateSelectionDeferred,
    failed_candidates: failedCandidates,
    blocked_sources: blockedSources,
  };
  await env.DB.prepare(`UPDATE ingestion_runs SET completed_at=?, status=?,
    metrics_json=? WHERE id=?`).bind(
    completedAt, overallStatus,
    JSON.stringify(metrics), runId
  ).run();
  return { run_id: runId, completed_at: completedAt, ...metrics };
}
