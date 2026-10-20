import { registrableDomain } from "../domain-registry";
import type { AcquisitionCandidate, HQEvidence } from "./types";

export function verifyHQ(candidate: AcquisitionCandidate, now: string): HQEvidence {
  const base = { method: "explicit_first_party_hq", evidenceUrl: candidate.evidenceUrl, observedAt: now };
  const unknown = (reason: string): HQEvidence => ({ ...base, status: "unknown", matchedText: null, reason });
  if (!candidate.document || candidate.document.permission !== "permitted") return unknown("lead_only");
  if (candidate.headquartersDocuments) {
    if (!candidate.headquartersDocuments.length) return unknown("independent_hq_missing");
    const documents = candidate.headquartersDocuments;
    const results = documents.map(doc => {
      try {
        if (doc.permission !== "permitted" || new URL(doc.url).protocol !== "https:" || registrableDomain(new URL(doc.url).hostname) !== registrableDomain(new URL(candidate.websiteUrl).hostname)) return unknown("hq_identity_mismatch");
        return verifyHQ({ ...candidate, headquartersDocuments: undefined, evidenceUrl: doc.url, document: { title: candidate.companyName, text: doc.text, permission: "permitted", publishedAt: "" } }, now);
      } catch { return unknown("invalid_hq_document"); }
    });
    // An explicitly contradictory announcement cannot be rescued by a second page.
    const announcement = verifyHQ({ ...candidate, headquartersDocuments: undefined }, now);
    const statuses = new Set([...results, announcement].map(r => r.status).filter(s => s !== "unknown"));
    if (statuses.size > 1 || [...results, announcement].some(r => ["contradictory_hq_statements", "hq_country_not_explicit_or_supported", "negated_hq_statement"].includes(r.reason || ""))) return unknown("contradictory_or_unsupported_hq_evidence");
    const verified = results.find(r => r.status !== "unknown");
    return verified ? { ...verified, method: "independent_" + verified.method } : unknown("independent_hq_unsupported");
  }
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
  if (/\b(?:not|never)\s+(?:currently\s+)?headquartered\s+in\b|\bheadquarters\s+(?:(?:is|are)\s+)?(?:located\s+)?not\s+in\b/i.test(text)) return unknown("negated_hq_statement");
  const matches = [...text.matchAll(/\b(?:headquartered in|headquarters(?: is| are)?(?: located)? in|headquarters:)\s*([^!?\n]+?)(?=\.(?:\s|$)|\n|$)/gi)];
  if (!matches.length) return unknown("no_explicit_hq_statement; office/customers/currency are not HQ");
  const locations = [...new Set(matches.map(m => m[1].trim()))];
  const us = (s: string) => /\b(?:United States|USA|U\.S\.A?|San Francisco Bay Area)\b/i.test(s) || /\b(?:San Francisco|San Jose|Palo Alto|Mountain View|San Mateo|Los Angeles),?\s+(?:CA|California)\b|\b(?:New York),?\s+(?:NY|New York)\b|\bBoston,?\s+(?:MA|Massachusetts)\b|\bAustin,?\s+(?:TX|Texas)\b|\bSeattle,?\s+(?:WA|Washington)\b/i.test(s);
  const foreign = (s: string) => /\b(?:Canada|United Kingdom|Germany|France|India|Singapore|Australia|Japan|Israel|Netherlands|Switzerland|China|Ireland)\b/i.test(s);
  if (locations.some(us) && locations.some(foreign)) return unknown("contradictory_hq_statements");
  if (locations.every(us)) return { ...base, method: locations.every(s => /\b(?:United States|USA|U\.S\.A?)\b/i.test(s)) ? base.method : "first_party_hq_supported_us_geography", status: "verified_us", matchedText: locations.join("; ") };
  if (locations.every(foreign)) return { ...base, status: "non_us", matchedText: locations.join("; ") };
  return unknown("hq_country_not_explicit_or_supported");
}
