import { readFile } from "node:fs/promises";
import { boundedText, PublicWebSession } from "../../public-web";
import { companyNameFromFundingTitle, companyWebsiteFromFundingHtml, pageMetadata, REPUTABLE_SOURCES } from "../../funding-discovery";
import { registrableDomain } from "../../domain-registry";
import type { AcquisitionCandidate, AcquisitionLane, CapCounter, SourceReceipt } from "../types";

export type Context = Parameters<AcquisitionLane["acquire"]>[0];
export type SourceUnit = {
  id: string;
  permission: "permitted" | "awaiting_permission" | "blocked";
  missingPrerequisite?: string;
  acquire(context: Context): Promise<{ candidates: AcquisitionCandidate[]; receipt: SourceReceipt }>;
};
export function sourceLane(source: SourceUnit, lane: AcquisitionLane["id"]): AcquisitionLane {
  return { id: lane, async acquire(context) {
    const result = await source.acquire(context);
    return { candidates: result.candidates, receipts: [result.receipt], checkpoints: [] };
  } };
}
export type FixtureDocument = { url: string; status: number; contentType: string; body: string; website?: string; name?: string };
export type FixtureSource = {
  id: string; permission: SourceUnit["permission"]; error?: string;
  documents?: FixtureDocument[];
  search?: { results: Array<{ url: string; title: string }> };
  fetch?: Record<string, FixtureDocument>;
};
export type Corpus = { label: "FIXTURE"; now: string; sources: FixtureSource[] };
export async function readCorpus(dir: string): Promise<Corpus> {
  const value = JSON.parse(await readFile(dir + "/corpus.json", "utf8")) as Corpus;
  if (value.label !== "FIXTURE" || !Array.isArray(value.sources) || !Number.isFinite(Date.parse(value.now))) throw new Error("invalid_fixture_corpus");
  return value;
}
export function malformed(doc: FixtureDocument): Error {
  return new Error("malformed_response status=" + doc.status + " content-type=" + doc.contentType + " excerpt=" + doc.body.slice(0, 180).replace(/\s+/g, " "));
}
export function pageCandidate(doc: FixtureDocument): AcquisitionCandidate | null {
  if (doc.status < 200 || doc.status >= 300) throw new Error("source_http_" + doc.status);
  if (!/text\/html/i.test(doc.contentType)) throw malformed(doc);
  const metadata = pageMetadata(doc.body);
  const companyName = doc.name || companyNameFromFundingTitle(metadata.title);
  const websiteUrl = doc.website || companyWebsiteFromFundingHtml(doc.body, doc.url);
  if (!companyName || !websiteUrl) return null;
  const text = doc.body.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return {
    companyName, websiteUrl, evidenceUrl: doc.url, publisher: new URL(doc.url).hostname,
    observedAt: metadata.publishedAt || "", kind: metadata.title === companyName ? "new_company" : "funding_event",
    document: { title: metadata.title, text, publishedAt: metadata.publishedAt || "", permission: "permitted" },
  };
}
export function sparqlCandidates(doc: FixtureDocument, now: string): AcquisitionCandidate[] {
  try {
    if (doc.status !== 200 || !/json/i.test(doc.contentType)) throw malformed(doc);
    const payload = JSON.parse(doc.body);
    if (!Array.isArray(payload.results?.bindings)) throw malformed(doc);
    return payload.results.bindings.map((row: Record<string, { value: string }>) => {
      if (!row.companyLabel?.value || !row.website?.value || !row.company?.value) throw malformed(doc);
      const country = row.countryLabel?.value || "";
      return {
        companyName: row.companyLabel.value, websiteUrl: row.website.value,
        evidenceUrl: row.company.value.replace("http://www.wikidata.org/entity/", "https://www.wikidata.org/wiki/"),
        publisher: "Wikidata", observedAt: now, kind: "new_company" as const,
        headquartersHint: country ? { location: country, method: "wikidata_P159_P17", evidenceUrl: row.company.value } : null,
        document: { title: row.companyLabel.value, text: "", publishedAt: "", permission: "permitted" as const },
      };
    });
  } catch { throw malformed(doc); }
}
export function permittedDocument(url: string, website?: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (REPUTABLE_SOURCES.some(s => new URL(s.url).hostname === u.hostname)) return true;
    return !!website && registrableDomain(u.hostname) === registrableDomain(new URL(website).hostname);
  } catch { return false; }
}
/** Every actual request, including robots and redirects, spends the shared cap. No retries. */
export function budgetFetcher(caps: CapCounter, fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    if (caps.fetchRequests >= caps.maxFetchRequests || Date.now() >= caps.deadlineAt) {
      caps.exceeded = true; throw new Error("request_or_time_cap");
    }
    caps.fetchRequests++;
    return fetcher(input, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(15000, caps.deadlineAt - Date.now()))) });
  };
}
export function webSession(caps: CapCounter, fetcher?: typeof fetch) {
  return new PublicWebSession(budgetFetcher(caps, fetcher), "OH-SHI/1.0 daily-discovery (https://ohshi.work/about)");
}
export async function fetchedDocument(session: PublicWebSession, url: string, website?: string, name?: string): Promise<FixtureDocument> {
  const response = await session.fetch(url);
  return { url, website, name, status: response.status, contentType: response.headers.get("content-type") || "", body: response.ok ? await boundedText(response, 1_000_000) : "" };
}
export function fixtureUnits(corpus: Corpus, lane: "direct" | "tinyfish"): SourceUnit[] {
  return corpus.sources.map(source => ({
    id: source.id, permission: source.permission,
    async acquire() {
      if (source.error) throw new Error(source.error);
      const candidates: AcquisitionCandidate[] = [];
      const documents = lane === "direct" ? source.documents || [] :
        (source.search?.results || []).map(hit => {
          const doc = source.fetch?.[hit.url];
          if (!doc) throw new Error("fetch_document_missing_for_search_lead");
          return doc;
        });
      for (const doc of documents) {
        if (/json/i.test(doc.contentType) || doc.url.includes("query.wikidata.org")) candidates.push(...sparqlCandidates(doc, corpus.now));
        else {
          if (!permittedDocument(doc.url, doc.website)) throw new Error("document_permission_denied");
          const candidate = pageCandidate(doc);
          if (candidate) candidates.push(candidate);
        }
      }
      return { candidates, receipt: { sourceId: source.id, lane, status: "completed", requests: 0, documentsChecked: documents.length, candidatesFound: candidates.length } };
    },
  }));
}
