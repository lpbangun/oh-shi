import { boundedText } from "../../public-web";
import { budgetFetcher, fixtureUnits, malformed, pageCandidate, permittedDocument, readCorpus, type SourceUnit } from "./shared";

export const TINYFISH_PREREQUISITE = "Missing TINYFISH_API_KEY and/or TINYFISH_SEARCH_URL and TINYFISH_FETCH_URL: scoped free Search + Fetch credentials/configuration required; no Browser/Agent/Monitor calls permitted.";
export async function tinyfishSources(options: {
  fixtures?: string; env?: Record<string, string | undefined>; fetcher?: typeof fetch;
} = {}): Promise<SourceUnit[]> {
  if (options.fixtures) return fixtureUnits(await readCorpus(options.fixtures), "tinyfish");
  const env = options.env || process.env;
  const key = env.TINYFISH_API_KEY, searchUrl = env.TINYFISH_SEARCH_URL, fetchUrl = env.TINYFISH_FETCH_URL;
  // Fail closed without touching the network. No key files or external secret locations are probed.
  const missing = ["TINYFISH_API_KEY", "TINYFISH_SEARCH_URL", "TINYFISH_FETCH_URL"].filter(name => !env[name]);
  const prerequisite = missing.length === 3 ? TINYFISH_PREREQUISITE : "Missing " + missing.join(", ") + ": scoped free Search + Fetch configuration required.";
  if (missing.length) return [{
    id: "tinyfish-search-fetch", permission: "blocked", missingPrerequisite: prerequisite,
    async acquire() { return { candidates: [], receipt: { sourceId: "tinyfish-search-fetch", lane: "tinyfish", status: "blocked", requests: 0, documentsChecked: 0, candidatesFound: 0, missingPrerequisite: prerequisite } }; },
  }];
  for (const value of [searchUrl!, fetchUrl!]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search) throw new Error("TinyFish endpoints must be plain HTTPS free Search/Fetch endpoints");
  }
  return [{
    id: "tinyfish-search-fetch", permission: "permitted",
    async acquire(context) {
      const transport = budgetFetcher(context.caps, options.fetcher);
      async function call(url: string, body: object, search: boolean) {
        if (search) {
          if (context.caps.searchRequests >= context.caps.maxSearchRequests) throw new Error("search_cap");
          context.caps.searchRequests++;
        }
        const response = await transport(url, { method: "POST", redirect: "error", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const doc = { url, status: response.status, contentType: response.headers.get("content-type") || "", body: await boundedText(response, 1_000_000) };
        try {
          if (!response.ok || !/json/i.test(doc.contentType)) throw malformed(doc);
          return { value: JSON.parse(doc.body), doc };
        } catch { throw malformed(doc); }
      }
      const before = context.caps.fetchRequests;
      const search = await call(searchUrl!, { query: 'US startup funding headquarters', lookback_days: context.lookbackDays, limit: 20 }, true);
      const payload = search.value;
      if (!Array.isArray(payload?.results)) throw malformed(search.doc);
      const candidates = [];
      let documentsChecked = 0;
      for (const hit of payload.results.slice(0, 20)) {
        if (!permittedDocument(hit.url, hit.website)) continue;
        const result = await call(fetchUrl!, { url: hit.url }, false);
        if (typeof result.value?.html !== "string") throw malformed(result.doc);
        const c = pageCandidate({ url: hit.url, website: hit.website, name: hit.name, status: 200, contentType: "text/html", body: result.value.html }, context.now);
        documentsChecked++;
        if (c) candidates.push(c);
      }
      return { candidates, receipt: { sourceId: "tinyfish-search-fetch", lane: "tinyfish", status: "completed", requests: context.caps.fetchRequests - before, documentsChecked, candidatesFound: candidates.length } };
    },
  }];
}
