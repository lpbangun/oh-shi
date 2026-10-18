import { registrableDomain } from "../domain-registry";
import type { AcquisitionCandidate, HQEvidence } from "./types";

export function verifyHQ(candidate: AcquisitionCandidate, now: string): HQEvidence {
  const base = { method: "explicit_first_party_hq", evidenceUrl: candidate.evidenceUrl, observedAt: now };
  const unknown = (reason: string): HQEvidence => ({ ...base, status: "unknown", matchedText: null, reason });
  if (!candidate.document || candidate.document.permission !== "permitted") return unknown("lead_only");
  let host: string;
  try { host = new URL(candidate.evidenceUrl).hostname; } catch { return unknown("invalid_evidence_url"); }
  if (registrableDomain(host) !== registrableDomain(new URL(candidate.websiteUrl).hostname)) {
    // Only the actual P159/P17 chain from the bounded query is accepted, not a search hint.
    if (host === "www.wikidata.org" && candidate.headquartersHint?.method === "wikidata_P159_P17") {
      const location = candidate.headquartersHint.location;
      if (location === "United States") return { ...base, method: "wikidata_P159_P17", status: "verified_us", matchedText: location };
      if (location) return { ...base, method: "wikidata_P159_P17", status: "non_us", matchedText: location };
    }
    return unknown("no_first_party_hq_evidence");
  }
  const text = candidate.document.text;
  const match = text.match(/\b(?:headquartered in|headquarters(?: is| are)?(?: located)? in|headquarters:)\s*([^.!?\n]+)/i);
  if (!match) return unknown("no_explicit_hq_statement; office/customers/currency are not HQ");
  const location = match[1].trim();
  if (/\b(?:United States|USA|U\.S\.A?)\b/i.test(location)) {
    return { ...base, status: "verified_us", matchedText: location };
  }
  if (/\b(?:Canada|United Kingdom|Germany|France|India|Singapore|Australia|Japan|Israel|Netherlands|Switzerland|China|Ireland)\b/i.test(location)) {
    return { ...base, status: "non_us", matchedText: location };
  }
  return unknown("hq_country_not_explicit_or_supported");
}
