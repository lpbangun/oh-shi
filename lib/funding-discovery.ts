import { boundedText, PublicWebSession } from "./public-web";
import { registrableDomain, type StartupDomainEvidenceInput } from "./domain-registry";
import type { Company } from "./types";

export const FUNDING_DISCOVERY_VERSION = "2026-09-18";
export const FUNDING_LOOKBACK_DAYS = 14;
export const UNMATCHED_FUNDING_LEAD_LIMIT = 8;

export type FundingDiscovery = {
  id: string;
  companyId: string;
  companyName: string;
  title: string;
  description: string;
  occurredAt: string;
  sourceUrl: string;
  sourceKind: "official" | "reputable";
  publisher: string;
  latestFundingLabel: string;
  stage: string | null;
};

export type FundingSourceReceipt = {
  sourceId: string;
  sourceUrl: string;
  sourceKind: "official" | "reputable";
  status: "completed" | "failed";
  documentsChecked: number;
  candidatesFound: number;
  leadsFound?: number;
  error?: string;
};

export type FundingCompanyLead = {
  companyName: string;
  websiteUrl: string;
  evidenceUrl: string;
  publisher: string;
  observedAt: string;
};

type FundingSource = {
  id: string;
  url: string;
  kind: "official" | "reputable";
  publisher: string;
  companyId: string | null;
};

type PageMetadata = {
  title: string;
  description: string;
  publishedAt: string | null;
};

const REPUTABLE_SOURCES: FundingSource[] = [
  {
    id: "techcrunch-venture",
    url: "https://techcrunch.com/category/venture/",
    kind: "reputable",
    publisher: "TechCrunch",
    companyId: null,
  },
  {
    id: "crunchbase-news",
    url: "https://news.crunchbase.com/",
    kind: "reputable",
    publisher: "Crunchbase News",
    companyId: null,
  },
];

const NEWS_TERMS_URL: Record<string, string> = {
  TechCrunch: "https://techcrunch.com/terms-of-service/",
  "Crunchbase News": "https://about.crunchbase.com/terms-of-service/",
};

const BLOCKED_COMPANY_HOST =
  /(?:^|\.)(?:techcrunch|crunchbase|yahoo|msn|google|apple|microsoft|amazon|facebook|instagram|linkedin|twitter|youtube|wikipedia|cloudfront|googleapis|wixstatic|substack)\.com$|^(?:www\.)?(?:x\.com|t\.co|bit\.ly)$/i;
