import { env } from "cloudflare:workers";
import { detectAtsFromLinks, fetchCanonicalBoard } from "./ats-adapters";
import { ensureDatabase } from "./data";
import { portfolioWindow } from "./ingestion-core";
import { normalizeDomain, sourceKey } from "./source-registry";

type Candidate = {
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

function linksFromHtml(html: string, baseUrl: string) {
  const links = new Set<string>();
  for (const match of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const url = new URL(match[1], baseUrl);
      if (url.protocol === "https:") links.add(url.href);
    } catch {
      // Invalid links are not candidates.
    }
  }
  return [...links];
}

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

function robotsAllows(html: string, path: string) {
  const groups = html.split(/\n(?=user-agent\s*:)/i);
  const relevant = groups.filter((group) => /user-agent\s*:\s*(\*|OH-SHI)/i.test(group));
  return !relevant.some((group) =>
    group.split(/\r?\n/).some((line) => {
      const match = line.match(/^\s*disallow\s*:\s*(\S+)/i);
      return match && match[1] !== "" && (match[1] === "/" || path.startsWith(match[1]));
    })
  );
}

async function permittedFetch(url: string, fetcher: typeof fetch) {
  let current = new URL(url);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const robotsUrl = new URL("/robots.txt", current);
    const robots = await fetcher(robotsUrl, {
      headers: { "User-Agent": "OH-SHI/1.0 discovery (+public portfolio evidence)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (robots.ok && !robotsAllows(await robots.text(), current.pathname)) {
      throw new Error("robots_policy_disallows_discovery");
    }
    const response = await fetcher(current, {
      redirect: "manual",
      headers: { "User-Agent": "OH-SHI/1.0 discovery (+public portfolio evidence)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("discovery_redirect_missing_location");
      const next = new URL(location, current);
      if (next.protocol !== "https:") throw new Error("discovery_redirect_not_https");
      current = next;
      continue;
    }
    if (!response.ok) throw new Error(`discovery_source_http_${response.status}`);
    return response;
  }
  throw new Error("discovery_redirect_limit_exceeded");
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
  const domain = normalizeDomain(candidate.websiteUrl);
  if (!domain) return { accepted: false, created: false };
  const investor = await env.DB.prepare("SELECT id FROM investor_sources WHERE id=?")
    .bind(candidate.investorSourceId).first<{ id: string }>();
  if (!investor) return { accepted: false, created: false };
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
      id, domain, candidate.name.trim() || titleFromDomain(domain), candidate.websiteUrl, now
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
    return { discovered: 0, nextCursor: source.discoveryCursor, status: "manual" as const };
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
  return { discovered, nextCursor, status: "success" as const };
}

async function resolveCanonicalSource(candidate: Candidate, fetcher: typeof fetch) {
  const pages = [candidate.websiteUrl, new URL("/careers", candidate.websiteUrl).href,
    new URL("/jobs", candidate.websiteUrl).href];
  const attempts = await Promise.all(pages.map(async (page) => {
    try {
      const response = await permittedFetch(page, fetcher);
      return [response.url, ...linksFromHtml(await response.text(), response.url)];
    } catch {
      return [];
    }
  }));
  return detectAtsFromLinks(attempts.flat());
}

async function processCandidate(
  candidate: Candidate,
  fetcher: typeof fetch,
  now: string,
  allowActivation: boolean
) {
  await env.DB.prepare("UPDATE discovery_queue SET status='resolving', last_attempted_at=? WHERE id=?")
    .bind(now, candidate.id).run();
  const detection = await resolveCanonicalSource(candidate, fetcher);
  if (!detection) {
    await env.DB.prepare(`UPDATE discovery_queue SET status='needs_review',
      last_error='canonical_ats_not_detected', review_notes=? WHERE id=?`)
      .bind("Official website checked; no supported public ATS link was detected.", candidate.id).run();
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
      ) VALUES (?, ?, ?, ?, ?, 1, 'active', ?, 0, 'Automatically detected and canonically verified')`)
        .bind(canonicalSourceId, companyId, detection.provider, detection.boardId,
          detection.careersUrl, now),
      env.DB.prepare(`INSERT OR IGNORE INTO company_investors (
        company_id, investor_source_id, first_discovered_at, evidence_url
      ) SELECT ?, investor_source_id, first_discovered_at, evidence_url
        FROM discovery_queue_investors WHERE candidate_id=?`).bind(companyId, candidate.id),
      env.DB.prepare(`UPDATE discovery_queue SET status='active', last_error=NULL,
        review_notes='Canonical source verified with US-eligible open jobs.' WHERE id=?`)
        .bind(candidate.id),
    ]);
    return { activated: true, boardDetected: true };
  } catch (error) {
    await env.DB.prepare(`UPDATE discovery_queue SET status='needs_review',
      last_error=?, review_notes='ATS detected but canonical verification failed.' WHERE id=?`)
      .bind((error instanceof Error ? error.message : String(error)).slice(0, 500), candidate.id).run();
    return { activated: false, boardDetected: true };
  }
}

export async function runDiscovery(options: {
  fetcher?: typeof fetch; processLimit?: number; activationLimit?: number;
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
  for (const source of configured.results) {
    const attemptedAt = new Date().toISOString();
    try {
      const result = await discoverInvestorSource(source, fetcher, attemptedAt);
      candidatesDiscovered += result.discovered;
      if (result.status === "manual") blockedSources.push(source.id);
      const sourceUpdate = result.status === "success"
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
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      failedSources.push({ id: source.id, error: message });
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

  const queued = await env.DB.prepare(`SELECT q.id, q.normalized_domain as normalizedDomain,
    q.company_name as companyName, q.website_url as websiteUrl, q.status,
    qi.investor_source_id as investorSourceId, qi.evidence_url as evidenceUrl
    FROM discovery_queue q LEFT JOIN discovery_queue_investors qi ON qi.candidate_id=q.id
    WHERE q.status IN ('discovered','canonical_source_found') GROUP BY q.id
    ORDER BY q.first_discovered_at, q.id LIMIT ?`)
    .bind(options.processLimit || 25).all<Candidate>();
  let canonicalBoardsDetected = 0;
  let companiesActivated = 0;
  for (const candidate of queued.results) {
    const result = await processCandidate(
      candidate,
      fetcher,
      new Date().toISOString(),
      companiesActivated < (options.activationLimit || 10)
    );
    if (result.boardDetected) canonicalBoardsDetected += 1;
    if (result.activated) companiesActivated += 1;
  }
  const completedAt = new Date().toISOString();
  const metrics = {
    investor_sources_attempted: configured.results.length,
    candidates_discovered: candidatesDiscovered,
    candidates_processed: Math.min(queued.results.length, options.processLimit || 25),
    canonical_boards_detected: canonicalBoardsDetected,
    companies_activated: companiesActivated,
    failed_sources: failedSources,
    blocked_sources: blockedSources,
  };
  await env.DB.prepare(`UPDATE ingestion_runs SET completed_at=?, status=?,
    metrics_json=? WHERE id=?`).bind(
    completedAt, failedSources.length === configured.results.length ? "failed" :
      failedSources.length ? "partial_success" : "success",
    JSON.stringify(metrics), runId
  ).run();
  return { run_id: runId, completed_at: completedAt, ...metrics };
}
