import { capturedRequest } from "../capture";
import { registrableDomain } from "../../domain-registry";
import { loadTregKey, TREG_KEY_FILE, TregTransport, type TregOptions } from "../treg";
import { REPUTABLE_SOURCES } from "../../funding-discovery";
import { boundedText } from "../../public-web";
import { budgetFetcher, fixtureUnits, malformed, pageCandidate, permittedDocument, readCorpus, type SourceUnit } from "./shared";
import type { AcquisitionCandidate } from "../types";

export const TINYFISH_PREREQUISITE = "Missing TINYFISH_API_KEY and/or TINYFISH_SEARCH_URL and TINYFISH_FETCH_URL: scoped free Search + Fetch credentials/configuration required; no Browser/Agent/Monitor calls permitted.";
function siteWebsite(site: unknown): string | undefined {
  if (typeof site !== "string" || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(site)) return;
  return "https://" + site.toLowerCase();
}
export async function tinyfishSources(options: {
  fixtures?: string; env?: Record<string, string | undefined>; fetcher?: typeof fetch; searchQueries?: string[]; verifiedEndpointsOnly?: boolean; treg?: TregOptions;
} = {}): Promise<SourceUnit[]> {
  if (options.fixtures) return fixtureUnits(await readCorpus(options.fixtures), "tinyfish");
  let treg: TregTransport | undefined;
  if (options.treg) {
    try {
      if (!options.treg.keyLoader && options.treg.keyFile !== TREG_KEY_FILE) throw new Error("treg_key_path_refused");
      const key = await (options.treg.keyLoader || loadTregKey)(options.treg.keyFile);
      treg = new TregTransport(key, options.treg, options.fetcher);
    } catch (error) {
      const missingPrerequisite = error instanceof Error ? error.message : "treg_key_unavailable";
      return [{ id: "tinyfish-search-fetch", permission: "blocked", missingPrerequisite, async acquire() { return {candidates: [], receipt: {sourceId: "tinyfish-search-fetch", lane: "tinyfish", status: "blocked", requests: 0, documentsChecked: 0, candidatesFound: 0, missingPrerequisite}}; } }];
    }
  }
  const env = options.env || process.env;
  const key = treg ? "treg-mode" : env.TINYFISH_API_KEY;
  const searchUrl = treg ? "https://treg.to/call/tinyfish.web.search" : env.TINYFISH_SEARCH_URL || "https://api.search.tinyfish.ai";
  const fetchUrl = treg ? "https://treg.to/call/tinyfish.web.fetch" : env.TINYFISH_FETCH_URL || "https://api.fetch.tinyfish.ai";
  // Preserve the historical missing-key prerequisite verbatim; never probe secret files.
  const missing = ["TINYFISH_API_KEY", "TINYFISH_SEARCH_URL", "TINYFISH_FETCH_URL"].filter(name => !env[name]);
  const prerequisite = missing.length === 3 ? TINYFISH_PREREQUISITE : "Missing " + missing.join(", ") + ": scoped free Search + Fetch configuration required.";
  if (!key) return [{
    id: "tinyfish-search-fetch", permission: "blocked", missingPrerequisite: prerequisite,
    async acquire() { return { candidates: [], receipt: { sourceId: "tinyfish-search-fetch", lane: "tinyfish", status: "blocked", requests: 0, documentsChecked: 0, candidatesFound: 0, missingPrerequisite: prerequisite } }; },
  }];
  if (!treg && options.verifiedEndpointsOnly && (new URL(searchUrl).href !== "https://api.search.tinyfish.ai/" || new URL(fetchUrl).href !== "https://api.fetch.tinyfish.ai/")) throw new Error("readiness_requires_documented_tinyfish_endpoints");
  for (const value of [searchUrl, fetchUrl]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("TinyFish endpoints must be plain HTTPS free Search/Fetch endpoints");
  }
  return [{
    id: "tinyfish-search-fetch", permission: "permitted",
    async acquire(context) {
      if (treg && !context.capture) throw new Error("treg_capture_required");
      const caps = context.caps;
      const before = caps.fetchRequests, searchBefore = caps.searchRequests;
      let fetchEnvelopes = 0, documentsChecked = 0, documentsSkipped = 0;
      const documentErrors: Array<{ url: string; error: string }> = [];
      const candidates: AcquisitionCandidate[] = [];
      async function call(url: string, urls?: string[]) {
        let response: Response;
        const init: RequestInit = { method: urls ? "POST" : "GET", redirect: "error", headers: { "X-API-Key": key!, ...(urls ? { "Content-Type": "application/json" } : {}) }, ...(urls ? { body: JSON.stringify({ urls, format: "html" }) } : {}) };
        if (treg) {
          response = await treg.call(url, urls, caps, context.capture);
          if (urls) fetchEnvelopes++;
        } else if (!urls) {
          const before = caps.searchRequests;
          const perform = async () => {
          if (caps.searchRequests >= caps.maxSearchRequests) { caps.exceeded = true; throw new Error("search_cap"); }
          if (Date.now() >= caps.deadlineAt) { caps.exceeded = true; throw new Error("request_or_time_cap"); }
          caps.searchRequests++;
          return (options.fetcher || fetch)(url, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(15000, caps.deadlineAt - Date.now()))) });
          };
          response = context.capture ? await capturedRequest(context.capture, "tinyfish", url, init, perform, () => caps.searchRequests - before, true) : await perform();
        } else {
          response = await budgetFetcher(caps, options.fetcher, urls.length, context.capture, "tinyfish")(url, init);
          fetchEnvelopes++;
        }
        const doc = { url, status: response.status, contentType: response.headers.get("content-type") || "", body: treg ? treg.clean(await boundedText(response, 1_000_000)) : await boundedText(response, 1_000_000) };
        let payload;
        try { payload = JSON.parse(doc.body); } catch { throw malformed(doc); }
        if (!response.ok) throw new Error("tinyfish_http_" + response.status + " " + JSON.stringify(payload?.error || {}).slice(0, 400));
        if (!/json/i.test(doc.contentType) || !Array.isArray(payload?.results)) throw malformed(doc);
        return payload;
      }
      for (const query of options.searchQueries ?? ["US startup funding headquarters"]) {
        const url = new URL(searchUrl); url.searchParams.set("query", query);
        if (treg) url.searchParams.set("domain_type", "web");
        const payload = await call(url.href);
        const hits: Array<{ url: string; website?: string }> = [];
        for (const hit of payload.results) {
          const website = siteWebsite(hit?.site_name);
          if (typeof hit?.url !== "string" || !permittedDocument(hit.url, website)) { documentsSkipped++; continue; }
          hits.push({ url: hit.url, website });
        }
        const remaining = Math.max(0, caps.maxFetchRequests - caps.fetchRequests);
        documentsSkipped += Math.max(0, hits.length - remaining);
        const selected = hits.slice(0, remaining);
        for (let i = 0; i < selected.length; i += 10) {
          const batch = selected.slice(i, i + 10);
          const result = await call(fetchUrl, batch.map(h => h.url));
          const errors = Array.isArray(result.errors) ? result.errors : [];
          for (const hit of batch) {
            const error = errors.find((e: { url?: string }) => e?.url === hit.url);
            if (error) { documentErrors.push({ url: hit.url, error: JSON.stringify(error).slice(0, 500) }); continue; }
            const doc = result.results.find((d: { url?: string }) => d?.url === hit.url);
            try {
              if (!doc || doc.format !== "html" || typeof doc.text !== "string") throw new Error("fetch_html_document_missing");
              const finalUrl = doc.final_url || hit.url;
              if (!permittedDocument(finalUrl, hit.website) || (treg && registrableDomain(new URL(finalUrl).hostname) !== registrableDomain(new URL(hit.url).hostname))) throw new Error("document_permission_denied");
              documentsChecked++;
              // A publisher domain authorizes retrieval, not company identity.
              const publisher = REPUTABLE_SOURCES.some(s => new URL(s.url).hostname === new URL(finalUrl).hostname);
              const candidate = pageCandidate({ url: finalUrl, website: publisher ? undefined : hit.website, status: 200, contentType: "text/html", body: doc.text });
              if (candidate) candidates.push(candidate);
              else documentsSkipped++;
            } catch (error) { documentErrors.push({ url: hit.url, error: error instanceof Error ? error.message : String(error) }); }
          }
        }
      }
      return { candidates, receipt: { sourceId: "tinyfish-search-fetch", lane: "tinyfish", status: "completed", requests: caps.fetchRequests - before + caps.searchRequests - searchBefore, fetchEnvelopes, documentsSkipped, documentsChecked, candidatesFound: candidates.length, documentErrors } };
    },
  }];
}
