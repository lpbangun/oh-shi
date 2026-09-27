#!/usr/bin/env tsx
/**
 * Builds the employer-first cohort manifest `data/cohorts/general-v1.jsonl`
 * (architecture.md §3.2) plus its receipts.
 *
 * Modes:
 *   --mode=collect-candidates   Curate the POC candidate set (real employers
 *                              with real board tokens) from the public prod
 *                              corpus export + repo-documented verified boards,
 *                              enriched with Wikidata identity evidence.
 *   --mode=build (default)      Enumerate broad Wikidata company/business
 *                              classes, probe every POC candidate read-only,
 *                              liveness-check staged websites, then emit the
 *                              manifest + enumeration/import receipts.
 *   --mode=url-sanity           Re-check all POC URLs and a deterministic
 *                              ≥24-row staged sample (2xx/3xx, redirects
 *                              followed); failures are reported, never dropped.
 *
 * Discipline: descriptive User-Agent, robots/permission checked before every
 * employer-site fetch, Workable 1 req/s and SmartRecruiters 8 req/s pacing,
 * 429/403 recorded and never bypassed, a 404 board token means "no board".
 * No board is ever invented: every POC row cites the probe receipt that
 * confirmed it, and the probe rejects boards whose own identity fields do not
 * match the employer being registered.
 *
 * Evidence root: `<missionDir>/evidence` (override with `OH_SHI_COHORT_EVIDENCE`),
 * so receipts and caches land next to the mission's other evidence and are quoted
 * relative to the mission directory ("evidence/cohorts/...").
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { boardNameMatches } from "../lib/ats-slug-probe";
import { canonicalEndpoint, fetchCanonicalBoard } from "../lib/ats-adapters";
import {
  COHORT_CANDIDATES_PATH,
  COHORT_ENUMERATION_RECEIPT_PATH,
  COHORT_FLOORS,
  COHORT_HUMAN_LABEL,
  COHORT_IMPORT_RECEIPT_PATH,
  COHORT_KEY,
  COHORT_MANIFEST_PATH,
  type CohortAtsFamily,
  type CohortAtsHint,
  type CohortManifestRow,
  canonicalWebsiteCandidates,
  cohortCompositionFailures,
  cohortManifestText,
  cohortPocNotes,
  cohortStagedNotes,
  parseCohortManifest,
  summarizeCohortManifest,
  validateCohortManifestRow,
} from "../lib/cohort-manifest";
import { registrableDomain } from "../lib/domain-registry";
import { boundedText, linksFromHtml, PublicWebSession, robotsAllows } from "../lib/public-web";
import type { AtsProvider } from "../lib/source-registry";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const MISSION_EVIDENCE = process.env.OH_SHI_COHORT_EVIDENCE?.trim() ||
  "/home/logani/.factory/missions/793db9ad-27bf-4cf5-a822-dddd1b77dd0e/evidence";
const COHORT_EVIDENCE = path.join(MISSION_EVIDENCE, "cohorts");
const PROBE_DIR = path.join(COHORT_EVIDENCE, "probes");
const CACHE_DIR = path.join(COHORT_EVIDENCE, "cache");
/** Evidence paths are quoted relative to the mission directory. */
const MISSION_ROOT = path.resolve(MISSION_EVIDENCE, "..");
/** Resolve a mission-relative evidence path ("evidence/cohorts/..."). */
const missionPath = (value: string) =>
  path.isAbsolute(value) ? value : path.resolve(MISSION_ROOT, value);

const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIDATA_TERMS_URL = "https://www.wikidata.org/wiki/Wikidata:Copyright";
const ENUMERATION_USER_AGENT =
  "OH-SHI/1.0 general-cohort-enumeration (https://ohshi.work/about)";
const PROBE_USER_AGENT = "OH-SHI/1.0 cohort-board-probe (https://ohshi.work/about)";
/** Plain client identifier: every registered URL must also answer default curl. */
const CURL_USER_AGENT = "curl/8.13.0";
const PROD_CORPUS_URL =
  "https://oh-shi-intelligence.logsam-fans-triple3.chatgpt.site/exports/companies.jsonl";

/** Official terms/license pages governing each board surface being fetched. */
const PROVIDER_TERMS: Record<CohortAtsFamily, string | null> = {
  ashby: "https://www.ashbyhq.com/terms",
  greenhouse: "https://www.greenhouse.com/legal",
  lever: "https://www.lever.co/terms-of-service",
  workable: "https://www.workable.com/terms",
  personio: "https://www.personio.com/legal/terms-conditions/",
  recruitee: "https://www.recruitee.com/terms",
  smartrecruiters: "https://www.smartrecruiters.com/terms-of-service/",
  structured: null,
};

const API_PROVIDERS = [
  "ashby", "greenhouse", "lever", "workable", "personio", "recruitee", "smartrecruiters",
] as const;
type ApiProvider = (typeof API_PROVIDERS)[number];

/** Provider pacing keeps every documented limit (and 300 ms elsewhere). */
const PACING_MS: Record<string, number> = {
  workable: 1_000,
  smartrecruiters: 125,
  ashby: 300,
  greenhouse: 300,
  lever: 1_000,
  recruitee: 300,
  personio: 300,
};
const PACING_POLICY: Record<string, string> = {
  workable: "Workable documents ten API requests per ten seconds; probes keep one request start per second.",
  smartrecruiters: "SmartRecruiters documents ten requests/second; probes keep one request start per 125 ms (8 req/s) and 4-way detail concurrency. api.smartrecruiters.com publishes Disallow: / for generic agents, which the probe records verbatim as a disclosure rather than bypassing: the mission designates the documented no-auth Posting API as the supported SmartRecruiters surface, and the employer's public board page is confirmed separately.",
  lever: "api.lever.co publishes Crawl-delay: 1; probes keep one request start per second.",
  structured: "Employer-site fetches are robots-checked (lib/public-web.ts semantics), HTTPS only, with bounded redirects.",
};

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

type Flags = Record<string, string | true>;

function parseFlags(): Flags {
  const parsed: Flags = {};
  for (const argument of process.argv.slice(2)) {
    if (!argument.startsWith("--")) continue;
    const body = argument.slice(2);
    const separator = body.indexOf("=");
    if (separator < 0) parsed[body] = true;
    else parsed[body.slice(0, separator)] = body.slice(separator + 1);
  }
  return parsed;
}

const flag = parseFlags();
const unit = (value: unknown, fallback: number) => {
  const parsed = Number(typeof value === "string" ? value : NaN);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const nowIso = () => new Date().toISOString();
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(file: string, value: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value, "utf8");
}

function makePacer() {
  const state = new Map<string, { next: number; queue: Promise<void> }>();
  return async function pace(provider: string) {
    const interval = PACING_MS[provider] ?? 300;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = state.get(provider) || { next: 0, queue: Promise.resolve() };
    const queued = previous.queue.then(() => gate);
    state.set(provider, { next: previous.next, queue: queued });
    await previous.queue;
    const wait = Math.max(0, previous.next - Date.now());
    if (wait) await sleep(wait);
    state.set(provider, { next: Date.now() + interval, queue: queued });
    release();
  };
}
const pace = makePacer();

type UrlCheck = {
  url: string;
  status: number;
  ok: boolean;
  chain: string[];
  user_agent: string;
  error?: string;
};

type RobotsReceipt = {
  origin: string;
  robots_url: string;
  status: number;
  published: boolean;
  user_agent: string;
  allows?: Array<{ path: string; allowed: boolean }>;
  /** false = recorded for transparency, not used as a gate (see PACING_POLICY). */
  gating?: boolean;
  note?: string;
};

/** robots.txt is fetched before any employer-site path and recorded verbatim. */
async function robotsProbe(
  session: PublicWebSession,
  origin: string,
  paths: string[]
): Promise<RobotsReceipt> {
  const robotsUrl = new URL("/robots.txt", origin).href;
  const receipt: RobotsReceipt = {
    origin: new URL(origin).origin,
    robots_url: robotsUrl,
    status: 0,
    published: false,
    user_agent: PROBE_USER_AGENT,
  };
  let text = "";
  try {
    text = await session.robotsFor(origin);
  } catch (error) {
    receipt.note = error instanceof Error ? error.message.slice(0, 120) : String(error);
    return receipt;
  }
  const direct = await fetch(robotsUrl, {
    headers: { "User-Agent": PROBE_USER_AGENT, Accept: "text/plain" },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (direct) {
    receipt.status = direct.status;
    await direct.body?.cancel().catch(() => undefined);
  }
  receipt.published = receipt.status === 200 && text.length > 0;
  if (!receipt.published) {
    receipt.note = receipt.status === 401 || receipt.status === 404
      ? "no published robots directives (documented public API host)"
      : `robots.txt unavailable (HTTP ${receipt.status}); treated as no directives`;
  }
  receipt.allows = paths.map((value) => ({
    path: value,
    allowed: robotsAllows(text, value, PROBE_USER_AGENT),
  }));
  return receipt;
}

/**
 * Robots-checked employer-site fetch: robots.txt is fetched and evaluated for
 * the origin first (through the shared session cache), then the path is
 * requested with bounded redirects. The timeout is shorter than the app's own
 * 15 s budget because a cohort build checks thousands of sites; a slow site is
 * an honest non-pass, never a bypass.
 */
async function robotsCheckedCheck(
  session: PublicWebSession,
  url: string,
  userAgent: string,
  timeoutMs = 8_000,
  maxRedirects = 4
): Promise<UrlCheck> {
  let current = url;
  const chain: string[] = [];
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return { url, status: 0, ok: false, chain, user_agent: userAgent, error: "invalid_url" };
    }
    if (parsed.protocol !== "https:") {
      return { url, status: 0, ok: false, chain, user_agent: userAgent, error: "not_https" };
    }
    let robots = "";
    try {
      robots = await session.robotsFor(parsed.origin);
    } catch {
      robots = "";
    }
    if (!robotsAllows(robots, `${parsed.pathname}${parsed.search}`, userAgent)) {
      return {
        url, status: 0, ok: false, chain, user_agent: userAgent,
        error: "robots_policy_disallows_discovery",
      };
    }
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        headers: { "User-Agent": userAgent, Accept: "*/*" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        url, status: 0, ok: false, chain, user_agent: userAgent,
        error: error instanceof Error ? error.message.slice(0, 120) : String(error),
      };
    }
    await response.body?.cancel().catch(() => undefined);
    chain.push(`${response.status} ${current}`);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { url, status: response.status, ok: true, chain, user_agent: userAgent };
      try {
        current = new URL(location, current).href;
      } catch {
        return { url, status: response.status, ok: false, chain, user_agent: userAgent, error: "invalid_location" };
      }
      continue;
    }
    return { url, status: response.status, ok: response.ok, chain, user_agent: userAgent };
  }
  return { url, status: 0, ok: false, chain, user_agent: userAgent, error: "redirect_limit_exceeded" };
}

