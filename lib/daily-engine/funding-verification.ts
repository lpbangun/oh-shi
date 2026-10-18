import { createHash } from "node:crypto";
import { REPUTABLE_SOURCES, companyNameFromFundingTitle } from "../funding-discovery";
import { registrableDomain } from "../domain-registry";
import type { AcquisitionCandidate, VerifiedFundingEvent } from "./types";

export const stableId = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
export function verifyFunding(c: AcquisitionCandidate, domain: string, existing: boolean, now: string): {
  event: VerifiedFundingEvent | null; reason: string | null;
} {
  if (c.kind !== "funding_event") return { event: null, reason: null };
  const doc = c.document;
  if (!doc || doc.permission !== "permitted") return { event: null, reason: "unsupported_lead_only" };
  let url: URL;
  try { url = new URL(c.evidenceUrl); } catch { return { event: null, reason: "unsupported_url" }; }
  const official = registrableDomain(url.hostname) === domain;
  const reputable = REPUTABLE_SOURCES.some(s => new URL(s.url).hostname === url.hostname);
  if (url.protocol !== "https:" || (!official && !reputable)) return { event: null, reason: "unsupported_source" };
  const text = doc.title + ". " + doc.text;
  if (/\b(?:in talks|seeking|seeks|plans? to raise|reportedly raising|targeting|may raise)\b/i.test(text)) {
    return { event: null, reason: "speculative" };
  }
  const subject = companyNameFromFundingTitle(doc.title);
  if (!subject || subject.toLowerCase() !== c.companyName.toLowerCase() ||
      !/\b(?:funding|financing|investment|round|seed|series [a-h])\b/i.test(text)) {
    return { event: null, reason: "unsupported_funding_claim" };
  }
  const validDate = doc.publishedAt && Number.isFinite(Date.parse(doc.publishedAt));
  const occurredAt = validDate ? new Date(doc.publishedAt).toISOString() : "";
  if (occurredAt && Date.parse(occurredAt) > Date.parse(now)) return { event: null, reason: "unsupported_future_date" };
  const status = /\b(?:raised|secured|closed|landed)\b/i.test(doc.title) ? "completed" : "announced";
  // Missing fields remain unpublished; a headline amount/stage is not inferred.
  return { reason: null, event: {
    id: "funding_" + stableId(domain + ":" + url.href),
    companyName: c.companyName, companyDomain: domain, companyExisting: existing,
    title: doc.title, description: doc.text, occurredAt, discoveredAt: now, lastCheckedAt: now,
    sourceUrl: url.href, sourceKind: official ? "official" : "reputable", publisher: c.publisher,
    latestFundingLabel: c.funding?.label || "", stage: c.funding?.stage || null, status,
    evidenceGaps: occurredAt ? [] : ["announcement_date_missing"],
  } };
}
