import { registrableDomain } from "../domain-registry";

/**
 * Identity and dedupe: one canonical registrable domain per candidate,
 * name/website agreement, and dedupe against the frozen baseline, the
 * existing company set, and the same run's earlier candidates.
 */

export type IdentityResult =
  | { ok: true; domain: string; nameAgrees: boolean }
  | { ok: false; reason: string };

export function normalizeCandidateIdentity(input: {
  companyName: string;
  websiteUrl: string;
}): IdentityResult {
  let url: URL;
  try {
    url = new URL(input.websiteUrl);
  } catch {
    return { ok: false, reason: "invalid_website_url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "website_not_https" };
  const domain = registrableDomain(url.hostname);
  if (!domain) return { ok: false, reason: "no_registrable_domain" };
  if (!input.companyName || input.companyName.trim().length < 2) {
    return { ok: false, reason: "company_name_missing" };
  }
  return { ok: true, domain, nameAgrees: nameAgreesWithWebsite(input.companyName, url.hostname) };
}

export function compactToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function nameAgreesWithWebsite(name: string, websiteHost: string) {
  const label = registrableDomain(websiteHost)?.split(".")[0] || "";
  const compactName = compactToken(name);
  const compactLabel = compactToken(label);
  return compactName.length >= 3 && compactLabel.length >= 3 &&
    (compactLabel.includes(compactName) || compactName.includes(compactLabel));
}

/**
 * Dedupe key: canonical registrable domain. Candidates already in the frozen
 * baseline or the existing company set are maintenance, not net-new discovery.
 */
export function dedupeCandidates(candidates: Array<{ companyName: string; websiteUrl: string }>): {
  kept: Array<{ candidate: { companyName: string; websiteUrl: string }; domain: string }>;
  duplicates: number;
  invalid: number;
} {
  const seen = new Set<string>();
  const kept: Array<{ candidate: { companyName: string; websiteUrl: string }; domain: string }> = [];
  let duplicates = 0;
  let invalid = 0;
  for (const candidate of candidates) {
    const identity = normalizeCandidateIdentity(candidate);
    if (!identity.ok) {
      invalid += 1;
      continue;
    }
    if (seen.has(identity.domain)) {
      duplicates += 1;
      continue;
    }
    seen.add(identity.domain);
    kept.push({ candidate, domain: identity.domain });
  }
  return { kept, duplicates, invalid };
}

export function domainsInBaseline(baseline: { composition: { productionEmployerDomains: string[]; repoSeedCompanyDomains: string[] } }) {
  return new Set([
    ...baseline.composition.productionEmployerDomains,
    ...baseline.composition.repoSeedCompanyDomains,
  ]);
}
