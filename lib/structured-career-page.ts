import {
  classifyRole,
  isUsEligible,
  summarizeCanonicalJob,
} from "./job-normalization";
import {
  boundedText,
  linksFromHtml,
  PublicWebSession,
  urlsFromSitemap,
} from "./public-web";
import type { NormalizedJob } from "./ats-adapters";

export const STRUCTURED_CAREER_ADAPTER_VERSION = "1.0";

type JsonRecord = Record<string, unknown>;

const object = (value: unknown): JsonRecord =>
  value && typeof value === "object" ? value as JsonRecord : {};
const array = (value: unknown) => Array.isArray(value) ? value : [value];
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const plain = (value: unknown) => text(value)
  .replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&quot;|&#34;/gi, "\"")
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/\s+/g, " ")
  .trim();
const iso = (value: unknown) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
};
const sameSite = (left: URL, right: URL) => {
  const normalize = (hostname: string) => hostname.toLowerCase().replace(/^www\./, "");
  const a = normalize(left.hostname);
  const b = normalize(right.hostname);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
};
const careerPath = (url: URL) =>
  /(?:^|\/)(?:careers?|jobs?|openings?|positions?|join-us|work-with-us)(?:\/|$)/i
    .test(url.pathname);
const crawlableCareerPath = (url: URL) =>
  careerPath(url) && !/(?:^|\/)(?:apply|application|feed)(?:\/|$)/i.test(url.pathname);

function jobPostingNodes(html: string) {
  const nodes: JsonRecord[] = [];
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      throw new Error("structured source returned an incomplete payload: invalid JSON-LD");
    }
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const record = object(value);
      if (!Object.keys(record).length) return;
      array(record["@graph"]).forEach(visit);
      const types = array(record["@type"]).map(text);
      if (types.some((type) => type.toLowerCase() === "jobposting")) nodes.push(record);
    };
    visit(parsed);
  }
  return nodes;
}

function locationsFromPosting(posting: JsonRecord) {
  const entries = [
    ...array(posting.jobLocation),
    ...array(posting.applicantLocationRequirements),
  ].map(object);
  const parts = entries.flatMap((entry) => {
    const address = object(entry.address);
    return [
      text(entry.name),
      text(address.addressLocality),
      text(address.addressRegion),
      text(address.addressCountry),
    ].filter(Boolean);
  });
  const remote = /telecommute/i.test(text(posting.jobLocationType));
  const location = [...new Set(parts)].join(", ") || (remote ? "Remote" : "");
  const country = entries
    .map((entry) => text(object(entry.address).addressCountry))
    .find(Boolean);
  return { location, remote, country };
}

function salaryFromPosting(posting: JsonRecord) {
  const salary = object(posting.baseSalary);
  const value = object(salary.value);
  const currency = text(salary.currency);
  const min = value.minValue;
  const max = value.maxValue;
  if (min !== undefined || max !== undefined) {
    return `${currency} ${String(min ?? max)}–${String(max ?? min)}`.trim();
  }
  return plain(value.value || salary.value);
}

function explicitApplyUrl(html: string, pageUrl: URL) {
  for (const match of html.matchAll(
    /<a\b([^>]*)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi
  )) {
    const label = plain(match[4]);
    const attributes = `${match[1]} ${match[3]}`;
    if (!/\bapply(?:\s+now)?\b/i.test(`${label} ${attributes}`)) continue;
    try {
      const url = new URL(match[2], pageUrl);
      if (url.protocol === "https:") return url.href;
    } catch {
      // An invalid action URL is not evidence of an actionable role.
    }
  }
  const labelledContainer = html.match(
    /\bApply\s+Now\b[\s\S]{0,800}?<a\b[^>]*href\s*=\s*["']([^"']+)["']/i
  );
  if (labelledContainer) {
    try {
      const url = new URL(labelledContainer[1], pageUrl);
      if (url.protocol === "https:") return url.href;
    } catch {
      // Invalid container action URLs are not actionable.
    }
  }
  return null;
}

