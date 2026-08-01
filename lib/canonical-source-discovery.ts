import {
  detectAtsCandidatesFromLinks,
  type AtsDetection,
} from "./ats-adapters";
import { registrableDomain } from "./domain-registry";
import {
  boundedText,
  linksFromHtml,
  PublicWebSession,
} from "./public-web";
import { discoverStructuredCareerSource } from "./structured-career-page";

export const CANONICAL_SOURCE_PROBE_VERSION = "1.1";
export const CANONICAL_SOURCE_PROBE_USER_AGENT =
  "OH-SHI/1.0 canonical-source-yield-probe";

export type CanonicalSourceProbePage = {
  requestedUrl: string;
  finalUrl: string | null;
  status: "fetched" | "http_error" | "robots_or_network_error" | "off_site_redirect";
  httpStatus: number | null;
  error: string | null;
};

export type ExternalCareerLinkEvidence = {
  host: string;
  registrableDomain: string | null;
  evidencePages: string[];
  occurrenceCount: number;
  signals: Array<
    | "career_path"
    | "jobs_path"
    | "openings_path"
    | "positions_path"
    | "apply_path"
    | "join_path"
  >;
  sampleUrls: string[];
};

export type CanonicalSourceProbe = {
  websiteUrl: string;
  detection: AtsDetection | null;
  detectionStatus: "single" | "ambiguous" | "structured" | "none";
  candidates: Array<AtsDetection & {
    evidencePages: string[];
  }>;
  pages: CanonicalSourceProbePage[];
  externalCareerLinks: ExternalCareerLinkEvidence[];
  structuredError: string | null;
};

const careerPath = (url: URL) =>
  /(?:^|\/)(?:careers?|jobs?|openings?|positions?|join-us|work-with-us)(?:\/|$)/i
    .test(url.pathname);

function sameRegistrableDomain(left: string, right: string) {
  const leftDomain = registrableDomain(left);
  return Boolean(leftDomain && leftDomain === registrableDomain(right));
}

function initialProbeUrls(website: URL) {
  return [...new Set([
    website.href,
    ...["/careers", "/jobs", "/join-us", "/work-with-us"]
      .map((path) => new URL(path, website.origin).href),
  ])];
}

function externalCareerSignals(url: URL): ExternalCareerLinkEvidence["signals"] {
  const path = url.pathname.toLowerCase();
  const signals = new Set<ExternalCareerLinkEvidence["signals"][number]>();
  if (/(?:^|\/)careers?(?:\/|$)/.test(path)) signals.add("career_path");
  if (/(?:^|\/)jobs?(?:\/|$)/.test(path)) signals.add("jobs_path");
  if (/(?:^|\/)(?:openings?|vacancies)(?:\/|$)/.test(path)) {
    signals.add("openings_path");
  }
  if (/(?:^|\/)positions?(?:\/|$)/.test(path)) signals.add("positions_path");
  if (/(?:^|\/)(?:apply|application)(?:\/|$)/.test(path)) signals.add("apply_path");
  if (/(?:^|\/)(?:join-us|join-our-team|work-with-us)(?:\/|$)/.test(path)) {
    signals.add("join_path");
  }
  return [...signals].sort();
}

