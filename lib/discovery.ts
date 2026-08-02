import { env } from "cloudflare:workers";
import { fetchCanonicalBoard, type AtsDetection } from "./ats-adapters";
import { probeCanonicalSource } from "./canonical-source-discovery";
import { probeAtsBySlug } from "./ats-slug-probe";
import { YC_SOURCE_KIND } from "./startup-directory";
import {
  ensureDatabase,
  registerStartupDomainEvidence,
} from "./data";
import {
  careerFingerprint,
  registrableDomain,
  type DomainPermissionStatus,
} from "./domain-registry";
import { portfolioWindow, processSequentiallyIsolated } from "./ingestion-core";
import {
  summarizeDiscoveryReceipts,
  type DiscoverySourceReceipt,
} from "./refresh-contract";
import { linksFromHtml, permittedFetch } from "./public-web";
import { normalizeDomain, sourceKey } from "./source-registry";

export type Candidate = {
  id: string;
  normalizedDomain: string;
  companyName: string;
  websiteUrl: string;
  status: string;
  investorSourceId?: string;
  evidenceUrl?: string;
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
    20
  );
  const externalLinks: Array<{ websiteUrl: string; name: string; evidenceUrl: string }> = [];
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
      } catch {
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
  let discovered = 0;
  for (const candidate of candidates.slice(0, 250)) {
    const result = await enqueueCandidate({
      name: candidate.name, websiteUrl: candidate.websiteUrl,
      investorSourceId: source.id, evidenceUrl: candidate.evidenceUrl,
    }, now);
    if (result.created) discovered += 1;
  }
  return { discovered, nextCursor, status: "completed" as const };
}

export async function resolveCanonicalSource(
  candidate: Candidate,
  fetcher: typeof fetch
): Promise<AtsDetection | null> {
  const probe = await probeCanonicalSource(candidate.websiteUrl, { fetcher });
  if (probe.detection) return probe.detection;
  // An ambiguous crawl means the site advertises more than one board; guessing
  // from the slug would only add a third answer, so leave it for review.
  if (probe.detectionStatus === "ambiguous") return null;
  const slugMatch = await probeAtsBySlug(
    candidate.normalizedDomain,
    candidate.companyName,
    { fetcher, extraSlugs: await registryBoardSlugs(candidate.normalizedDomain) }
  );
  if (!slugMatch || slugMatch.provider === "manual") return null;
  return {
    provider: slugMatch.provider,
    boardId: slugMatch.boardId,
    careersUrl: slugMatch.careersUrl,
  };
}

/**
 * A directory records the employer's own identifier for itself, which is a
 * better slug guess than the domain label whenever the two differ.
 */
async function registryBoardSlugs(domain: string) {
  const evidence = await env.DB.prepare(`SELECT source_id as sourceId
    FROM startup_domain_evidence WHERE canonical_domain=?`)
    .bind(domain).all<{ sourceId: string }>();
  return evidence.results
    .map((row) => row.sourceId.includes(":") ? row.sourceId.split(":").pop() || "" : "")
    .filter(Boolean);
}