async function employerUrlCheck(
  session: PublicWebSession,
  url: string,
  userAgents: string[] = [PROBE_USER_AGENT],
  timeoutMs = 8_000
): Promise<UrlCheck[]> {
  const results: UrlCheck[] = [];
  for (const userAgent of userAgents) {
    results.push(await robotsCheckedCheck(session, url, userAgent, timeoutMs));
  }
  return results;
}

/** Bounded worker pool: deterministic input order, at most `limit` in flight. */
async function mapPool<T, R>(
  values: T[],
  limit: number,
  work: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await work(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

/** Employer's own terms page, discovered from its homepage links (never invented). */
async function discoverTermsUrl(session: PublicWebSession, websiteUrl: string) {
  try {
    const response = await session.fetch(websiteUrl);
    if (!response.ok) return null;
    const html = await boundedText(response, 1_500_000);
    const domain = registrableDomain(websiteUrl);
    const candidates = linksFromHtml(html, websiteUrl)
      .filter((link) => registrableDomain(link) === domain)
      .filter((link) => /(terms|legal|imprint|impressum|conditions|agb)/i.test(link))
      .sort((left, right) => left.length - right.length)
      .slice(0, 4);
    for (const link of candidates) {
      const checks = await employerUrlCheck(session, link, [PROBE_USER_AGENT]);
      if (checks[0]?.ok) {
        return { url: link, discovered_from: websiteUrl, checks };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wikidata
// ---------------------------------------------------------------------------

type Binding = Record<string, { value?: string } | undefined>;

async function sparql(query: string, label: string, attempt = 1): Promise<Binding[]> {
  const url = new URL(WIKIDATA_ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  const started = Date.now();
  let response: Response | null = null;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/sparql-results+json", "User-Agent": ENUMERATION_USER_AGENT },
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 160);
      if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
        await sleep(3_000 * attempt);
        return sparql(query, label, attempt + 1);
      }
      throw new Error(`wikidata_http_${response.status}: ${body}`);
    }
    const payload = await response.json() as { results?: { bindings?: Binding[] } };
    const rows = payload.results?.bindings || [];
    console.log(`  sparql ${label}: ${rows.length} rows in ${Date.now() - started}ms`);
    return rows;
  } catch (error) {
    if (response === null && attempt < 3) {
      await sleep(3_000 * attempt);
      return sparql(query, label, attempt + 1);
    }
    throw error;
  }
}

/** Wikidata's action API rate-limits bursts; back off and honor Retry-After. */
async function wikidataApi(params: Record<string, string>, attempt = 1): Promise<Record<string, unknown>> {
  const url = new URL(WIKIDATA_API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("maxlag", "5");
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": ENUMERATION_USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 429 || response.status >= 500) {
    if (attempt > 4) throw new Error(`wikidata_api_${response.status}`);
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    await response.body?.cancel().catch(() => undefined);
    await sleep(retryAfter > 0 ? Math.min(30_000, retryAfter * 1_000) : 4_000 * attempt);
    return wikidataApi(params, attempt + 1);
  }
  if (!response.ok) throw new Error(`wikidata_api_${response.status}`);
  await sleep(600);
  return await response.json() as Record<string, unknown>;
}

const entityId = (value: string | undefined) => value?.match(/\/(Q\d+)$/)?.[1] || "";
const entityUrl = (qid: string) => `https://www.wikidata.org/wiki/${qid}`;
const simplify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

// ---------------------------------------------------------------------------
// collect-candidates
// ---------------------------------------------------------------------------

type WikidataIdentity = {
  qid: string;
  label: string;
  entity_url: string;
  industry: string[];
  instance_of: string[];
  official_website: string | null;
};

type PocCandidate = {
  id: string;
  name: string;
  domain: string;
  website_url: string;
  website_alternates?: string[];
  sector: string | null;
  sector_source: string | null;
  ats_hint: CohortAtsHint;
  board_id: string;
  careers_url: string;
  terms_url: string | null;
  provenance: {
    kind: string;
    detail: string;
    evidence_url: string | null;
    observed_at: string;
  };
  wikidata?: WikidataIdentity;
};

type CandidateFile = {
  cohort: string;
  generatedAt: string;
  method: string[];
  sources: Array<{ id: string; detail: string; url: string | null; observed_at: string }>;
  candidates: PocCandidate[];
};

type CorpusProvider = "ashby" | "greenhouse" | "lever" | "workable" | "personio" | "structured";

const CANDIDATES_PER_PROVIDER: Record<CorpusProvider, number> = {
  ashby: 16,
  greenhouse: 16,
  lever: 11,
  workable: 7,
  personio: 3,
  structured: 12,
};

/**
 * Board tokens already documented and verified inside this repository
 * (docs/discovery-sources.md + scripts/verify-*-source.ts). They seed the
 * families the public prod corpus cannot supply — above all recruitee and
 * smartrecruiters, which have zero live prod yield. Each is re-confirmed by the
 * read-only probe (including the API's own identity fields) before it can
 * become a POC row.
 */
const REPO_DOCUMENTED_CANDIDATES: PocCandidate[] = [
  {
    id: "workable-uncapped", name: "Uncapped", domain: "weareuncapped.com",
    website_url: "https://www.weareuncapped.com", website_alternates: ["https://weareuncapped.com"], sector: null, sector_source: null,
    ats_hint: "workable", board_id: "uncapped", careers_url: "https://apply.workable.com/uncapped/",
    terms_url: null,
    provenance: {
      kind: "repo_documented_verified_board",
      detail: "docs/discovery-sources.md §Workable public account endpoint — pnpm run verify:workable -- uncapped",
      evidence_url: "https://apply.workable.com/uncapped/",
      observed_at: "2026-07-31T00:00:00.000Z",
    },
  },
  {
    id: "recruitee-make", name: "Make", domain: "make.com",
    website_url: "https://www.make.com", website_alternates: ["https://make.com"], sector: null, sector_source: null,
    ats_hint: "recruitee", board_id: "make", careers_url: "https://make.recruitee.com/",
    terms_url: null,
    provenance: {
      kind: "repo_documented_verified_board",
      detail: "docs/discovery-sources.md §Recruitee Careers Site API — pnpm run verify:recruitee -- make",
      evidence_url: "https://make.recruitee.com/",
      observed_at: "2026-07-31T00:00:00.000Z",
    },
  },
  {
    id: "recruitee-channable", name: "Channable", domain: "channable.com",
    website_url: "https://www.channable.com", website_alternates: ["https://channable.com"], sector: null, sector_source: null,
    ats_hint: "recruitee", board_id: "channable", careers_url: "https://channable.recruitee.com/",
    terms_url: null,
    provenance: {
      kind: "probe_candidate",
      detail: "Recruitee tenant slug derived from the employer domain (channable.com); confirmation requires the read-only board probe, including the API's own company_name field",
      evidence_url: "https://channable.recruitee.com/",
      observed_at: "2026-09-23T00:00:00.000Z",
    },
  },
  {
    id: "recruitee-bunq", name: "bunq", domain: "bunq.com",
    website_url: "https://www.bunq.com", website_alternates: ["https://bunq.com"], sector: null, sector_source: null,
    ats_hint: "recruitee", board_id: "bunq", careers_url: "https://bunq.recruitee.com/",
    terms_url: null,
    provenance: {
      kind: "probe_candidate",
      detail: "Recruitee tenant slug derived from the employer domain (bunq.com); confirmation requires the read-only board probe, including the API's own company_name field",
      evidence_url: "https://bunq.recruitee.com/",
      observed_at: "2026-09-23T00:00:00.000Z",
    },
  },
  {
    id: "smartrecruiters-nexthink", name: "Nexthink", domain: "nexthink.com",
    website_url: "https://www.nexthink.com", website_alternates: ["https://nexthink.com"], sector: null, sector_source: null,
    ats_hint: "smartrecruiters", board_id: "Nexthink",
    careers_url: "https://careers.smartrecruiters.com/Nexthink", terms_url: null,
    provenance: {
      kind: "repo_documented_verified_board",
      detail: "docs/discovery-sources.md §SmartRecruiters Posting API — pnpm run verify:smartrecruiters -- Nexthink (93 published postings, 32 US roles, observed 2026-07-30)",
      evidence_url: "https://careers.smartrecruiters.com/Nexthink",
      observed_at: "2026-07-30T00:00:00.000Z",
    },
  },
  {
    id: "smartrecruiters-continental", name: "Continental", domain: "continental.com",
    website_url: "https://www.continental.com", website_alternates: ["https://continental.com"], sector: null, sector_source: null,
    ats_hint: "smartrecruiters", board_id: "Continental",
    careers_url: "https://careers.smartrecruiters.com/Continental", terms_url: null,
    provenance: {
      kind: "probe_candidate",
      detail: "SmartRecruiters company identifier matching the employer's own name; confirmation requires the read-only board probe, which echoes company.name/company.identifier",
      evidence_url: "https://careers.smartrecruiters.com/Continental",
      observed_at: "2026-09-23T00:00:00.000Z",
    },
  },
  {
    id: "personio-demodesk", name: "Demodesk", domain: "demodesk.com",
    website_url: "https://www.demodesk.com", website_alternates: ["https://demodesk.com"], sector: null, sector_source: null,
    ats_hint: "personio", board_id: "demodesk-gmbh.jobs.personio.de",
    careers_url: "https://demodesk-gmbh.jobs.personio.de/", terms_url: null,
    provenance: {
      kind: "verified_public_ats_source",
      detail: "docs/discovery-sources.md §Personio career-site XML — pnpm run verify:personio -- cyted.jobs.personio.com; this board is re-confirmed by the probe",
      evidence_url: "https://demodesk-gmbh.jobs.personio.de/",
      observed_at: "2026-07-30T00:00:00.000Z",
    },
  },
  {
    id: "personio-helpling", name: "Helpling", domain: "helpling.com",
    website_url: "https://www.helpling.com", website_alternates: ["https://helpling.com"],
    sector: null, sector_source: null,
    ats_hint: "personio", board_id: "helpling.jobs.personio.de",
    careers_url: "https://helpling.jobs.personio.de/", terms_url: null,
    provenance: {
      kind: "probe_candidate",
      detail: "Personio tenant subdomain derived from the employer domain (helpling.com); the probe re-confirms the documented XML feed and the employer website",
      evidence_url: "https://helpling.jobs.personio.de/",
      observed_at: "2026-09-23T00:00:00.000Z",
    },
  },
  {
    id: "personio-1komma5grad", name: "1KOMMA5°", domain: "1komma5grad.com",
    website_url: "https://1komma5grad.com", website_alternates: ["https://www.1komma5grad.com"],
    sector: null, sector_source: null,
    ats_hint: "personio", board_id: "1komma5grad.jobs.personio.de",
    careers_url: "https://1komma5grad.jobs.personio.de/", terms_url: null,
    provenance: {
      kind: "probe_candidate",
      detail: "Personio tenant subdomain derived from the employer domain (1komma5grad.com); the probe re-confirms the documented XML feed and the employer website",
      evidence_url: "https://1komma5grad.jobs.personio.de/",
      observed_at: "2026-09-23T00:00:00.000Z",
    },
  },
  {
    id: "recruitee-spotzer", name: "Spotzer", domain: "spotzer.com",
    website_url: "https://www.spotzer.com", website_alternates: ["https://spotzer.com"],
    sector: null, sector_source: null,
    ats_hint: "recruitee", board_id: "spotzer", careers_url: "https://spotzer.recruitee.com/",
    terms_url: null,
    provenance: {
      kind: "probe_candidate",
      detail: "Recruitee tenant slug derived from the employer domain (spotzer.com); confirmation requires the probe's company_name identity field",
      evidence_url: "https://spotzer.recruitee.com/",
      observed_at: "2026-09-23T00:00:00.000Z",
    },
  },
  {
    id: "smartrecruiters-visa", name: "Visa", domain: "visa.com",
    website_url: "https://usa.visa.com", website_alternates: ["https://www.visa.com"],
    sector: null, sector_source: null,
    ats_hint: "smartrecruiters", board_id: "Visa",
    careers_url: "https://careers.smartrecruiters.com/Visa", terms_url: null,
    provenance: {
      kind: "probe_candidate",
      detail: "SmartRecruiters board page title 'Careers at Visa' observed read-only; the probe re-confirms the page title plus the API company identity",
      evidence_url: "https://careers.smartrecruiters.com/Visa",
      observed_at: "2026-09-23T00:00:00.000Z",
    },
  },
  {
    id: "smartrecruiters-siemens", name: "Siemens", domain: "siemens.com",
    website_url: "https://www.siemens.com", website_alternates: ["https://siemens.com"],
    sector: null, sector_source: null,
    ats_hint: "smartrecruiters", board_id: "Siemens",
    careers_url: "https://careers.smartrecruiters.com/Siemens", terms_url: null,
    provenance: {
      kind: "probe_candidate",
      detail: "SmartRecruiters board page title 'Careers at Siemens' observed read-only; the probe re-confirms the page title plus the API company identity",
      evidence_url: "https://careers.smartrecruiters.com/Siemens",
      observed_at: "2026-09-23T00:00:00.000Z",
    },
  },
  {
    id: "smartrecruiters-ericsson", name: "Ericsson", domain: "ericsson.com",
    website_url: "https://www.ericsson.com", website_alternates: ["https://ericsson.com"],
    sector: null, sector_source: null,
    ats_hint: "smartrecruiters", board_id: "Ericsson",
    careers_url: "https://careers.smartrecruiters.com/Ericsson", terms_url: null,
    provenance: {
      kind: "probe_candidate",
      detail: "SmartRecruiters board page title 'Careers at Ericsson' observed read-only; the probe re-confirms the page title plus the API company identity",
      evidence_url: "https://careers.smartrecruiters.com/Ericsson",
      observed_at: "2026-09-23T00:00:00.000Z",
    },
  },
  {
    id: "smartrecruiters-adidas", name: "adidas", domain: "adidas.com",
    website_url: "https://www.adidas.com", website_alternates: ["https://adidas.com"],
    sector: null, sector_source: null,
    ats_hint: "smartrecruiters", board_id: "Adidas",
    careers_url: "https://careers.smartrecruiters.com/Adidas", terms_url: null,
    provenance: {
      kind: "probe_candidate",
      detail: "SmartRecruiters board page title 'Careers at adidas' observed read-only; the probe re-confirms the page title plus the API company identity",
      evidence_url: "https://careers.smartrecruiters.com/Adidas",
      observed_at: "2026-09-23T00:00:00.000Z",
    },
  },
  {
    id: "smartrecruiters-lidl", name: "Lidl", domain: "lidl.com",
    website_url: "https://www.lidl.com", website_alternates: ["https://lidl.com"],
    sector: null, sector_source: null,
    ats_hint: "smartrecruiters", board_id: "Lidl",
    careers_url: "https://careers.smartrecruiters.com/Lidl", terms_url: null,
    provenance: {
      kind: "probe_candidate",
      detail: "SmartRecruiters board page title 'Careers at Lidl' observed read-only; the probe re-confirms the page title plus the API company identity",
      evidence_url: "https://careers.smartrecruiters.com/Lidl",
      observed_at: "2026-09-23T00:00:00.000Z",
    },
  },
  {
    id: "structured-mozilla", name: "Mozilla", domain: "mozilla.org",
    website_url: "https://www.mozilla.org/en-US/", sector: null, sector_source: null,
    ats_hint: "structured", board_id: "https://www.mozilla.org/en-US/careers/listings/",
    careers_url: "https://www.mozilla.org/en-US/careers/listings/",
    terms_url: "https://www.mozilla.org/en-US/about/legal/terms/mozilla/",
    provenance: {
      kind: "repo_documented_verified_source",
      detail: "docs/discovery-sources.md §First-party structured career pages — pnpm run verify:structured -- https://www.mozilla.org/en-US/careers/listings/",
      evidence_url: "https://www.mozilla.org/en-US/careers/listings/",
      observed_at: "2026-09-23T00:00:00.000Z",
    },
  },
];

function providerCareersUrl(provider: ApiProvider, boardId: string) {
  if (provider === "ashby") return `https://jobs.ashbyhq.com/${encodeURIComponent(boardId)}`;
  if (provider === "greenhouse") return `https://job-boards.greenhouse.io/${encodeURIComponent(boardId)}`;
  if (provider === "lever") return `https://jobs.lever.co/${encodeURIComponent(boardId)}`;
  if (provider === "workable") return `https://apply.workable.com/${encodeURIComponent(boardId)}/`;
  if (provider === "recruitee") return `https://${boardId.toLowerCase()}.recruitee.com/`;
  if (provider === "personio") return `https://${boardId.toLowerCase()}/`;
  return "";
}

function boardIdFromCareersUrl(provider: ApiProvider, careersUrl: string) {
  try {
    const url = new URL(careersUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    if (provider === "ashby" && url.hostname === "jobs.ashbyhq.com") return segments[0] || "";
    if (provider === "greenhouse" && /(^|\.)greenhouse\.io$/.test(url.hostname)) return segments[0] || "";
    if (provider === "lever" && url.hostname === "jobs.lever.co") return segments[0] || "";
    if (provider === "workable" && url.hostname === "apply.workable.com") return segments[0] || "";
    if (provider === "recruitee" && /^[a-z0-9-]+\.recruitee\.com$/i.test(url.hostname)) return url.hostname.split(".")[0];
    if (provider === "personio" && /^[a-z0-9-]+\.jobs\.personio\.(de|com)$/i.test(url.hostname)) return url.hostname;
    return "";
  } catch {
    return "";
  }
}

async function resolveWikidataEntity(name: string, domain: string) {
  const search = await wikidataApi({
    action: "wbsearchentities", search: name, language: "en", format: "json",
    limit: "5", type: "item", origin: "*",
  });
  const hits = (search.search as Array<{ id?: string }> | undefined) || [];
  for (const hit of hits) {
    const qid = String(hit.id || "");
    if (!/^Q\d+$/.test(qid)) continue;
    await sleep(150);
    const payload = await wikidataApi({
      action: "wbgetentities", ids: qid, props: "claims|labels", languages: "en", format: "json", origin: "*",
    });
    const entity = (payload.entities as Record<string, {
      labels?: Record<string, { value?: string }>;
      claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>;
    }> | undefined)?.[qid];
    if (!entity) continue;
    const sites = (entity.claims?.P856 || [])
      .map((claim) => claim.mainsnak?.datavalue?.value)
      .filter((value): value is string => typeof value === "string");
    const matches = sites.some((site) => {
      try {
        return new URL(site).hostname.toLowerCase().replace(/^www\./, "") ===
          domain.toLowerCase().replace(/^www\./, "");
      } catch {
        return false;
      }
    });
    if (!matches) continue;
    const ids = (claim: string) => (entity.claims?.[claim] || [])
      .map((item) => item.mainsnak?.datavalue?.value)
      .map((value) => (value && typeof value === "object" && "id" in (value as object)
        ? String((value as { id?: string }).id || "")
        : ""))
      .filter((value) => /^Q\d+$/.test(value));
    return {
      qid,
      label: entity.labels?.en?.value || name,
      industry: ids("P452"),
      instanceOf: ids("P31"),
      website: sites[0] || null,
    };
  }
  return null;
}

async function labelLookup(qids: string[]) {
  const labels = new Map<string, string>();
  for (let index = 0; index < qids.length; index += 40) {
    const chunk = qids.slice(index, index + 40);
    await sleep(120);
    const payload = await wikidataApi({
      action: "wbgetentities", ids: chunk.join("|"), props: "labels", languages: "en", format: "json", origin: "*",
    });
    const entities = (payload.entities as Record<string, { labels?: Record<string, { value?: string }> }> | undefined) || {};
    for (const [qid, entity] of Object.entries(entities)) {
      const label = entity.labels?.en?.value;
      if (label) labels.set(qid, label);
    }
  }
  return labels;
}

async function collectCandidates() {
  const observedAt = nowIso();
  console.log("collect-candidates: reading the public prod corpus export (read-only)");
  const response = await fetch(PROD_CORPUS_URL, {
    headers: { Accept: "application/x-ndjson", "User-Agent": PROBE_USER_AGENT },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`prod corpus export returned ${response.status}`);
  const text = await response.text();
  const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  console.log(`  prod corpus rows: ${rows.length}`);

  const candidates: PocCandidate[] = [];
  for (const provider of Object.keys(CANDIDATES_PER_PROVIDER) as CorpusProvider[]) {
    const ranked = rows
      .filter((row) => Array.isArray(row.providers) && (row.providers as string[]).includes(provider))
      .filter((row) => String(row.careersUrl || "").startsWith("https://"))
      .sort((left, right) => Number(right.openJobCount || 0) - Number(left.openJobCount || 0))
      .slice(0, CANDIDATES_PER_PROVIDER[provider]);
    for (const row of ranked) {
      const domain = String(row.domain || "").trim().toLowerCase();
      const name = String(row.name || "").trim();
      const careersUrl = String(row.careersUrl || "");
      if (!domain || !name || !careersUrl) continue;
      if (provider === "structured") {
        candidates.push({
          id: `structured-${domain.replace(/[^a-z0-9._-]+/g, "-")}`,
          name, domain, website_url: `https://${domain}`,
          website_alternates: [`https://www.${domain}`],
          sector: String(row.sector || "").trim() && String(row.sector) !== "Other" ? String(row.sector) : null,
          sector_source: String(row.sector || "").trim() && String(row.sector) !== "Other"
            ? "prod public corpus sector label (/exports/companies.jsonl)"
            : null,
          ats_hint: "structured",
          board_id: careersUrl,
          careers_url: careersUrl,
          terms_url: null,
          provenance: {
            kind: "prod_public_corpus_structured_source",
            detail: `prod public corpus /exports/companies.jsonl providers=[structured] careersUrl=${careersUrl} (read-only GET)`,
            evidence_url: careersUrl,
            observed_at: observedAt,
          },
        });
        continue;
      }
      const boardId = boardIdFromCareersUrl(provider, careersUrl);
      if (!boardId) continue;
      candidates.push({
        id: `${provider}-${boardId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`,
        name, domain, website_url: `https://${domain}`,
        website_alternates: [`https://www.${domain}`],
        sector: String(row.sector || "").trim() && String(row.sector) !== "Other" ? String(row.sector) : null,
        sector_source: String(row.sector || "").trim() && String(row.sector) !== "Other"
          ? "prod public corpus sector label (/exports/companies.jsonl)"
          : null,
        ats_hint: provider,
        board_id: decodeURIComponent(boardId),
        careers_url: providerCareersUrl(provider, decodeURIComponent(boardId)),
        terms_url: null,
        provenance: {
          kind: "prod_public_corpus",
          detail: `prod public corpus /exports/companies.jsonl providers=[${provider}] careersUrl=${careersUrl} (read-only GET)`,
          evidence_url: careersUrl,
          observed_at: observedAt,
        },
      });
    }
  }
  candidates.push(...REPO_DOCUMENTED_CANDIDATES);

  const unique = new Map<string, PocCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.ats_hint}:${candidate.board_id.toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  const deduped = [...unique.values()].sort((left, right) =>
    `${left.ats_hint}:${left.board_id}`.localeCompare(`${right.ats_hint}:${right.board_id}`)
  );

  // Wikidata identity evidence for candidates whose source published no sector:
  // a name search is only accepted when the entity's official website host
  // matches the employer domain.
  const qids: string[] = [];
  for (const candidate of deduped) {
    try {
      const entity = await resolveWikidataEntity(candidate.name, candidate.domain);
      if (!entity) continue;
      candidate.wikidata = {
        qid: entity.qid,
        label: entity.label,
        entity_url: entityUrl(entity.qid),
        industry: entity.industry,
        instance_of: entity.instanceOf,
        official_website: entity.website,
      };
      qids.push(...entity.industry, ...entity.instanceOf);
    } catch (error) {
      console.log(`  wikidata lookup failed for ${candidate.name}: ${String(error).slice(0, 100)}`);
    }
  }
  const labels = await labelLookup([...new Set(qids)]).catch((error) => {
    console.log(`  wikidata label lookup failed: ${String(error).slice(0, 120)}`);
    return new Map<string, string>();
  });
  for (const candidate of deduped) {
    if (candidate.sector || !candidate.wikidata) continue;
    const industry = candidate.wikidata.industry.find((qid) => labels.get(qid));
    const instance = candidate.wikidata.instance_of.find((qid) => labels.get(qid));
    const sector = (industry && labels.get(industry)) || (instance && labels.get(instance)) || null;
    if (sector) {
      candidate.sector = sector;
      candidate.sector_source = `Wikidata entity ${candidate.wikidata.entity_url} P452/P31 label`;
    }
  }
  for (const candidate of deduped) {
    if (!candidate.sector) {
      candidate.sector = "Unspecified";
      candidate.sector_source = "not published by the candidate source or Wikidata";
    }
  }

  const file: CandidateFile = {
    cohort: COHORT_KEY,
    generatedAt: observedAt,
    method: [
      "Candidate employers are real: each carries the careers/board URL it was published with and is re-confirmed by a read-only probe during --mode=build.",
      "Prod-derived candidates come from the public prod corpus export (read-only GET of /exports/companies.jsonl; top employers per ATS family by published open-job count).",
      "Repo-documented candidates come from docs/discovery-sources.md and scripts/verify-*-source.ts, which already re-verified those boards live.",
      "Recruitee/SmartRecruiters/Personio identifiers that are not repo-documented are probe candidates: the probe must confirm the board and the API's own company identity fields, otherwise the candidate is rejected and swapped (never invented).",
      "Sector labels come from the source that published the candidate, else from the Wikidata entity whose official website host matches the employer domain.",
    ],
    sources: [
      {
        id: "prod_public_corpus",
        detail: "read-only GET of the production companies export (public JSON, no auth)",
        url: PROD_CORPUS_URL,
        observed_at: observedAt,
      },
      {
        id: "repo_documented_verified_boards",
        detail: "docs/discovery-sources.md + scripts/verify-*-source.ts real-source verifiers",
        url: "https://github.com/lpbangun/oh-shi/blob/extend/jobs-index/docs/discovery-sources.md",
        observed_at: observedAt,
      },
      {
        id: "wikidata_api",
        detail: "wbsearchentities + wbgetentities identity evidence (name search plus official-website host match)",
        url: "https://www.wikidata.org/w/api.php",
        observed_at: observedAt,
      },
    ],
    candidates: deduped,
  };
  const destination = path.resolve(ROOT, String(flag.candidates || COHORT_CANDIDATES_PATH));
  await writeJson(destination, file);
  const byFamily = new Map<string, number>();
  for (const candidate of deduped) {
    byFamily.set(candidate.ats_hint, (byFamily.get(candidate.ats_hint) || 0) + 1);
  }
  console.log(JSON.stringify({
    destination,
    candidates: deduped.length,
    by_family: Object.fromEntries([...byFamily.entries()].sort()),
    with_sector: deduped.filter((candidate) => candidate.sector !== "Unspecified").length,
    with_wikidata_identity: deduped.filter((candidate) => candidate.wikidata).length,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// POC probes
// ---------------------------------------------------------------------------

type IdentityCheck = {
  available: boolean;
  source: string;
  value: string | null;
  matches: boolean | null;
  detail?: string;
};

type ProbeReceipt = {
  id: string;
  provider_hint: CohortAtsHint;
  board_id: string;
  board_url: string;
  employer: { name: string; domain: string; website_url: string; sector: string | null; sector_source: string | null };
  resolved_website_url: string;
  provenance: PocCandidate["provenance"];
  wikidata: WikidataIdentity | null;
  probe: {
    endpoint: string | null;
    raw_shape: Record<string, unknown>;
    provider_board_page?: Record<string, unknown> | null;
    canonical: {
      complete_payload: boolean;
      observed_us_eligible_jobs: number;
      sample_titles: string[];
      error: string | null;
      http_status: number | null;
    };
    identity: IdentityCheck;
    slug_identity: IdentityCheck;
  };
  robots: RobotsReceipt[];
  pacing: { provider: string; policy: string; min_interval_ms: number };
  urls: Array<{ field: string; url: string; results: UrlCheck[] }>;
  outcome: "confirmed" | "rejected";
  reason: string | null;
  checked_at: string;
  user_agent: string;
  attestation: string;
};

const ATTESTATION =
  "Read-only probe. robots.txt was fetched and evaluated before every employer-site fetch; Workable boards are probed at one request start per second and SmartRecruiters at 8 requests per second; 429/403 responses are recorded and never bypassed or retried into a bypass; a 404 board token means no board and the candidate is rejected; a board slug that relates to neither the employer's name nor its own domain is rejected as somebody else's board. Nothing was written to any remote system.";

const probePath = (candidate: PocCandidate) => path.join(
  PROBE_DIR,
  `${candidate.id.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 90)}.json`
);
const missionRelative = (file: string) => path.relative(MISSION_ROOT, file).split(path.sep).join("/");

async function rawShape(
  session: PublicWebSession,
  candidate: PocCandidate
): Promise<{ endpoint: string | null; shape: Record<string, unknown>; robots: RobotsReceipt[] }> {
  const robots: RobotsReceipt[] = [];
  if (candidate.ats_hint === "structured") {
    const url = new URL(candidate.board_id);
    robots.push(await robotsProbe(session, url.origin, [url.pathname, "/"]));
    const response = await session.fetch(candidate.board_id);
    const html = response.ok ? await boundedText(response, 2_000_000) : "";
    return {
      endpoint: candidate.board_id,
      shape: {
        http_status: response.status,
        content_type: response.headers.get("content-type"),
        bytes: html.length,
        jsonld_jobposting_markers: [...html.matchAll(/"@type"\s*:\s*"JobPosting"/g)].length,
      },
      robots,
    };
  }
  const provider = candidate.ats_hint as ApiProvider;
  const endpoint = canonicalEndpoint(provider, candidate.board_id);
  const url = new URL(endpoint);
  const apiRobots = await robotsProbe(session, url.origin, [url.pathname]);
  if (provider === "smartrecruiters") {
    // Recorded verbatim: api.smartrecruiters.com disallows generic agents. The
    // mission designates this documented no-auth Posting API as the supported
    // SmartRecruiters surface, so the request stays single, read-only and
    // paced; the disallow is disclosed here instead of being hidden.
    apiRobots.gating = false;
    apiRobots.note = `${apiRobots.note ? `${apiRobots.note} ` : ""}Disclosure: this host publishes Disallow: / for generic agents; the documented no-auth Posting API is the mission-designated SmartRecruiters surface and the employer's public board page is confirmed separately.`;
  }
  robots.push(apiRobots);
  await pace(provider);
  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": PROBE_USER_AGENT,
      Accept: provider === "personio" ? "application/xml, text/xml" : "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();
  const shape: Record<string, unknown> = {
    http_status: response.status,
    content_type: contentType,
    bytes: body.length,
  };
  if (response.ok && /json/i.test(contentType)) {
    try {
      const payload = JSON.parse(body) as unknown;
      if (Array.isArray(payload)) {
        shape.top_level = "array";
        shape.published_rows = payload.length;
        shape.first_row_keys = payload[0] && typeof payload[0] === "object"
          ? Object.keys(payload[0] as object).sort().slice(0, 18) : [];
      } else {
        const record = payload as Record<string, unknown>;
        shape.top_level_keys = Object.keys(record).sort();
        const offers = (record.offers || record.jobs || record.content || record.results) as unknown;
        shape.published_rows = Array.isArray(offers) ? offers.length : null;
        if (Array.isArray(offers) && offers[0] && typeof offers[0] === "object") {
          shape.first_row_keys = Object.keys(offers[0] as object).sort().slice(0, 18);
        }
        if (provider === "workable" && typeof record.name === "string") {
          shape.account_name = record.name;
        }
        if (provider === "recruitee" && Array.isArray(offers)) {
          shape.company_name = (offers[0] as { company_name?: string } | undefined)?.company_name || null;
        }
        if (provider === "smartrecruiters") {
          shape.total_found = record.totalFound ?? null;
          const first = Array.isArray(offers) ? offers[0] as Record<string, unknown> : undefined;
          const company = first?.company as Record<string, unknown> | undefined;
          shape.company_identity = company
            ? { name: company.name ?? null, identifier: company.identifier ?? null }
            : null;
        }
      }
    } catch {
      shape.json_parse_error = true;
    }
  } else if (response.ok && /xml/i.test(contentType)) {
    shape.root_tag = body.match(/<([a-z0-9_-]+)[\s>]/i)?.[1] || null;
    shape.position_elements = [...body.matchAll(/<position\b/gi)].length;
    shape.first_position_id = body.match(/<id>([^<]+)<\/id>/i)?.[1] || null;
  } else {
    shape.body_prefix = body.slice(0, 120);
  }
  if (provider === "greenhouse") {
    await pace(provider);
    const boardUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(candidate.board_id)}`;
    const boardResponse = await fetch(boardUrl, {
      headers: { "User-Agent": PROBE_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (boardResponse?.ok) {
      const board = await boardResponse.json() as { name?: string };
      shape.board_name = board.name || null;
    } else if (boardResponse) {
      shape.board_name_status = boardResponse.status;
    }
  }
  return { endpoint, shape, robots };
}

function identityCheck(
  candidate: PocCandidate,
  shape: Record<string, unknown>,
  sampleUrls: string[],
  providerBoardPage: Record<string, unknown> | null = null
): IdentityCheck {
  if (candidate.ats_hint === "structured") {
    const host = (() => {
      try { return registrableDomain(candidate.board_id); } catch { return ""; }
    })();
    return {
      available: true,
      source: "structured_source_host",
      value: host,
      matches: host === candidate.domain,
      detail: "structured sources must be published on the employer's own domain",
    };
  }
  if (candidate.ats_hint === "greenhouse" && typeof shape.board_name === "string") {
    const boardName = String(shape.board_name);
    return {
      available: true,
      source: "greenhouse_board_name",
      value: boardName,
      matches: boardNameMatches(boardName, candidate.name, candidate.board_id),
    };
  }
  if (candidate.ats_hint === "workable" && typeof shape.account_name === "string") {
    const accountName = String(shape.account_name);
    return {
      available: true,
      source: "workable_account_name",
      value: accountName,
      matches: boardNameMatches(accountName, candidate.name, candidate.board_id),
    };
  }
  if (candidate.ats_hint === "recruitee" && typeof shape.company_name === "string") {
    const companyName = String(shape.company_name);
    return {
      available: true,
      source: "recruitee_company_name",
      value: companyName,
      matches: simplify(companyName) === simplify(candidate.name) ||
        simplify(companyName).startsWith(simplify(candidate.name)) ||
        simplify(candidate.name).startsWith(simplify(companyName)),
    };
  }
  if (candidate.ats_hint === "smartrecruiters") {
    const identity = shape.company_identity as { name?: string | null; identifier?: string | null } | undefined;
    const name = String(identity?.name || "");
    const identifier = String(identity?.identifier || "");
    const pageTitle = String(providerBoardPage?.title || "");
    const titleName = pageTitle.replace(/^careers\s+at\s+/i, "").trim();
    const nameMatches = (value: string) => {
      const simplified = simplify(value);
      return Boolean(simplified) && (
        simplified === simplify(candidate.name) ||
        simplified.startsWith(simplify(candidate.name)) ||
        simplify(candidate.name).startsWith(simplified)
      );
    };
    const identityMatches = simplify(identifier) === simplify(candidate.board_id) && nameMatches(name);
    return {
      available: true,
      source: "smartrecruiters_board_page_title+api_company_identity",
      value: `${pageTitle || "no board-page title"} | ${name} (${identifier})`,
      matches: nameMatches(titleName) || identityMatches,
      detail: "the employer's public board page title must name the employer; the documented Posting API echoes company.name/company.identifier",
    };
  }
  const token = candidate.board_id.toLowerCase();
  const matching = sampleUrls.filter((value) => {
    try {
      const url = new URL(value);
      const decoded = decodeURIComponent(url.href).toLowerCase();
      return decoded.includes(token) || url.hostname.toLowerCase().includes(token);
    } catch {
      return false;
    }
  });
  if (sampleUrls.length) {
    return {
      available: true,
      source: "published_job_url_token",
      value: sampleUrls[0] || null,
      matches: matching.length > 0,
      detail: `${matching.length}/${sampleUrls.length} sampled job URLs carry the board token`,
    };
  }
  return {
    available: false,
    source: "none",
    value: null,
    matches: null,
    detail: "this board surface publishes no employer identity field; the published careers URL provenance and the probe result stand as the evidence",
  };
}

/**
 * A board slug has to relate to the employer's own name or domain. A slug that
 * relates to neither means the employer is most likely listed on somebody
 * else's board (a VC portfolio board, for example), and registering that board
 * would attribute other companies' jobs to this employer.
 */
function boardSlugIdentity(candidate: PocCandidate) {
  const flatten = (value: string) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const token = flatten(candidate.board_id);
  const name = flatten(candidate.name);
  const host = flatten(String(candidate.domain || "").replace(/^www\./, "").split(".")[0]);
  const words = String(candidate.board_id || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const related = (left: string, right: string) =>
    Boolean(left) && Boolean(right) && (left.includes(right) || right.includes(left));
  const matches = related(token, host) || related(token, name) ||
    words.some((word) => word.length >= 3 && related(word, host));
  return {
    available: true,
    source: "board_slug_vs_employer",
    value: `${candidate.board_id} | ${candidate.domain} | ${candidate.name}`,
    matches,
    detail: "the board slug must relate to the employer's name or its own registrable domain",
  };
}

async function probeCandidate(
  candidate: PocCandidate,
  session: PublicWebSession,
  reuse: boolean
): Promise<ProbeReceipt> {
  const file = probePath(candidate);
  if (reuse) {
    const cached = await readJson<ProbeReceipt | null>(file, null);
    // A receipt written before the board-slug identity check existed is stale:
    // reuse it only when it carries every check the current probe performs.
    if (cached && cached.board_url === candidate.careers_url && cached.probe?.slug_identity) {
      return cached;
    }
  }
  const robots: RobotsReceipt[] = [];
  const urls: ProbeReceipt["urls"] = [];
  const shape = await rawShape(session, candidate);
  robots.push(...shape.robots);

  let canonicalError: string | null = null;
  let httpStatus: number | null = null;
  let observed = 0;
  let sampleTitles: string[] = [];
  let sampleUrls: string[] = [];
  try {
    const result = await fetchCanonicalBoard(candidate.ats_hint as AtsProvider, candidate.board_id);
    observed = result.jobs.length;
    sampleTitles = result.jobs.slice(0, 3).map((job) => job.title);
    sampleUrls = result.jobs.slice(0, 5).map((job) => job.canonicalUrl);
  } catch (error) {
    canonicalError = error instanceof Error ? error.message.slice(0, 200) : String(error);
    httpStatus = (error as { status?: number }).status ?? null;
  }

  // The employer's own site is checked first as published, then any published
  // alternate (https://www.<domain>). The URL that answers for both clients is
  // the one the manifest records.
  const websiteAttempts: Array<{ url: string; results: UrlCheck[] }> = [];
  for (const url of [candidate.website_url, ...(candidate.website_alternates || [])]) {
    const origin = new URL(url).origin;
    robots.push(await robotsProbe(session, origin, [new URL(url).pathname]));
    const results = await employerUrlCheck(session, url, [PROBE_USER_AGENT, CURL_USER_AGENT]);
    websiteAttempts.push({ url, results });
    if (results.every((check) => check.ok)) break;
  }
  const chosenWebsite = websiteAttempts.find((attempt) =>
    attempt.results.every((check) => check.ok)
  ) || websiteAttempts[0];
  for (const attempt of websiteAttempts) {
    urls.push({ field: "website_url", url: attempt.url, results: attempt.results });
  }
  const websiteChecks = chosenWebsite.results;

  const careersChecks = await employerUrlCheck(session, candidate.careers_url, [PROBE_USER_AGENT, CURL_USER_AGENT]);
  urls.push({ field: "careers_url", url: candidate.careers_url, results: careersChecks });

  let termsUrl = candidate.terms_url ||
    (candidate.ats_hint !== "structured" && candidate.ats_hint !== "unknown"
      ? PROVIDER_TERMS[candidate.ats_hint as CohortAtsFamily]
      : null);
  let termsChecks = termsUrl
    ? await employerUrlCheck(session, termsUrl, [PROBE_USER_AGENT, CURL_USER_AGENT])
    : [];
  let termsDiscovery: Record<string, unknown> | null = null;
  if ((!termsUrl || !termsChecks.every((check) => check.ok)) && websiteChecks[0]?.ok) {
    const discovered = await discoverTermsUrl(session, chosenWebsite.url);
    if (discovered) {
      termsDiscovery = { url: discovered.url, discovered_from: discovered.discovered_from };
      termsUrl = discovered.url;
      termsChecks = discovered.checks.concat(
        await employerUrlCheck(session, discovered.url, [CURL_USER_AGENT])
      );
    }
  }
  urls.push({ field: "terms_url", url: termsUrl || "", results: termsChecks });

  const resolvedWebsiteUrl = chosenWebsite.url;
  let providerBoardPage: Record<string, unknown> | null = null;
  if (candidate.ats_hint === "smartrecruiters") {
    const boardPageUrl = `https://careers.smartrecruiters.com/${encodeURIComponent(candidate.board_id)}`;
    robots.push(await robotsProbe(
      session, "https://careers.smartrecruiters.com", [`/${encodeURIComponent(candidate.board_id)}`]
    ));
    const pageCheck = await robotsCheckedCheck(session, boardPageUrl, PROBE_USER_AGENT, 20_000);
    urls.push({ field: "provider_board_page", url: boardPageUrl, results: [pageCheck] });
    if (pageCheck.ok) {
      const response = await fetch(boardPageUrl, {
        headers: { "User-Agent": PROBE_USER_AGENT, Accept: "text/html" },
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);
      const html = response?.ok ? await boundedText(response, 1_500_000) : "";
      const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || "";
      const postings = new Set(
        [...html.matchAll(new RegExp(`href="/${candidate.board_id}/(\\d{6,25})`, "gi"))].map((match) => match[1])
      );
      providerBoardPage = {
        url: boardPageUrl,
        http_status: pageCheck.status,
        title,
        posting_links: postings.size,
        provider_markers: ["smartrecruiters"].filter((marker) => /smartrecruiters/i.test(html)),
      };
    } else {
      providerBoardPage = { url: boardPageUrl, http_status: pageCheck.status, error: pageCheck.error || null };
    }
  }
  const identity = identityCheck(candidate, shape.shape, sampleUrls, providerBoardPage);
  const slugIdentity = boardSlugIdentity(candidate);
  const robotsAllowed = robots.every((entry) =>
    entry.gating === false || !entry.allows || entry.allows.every((value) => value.allowed)
  );
  const websiteOk = websiteChecks.every((check) => check.ok);
  const careersOk = careersChecks.every((check) => check.ok);
  const termsOk = Boolean(termsUrl) && termsChecks.every((check) => check.ok);

  let outcome: ProbeReceipt["outcome"] = "confirmed";
  let reason: string | null = null;
  if (canonicalError) {
    outcome = "rejected";
    reason = httpStatus === 404
      ? "no_board_404"
      : httpStatus === 429 || httpStatus === 403
        ? `recorded_not_bypassed_http_${httpStatus}`
        : `board_probe_failed:${canonicalError}`;
  } else if (observed === 0) {
    outcome = "rejected";
    // Distinguish an empty board (the tenant publishes nothing through the
    // documented endpoint) from a board that publishes openings but none the
    // US-eligible filter would import. The raw shape keeps the counts either way.
    const publishedRows = Number((shape.shape as { published_rows?: number }).published_rows ?? 0);
    reason = publishedRows > 0 ? "board_has_no_us_eligible_openings" : "board_has_no_openings";
  } else if (identity.available && !identity.matches) {
    outcome = "rejected";
    reason = `board_identity_mismatch:${identity.source}`;
  } else if (slugIdentity.available && slugIdentity.matches === false) {
    outcome = "rejected";
    reason = "board_slug_unrelated_to_employer";
  } else if (!robotsAllowed) {
    outcome = "rejected";
    reason = "robots_disallowed";
  } else if (!websiteOk) {
    outcome = "rejected";
    reason = "employer_website_unresponsive";
  } else if (!careersOk) {
    outcome = "rejected";
    reason = "board_url_unresponsive";
  } else if (!termsOk) {
    outcome = "rejected";
    reason = "terms_url_unverified";
  }

  const receipt: ProbeReceipt = {
    id: candidate.id,
    provider_hint: candidate.ats_hint,
    board_id: candidate.board_id,
    board_url: candidate.careers_url,
    employer: {
      name: candidate.name,
      domain: candidate.domain,
      website_url: resolvedWebsiteUrl,
      sector: candidate.sector,
      sector_source: candidate.sector_source,
    },
    resolved_website_url: resolvedWebsiteUrl,
    provenance: candidate.provenance,
    wikidata: candidate.wikidata || null,
    probe: {
      endpoint: shape.endpoint,
      raw_shape: shape.shape,
      provider_board_page: providerBoardPage,
      canonical: {
        complete_payload: !canonicalError,
        observed_us_eligible_jobs: observed,
        sample_titles: sampleTitles,
        error: canonicalError,
        http_status: httpStatus,
      },
      identity,
      slug_identity: slugIdentity,
    },
    robots,
    pacing: {
      provider: candidate.ats_hint,
      policy: PACING_POLICY[candidate.ats_hint] || "probes keep at least 300 ms between request starts",
      min_interval_ms: PACING_MS[candidate.ats_hint] ?? 300,
    },
    urls,
    outcome,
    reason,
    checked_at: nowIso(),
    user_agent: PROBE_USER_AGENT,
    attestation: ATTESTATION,
  };
  if (termsDiscovery) (receipt as ProbeReceipt & { terms_discovery?: unknown }).terms_discovery = termsDiscovery;
  await writeJson(file, receipt);
  return receipt;
}

// ---------------------------------------------------------------------------
// enumeration + staged registration
// ---------------------------------------------------------------------------

const ENUMERATION_ROOTS = [
  { id: "company-class-walk", qid: "Q783794", label: "company (WikiProject Companies root class)" },
  { id: "business-class-walk", qid: "Q4830453", label: "business / enterprise" },
];

const enumerationQuery = (qid: string, limit: number, offset: number) => `SELECT ?entity ?website WHERE {
  ?entity wdt:P31 ?class .
  ?class wdt:P279* wd:${qid} .
  OPTIONAL { ?entity wdt:P856 ?website }
} LIMIT ${limit} OFFSET ${offset}`;

const entityMetadataQuery = (qids: string[]) => `SELECT ?entity ?entityLabel ?classLabel ?industryLabel WHERE {
  VALUES ?entity { ${qids.map((qid) => `wd:${qid}`).join(" ")} }
  OPTIONAL { ?entity wdt:P31 ?class }
  OPTIONAL { ?entity wdt:P452 ?industry }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 6000`;

/**
 * Entities Wikidata files under broad organization classes that are not
 * employers: administrative territories, governments and other public bodies.
 * They are counted as exclusions, never silently dropped.
 */
const NON_EMPLOYER_CLASS = new RegExp([
  "administrative territorial entity", "human settlement", "municipality", "city",
  "town", "village", "district", "county", "province", "region of", "sovereign state",
  "country", "dependent territory", "government", "ministry", "public authority",
  "administrative division", "electoral", "military unit", "political party",
  "diocese", "parish", "school district", "public university", "intergovernmental",
  "supranational", "statutory corporation", "tribunal", "court", "legislature",
  "police force", "fire department", "public hospital", "sports league",
  "national team", "air force", "navy", "army", "regiment", "unincorporated area",
  "census-designated place", "borough", "canton of", "federal subject", "constituency",
  "public company limited by guarantee", "nonprofit organization", "foundation",
  "charitable organization", "regulatory college", "professional association",
  "trade association", "industry trade group", "learned society", "chamber of commerce",
  "trade union", "labor union", "religious organization", "voluntary association",
  "business association", "employers' organization", "umbrella organization",
].map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");

type EnumerationPage = {
  root: string; qid: string; offset: number; limit: number;
  rows: number; distinct_entities: number; with_website: number; ms: number;
};

type StagedCandidate = {
  qid: string;
  entity: string;
  name: string;
  website: string;
  domain: string;
  sector: string;
  classes: string[];
};

type StagedAccounting = {
  entities_enumerated: number;
  without_website: number;
  non_https_or_unregistrable: number;
  entity_label_unavailable: number;
  non_employer_entity: number;
  duplicate_domain: number;
  poc_domain_already_registered: number;
  website_unresponsive_or_blocked: number;
  robots_disallowed: number;
  unchecked_after_target: number;
};

const EMPTY_ACCOUNTING: StagedAccounting = {
  entities_enumerated: 0,
  without_website: 0,
  non_https_or_unregistrable: 0,
  entity_label_unavailable: 0,
  non_employer_entity: 0,
  duplicate_domain: 0,
  poc_domain_already_registered: 0,
  website_unresponsive_or_blocked: 0,
  robots_disallowed: 0,
  unchecked_after_target: 0,
};

async function enumerate(): Promise<{
  pages: EnumerationPage[];
  entities: Map<string, string[]>;
  errors: string[];
}> {
  const cacheFile = path.join(CACHE_DIR, "enumeration.json");
  const reuse = flag["no-reuse-enumeration"] !== true;
  if (reuse) {
    const cached = await readJson<{
      generated_at: string;
      pages: EnumerationPage[];
      entities: Record<string, string[]>;
      errors: string[];
      page_size: number;
      page_count: number;
    } | null>(cacheFile, null);
    const pageSize = unit(flag["enumeration-page-size"], 1_000);
    const pageCount = unit(flag["enumeration-pages"], 3);
    if (
      cached && cached.page_size === pageSize && cached.page_count === pageCount &&
      Date.now() - Date.parse(cached.generated_at) < 12 * 60 * 60 * 1_000
    ) {
      console.log(`enumeration: reusing cached sample (${cached.generated_at})`);
      return {
        pages: cached.pages,
        entities: new Map(Object.entries(cached.entities)),
        errors: cached.errors,
      };
    }
  }
  const pages: EnumerationPage[] = [];
  const entities = new Map<string, string[]>();
  const errors: string[] = [];
  const pageSize = unit(flag["enumeration-page-size"], 1_000);
  const pageCount = unit(flag["enumeration-pages"], 3);
  for (const root of ENUMERATION_ROOTS) {
    for (let page = 0; page < pageCount; page += 1) {
      const offset = page * pageSize;
      const started = Date.now();
      try {
        const rows = await sparql(
          enumerationQuery(root.qid, pageSize, offset),
          `${root.id} offset=${offset}`
        );
        const distinct = new Set<string>();
        let withWebsite = 0;
        for (const row of rows) {
          const qid = entityId(row.entity?.value);
          if (!qid) continue;
          distinct.add(qid);
          const website = row.website?.value;
          const current = entities.get(qid) || [];
          if (website && !current.includes(website)) current.push(website);
          if (website) withWebsite += 1;
          entities.set(qid, current);
        }
        pages.push({
          root: root.id, qid: root.qid, offset, limit: pageSize,
          rows: rows.length, distinct_entities: distinct.size,
          with_website: withWebsite, ms: Date.now() - started,
        });
      } catch (error) {
        errors.push(`${root.id}@${offset}: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`);
      }
      await sleep(500);
    }
  }
  await writeJson(cacheFile, {
    generated_at: nowIso(),
    page_size: pageSize,
    page_count: pageCount,
    pages,
    entities: Object.fromEntries(entities),
    errors,
  });
  return { pages, entities, errors };
}

/**
 * Every enumerated entity that does not become a manifest row is recorded here
 * with its Wikidata id and the reason, so the exclusions are auditable instead
 * of only being counted. `stage` says whether the entity was excluded while
 * building the pool ("collect") or by the liveness check ("liveness").
 */
type RegistrationRejection = {
  qid: string | null;
  entity: string | null;
  domain: string | null;
  website: string | null;
  stage: "collect" | "liveness" | "not_checked";
  reason: string;
};

/** Applies metadata + exclusions, yielding the deterministic staged pool. */
async function collectStaged(
  entities: Map<string, string[]>,
  pocDomains: Set<string>
): Promise<{
  accounting: StagedAccounting;
  staged: StagedCandidate[];
  rejections: RegistrationRejection[];
  pages: Array<{ chunk: string; rows: number }>;
}> {
  const accounting: StagedAccounting = {
    ...EMPTY_ACCOUNTING,
    entities_enumerated: entities.size,
  };
  const rejections: RegistrationRejection[] = [];
  const withWebsite: Array<{ qid: string; websites: string[]; domain: string }> = [];
  for (const [qid, rawWebsites] of entities) {
    if (!rawWebsites.length) {
      accounting.without_website += 1;
      rejections.push({
        qid, entity: entityUrl(qid), domain: null, website: null, stage: "collect",
        reason: "unregisterable:no_P856_website",
      });
      continue;
    }
    const candidates = canonicalWebsiteCandidates(rawWebsites);
    const domain = candidates.length ? registrableDomain(candidates[0]) : "";
    if (!candidates.length || !domain) {
      accounting.non_https_or_unregistrable += 1;
      rejections.push({
        qid, entity: entityUrl(qid), domain: null, website: rawWebsites[0] || null, stage: "collect",
        reason: "unregisterable:no_https_registrable_domain",
      });
      continue;
    }
    withWebsite.push({ qid, websites: candidates, domain });
  }
  withWebsite.sort((left, right) => left.qid.localeCompare(right.qid));

  const metadata = new Map<string, { name: string; classes: string[]; industries: string[] }>();
  const chunkSize = 200;
  const pages: Array<{ chunk: string; rows: number }> = [];
  for (let index = 0; index < withWebsite.length; index += chunkSize) {
    const chunk = withWebsite.slice(index, index + chunkSize).map((entry) => entry.qid);
    try {
      const rows = await sparql(
        entityMetadataQuery(chunk),
        `entity-metadata ${index}-${index + chunk.length}`
      );
      pages.push({ chunk: `${index}-${index + chunk.length}`, rows: rows.length });
      for (const row of rows) {
        const qid = entityId(row.entity?.value);
        if (!qid) continue;
        const current = metadata.get(qid) || { name: "", classes: [], industries: [] };
        if (!current.name && row.entityLabel?.value) current.name = row.entityLabel.value;
        const classLabel = row.classLabel?.value;
        if (classLabel && !current.classes.includes(classLabel)) current.classes.push(classLabel);
        const industryLabel = row.industryLabel?.value;
        if (industryLabel && !current.industries.includes(industryLabel)) current.industries.push(industryLabel);
        metadata.set(qid, current);
      }
    } catch (error) {
      console.log(`  entity metadata chunk failed (${index}): ${String(error).slice(0, 140)}`);
      pages.push({ chunk: `${index}-${index + chunk.length}`, rows: -1 });
    }
    await sleep(400);
  }

  const staged: StagedCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of withWebsite) {
    if (pocDomains.has(entry.domain)) {
      accounting.poc_domain_already_registered += 1;
      rejections.push({
        qid: entry.qid, entity: entityUrl(entry.qid), domain: entry.domain,
        website: entry.websites[0] || null, stage: "collect",
        reason: "already_a_poc_row",
      });
      continue;
    }
    if (seen.has(entry.domain)) {
      accounting.duplicate_domain += 1;
      rejections.push({
        qid: entry.qid, entity: entityUrl(entry.qid), domain: entry.domain,
        website: entry.websites[0] || null, stage: "collect",
        reason: "duplicate_domain",
      });
      continue;
    }
    const meta = metadata.get(entry.qid);
    // The Wikidata label service falls back to the entity id when no label
    // exists in the requested language; such rows would carry "Q1234" as the
    // employer name, so they are counted as label-unavailable instead.
    if (!meta || !meta.name || /^Q\d+$/i.test(meta.name.trim())) {
      accounting.entity_label_unavailable += 1;
      rejections.push({
        qid: entry.qid, entity: entityUrl(entry.qid), domain: entry.domain,
        website: entry.websites[0] || null, stage: "collect",
        reason: "entity_label_unavailable",
      });
      continue;
    }
    if (meta.classes.some((value) => NON_EMPLOYER_CLASS.test(value))) {
      accounting.non_employer_entity += 1;
      rejections.push({
        qid: entry.qid, entity: entityUrl(entry.qid), domain: entry.domain,
        website: entry.websites[0] || null, stage: "collect",
        reason: `non_employer_entity:${meta.classes.join("/")}`.slice(0, 120),
      });
      continue;
    }
    seen.add(entry.domain);
    staged.push({
      qid: entry.qid,
      entity: entityUrl(entry.qid),
      name: meta.name,
      website: entry.websites[0],
      domain: entry.domain,
      sector: meta.industries[0] || meta.classes[0] || "Unspecified",
      classes: meta.classes,
    });
  }
  return { accounting, staged, rejections, pages };
}

const livenessCacheKey = (url: string) => `${url}|${PROBE_USER_AGENT},${CURL_USER_AGENT}`;

async function registerStaged(
  session: PublicWebSession,
  cache: Map<string, UrlCheck[]>,
  staged: StagedCandidate[],
  accounting: StagedAccounting,
  rejections: RegistrationRejection[],
  cacheFile: string
) {
  const target = unit(flag["staged-target"], 960);
  const pool = unit(flag["liveness-concurrency"], 6);
  const batchSize = unit(flag["liveness-batch"], 60);
  const registered: Array<StagedCandidate & { checks: UrlCheck[] }> = [];
  let index = 0;
  while (index < staged.length && registered.length < target) {
    const batch = staged.slice(index, index + batchSize);
    const results = await mapPool(batch, pool, async (candidate) => {
      const key = livenessCacheKey(candidate.website);
      const cached = cache.get(key);
      if (cached) return cached;
      const checks = await employerUrlCheck(session, candidate.website, [PROBE_USER_AGENT, CURL_USER_AGENT]);
      cache.set(key, checks);
      return checks;
    });
    for (let offset = 0; offset < batch.length; offset += 1) {
      if (registered.length >= target) {
        accounting.unchecked_after_target += staged.length - (index + offset);
        for (const leftover of staged.slice(index + offset)) {
          rejections.push({
            qid: leftover.qid, entity: leftover.entity, domain: leftover.domain,
            website: leftover.website, stage: "not_checked",
            reason: "unchecked_after_target",
          });
        }
        break;
      }
      const candidate = batch[offset];
      const checks = results[offset];
      if (checks.some((check) => check.error?.includes("robots_policy_disallows"))) {
        accounting.robots_disallowed += 1;
        rejections.push({
          qid: candidate.qid, entity: candidate.entity, domain: candidate.domain,
          website: candidate.website, stage: "liveness", reason: "robots_disallowed",
        });
        continue;
      }
      if (checks.every((check) => check.ok)) {
        registered.push({ ...candidate, checks });
      } else {
        accounting.website_unresponsive_or_blocked += 1;
        rejections.push({
          qid: candidate.qid, entity: candidate.entity, domain: candidate.domain,
          website: candidate.website, stage: "liveness",
          reason: `http_${checks.map((check) => check.status || check.error || "error").join("|")}`.slice(0, 120),
        });
      }
    }
    index += batch.length;
    console.log(
      `  liveness: ${Math.min(index, staged.length)}/${staged.length} checked, ` +
        `${registered.length}/${target} registered, cache=${cache.size}`
    );
    await writeJson(cacheFile, Object.fromEntries(cache));
  }
  return registered;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

async function build() {
  await mkdir(PROBE_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });
  const session = new PublicWebSession(fetch, PROBE_USER_AGENT);
  const livenessCache = new Map<string, UrlCheck[]>(
    Object.entries(await readJson<Record<string, UrlCheck[]>>(path.join(CACHE_DIR, "website-liveness.json"), {}))
  );
  const candidatesFile = await readJson<CandidateFile>(
    path.resolve(ROOT, String(flag.candidates || COHORT_CANDIDATES_PATH)),
    { cohort: COHORT_KEY, generatedAt: "", method: [], sources: [], candidates: [] }
  );
  if (!candidatesFile.candidates.length) {
    throw new Error("No POC candidates found; run --mode=collect-candidates first.");
  }

  const reuseProbes = flag["no-reuse-probes"] !== true;
  const receipts: ProbeReceipt[] = [];
  const pocRows: CohortManifestRow[] = [];
  const probeLimit = unit(flag["probe-limit"], candidatesFile.candidates.length);
  let probed = 0;
  for (const candidate of candidatesFile.candidates) {
    if (probed >= probeLimit) break;
    probed += 1;
    const receipt = await probeCandidate(candidate, session, reuseProbes);
    receipts.push(receipt);
    if (receipt.outcome !== "confirmed") {
      console.log(`  ${receipt.outcome}: ${candidate.id} (${receipt.reason})`);
      continue;
    }
    const row: CohortManifestRow = {
      name: candidate.name,
      website_url: receipt.resolved_website_url || candidate.website_url,
      domain: candidate.domain,
      sector: candidate.sector || "Unspecified",
      ats_hint: candidate.ats_hint,
      careers_url: candidate.careers_url,
      access_mode: "public_page",
      terms_url: String(receipt.urls.find((entry) => entry.field === "terms_url")?.url || ""),
      evidence_url: candidate.careers_url,
      notes: cohortPocNotes(missionRelative(probePath(candidate))),
    };
    const validation = validateCohortManifestRow(row);
    if (!validation.ok) {
      console.log(`  ${candidate.id} rejected at row validation: ${validation.reason}`);
      await writeJson(probePath(candidate), { ...receipt, outcome: "rejected", reason: `row_validation:${validation.reason}` });
      continue;
    }
    pocRows.push(validation.row);
  }

  console.log("enumeration: broad Wikidata class walk (company + business roots)");
  const enumeration = await enumerate();
  const pocDomains = new Set(pocRows.map((row) => row.domain));
  const stagedCollection = await collectStaged(enumeration.entities, pocDomains);
  const accounting = stagedCollection.accounting;
  const registered = await registerStaged(
    session, livenessCache, stagedCollection.staged, accounting, stagedCollection.rejections,
    path.join(CACHE_DIR, "website-liveness.json")
  );

  const enumerationReceiptPath = String(flag.receipt || COHORT_ENUMERATION_RECEIPT_PATH);
  const stagedRows: CohortManifestRow[] = [];
  for (const entry of registered) {
    const validation = validateCohortManifestRow({
      name: entry.name,
      website_url: entry.website,
      domain: entry.domain,
      sector: entry.sector,
      ats_hint: "unknown",
      careers_url: null,
      access_mode: "awaiting_permission",
      terms_url: WIKIDATA_TERMS_URL,
      evidence_url: entry.entity,
      notes: cohortStagedNotes(enumerationReceiptPath),
    });
    if (!validation.ok) continue;
    stagedRows.push(validation.row);
  }

  const pocSorted = pocRows.sort((left, right) =>
    `${left.ats_hint}:${left.domain}`.localeCompare(`${right.ats_hint}:${right.domain}`)
  );
  const stagedSorted = stagedRows.sort((left, right) => left.domain.localeCompare(right.domain));
  const rows = [...pocSorted, ...stagedSorted];
  const summary = summarizeCohortManifest(rows);
  const failures = cohortCompositionFailures(summary);

  const accounted =
    accounting.without_website +
    accounting.non_https_or_unregistrable +
    accounting.entity_label_unavailable +
    accounting.non_employer_entity +
    accounting.duplicate_domain +
    accounting.poc_domain_already_registered +
    accounting.website_unresponsive_or_blocked +
    accounting.robots_disallowed +
    accounting.unchecked_after_target +
    stagedRows.length;

  await writeJson(path.join(CACHE_DIR, "website-liveness.json"), Object.fromEntries(livenessCache));
  await writeJson(path.join(COHORT_EVIDENCE, "staged-website-liveness.json"), {
    checked_at: nowIso(),
    user_agents: [PROBE_USER_AGENT, CURL_USER_AGENT],
    note: "Every registered staged row answered 2xx for both clients at build time through lib/public-web.ts (robots.txt fetched first). Candidates the liveness check rejected are listed separately and never dropped silently.",
    registered: registered.map((entry) => ({
      domain: entry.domain,
      website_url: entry.website,
      results: entry.checks.map((check) => ({ user_agent: check.user_agent, status: check.status })),
    })),
    rejected: stagedCollection.rejections.filter((entry) => entry.stage === "liveness"),
  });

  // The full exclusion ledger: every enumerated entity that did not become a row,
  // with its Wikidata id, domain (when known) and the exact reason.
  const rejectionCounts: Record<string, number> = {};
  for (const entry of stagedCollection.rejections) {
    const category = entry.stage === "liveness" ? `liveness:${entry.reason.split(":")[0]}` : entry.reason.split(":")[0];
    rejectionCounts[category] = (rejectionCounts[category] || 0) + 1;
  }
  const rejectionLedgerPath = "evidence/cohorts/staged-registration-rejections.json";
  await writeJson(path.join(COHORT_EVIDENCE, "staged-registration-rejections.json"), {
    cohort: COHORT_KEY,
    generated_at: nowIso(),
    note: "Every enumerated entity that does not appear as a manifest row appears here exactly once with its Wikidata entity URL and the reason, so the exclusions are auditable rather than counted only. Candidates left over after the staged target was reached are listed with stage=not_checked.",
    counts_by_stage_and_category: rejectionCounts,
    total: stagedCollection.rejections.length,
    reconciliation: {
      ledger_entries: stagedCollection.rejections.length,
      manifest_rows: stagedRows.length,
      entities_enumerated: accounting.entities_enumerated,
      equation: "ledger_entries + manifest_rows = entities_enumerated",
      balanced: stagedCollection.rejections.length + stagedRows.length === accounting.entities_enumerated,
    },
    rejections: stagedCollection.rejections,
  });

  const manifestPath = String(flag.emit || COHORT_MANIFEST_PATH);
  const manifestText = cohortManifestText(rows);
  await writeText(path.resolve(ROOT, manifestPath), manifestText);
  const manifestDigest = sha256(manifestText);

  const receipt = {
    cohort: COHORT_KEY,
    human_label: COHORT_HUMAN_LABEL,
    generated_at: nowIso(),
    method: [
      "Wikidata SPARQL subclass walk (wdt:P31/wdt:P279* over the company and business root classes) — no startup-only class, no US-HQ filter, no required P856 website triple, no industry requirement.",
      "Enumeration is a bounded sample: fixed LIMIT/OFFSET pages are requested and every page's row/entity counts are recorded below, so the numbers are reproducible rather than a census claim.",
      "Entities without a registrable HTTPS website are counted as excluded-unregisterable; they are never silently dropped.",
      "Entities whose Wikidata class labels identify a non-employer body (territories, governments, courts, associations, foundations and similar) are counted as excluded and listed with their entity URLs in the rejection ledger.",
      "Every enumerated entity that is not a manifest row appears in the rejection ledger with its Wikidata id and reason — the counts below are summarized from that ledger.",
      "Staged rows were liveness-checked before registration: robots.txt fetched first, then the employer site had to answer 2xx for both a descriptive client and the default curl client.",
      "POC rows are curated employers whose board was confirmed by a read-only probe, including the board surface's own employer identity fields where the provider publishes them.",
    ],
    source: {
      endpoint: WIKIDATA_ENDPOINT,
      terms_url: WIKIDATA_TERMS_URL,
      license: "Wikidata structured data is CC0; linked company websites retain their own rights.",
      user_agent: ENUMERATION_USER_AGENT,
      roots: ENUMERATION_ROOTS,
      queries: ENUMERATION_ROOTS.map((root) => ({
        id: root.id,
        qid: root.qid,
        label: root.label,
        query: enumerationQuery(root.qid, unit(flag["enumeration-page-size"], 1_000), 0),
      })),
      pages: enumeration.pages,
      metadata_pages: stagedCollection.pages,
      errors: enumeration.errors,
    },
    accounting: {
      entities_enumerated: enumeration.entities.size,
      staged_registered: stagedRows.length,
      excluded: {
        unregisterable_no_website: accounting.without_website,
        unregisterable_no_https_registrable_domain: accounting.non_https_or_unregistrable,
        entity_label_unavailable: accounting.entity_label_unavailable,
        non_employer_entity: accounting.non_employer_entity,
        duplicate_domain: accounting.duplicate_domain,
        already_registered_poc_domain: accounting.poc_domain_already_registered,
        website_unresponsive_or_blocked: accounting.website_unresponsive_or_blocked,
        robots_disallowed: accounting.robots_disallowed,
      },
      unchecked_after_target: accounting.unchecked_after_target,
      staged_pool_size: stagedCollection.staged.length + accounting.website_unresponsive_or_blocked +
        accounting.robots_disallowed + accounting.unchecked_after_target,
      reconciled: accounted === enumeration.entities.size,
      reconciliation_equation:
        "excluded + unchecked_after_target + staged_registered = entities_enumerated",
      rejection_ledger: {
        path: rejectionLedgerPath,
        entries: stagedCollection.rejections.length,
        counts_by_stage_and_category: rejectionCounts,
      },
      rejected_examples: stagedCollection.rejections.slice(0, 25),
    },
    poc: {
      candidates: candidatesFile.candidates.length,
      probed,
      confirmed: receipts.filter((entry) => entry.outcome === "confirmed").length,
      rejected: receipts
        .filter((entry) => entry.outcome !== "confirmed")
        .map((entry) => ({ id: entry.id, provider: entry.provider_hint, reason: entry.reason })),
      families: summary.families,
      missing_families: summary.missingFamilies,
      receipt_dir: missionRelative(PROBE_DIR),
    },
    manifest: {
      path: manifestPath,
      rows: rows.length,
      sha256: manifestDigest,
      composition: summary,
      floors: COHORT_FLOORS,
      failures,
    },
  };
  await writeJson(missionPath(enumerationReceiptPath), receipt);

  const importReceiptPath = String(flag["import-receipt"] || COHORT_IMPORT_RECEIPT_PATH);
  const existing = await readJson<Record<string, unknown>>(missionPath(importReceiptPath), {});
  await writeJson(missionPath(importReceiptPath), {
    cohort: COHORT_KEY,
    human_label: COHORT_HUMAN_LABEL,
    file: importReceiptPath,
    generated_at: nowIso(),
    manifest: {
      path: manifestPath,
      rows: rows.length,
      sha256: manifestDigest,
      access_mode_counts: summary.byAccessMode,
      poc_rows: summary.pocRows,
      staged_rows: summary.stagedRows,
      staged_pending_rows: summary.stagedPendingRows,
      staged_pending_share: Number(summary.stagedPendingShare.toFixed(4)),
      families: summary.families,
      composition_failures: failures,
    },
    import: (existing.import as Record<string, unknown> | undefined) || {
      status: "pending",
      note: "Filled by the cohort-import-and-gating feature: POST batches to /api/internal/discovery/domains (cohort key general-v1) and reconcile startup_domain_imports expected/persisted against this manifest.",
      endpoint: "/api/internal/discovery/domains",
      cohort_key: COHORT_KEY,
    },
  });

  console.log(JSON.stringify({
    manifest: manifestPath,
    rows: rows.length,
    sha256: manifestDigest,
    access_mode: summary.byAccessMode,
    poc_rows: summary.pocRows,
    staged_rows: summary.stagedRows,
    staged_pending_share: Number(summary.stagedPendingShare.toFixed(4)),
    families: summary.families.map((family) => `${family.family}:${family.pocRows}`),
    missing_families: summary.missingFamilies,
    enumeration: receipt.accounting,
    failures,
  }, null, 2));
  if (failures.length) console.warn(`composition floors not met: ${failures.join(", ")}`);
}

// ---------------------------------------------------------------------------
// url-sanity
// ---------------------------------------------------------------------------

/** Deterministic sample: identical for identical manifest bytes. */
function seededSample<T>(values: T[], size: number, seed: string) {
  if (values.length <= size) return [...values];
  return values
    .map((value, index) => ({ value, rank: sha256(`${seed}:${index}:${JSON.stringify(value)}`) }))
    .sort((left, right) => left.rank.localeCompare(right.rank))
    .slice(0, size)
    .map((entry) => entry.value);
}

async function urlSanity() {
  const manifestPath = path.resolve(ROOT, String(flag.emit || COHORT_MANIFEST_PATH));
  const text = await readFile(manifestPath, "utf8");
  const { rows, issues } = parseCohortManifest(text);
  const sampleSize = unit(flag.sample, 24);
  // The budget is generous because the point is "does this URL still answer",
  // not speed; verification traffic is paced (400 ms between checks).
  const sanityTimeout = unit(flag["check-timeout-ms"], 15_000);
  const session = new PublicWebSession(fetch, PROBE_USER_AGENT);
  const failures: string[] = [];
  const lines: string[] = [
    `# URL sanity — ${COHORT_HUMAN_LABEL} manifest`,
    `checked_at: ${nowIso()}`,
    `manifest: ${path.relative(ROOT, manifestPath)} (${rows.length} rows, ${issues.length} parse issues)`,
    `user_agents: ${PROBE_USER_AGENT} | ${CURL_USER_AGENT} (redirects followed, bounded to 5 hops; robots.txt fetched first; ${sanityTimeout / 1000} s timeout per request; 400 ms between checks)`,
    "",
  ];
  failures.push(...issues.map((issue) => `line ${issue.line}: ${issue.reason}`));

  const pocRows = rows.filter((row) => row.access_mode === "public_page");
  const stagedRows = rows.filter((row) => row.access_mode !== "public_page");
  const stagedSample = seededSample(stagedRows, sampleSize, sha256(text));
  const check = async (url: string) => {
    const results = await employerUrlCheck(session, url, [PROBE_USER_AGENT, CURL_USER_AGENT], sanityTimeout);
    await sleep(400);
    return results;
  };
  lines.push(`## POC rows (${pocRows.length}) — every URL checked`);
  for (const row of pocRows) {
    for (const [field, url] of [
      ["website_url", row.website_url],
      ["careers_url", row.careers_url],
      ["terms_url", row.terms_url],
      ["evidence_url", row.evidence_url],
    ] as Array<[string, string | null]>) {
      if (!url) continue;
      const results = await check(url);
      const ok = results.every((entry) => entry.ok);
      if (!ok) {
        failures.push(`${row.name} ${field}=${url} → ${results.map((check) => `${check.user_agent}:${check.status || check.error}`).join(", ")}`);
      }
      lines.push(`${ok ? "OK  " : "FAIL"} ${row.name} ${field} ${url} [${results.map((check) => check.status || check.error).join("/")}]`);
    }
  }
  lines.push("", `## Staged sample (${stagedSample.length} of ${stagedRows.length}; deterministic seeded sample)`);
  for (const row of stagedSample) {
    for (const [field, url] of [
      ["website_url", row.website_url],
      ["terms_url", row.terms_url],
      ["evidence_url", row.evidence_url],
    ] as Array<[string, string | null]>) {
      if (!url) continue;
      const results = await check(url);
      const ok = results.every((entry) => entry.ok);
      if (!ok) {
        failures.push(`${row.domain} ${field}=${url} → ${results.map((check) => `${check.user_agent}:${check.status || check.error}`).join(", ")}`);
      }
      lines.push(`${ok ? "OK  " : "FAIL"} ${row.domain} ${field} ${url} [${results.map((check) => check.status || check.error).join("/")}]`);
    }
  }
  lines.push("", `## Result: ${failures.length ? `${failures.length} failure(s) reported, none dropped` : "all checked URLs answered 2xx"}`);
  for (const failure of failures) lines.push(`FAILURE ${failure}`);
  const destination = missionPath(String(flag.out || "evidence/cohorts/url-sanity.txt"));
  await writeText(destination, `${lines.join("\n")}\n`);
  console.log(lines.slice(-6).join("\n"));
  console.log(`url-sanity report: ${destination}`);
  if (failures.length) process.exitCode = 1;
}

// ---------------------------------------------------------------------------

const mode = String(flag.mode || "build");
if (mode === "collect-candidates") {
  await collectCandidates();
} else if (mode === "build") {
  await build();
  console.log("build complete");
} else if (mode === "url-sanity") {
  await urlSanity();
} else {
  throw new Error(`Unknown --mode=${mode}`);
}