const FUNDING_ACTION = /\b(?:raises?|raised|secures?|secured|closes?|closed|lands?|landed|announces?|announced)\b/i;
const FUNDING_OBJECT = /(?:\bfunding\b|\bfinancing\b|\binvestment\b|\bround\b|\bpre[- ]?seed\b|\bseed\b|\bseries\s+[a-h]\b|[$€£]\s?\d)/i;
const SPECULATIVE = /\b(?:in talks|seeks?|seeking|plans? to raise|reportedly raising|targeting)\b/i;

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value: string) {
  return decodeHtml(value.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
}

function metaContent(html: string, keys: string[]) {
  for (const match of html.matchAll(/<meta\b([^>]+)>/gi)) {
    const attributes = match[1];
    const key = attributes.match(/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!key || !keys.some((candidate) => candidate.toLowerCase() === key.toLowerCase())) continue;
    const content = attributes.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (content) return decodeHtml(content);
  }
  return "";
}

export function pageMetadata(html: string): PageMetadata {
  const title =
    metaContent(html, ["og:title", "twitter:title", "headline"]) ||
    stripTags(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const description = metaContent(html, [
    "og:description",
    "twitter:description",
    "description",
  ]);
  const published =
    metaContent(html, [
      "article:published_time",
      "datePublished",
      "date",
      "publish-date",
      "parsely-pub-date",
    ]) ||
    html.match(/["']datePublished["']\s*:\s*["']([^"']+)["']/i)?.[1] ||
    "";
  const parsed = Date.parse(decodeHtml(published));
  return {
    title,
    description,
    publishedAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null,
  };
}

export function fundingLinksFromHtml(html: string, baseUrl: string) {
  const links = new Map<string, string>();
  for (const match of html.matchAll(/<a\b([^>]*?)href\s*=\s*["']([^"'#]+)["']([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const label = stripTags(match[4]);
    const context = `${label} ${match[1]} ${match[3]}`;
    if (!FUNDING_ACTION.test(context) || !FUNDING_OBJECT.test(context) || SPECULATIVE.test(context)) continue;
    try {
      const url = new URL(match[2], baseUrl);
      if (url.protocol === "https:") links.set(url.href, label);
    } catch {
      // Invalid source links are ignored.
    }
  }
  return [...links].map(([url, label]) => ({ url, label }));
}

function normalizedWords(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function companyMentioned(company: Company, value: string) {
  const name = normalizedWords(company.name);
  const haystack = ` ${normalizedWords(value)} `;
  return name.length >= 3 && haystack.includes(` ${name} `);
}

function officialHost(company: Company, sourceUrl: string) {
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./, "");
    const domain = company.domain.replace(/^www\./, "").toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function fundingLabel(value: string) {
  const amount = value.match(/[$€£]\s?\d+(?:[.,]\d+)?\s?(?:[kmb]|million|billion)?\+?/i)?.[0]
    ?.replace(/\s+/g, " ");
  const round = value.match(/\b(?:pre[- ]?seed|seed|series\s+[a-h]|growth)(?:\s+(?:round|funding))?\b/i)?.[0];
  if (amount && round) return `${amount} ${round.replace(/\b\w/g, (letter) => letter.toUpperCase())}`;
  if (amount) return `${amount} funding round`;
  if (round) return round.replace(/\b\w/g, (letter) => letter.toUpperCase());
  return "Funding announced";
}

function stageFromText(value: string) {
  const series = value.match(/\bseries\s+([a-h])\b/i)?.[1];
  if (series) return `Series ${series.toUpperCase()}`;
  if (/\bpre[- ]?seed\b/i.test(value)) return "Pre-seed";
  if (/\bseed\b/i.test(value)) return "Seed";
  if (/\bgrowth\b/i.test(value)) return "Growth";
  return null;
}

function stableId(companyId: string, sourceUrl: string) {
  let hash = 2166136261;
  const value = `${companyId}:${sourceUrl}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `funding_${companyId.replace(/^company_/, "")}_${(hash >>> 0).toString(36)}`;
}

export function fundingDiscoveryFromPage(input: {
  company: Company;
  sourceUrl: string;
  sourceKind: "official" | "reputable";
  publisher: string;
  metadata: PageMetadata;
  now: string;
}): FundingDiscovery | null {
  const combined = `${input.metadata.title}. ${input.metadata.description}`;
  if (!input.metadata.publishedAt) return null;
  if (!FUNDING_ACTION.test(combined) || !FUNDING_OBJECT.test(combined) || SPECULATIVE.test(combined)) return null;
  if (input.sourceKind === "official" && !officialHost(input.company, input.sourceUrl)) return null;
  if (input.sourceKind === "reputable" && !companyMentioned(input.company, combined)) return null;
  const occurred = Date.parse(input.metadata.publishedAt);
  const now = Date.parse(input.now);
  if (!Number.isFinite(occurred) || !Number.isFinite(now)) return null;
  if (occurred > now + 86_400_000 || occurred < now - FUNDING_LOOKBACK_DAYS * 86_400_000) return null;
  let source: URL;
  try {
    source = new URL(input.sourceUrl);
  } catch {
    return null;
  }
  if (source.protocol !== "https:") return null;

  const label = fundingLabel(combined);
  const title = label === "Funding announced"
    ? `${input.company.name} announced new funding`
    : `${input.company.name} announced ${label}`;
  return {
    id: stableId(input.company.id, source.href),
    companyId: input.company.id,
    companyName: input.company.name,
    title,
    description: input.metadata.description || input.metadata.title,
    occurredAt: new Date(occurred).toISOString(),
    sourceUrl: source.href,
    sourceKind: input.sourceKind,
    publisher: input.publisher,
    latestFundingLabel: label,
    stage: stageFromText(combined),
  };
}

export function companyNameFromFundingTitle(title: string) {
  const cleaned = title.replace(/\s+/g, " ").trim();
  const match = cleaned.match(
    /^(.{2,80}?)\s+(?:raises?|raised|secures?|secured|closes?|closed|lands?|landed|announces?|announced)\b/i
  );
  const name = match?.[1]?.replace(/^[\s:;|–—-]+|[\s:;|–—-]+$/g, "").trim() || "";
  if (!name || /^(breaking|exclusive|how|why|what|the)\b/i.test(name)) return null;
  if (name.split(/\s+/).length > 8) return null;
  return name;
}

function considerCompanyWebsite(href: string, pageUrl: string, found: Map<string, string>) {
  try {
    const url = new URL(href, pageUrl);
    if (url.protocol !== "https:") return;
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const pageHost = new URL(pageUrl).hostname.replace(/^www\./, "").toLowerCase();
    if (host === pageHost || BLOCKED_COMPANY_HOST.test(host)) return;
    const domain = registrableDomain(host);
    if (!domain) return;
    if (!found.has(domain)) found.set(domain, `https://${domain}/`);
  } catch {
    // Invalid hrefs are not company websites.
  }
}

export function companyWebsiteFromFundingHtml(html: string, pageUrl: string) {
  const found = new Map<string, string>();
  for (const script of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const parsed = JSON.parse(script[1]);
      const nodes = Array.isArray(parsed)
        ? parsed
        : [parsed, ...((parsed && parsed["@graph"]) || [])];
      for (const node of nodes) {
        const type = String(node?.["@type"] || "");
        if (!/organization|corporation/i.test(type) || !node?.url) continue;
        considerCompanyWebsite(String(node.url), pageUrl, found);
      }
    } catch {
      // Malformed JSON-LD is ignored.
    }
  }
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    considerCompanyWebsite(match[1], pageUrl, found);
  }
  if (found.size !== 1) return null;
  return [...found.values()][0];
}

function nameAgreesWithWebsite(name: string, websiteUrl: string) {
  try {
    const label = registrableDomain(new URL(websiteUrl).hostname).split(".")[0] || "";
    const compactName = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const compactLabel = label.toLowerCase().replace(/[^a-z0-9]/g, "");
    return compactName.length >= 3 && compactLabel.length >= 3 &&
      (compactLabel.includes(compactName) || compactName.includes(compactLabel));
  } catch {
    return false;
  }
}

export function fundingCompanyLeadFromPage(input: {
  sourceUrl: string;
  publisher: string;
  metadata: PageMetadata;
  html: string;
  now: string;
}): FundingCompanyLead | null {
  const terms = NEWS_TERMS_URL[input.publisher];
  if (!terms) return null;
  const combined = `${input.metadata.title}. ${input.metadata.description}`;
  if (!input.metadata.publishedAt) return null;
  if (!FUNDING_ACTION.test(combined) || !FUNDING_OBJECT.test(combined) || SPECULATIVE.test(combined)) {
    return null;
  }
  const occurred = Date.parse(input.metadata.publishedAt);
  const now = Date.parse(input.now);
  if (!Number.isFinite(occurred) || !Number.isFinite(now)) return null;
  if (occurred > now + 86_400_000 || occurred < now - FUNDING_LOOKBACK_DAYS * 86_400_000) return null;
  let source: URL;
  try {
    source = new URL(input.sourceUrl);
  } catch {
    return null;
  }
  if (source.protocol !== "https:") return null;
  const companyName = companyNameFromFundingTitle(input.metadata.title);
  const websiteUrl = companyWebsiteFromFundingHtml(input.html, source.href);
  if (!companyName || !websiteUrl || !nameAgreesWithWebsite(companyName, websiteUrl)) return null;
  return {
    companyName,
    websiteUrl,
    evidenceUrl: source.href,
    publisher: input.publisher,
    observedAt: new Date(occurred).toISOString(),
  };
}

export function fundingLeadEvidenceInput(lead: FundingCompanyLead): StartupDomainEvidenceInput {
  return {
    companyName: lead.companyName,
    websiteUrl: lead.websiteUrl,
    sourceId: `news:${lead.evidenceUrl}`,
    sourceKind: "funding-news",
    sourceClassification: "recent_funding_announcement",
    evidenceUrl: lead.evidenceUrl,
    permissionStatus: "permitted",
    sourceTermsUrl: NEWS_TERMS_URL[lead.publisher],
    observedAt: lead.observedAt,
    activityState: "unknown",
    reviewStatus: "pending",
  };
}

async function mapWithConcurrency<T, U>(
  values: T[],
  limit: number,
  task: (value: T) => Promise<U>
) {
  const result: U[] = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      result[index] = await task(values[index]);
    }
  }));
  return result;
}

async function fetchPage(session: PublicWebSession, url: string) {
  const response = await session.fetch(url);
  if (!response.ok) throw new Error(`funding_source_http_${response.status}`);
  return boundedText(response);
}

function officialSources(companies: Company[]): FundingSource[] {
  return companies
    .filter((company) => officialHost(company, company.sourceUrl))
    .map((company) => ({
      id: `official-${company.id}`,
      url: company.sourceUrl,
      kind: "official" as const,
      publisher: company.name,
      companyId: company.id,
    }));
}

export async function discoverFundingUpdates(
  companies: Company[],
  options: { fetcher?: typeof fetch; now?: string } = {}
) {
  const now = options.now || new Date().toISOString();
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const session = new PublicWebSession(options.fetcher || fetch, "OH-SHI/1.0 funding-discovery");
  const sources = [...REPUTABLE_SOURCES, ...officialSources(companies)];

  const outputs = await mapWithConcurrency(sources, 4, async (source) => {
    let documentsChecked = 0;
    try {
      const sourceHtml = await fetchPage(session, source.url);
      documentsChecked += 1;
      const links = fundingLinksFromHtml(sourceHtml, source.url);
      const boundCompany = source.companyId ? companyById.get(source.companyId) : null;
      const sourceCandidates: FundingDiscovery[] = [];

      if (boundCompany) {
        const direct = fundingDiscoveryFromPage({
          company: boundCompany,
          sourceUrl: source.url,
          sourceKind: source.kind,
          publisher: source.publisher,
          metadata: pageMetadata(sourceHtml),
          now,
        });
        if (direct) sourceCandidates.push(direct);
      }

      const matchesKnown = (link: { url: string; label: string }) => boundCompany
        ? companyMentioned(boundCompany, link.label) || officialHost(boundCompany, link.url)
        : companies.some((company) => companyMentioned(company, link.label));
      const knownLinks = links.filter(matchesKnown)
        .slice(0, source.kind === "reputable" ? 20 : 4);
      const unmatchedLinks = source.kind === "reputable" && !boundCompany
        ? links.filter((link) => !matchesKnown(link)).slice(0, UNMATCHED_FUNDING_LEAD_LIMIT)
        : [];
      const relevantLinks = [...knownLinks, ...unmatchedLinks];
      const sourceLeads: FundingCompanyLead[] = [];
      const linked = await mapWithConcurrency(relevantLinks, 3, async (link) => {
        try {
          const html = await fetchPage(session, link.url);
          documentsChecked += 1;
          const metadata = pageMetadata(html);
          const matchedCompanies = boundCompany
            ? [boundCompany]
            : companies.filter((company) => companyMentioned(company, `${link.label} ${metadata.title} ${metadata.description}`));
          const discoveries = matchedCompanies.flatMap((company) => {
            const discovery = fundingDiscoveryFromPage({
              company,
              sourceUrl: link.url,
              sourceKind: source.kind,
              publisher: source.publisher,
              metadata,
              now,
            });
            return discovery ? [discovery] : [];
          });
          if (!discoveries.length && !boundCompany) {
            const lead = fundingCompanyLeadFromPage({
              sourceUrl: link.url,
              publisher: source.publisher,
              metadata,
              html,
              now,
            });
            if (lead) sourceLeads.push(lead);
          }
          return discoveries;
        } catch {
          return [];
        }
      });
      sourceCandidates.push(...linked.flat());
      const candidates = [...new Map(sourceCandidates.map((candidate) => [candidate.id, candidate])).values()];
      const leads = [...new Map(sourceLeads.map((lead) => [lead.websiteUrl, lead])).values()];
      return {
        candidates,
        leads,
        receipt: {
          sourceId: source.id,
          sourceUrl: source.url,
          sourceKind: source.kind,
          status: "completed" as const,
          documentsChecked,
          candidatesFound: candidates.length,
          leadsFound: leads.length,
        },
      };
    } catch (error) {
      return {
        candidates: [] as FundingDiscovery[],
        leads: [] as FundingCompanyLead[],
        receipt: {
          sourceId: source.id,
          sourceUrl: source.url,
          sourceKind: source.kind,
          status: "failed" as const,
          documentsChecked,
          candidatesFound: 0,
          leadsFound: 0,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        },
      };
    }
  });

  const discoveries = [...new Map(outputs.flatMap((output) => output.candidates).map((candidate) => [candidate.id, candidate])).values()]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  const leads = [...new Map(outputs.flatMap((output) => output.leads).map((lead) => [lead.websiteUrl, lead])).values()];
  return {
    version: FUNDING_DISCOVERY_VERSION,
    completedAt: new Date().toISOString(),
    discoveries,
    leads,
    receipts: outputs.map((output) => output.receipt),
  };
}
