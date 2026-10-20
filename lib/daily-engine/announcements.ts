import { createHash } from "node:crypto";
import { registrableDomain } from "../domain-registry";
import { fundingLabel, stageFromText } from "../funding-discovery";
import { pageCandidate, type FixtureDocument, type SourceUnit } from "./lanes/shared";
import type { AcquisitionCandidate } from "./types";
import { verifyFunding } from "./funding-verification";
import { verifyHQ } from "./hq-verification";

/** Captures are replayed offline. Robots is an access constraint, never a reuse grant. */
export type AnnouncementCapture = FixtureDocument & {
  capturedAt: string;
  sha256: string;
  permission: {
    status: "permitted" | "blocked" | "awaiting_permission";
    basis: "license" | "owner_authorization" | "published_reuse_policy" | "factual_extraction";
    scope?: "facts_only";
    evidenceUrl: string;
    passage: string;
    /** Captured grant/policy evidence; declarations alone are never authorization. */
    evidenceCapture?: { url: string; status: number; body: string; capturedAt: string; sha256: string };
  };
};
export type AnnouncementInput = {
  schema: "ohshi-announcement-input/1";
  announcements: Array<{
    id: string;
    companyName: string;
    websiteUrl: string;
    announcement: AnnouncementCapture;
    headquarters: AnnouncementCapture[];
  }>;
};