export async function probeCanonicalSource(
  websiteUrl: string,
  options: {
    fetcher?: typeof fetch;
    includeStructured?: boolean;
    maxPages?: number;
    structuredMaxPages?: number;
    structuredMaxDepth?: number;
    asOf?: string;
  } = {}
): Promise<CanonicalSourceProbe> {
  const website = new URL(websiteUrl);
  if (website.protocol !== "https:") throw new Error("canonical_source_probe_requires_https");
  const fetcher = options.fetcher || fetch;
  const session = new PublicWebSession(fetcher, CANONICAL_SOURCE_PROBE_USER_AGENT);
  const maxPages = Math.min(12, Math.max(1, options.maxPages || 8));
  const queue = initialProbeUrls(website).map((url) => ({ url }));
  const seen = new Set<string>();
  const pages: CanonicalSourceProbePage[] = [];
  const candidates = new Map<string, AtsDetection & { evidencePages: Set<string> }>();
  const externalCareerLinks = new Map<string, {
    host: string;
    registrableDomain: string | null;
    evidencePages: Set<string>;
    occurrenceCount: number;
    signals: Set<ExternalCareerLinkEvidence["signals"][number]>;
    sampleUrls: Set<string>;
  }>();

  while (queue.length && seen.size < maxPages) {
    const candidate = queue.shift()!;
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    try {
      const response = await session.fetch(candidate.url);
      const finalUrl = response.url || candidate.url;
      const direct = detectAtsCandidatesFromLinks([finalUrl]);
      for (const detection of direct) {
        const key = `${detection.provider}:${detection.boardId.toLowerCase()}`;
        const current = candidates.get(key) || { ...detection, evidencePages: new Set() };
        current.evidencePages.add(candidate.url);
        candidates.set(key, current);
      }
      if (!sameRegistrableDomain(finalUrl, website.href) && !direct.length) {
        pages.push({
          requestedUrl: candidate.url,
          finalUrl,
          status: "off_site_redirect",
          httpStatus: response.status,
          error: "probe_redirected_outside_candidate_domain",
        });
        continue;
      }
      if (!response.ok) {
        pages.push({
          requestedUrl: candidate.url,
          finalUrl,
          status: "http_error",
          httpStatus: response.status,
          error: `discovery_source_http_${response.status}`,
        });
        continue;
      }
      const html = await boundedText(response);
      const links = linksFromHtml(html, finalUrl);
      for (const detection of detectAtsCandidatesFromLinks(links)) {
        const key = `${detection.provider}:${detection.boardId.toLowerCase()}`;
        const current = candidates.get(key) || { ...detection, evidencePages: new Set() };
        current.evidencePages.add(finalUrl);
        candidates.set(key, current);
      }
      for (const link of links) {
        let parsed: URL;
        try { parsed = new URL(link); } catch { continue; }
        if (
          sameRegistrableDomain(parsed.href, website.href) ||
          detectAtsCandidatesFromLinks([parsed.href]).length
        ) continue;
        const signals = externalCareerSignals(parsed);
        if (!signals.length) continue;
        const host = parsed.hostname.toLowerCase();
        const current = externalCareerLinks.get(host) || {
          host,
          registrableDomain: registrableDomain(parsed.href),
          evidencePages: new Set<string>(),
          occurrenceCount: 0,
          signals: new Set<ExternalCareerLinkEvidence["signals"][number]>(),
          sampleUrls: new Set<string>(),
        };
        current.evidencePages.add(finalUrl);
        current.occurrenceCount += 1;
        for (const signal of signals) current.signals.add(signal);
        if (current.sampleUrls.size < 3) {
          parsed.search = "";
          parsed.hash = "";
          current.sampleUrls.add(parsed.href);
        }
        externalCareerLinks.set(host, current);
      }
      pages.push({
        requestedUrl: candidate.url,
        finalUrl,
        status: "fetched",
        httpStatus: response.status,
        error: null,
      });
      for (const link of links) {
        let parsed: URL;
        try { parsed = new URL(link); } catch { continue; }
        if (
          sameRegistrableDomain(parsed.href, website.href) &&
          careerPath(parsed) &&
          !seen.has(parsed.href) &&
          !queue.some((item) => item.url === parsed.href) &&
          queue.length + seen.size < maxPages
        ) queue.push({ url: parsed.href });
      }
    } catch (error) {
      pages.push({
        requestedUrl: candidate.url,
        finalUrl: null,
        status: "robots_or_network_error",
        httpStatus: null,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
  }

  const found = [...candidates.values()].map((item) => ({
    provider: item.provider,
    boardId: item.boardId,
    careersUrl: item.careersUrl,
    evidencePages: [...item.evidencePages].sort(),
  })).sort((left, right) =>
    `${left.provider}:${left.boardId.toLowerCase()}`.localeCompare(
      `${right.provider}:${right.boardId.toLowerCase()}`
    )
  );
  const externalEvidence = [...externalCareerLinks.values()].map((item) => ({
    host: item.host,
    registrableDomain: item.registrableDomain,
    evidencePages: [...item.evidencePages].sort(),
    occurrenceCount: item.occurrenceCount,
    signals: [...item.signals].sort(),
    sampleUrls: [...item.sampleUrls].sort(),
  })).sort((left, right) => left.host.localeCompare(right.host));
  if (found.length === 1) {
    const detection: AtsDetection = {
      provider: found[0].provider,
      boardId: found[0].boardId,
      careersUrl: found[0].careersUrl,
    };
    return {
      websiteUrl: website.href,
      detection,
      detectionStatus: "single",
      candidates: found,
      pages,
      externalCareerLinks: externalEvidence,
      structuredError: null,
    };
  }
  if (found.length > 1) {
    return {
      websiteUrl: website.href,
      detection: null,
      detectionStatus: "ambiguous",
      candidates: found,
      pages,
      externalCareerLinks: externalEvidence,
      structuredError: null,
    };
  }

  let structuredError: string | null = null;
  if (options.includeStructured !== false) {
    try {
      const structured = await discoverStructuredCareerSource(
        website.href,
        fetcher,
        options.asOf || new Date().toISOString(),
        {
          maxPages: options.structuredMaxPages,
          maxDepth: options.structuredMaxDepth,
          sitemapJobLimit: options.structuredMaxPages === undefined ? undefined : 5,
        }
      );
      if (structured) {
        return {
          websiteUrl: website.href,
          detection: structured,
          detectionStatus: "structured",
          candidates: [{
            ...structured,
            evidencePages: [structured.careersUrl],
          }],
          pages,
          externalCareerLinks: externalEvidence,
          structuredError: null,
        };
      }
    } catch (error) {
      structuredError =
        (error instanceof Error ? error.message : String(error)).slice(0, 300);
    }
  }
  return {
    websiteUrl: website.href,
    detection: null,
    detectionStatus: "none",
    candidates: [],
    pages,
    externalCareerLinks: externalEvidence,
    structuredError,
  };
}
