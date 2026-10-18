import { boundedText } from "../../public-web";
import { registrableDomain } from "../../domain-registry";
import { REPUTABLE_SOURCES, fundingLinksFromHtml } from "../../funding-discovery";
import { budgetFetcher, fetchedDocument, fixtureUnits, pageCandidate, permittedDocument, readCorpus, sparqlCandidates, webSession, type Context, type SourceUnit } from "./shared";

export const WIKIDATA_QUERY = `SELECT ?company ?companyLabel ?website ?countryLabel WHERE {
  ?company wdt:P31/wdt:P279* wd:Q129238; wdt:P856 ?website.
  OPTIONAL { ?company wdt:P159/wdt:P17 ?country. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY ?company ?website LIMIT 40`;

export async function directSources(options: { fixtures?: string; existing: Context["existingCompanies"]; fetcher?: typeof fetch }): Promise<SourceUnit[]> {
  if (options.fixtures) return fixtureUnits(await readCorpus(options.fixtures), "direct");
  const sources: SourceUnit[] = [{
    id: "wikidata-startups", permission: "permitted",
    async acquire(context) {
      const url = new URL("https://query.wikidata.org/sparql");
      url.searchParams.set("query", WIKIDATA_QUERY); url.searchParams.set("format", "json");
      const before = context.caps.fetchRequests;
      const response = await budgetFetcher(context.caps, options.fetcher)(url, {
        redirect: "error", headers: { Accept: "application/sparql-results+json", "User-Agent": "OH-SHI/1.0 daily-discovery (https://ohshi.work/about)" },
      });
      const doc = { url: url.href, status: response.status, contentType: response.headers.get("content-type") || "", body: await boundedText(response, 1_000_000) };
      const candidates = sparqlCandidates(doc, context.now);
      return { candidates, receipt: { sourceId: "wikidata-startups", lane: "direct", status: "completed", requests: context.caps.fetchRequests - before, documentsChecked: 1, candidatesFound: candidates.length } };
    },
  }];
  const feeds = [
    ...REPUTABLE_SOURCES.map(s => ({ id: s.id, url: s.url, website: undefined as string | undefined, name: undefined as string | undefined })),
    ...options.existing.filter(c => {
      try { const u = new URL(c.sourceUrl); return u.protocol === "https:" && registrableDomain(u.hostname) === c.domain; }
      catch { return false; }
    }).map(c => ({
      id: "official-" + c.domain, url: c.sourceUrl, website: "https://" + c.domain, name: c.name,
    })),
  ];
  for (const feed of feeds) sources.push({
    id: feed.id, permission: "permitted",
    async acquire(context) {
      const before = context.caps.fetchRequests;
      const session = webSession(context.caps, options.fetcher);
      const index = await fetchedDocument(session, feed.url, feed.website, feed.name);
      const candidates = [];
      let documentsChecked = 1;
      if (feed.website) { const c = pageCandidate(index); if (c) candidates.push(c); }
      for (const link of fundingLinksFromHtml(index.body, feed.url).filter(l => permittedDocument(l.url, feed.website)).slice(0, 8)) {
        const doc = await fetchedDocument(session, link.url, feed.website, feed.name);
        documentsChecked++;
        const c = pageCandidate(doc); if (c) candidates.push(c);
      }
      return { candidates, receipt: { sourceId: feed.id, lane: "direct", status: "completed", requests: context.caps.fetchRequests - before, documentsChecked, candidatesFound: candidates.length } };
    },
  });
  // No investor directory is included, regardless of robots availability.
  return sources;
}