function stableExternalId(posting: JsonRecord, canonicalUrl: URL, html: string) {
  const identifier = posting.identifier;
  const structured = typeof identifier === "object"
    ? text(object(identifier).value || object(identifier).name)
    : text(identifier);
  const req = plain(html).match(
    /\b(?:req(?:uisition)?|job)\s*(?:id|#)\s*[:#]?\s*([a-z0-9][a-z0-9._-]*)\b/i
  );
  return structured || req?.[1] || canonicalUrl.pathname.replace(/\/+$/, "").split("/").pop() ||
    canonicalUrl.href;
}

function textByClass(html: string, classNames: string[]) {
  for (const match of html.matchAll(
    /<[a-z][a-z0-9]*\b[^>]*class\s*=\s*["']([^"']+)["'][^>]*>([^<]*)/gi
  )) {
    const tokens = match[1].split(/\s+/);
    if (classNames.some((name) => tokens.includes(name))) return plain(match[2]);
  }
  return "";
}

function normalizePosting(
  posting: JsonRecord,
  html: string,
  pageUrl: URL,
  now: string
): NormalizedJob | null {
  const title = text(posting.title);
  const description = plain(posting.description);
  const applyUrl = explicitApplyUrl(html, pageUrl);
  const postingUrl = text(posting.url);
  let canonicalUrl: URL;
  try {
    canonicalUrl = new URL(postingUrl || pageUrl.href, pageUrl);
  } catch {
    return null;
  }
  const employer = object(posting.hiringOrganization);
  const employerUrl = text(employer.sameAs || employer.url);
  if (!title || !description || !text(employer.name) || !applyUrl) return null;
  if (canonicalUrl.protocol !== "https:" || !sameSite(canonicalUrl, pageUrl)) return null;
  if (employerUrl) {
    try {
      if (!sameSite(new URL(employerUrl, pageUrl), pageUrl)) return null;
    } catch {
      return null;
    }
  }
  const expires = iso(posting.validThrough);
  if (expires && Date.parse(expires) <= Date.parse(now)) return null;
  const location = locationsFromPosting(posting);
  const jobInput = {
    title,
    department: text(object(posting.occupationalCategory).name) ||
      text(posting.occupationalCategory),
    location: location.location,
    isRemote: location.remote,
    descriptionPlain: description,
    address: { postalAddress: { addressCountry: location.country } },
  };
  if (!isUsEligible(jobInput)) return null;
  return {
    externalId: stableExternalId(posting, canonicalUrl, html),
    title,
    roleFamily: classifyRole(title, jobInput.department),
    location: location.location || "US eligibility stated in posting",
    remoteStatus: location.remote ? "Remote" : "See posting",
    employmentType: array(posting.employmentType).map(text).filter(Boolean).join(", ") ||
      "See posting",
    compensation: salaryFromPosting(posting) || "See posting",
    canonicalUrl: canonicalUrl.href,
    publishedAt: iso(posting.datePosted),
    summary: summarizeCanonicalJob(jobInput),
  };
}

function semanticPosting(html: string, pageUrl: URL): NormalizedJob | null {
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title = plain(heading?.[1]);
  const applyUrl = explicitApplyUrl(html, pageUrl);
  const bodyStart = (heading?.index || 0) + (heading?.[0].length || 0);
  const body = plain(html.slice(bodyStart));
  const location = textByClass(html, ["job-post-location", "job-location"]) ||
    body.match(/\bLocation\s*:\s*([^|•]{2,100})/i)?.[1]?.trim() || "";
  const req = body.match(
    /\b(?:Req(?:uisition)?|Job)\s*(?:ID|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9._-]*)\b/i
  );
  if (!title || !applyUrl || !req || body.length < 250) return null;
  const remote = /\bremote\b/i.test(location);
  const jobInput = { title, location, isRemote: remote, descriptionPlain: body };
  if (!isUsEligible(jobInput)) return null;
  return {
    externalId: req[1],
    title,
    roleFamily: classifyRole(title),
    location,
    remoteStatus: remote ? "Remote" : "See posting",
    employmentType: body.match(/\b(?:Full[- ]time|Part[- ]time|Contract|Temporary)\b/i)?.[0] ||
      "See posting",
    compensation: body.match(/\$\d[\d,]*(?:\.\d+)?(?:\s*[–-]\s*\$\d[\d,]*(?:\.\d+)?)?/i)?.[0] ||
      "See posting",
    canonicalUrl: pageUrl.href,
    publishedAt: null,
    summary: summarizeCanonicalJob(jobInput),
  };
}

export function parseStructuredCareerPage(
  html: string,
  pageUrl: string,
  now = new Date().toISOString()
) {
  const url = new URL(pageUrl);
  const structured = jobPostingNodes(html)
    .map((posting) => normalizePosting(posting, html, url, now))
    .filter((job): job is NormalizedJob => Boolean(job));
  if (structured.length) return structured;
  const semantic = semanticPosting(html, url);
  return semantic ? [semantic] : [];
}

type CrawlResult = {
  indexUrl: string;
  jobs: NormalizedJob[];
};

export type StructuredCrawlOptions = {
  maxPages?: number;
  maxDepth?: number;
  sitemapJobLimit?: number;
};