function domain(url: string) {
  const value = new URL(url);
  if (value.protocol !== "https:" || value.username || value.password || [...value.searchParams.keys()].some(key => /(?:api.?key|token|secret|password|authorization|signature)/i.test(key))) throw new Error("invalid_or_sensitive_capture_url");
  const host = registrableDomain(value.hostname);
  if (!host) throw new Error("capture_url_requires_public_domain");
  return host;
}
function validateCapture(doc: AnnouncementCapture, now: string) {
  domain(doc.url);
  if (doc.status !== 200 || !/text\/html/i.test(doc.contentType)) throw new Error("invalid_capture_response");
  if (!Number.isFinite(Date.parse(doc.capturedAt))) throw new Error("capture_date_missing");
  if (createHash("sha256").update(doc.body).digest("hex") !== doc.sha256) throw new Error("capture_hash_mismatch");
  const p = doc.permission;
  if (!p || p.status !== "permitted" || !["license", "owner_authorization", "published_reuse_policy", "factual_extraction"].includes(p.basis) || !p.passage?.trim()) throw new Error("capture_reuse_not_authorized");
  domain(p.evidenceUrl);
  const policy = p.evidenceCapture;
  if (!policy || policy.url !== p.evidenceUrl || policy.status !== 200 || !Number.isFinite(Date.parse(policy.capturedAt)) || Date.parse(policy.capturedAt) > Date.parse(now) || policy.body.length > 1_000_000 || createHash("sha256").update(policy.body).digest("hex") !== policy.sha256 || !policy.body.includes(p.passage)) throw new Error("captured_reuse_evidence_required");
  if (p.basis !== "factual_extraction" && domain(p.evidenceUrl) !== domain(doc.url) && !doc.body.includes(p.evidenceUrl)) throw new Error("reuse_policy_not_bound_to_source");
  if (p.basis === "factual_extraction" && (p.scope !== "facts_only" || new URL(p.evidenceUrl).hostname !== "www.copyright.gov" || !p.passage.includes("Copyright does not protect facts"))) throw new Error("unsupported_factual_reuse_basis");
  if (doc.body.length > 1_000_000) throw new Error("capture_too_large");
  if (/<input\b[^>]*type\s*=\s*["']password["']|\b(?:subscribe|sign in|log in)\s+to\s+(?:read|continue)\b/i.test(doc.body)) throw new Error("capture_access_wall");
  if (/robots\.txt(?:$|[?#])/i.test(p.evidenceUrl) || /^robots\b/i.test(p.passage.trim())) throw new Error("robots_is_not_reuse_authorization");
}
function dates(html: string) {
  const values: string[] = [];
  for (const meta of html.matchAll(/<meta\b([^>]+)>/gi)) {
    const key = meta[1].match(/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1];
    const value = meta[1].match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
    if (key && /^(?:article:published_time|datePublished|date|publish-date|parsely-pub-date)$/i.test(key) && value) values.push(value);
  }
  values.push(...[...html.matchAll(/["']datePublished["']\s*:\s*["']([^"']+)["']/gi)].map(m => m[1]));
  values.push(...[...html.matchAll(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]));
  return values;
}
export function announcementSources(input: AnnouncementInput): SourceUnit[] {
  if (input.schema !== "ohshi-announcement-input/1" || !Array.isArray(input.announcements) || input.announcements.length > 25) throw new Error("invalid_announcement_input");
  const ids = new Set<string>();
  return input.announcements.map(item => {
    if (!item.id || ids.has(item.id)) throw new Error("duplicate_announcement_source_id");
    if (!Array.isArray(item.headquarters) || item.headquarters.length > 5) throw new Error("invalid_headquarters_capture_count");
    ids.add(item.id);
    return {
      id: "announcement-" + item.id,
      permission: item.announcement.permission?.status || "awaiting_permission",
      async acquire(context) {
        validateCapture(item.announcement, context.now);
        const companyDomain = domain(item.websiteUrl);
        const announcementDomain = domain(item.announcement.url);
        // For external publishers the official website must actually be linked by the capture.
        const links = [...item.announcement.body.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].flatMap(m => {
          try { return [domain(new URL(m[1], item.announcement.url).href)]; } catch { return []; }
        });
        if (announcementDomain !== companyDomain && !links.includes(companyDomain)) throw new Error("official_domain_not_evidenced");
        const candidate = pageCandidate({ ...item.announcement, name: item.companyName, website: item.websiteUrl });
        if (!candidate) throw new Error("announcement_parse_failed");
        if (candidate.kind !== "funding_event") throw new Error("not_funding_announcement");
        const published = candidate.document!.publishedAt;
        const declared = dates(item.announcement.body);
        if (!published || !declared.length) throw new Error("announcement_date_missing");
        if (declared.some(d => !Number.isFinite(Date.parse(d)) || (/^\d{4}-\d\d-\d\d/.test(d) && new Date(d.slice(0, 10)).toISOString().slice(0, 10) !== d.slice(0, 10)) || new Date(d).toISOString().slice(0, 10) !== published.slice(0, 10))) throw new Error("announcement_date_conflict");
        const age = Date.parse(context.now) - Date.parse(published);
        if (!Number.isFinite(age) || age < 0 || age > context.lookbackDays * 86_400_000) throw new Error("announcement_outside_lookback");
        if (Date.parse(item.announcement.capturedAt) > Date.parse(context.now)) throw new Error("capture_in_future");
        const evidence: NonNullable<AcquisitionCandidate["headquartersDocuments"]> = [];
        for (const doc of item.headquarters) {
          validateCapture(doc, context.now);
          if (domain(doc.url) !== companyDomain || doc.url === item.announcement.url) throw new Error("independent_official_hq_required");
          if (Date.parse(doc.capturedAt) > Date.parse(context.now)) throw new Error("capture_in_future");
          const text = doc.body.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<\/(?:p|div|span|h[1-6]|li|address)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/[^\S\n]+/g, " ").split("\n").map(s => s.trim()).filter(Boolean).join("\n");
          evidence.push({ url: doc.url, text, capturedAt: doc.capturedAt, sha256: doc.sha256, permission: "permitted" });
        }
        const roundFact = candidate.document!.text.match(/\$\s*\d+(?:[.,]\d+)?\s*(?:million|billion|[mbk])?\s+(?:series\s+[a-h]|pre[- ]?seed|seed)\b/i)?.[0];
        const fundingFact = stageFromText(candidate.document!.title) ? candidate.document!.title : roundFact || candidate.document!.title;
        candidate.funding = { label: fundingLabel(fundingFact), stage: stageFromText(fundingFact), status: /\b(?:raised|secured|closed|landed)\b/i.test(candidate.document!.title) ? "completed" : "announced" };
        candidate.headquartersDocuments = evidence;
        candidate.announcementEvidence = { capturedAt: item.announcement.capturedAt, sha256: item.announcement.sha256, permission: {
          status: item.announcement.permission.status, basis: item.announcement.permission.basis,
          scope: item.announcement.permission.scope, evidenceUrl: item.announcement.permission.evidenceUrl,
          passage: item.announcement.permission.passage,
          evidenceSha256: item.announcement.permission.evidenceCapture!.sha256,
          evidenceCapturedAt: item.announcement.permission.evidenceCapture!.capturedAt,
        } };
        if ([item.announcement, ...item.headquarters].some(d => d.permission.basis === "factual_extraction")) {
          // Verify the actual captured text BEFORE dropping expression. Persist only
          // names, dates, source IDs, funding facts and short factual HQ statements.
          const hq = verifyHQ(candidate, context.now);
          const funding = verifyFunding(candidate, companyDomain, false, context.now);
          if (hq.status !== "verified_us") throw new Error(hq.reason || "independent_us_hq_required");
          if (!funding.event || funding.reason) throw new Error(funding.reason || "funding_unverified");
          const stage = candidate.funding.stage;
          const label = candidate.funding.label;
          candidate.document = { ...candidate.document!, text: `Funding announcement: ${label}.`, retention: "facts_only" };
          candidate.headquartersDocuments = [{ ...evidence.find(e => e.url === hq.evidenceUrl)!, text: `Headquarters: ${hq.matchedText}` }];
          candidate.funding = { ...candidate.funding!, label, stage };
        }
        return { candidates: [candidate], receipt: { sourceId: "announcement-" + item.id, lane: "direct", status: "completed", requests: 0, documentsChecked: 1 + evidence.length, candidatesFound: 1 } };
      },
    };
  });
}
