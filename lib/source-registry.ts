export type AtsProvider = "ashby" | "greenhouse" | "lever" | "workable" | "manual";
export type DiscoveryAccess = "public_page" | "manual_import" | "awaiting_permission";

export type InvestorSourceSeed = {
  id: string;
  name: string;
  kind: "investor" | "accelerator";
  portfolioUrl: string;
  jobsUrl: string | null;
  access: DiscoveryAccess;
  enabled: boolean;
  mandatory: boolean;
  reviewNotes: string;
};

/**
 * Discovery-source ranking (reviewed 2026-07-28).
 *
 * Order balances private-company breadth, recent investment activity, US hiring
 * relevance, quality of first-party evidence, and availability of a permitted
 * public discovery surface. It is deliberately configuration data: changing
 * source priority or access policy does not change the discovery engine.
 */
export const INVESTOR_SOURCE_SEEDS: readonly InvestorSourceSeed[] = [
  {
    id: "a16z", name: "Andreessen Horowitz / a16z", kind: "investor",
    portfolioUrl: "https://a16z.com/portfolio/", jobsUrl: "https://portfoliojobs.a16z.com/jobs",
    access: "awaiting_permission", enabled: true, mandatory: true,
    reviewNotes: "Official portfolio remains manual: robots guidance is absent (404). Getro requests API access.",
  },
  {
    id: "general-catalyst", name: "General Catalyst", kind: "investor",
    portfolioUrl: "https://www.generalcatalyst.com/portfolio", jobsUrl: "https://jobs.generalcatalyst.com/jobs",
    access: "public_page", enabled: true, mandatory: true,
    reviewNotes: "Official public portfolio; investor page is not canonical job evidence.",
  },
  {
    id: "khosla-ventures", name: "Khosla Ventures", kind: "investor",
    portfolioUrl: "https://www.khoslaventures.com/portfolio", jobsUrl: "https://jobs.khoslaventures.com/jobs",
    access: "awaiting_permission", enabled: true, mandatory: true,
    reviewNotes: "Official portfolio is configured for manual import; automation terms are unclear.",
  },
  {
    id: "sequoia", name: "Sequoia Capital", kind: "investor",
    portfolioUrl: "https://sequoiacap.com/our-companies/", jobsUrl: "https://jobs.sequoiacap.com/jobs",
    access: "public_page", enabled: true, mandatory: false,
    reviewNotes: "Official companies resource and public portfolio-job surface.",
  },
  {
    id: "nea", name: "New Enterprise Associates / NEA", kind: "investor",
    portfolioUrl: "https://www.nea.com/portfolio", jobsUrl: "https://careers.nea.com/jobs",
    access: "awaiting_permission", enabled: true, mandatory: false,
    reviewNotes: "Terms restrict copying/republication; use reviewed manual imports pending permission.",
  },
  {
    id: "lightspeed", name: "Lightspeed Venture Partners", kind: "investor",
    portfolioUrl: "https://lsvp.com/companies/", jobsUrl: null,
    access: "awaiting_permission", enabled: true, mandatory: false,
    reviewNotes: "Terms prohibit robots and automated scraping; manual import only.",
  },
  {
    id: "accel", name: "Accel", kind: "investor",
    portfolioUrl: "https://www.accel.com/companies", jobsUrl: "https://jobs.accel.com/jobs",
    access: "awaiting_permission", enabled: true, mandatory: false,
    reviewNotes: "Portfolio robots permits access, but automation terms are unclear and job board returns 403.",
  },
  {
    id: "bessemer", name: "Bessemer Venture Partners", kind: "investor",
    portfolioUrl: "https://www.bvp.com/companies", jobsUrl: "https://jobs.bvp.com/jobs",
    access: "awaiting_permission", enabled: true, mandatory: false,
    reviewNotes: "Terms expressly prohibit scraping/database scraping; manual import only.",
  },
  {
    id: "insight-partners", name: "Insight Partners", kind: "investor",
    portfolioUrl: "https://www.insightpartners.com/portfolio/", jobsUrl: "https://jobs.insightpartners.com/jobs",
    access: "awaiting_permission", enabled: true, mandatory: false,
    reviewNotes: "Terms expressly prohibit robots, scrapers, and crawlers; manual import only.",
  },
  {
    id: "y-combinator", name: "Y Combinator", kind: "accelerator",
    portfolioUrl: "https://www.ycombinator.com/companies", jobsUrl: "https://www.ycombinator.com/jobs",
    access: "awaiting_permission", enabled: true, mandatory: true,
    reviewNotes: "Official terms prohibit scraping site content; manual import only.",
  },
] as const;

export type CompanySourceSeed = {
  companyId: string;
  provider: AtsProvider;
  boardId: string;
  careersUrl: string;
};

export const COMPANY_SOURCE_SEEDS: readonly CompanySourceSeed[] = [
  ["company_ataraxis", "ashby", "ataraxis-ai"],
  ["company_cognition", "ashby", "cognition"],
  ["company_conduct", "ashby", "conduct"],
  ["company_edison", "ashby", "Edison Scientific"],
  ["company_hotplate", "ashby", "hotplate"],
  ["company_ramp", "ashby", "ramp"],
  ["company_watershed", "ashby", "watershed"],
  ["company_vanta", "ashby", "vanta"],
  ["company_harvey", "ashby", "harvey"],
  ["company_abridge", "ashby", "abridge"],
  ["company_higharc", "ashby", "higharc"],
  ["company_suno", "ashby", "suno"],
].map(([companyId, provider, boardId]) => ({
  companyId,
  provider: provider as AtsProvider,
  boardId,
  careersUrl: `https://jobs.ashbyhq.com/${encodeURIComponent(boardId)}`,
}));

export function normalizeDomain(value: string) {
  const candidate = value.trim().toLowerCase();
  if (!candidate) return "";
  try {
    const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    return url.hostname.replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

export function sourceKey(provider: AtsProvider, boardId: string) {
  return `${provider}:${boardId.trim().toLowerCase()}`;
}