async function crawlStructuredCareerSite(
  websiteUrl: string,
  fetcher: typeof fetch,
  now: string,
  requireEntry: boolean,
  options: StructuredCrawlOptions = {}
): Promise<CrawlResult> {
  const site = new URL(websiteUrl);
  if (site.protocol !== "https:") throw new Error("structured source requires HTTPS");
  const requestedLocale = site.pathname.match(/^\/[a-z]{2}(?:-[a-z]{2})?\//i)?.[0] || "";
  const session = new PublicWebSession(fetcher);
  const roots = [
    { url: site.href, required: requireEntry },
    ...["/careers", "/careers/", "/jobs", "/jobs/", "/join-us", "/work-with-us"]
      .map((path) => ({ url: new URL(path, site).href, required: false })),
  ];
  const sitemapCandidates = await session.sitemapUrls(site.origin);
  for (const sitemapUrl of sitemapCandidates.slice(0, 2)) {
    try {
      const response = await session.fetch(sitemapUrl);
      if (!response.ok) continue;
      const locations = urlsFromSitemap(await boundedText(response)).slice(0, 2_000);
      let added = 0;
      for (const location of locations) {
        const parsed = new URL(location);
        if (
          sameSite(parsed, site) &&
          crawlableCareerPath(parsed) &&
          (!requestedLocale || parsed.pathname.startsWith(requestedLocale)) &&
          /(?:position|posting|opening|jobs?\/[^/]+)/i.test(parsed.pathname)
        ) {
          roots.push({ url: parsed.href, required: false });
          added += 1;
          if (added >= (options.sitemapJobLimit ?? 10)) break;
        }
      }
    } catch {
      // Sitemap discovery is optional; direct career roots remain authoritative.
    }
  }

  const seedMap = new Map<string, boolean>();
  for (const root of roots) {
    seedMap.set(root.url, Boolean(seedMap.get(root.url) || root.required));
  }
  const queue = [...seedMap].map(([url, required]) => ({ url, depth: 0, required }));
  const visited = new Set<string>();
  const jobs = new Map<string, NormalizedJob>();
  let indexUrl = "";
  const maxPages = Math.min(60, Math.max(1, options.maxPages ?? 60));
  const maxDepth = Math.min(2, Math.max(0, options.maxDepth ?? 2));
  while (queue.length && visited.size < maxPages) {
    const batch = queue.splice(0, 4);
    const pages = await Promise.all(batch.map(async (candidate) => {
      if (visited.has(candidate.url)) return null;
      visited.add(candidate.url);
      try {
        const response = await session.fetch(candidate.url);
        if (response.status === 404) {
          if (candidate.required) {
            throw new Error("structured source returned an incomplete payload: required page 404");
          }
          return null;
        }
        if (!response.ok) {
          throw new Error(`structured source returned ${response.status}`);
        }
        return {
          ...candidate,
          url: response.url || candidate.url,
          html: await boundedText(response),
        };
      } catch (error) {
        if (!candidate.required) return null;
        throw error;
      }
    }));
    for (const page of pages) {
      if (!page) continue;
      const parsedJobs = parseStructuredCareerPage(page.html, page.url, now);
      if (!indexUrl && !parsedJobs.length) indexUrl = page.url;
      for (const job of parsedJobs) jobs.set(job.externalId, job);
      if (page.depth >= maxDepth) continue;
      const pageUrl = new URL(page.url);
      const pageLocale = pageUrl.pathname.match(/^\/[a-z]{2}(?:-[a-z]{2})?\//i)?.[0] || "";
      for (const link of linksFromHtml(page.html, page.url)) {
        const parsed = new URL(link);
        if (
          sameSite(parsed, site) &&
          crawlableCareerPath(parsed) &&
          (!pageLocale || parsed.pathname.startsWith(pageLocale)) &&
          !visited.has(parsed.href) &&
          !queue.some((candidate) => candidate.url === parsed.href)
        ) queue.push({ url: parsed.href, depth: page.depth + 1, required: true });
      }
    }
  }
  if (queue.length) {
    throw new Error("structured source returned an incomplete payload: crawl limit");
  }
  return { indexUrl: indexUrl || websiteUrl, jobs: [...jobs.values()] };
}

export async function discoverStructuredCareerSource(
  websiteUrl: string,
  fetcher: typeof fetch = fetch,
  now = new Date().toISOString(),
  options: StructuredCrawlOptions = {}
) {
  const result = await crawlStructuredCareerSite(
    websiteUrl, fetcher, now, false, options
  );
  if (!result.jobs.length) return null;
  return {
    provider: "structured" as const,
    boardId: result.indexUrl,
    careersUrl: result.indexUrl,
  };
}

export async function fetchStructuredCareerSource(
  indexUrl: string,
  fetcher: typeof fetch = fetch,
  now = new Date().toISOString()
) {
  const result = await crawlStructuredCareerSite(indexUrl, fetcher, now, true);
  return { complete: true as const, jobs: result.jobs };
}
