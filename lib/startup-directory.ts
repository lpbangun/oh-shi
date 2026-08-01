import type { StartupDomainEvidenceInput } from "./domain-registry";

export const YC_DIRECTORY_URL = "https://yc-oss.github.io/api/companies/all.json";
export const YC_TERMS_URL = "https://github.com/yc-oss/api";
export const YC_SOURCE_KIND = "ycombinator-oss";

const USER_AGENT = "OH-SHI/1.0 startup-directory (https://ohshi.work/about)";

export type YcCompany = {
  id?: number;
  name?: string;
  slug?: string;
  website?: string;
  status?: string;
  batch?: string;
  industry?: string;
  team_size?: number;
};

/**
 * Wikidata only lists companies notable enough for an encyclopedia, so it skews
 * old and large and almost never covers the seed-stage startups this index is
 * for. The YC open-source mirror is the opposite: every entry is a startup, and
 * it publishes a website for ~99% of them under an open licence with no key.
 */
export function classifyYcCompany(company: YcCompany) {
  const batchYear = Number(String(company.batch || "").match(/(\d{2})$/)?.[1]);
  const recent = Number.isFinite(batchYear) && batchYear >= 18;
  if (recent) return "recent_yc_startup";
  return "yc_startup";
}

/** Active companies only: dead and acquired entries never have live boards. */
export function isLiveYcCompany(company: YcCompany) {
  return (company.status || "").toLowerCase() === "active";
}

export function ycEvidenceInputs(
  companies: YcCompany[],
  observedAt: string
): StartupDomainEvidenceInput[] {
  const inputs: StartupDomainEvidenceInput[] = [];
  const seen = new Set<string>();
  for (const company of companies) {
    const slug = String(company.slug || "").trim();
    const name = String(company.name || "").trim();
    const website = String(company.website || "").trim();
    if (!slug || !name || !website || seen.has(slug)) continue;
    if (!isLiveYcCompany(company)) continue;
    // normalizedRecord rejects anything that is not https, so upgrade bare
    // http entries rather than silently dropping the company.
    const httpsWebsite = website.startsWith("http://")
      ? `https://${website.slice("http://".length)}`
      : website;
    if (!httpsWebsite.startsWith("https://")) continue;
    seen.add(slug);
    inputs.push({
      companyName: name,
      websiteUrl: httpsWebsite,
      sourceId: `yc:${slug}`,
      sourceKind: YC_SOURCE_KIND,
      sourceClassification: classifyYcCompany(company),
      evidenceUrl: `https://www.ycombinator.com/companies/${slug}`,
      permissionStatus: "permitted",
      sourceTermsUrl: YC_TERMS_URL,
      observedAt,
      // Registry import accepts evidence only; discovery decides whether a
      // domain is actually active, so it must enter as "unknown".
      activityState: "unknown",
      reviewStatus: "pending",
    });
  }
  return inputs;
}

export async function fetchYcDirectory(
  fetchImpl: typeof fetch = fetch
): Promise<YcCompany[]> {
  const response = await fetchImpl(YC_DIRECTORY_URL, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`YC directory fetch failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("YC directory payload was not an array");
  }
  return payload as YcCompany[];
}