export async function activateDiscoveredCandidate(
  candidate: Candidate,
  detection: AtsDetection,
  now: string,
  options: { sourceEnabled?: boolean } = {}
) {
  const existingCompany = await env.DB.prepare(
    "SELECT id FROM companies WHERE lower(domain)=? LIMIT 1"
  ).bind(candidate.normalizedDomain).first<{ id: string }>();
  const companyId = existingCompany?.id || hashId("company", candidate.normalizedDomain);
  const slug = candidate.normalizedDomain.replace(/[^a-z0-9]+/g, "-");
  const canonicalSourceId = sourceKey(detection.provider, detection.boardId);
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO companies (
      id, slug, name, domain, description, founded_year, headquarters, employee_range,
      industry, sector, stage, funding_mode, lifecycle_status, hiring_score,
      evidence_confidence, latest_funding_label, latest_funding_date, careers_url,
      source_url, open_job_count, last_verified_at
    ) VALUES (?, ?, ?, ?, 'Profile discovered from an official investor portfolio.',
      NULL, 'Not published', 'Not published', 'Other', 'Other', 'Not published',
      'Not published', 'active', 0, 0, 'Not published', NULL, ?, ?, 0, ?)`)
      .bind(companyId, slug, candidate.companyName, candidate.normalizedDomain,
        detection.careersUrl, candidate.evidenceUrl || candidate.websiteUrl, now),
    env.DB.prepare(`INSERT OR IGNORE INTO company_sources (
      id, company_id, provider, board_id, careers_url, enabled, discovery_status,
      first_discovered_at, consecutive_failures, review_notes
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0, 'Automatically detected and canonically verified')`)
      .bind(canonicalSourceId, companyId, detection.provider, detection.boardId,
        detection.careersUrl, options.sourceEnabled === false ? 0 : 1, now),
    env.DB.prepare(`INSERT OR IGNORE INTO company_investors (
      company_id, investor_source_id, first_discovered_at, evidence_url
    ) SELECT ?, investor_source_id, first_discovered_at, evidence_url
      FROM discovery_queue_investors WHERE candidate_id=?`).bind(companyId, candidate.id),
    env.DB.prepare(`UPDATE discovery_queue SET status='active', last_error=NULL,
      review_notes='Canonical source verified with US-eligible open jobs.' WHERE id=?`)
      .bind(candidate.id),
    env.DB.prepare(`UPDATE startup_domains SET company_id=?, activity_state='active',
      review_status='verified', careers_url=?, ats_provider=?, ats_board_id=?,
      career_fingerprint=?, last_discovery_attempt_at=?, last_seen_at=?
      WHERE canonical_domain=?`).bind(
      companyId,
      detection.careersUrl,
      detection.provider,
      detection.boardId,
      careerFingerprint(detection.provider, detection.boardId, detection.careersUrl),
      now,
      now,
      candidate.normalizedDomain
    ),
  ]);
  return { companyId, canonicalSourceId };
}

async function processCandidate(
  candidate: Candidate,
  fetcher: typeof fetch,
  now: string,
  allowActivation: boolean
) {
  await env.DB.prepare("UPDATE discovery_queue SET status='resolving', last_attempted_at=? WHERE id=?")
    .bind(now, candidate.id).run();
  await env.DB.prepare(`UPDATE startup_domains SET
    last_discovery_attempt_at=?, last_seen_at=? WHERE canonical_domain=?`)
    .bind(now, now, candidate.normalizedDomain).run();
  const detection = await resolveCanonicalSource(candidate, fetcher);
  if (!detection) {
    await env.DB.prepare(`UPDATE discovery_queue SET status='needs_review',
      last_error='canonical_ats_not_detected', review_notes=? WHERE id=?`)
        .bind("Official website checked; no supported public ATS or actionable first-party career page was detected.", candidate.id).run();
    return { activated: false, boardDetected: false };
  }
  try {
    const canonical = await fetchCanonicalBoard(detection.provider, detection.boardId, fetcher);
    if (!canonical.jobs.length) {
      await env.DB.prepare(`UPDATE discovery_queue SET status='needs_review',
        last_error='no_verified_us_open_jobs', review_notes=? WHERE id=?`)
        .bind("Canonical board fetched successfully but had no US-eligible open roles.", candidate.id).run();
      return { activated: false, boardDetected: true };
    }
    if (!allowActivation) {
      await env.DB.prepare(`UPDATE discovery_queue SET status='canonical_source_found',
        last_error=NULL, review_notes='Canonical source verified; queued for a later activation slot.'
        WHERE id=?`).bind(candidate.id).run();
      return { activated: false, boardDetected: true };
    }
    await activateDiscoveredCandidate(candidate, detection, now);
    return { activated: true, boardDetected: true };
  } catch (error) {
    await env.DB.prepare(`UPDATE discovery_queue SET status='needs_review',
      last_error=?, review_notes='ATS detected but canonical verification failed.' WHERE id=?`)
      .bind((error instanceof Error ? error.message : String(error)).slice(0, 500), candidate.id).run();
    return { activated: false, boardDetected: true };
  }
}

/**
 * Throughput comes from running often, not from long runs: each candidate costs
 * several sequential fetches, so a large batch risks exceeding the refresh
 * client's request timeout and losing the whole run. A smaller batch on a
 * two-hourly schedule drains more per day than the previous 25/10 pair did in
 * six-hourly runs, and fails cheaply when it fails.
 */
export const DEFAULT_PROCESS_LIMIT = 30;
export const DEFAULT_ACTIVATION_LIMIT = 25;

/** How many registry domains are moved into the queue per run. */
export const DEFAULT_PROMOTION_LIMIT = 150;

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
  // Directory evidence names a startup outright, so it detects a board far more
  // often than an encyclopedia entry that merely happens to list a company.
  // Draining strictly by age would spend weeks on the low-yield sources first.
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
    WHERE evidence.permission_status='permitted'
      AND domains.review_status='pending'
      AND domains.company_id IS NULL
      AND queue.id IS NULL
    GROUP BY domains.canonical_domain
    ORDER BY directoryRanked DESC, domains.first_seen_at, domains.canonical_domain
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
} = {}) {
  await ensureDatabase();
  const fetcher = options.fetcher || fetch;
  const now = new Date().toISOString();
  const runId = hashId("discovery", now);
  await env.DB.prepare(`INSERT INTO ingestion_runs (id, started_at, status, metrics_json)
    VALUES (?, ?, 'running', '{}')`).bind(runId, now).run();
  const configured = await env.DB.prepare(`SELECT id, portfolio_url as portfolioUrl,
    access_mode as accessMode, discovery_cursor as discoveryCursor
    FROM investor_sources WHERE enabled=1 ORDER BY id`)
    .all<{ id: string; portfolioUrl: string; accessMode: string; discoveryCursor: number }>();
  let candidatesDiscovered = 0;
  const failedSources: Array<{ id: string; error: string }> = [];
  const blockedSources: string[] = [];
  const receipts: DiscoverySourceReceipt[] = [];
  for (const source of configured.results) {
    const attemptedAt = new Date().toISOString();
    try {
      const result = await discoverInvestorSource(source, fetcher, attemptedAt);
      candidatesDiscovered += result.discovered;
      if (result.status === "blocked") blockedSources.push(source.id);
      const sourceUpdate = result.status === "completed"
        ? env.DB.prepare(`UPDATE investor_sources SET last_attempted_at=?,
            last_successful_at=?, last_error=NULL, discovery_cursor=? WHERE id=?`)
            .bind(attemptedAt, attemptedAt, result.nextCursor, source.id)
        : env.DB.prepare(`UPDATE investor_sources SET last_attempted_at=?,
            last_error='awaiting_permission_or_manual_import' WHERE id=?`).bind(attemptedAt, source.id);
      await env.DB.batch([
        sourceUpdate,
        env.DB.prepare(`INSERT INTO ingestion_source_results (
          run_id, source_kind, source_id, status, attempted_at, completed_at, discovered_count
        ) VALUES (?, 'investor', ?, ?, ?, ?, ?)`).bind(
          runId, source.id, result.status, attemptedAt, attemptedAt, result.discovered
        ),
      ]);
      receipts.push({
        source_id: source.id,
        access_mode: source.accessMode,
        status: result.status,
        fetched: source.accessMode === "public_page",
        discovered_count: result.discovered,
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      failedSources.push({ id: source.id, error: message });
      receipts.push({
        source_id: source.id,
        access_mode: source.accessMode,
        status: "failed",
        fetched: source.accessMode === "public_page",
        discovered_count: 0,
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

  const promoted = await promoteRegistryDomains(
    options.promotionLimit ?? DEFAULT_PROMOTION_LIMIT,
    now
  );
  candidatesDiscovered += promoted;

  const queued = await env.DB.prepare(`SELECT q.id, q.normalized_domain as normalizedDomain,
    q.company_name as companyName, q.website_url as websiteUrl, q.status,
    qi.investor_source_id as investorSourceId, qi.evidence_url as evidenceUrl
    FROM discovery_queue q LEFT JOIN discovery_queue_investors qi ON qi.candidate_id=q.id
    WHERE (
      q.status IN ('discovered','canonical_source_found')
      OR (q.status='resolving' AND (
        q.last_attempted_at IS NULL OR q.last_attempted_at < ?
      ))
    )
      AND NOT EXISTS (
        SELECT 1 FROM discovery_candidate_reviews review
        WHERE review.candidate_id=q.id
          AND review.status NOT IN ('rejected','activated')
      )
    GROUP BY q.id
    ORDER BY q.first_discovered_at, q.id LIMIT ?`)
    .bind(
      new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
      options.processLimit || DEFAULT_PROCESS_LIMIT
    ).all<Candidate>();
  let canonicalBoardsDetected = 0;
  let companiesActivated = 0;
  const processed = await processSequentiallyIsolated(
    queued.results,
    async (candidate) => {
      const result = await processCandidate(
        candidate, fetcher, new Date().toISOString(),
        companiesActivated < (options.activationLimit || DEFAULT_ACTIVATION_LIMIT)
      );
      if (result.boardDetected) canonicalBoardsDetected += 1;
      if (result.activated) companiesActivated += 1;
      return result;
    },
    async (candidate, error) => {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await env.DB.prepare(`UPDATE discovery_queue SET status='discovered',
        last_error=?, review_notes='Transient candidate processing failure; queued for retry.'
        WHERE id=?`).bind(message, candidate.id).run();
    }
  );
  const failedCandidates = processed.failures.map(({ value, error }) => ({
    id: value.id,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  }));
  const completedAt = new Date().toISOString();
  const sourceCounts = summarizeDiscoveryReceipts(receipts);
  const allFetchedSourcesFailed =
    sourceCounts.fetched > 0 && sourceCounts.failed === sourceCounts.fetched;
  const overallStatus = allFetchedSourcesFailed
    ? "failed"
    : failedSources.length || failedCandidates.length
      ? "partial_success"
      : "success";
  const metrics = {
    overall_status: overallStatus,
    source_counts: sourceCounts,
    receipts,
    candidates_discovered: candidatesDiscovered,
    candidates_processed: Math.min(queued.results.length, options.processLimit || DEFAULT_PROCESS_LIMIT),
    canonical_boards_detected: canonicalBoardsDetected,
    companies_activated: companiesActivated,
    failed_sources: failedSources,
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
