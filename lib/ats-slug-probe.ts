import { canonicalEndpoint, isCompleteProviderPayload } from "./ats-adapters";
import type { AtsProvider } from "./source-registry";

export const ATS_SLUG_PROBE_VERSION = "1.0";

const PROBE_USER_AGENT = "OH-SHI/1.0 ats-slug-probe (https://ohshi.work/about)";

/**
 * Providers whose public board endpoint is keyed by a company-chosen slug that
 * is usually the company's own name. Ordered by how commonly startups use them
 * so the first hit is also the most likely to be right.
 */
const PROBED_PROVIDERS: AtsProvider[] = ["greenhouse", "lever", "ashby"];

/**
 * Slugs short or generic enough that a match is more likely to be a different
 * company than the one being probed.
 */
const AMBIGUOUS_SLUG = /^(?:app|api|get|the|inc|team|labs|hq|io|ai|co|dev|web|new|now|one|go|up|my)$/;

export function slugCandidates(domain: string, extraSlugs: string[] = []) {
  const label = domain.split(".")[0].toLowerCase();
  const slugs = new Set<string>();
  for (const value of [...extraSlugs, label]) {
    const normalized = String(value || "").trim().toLowerCase()
      .replace(/[^a-z0-9-]+/g, "");
    if (normalized.length < 3 || AMBIGUOUS_SLUG.test(normalized)) continue;
    slugs.add(normalized);
    // Companies routinely register the hyphenless form of a hyphenated name.
    if (normalized.includes("-")) slugs.add(normalized.replaceAll("-", ""));
  }
  return [...slugs];
}

/**
 * A slug match is circumstantial evidence, so require the board itself to name
 * the company and require that name to correspond to the slug we probed. This
 * is what keeps a collision (a different company owning the same slug) from
 * being activated as if it were the candidate.
 */
export function boardNameMatches(boardName: string, companyName: string, slug: string) {
  const simplify = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const board = simplify(boardName);
  const company = simplify(companyName);
  const target = simplify(slug);
  if (!board) return false;
  if (board === target || board.startsWith(target) || target.startsWith(board)) return true;
  if (!company) return false;
  return board === company || board.startsWith(company) || company.startsWith(board);
}

async function fetchJson(url: string, fetcher: typeof fetch) {
  const response = await fetcher(url, {
    headers: { Accept: "application/json", "User-Agent": PROBE_USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("json")) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Greenhouse publishes the employer's display name on the board resource. */
async function greenhouseBoardName(slug: string, fetcher: typeof fetch) {
  const payload = await fetchJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`,
    fetcher
  );
  const name = (payload as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : "";
}

export type SlugProbeResult = {
  provider: AtsProvider;
  boardId: string;
  careersUrl: string;
  confirmedBy: "board_name" | "board_url";
};

/**
 * Website crawling misses any employer whose careers page is client-rendered or
 * bot-protected. These board APIs are public JSON published for exactly this
 * purpose, so probing them recovers employers the crawl cannot reach.
 */
export async function probeAtsBySlug(
  domain: string,
  companyName: string,
  options: { fetcher?: typeof fetch; extraSlugs?: string[] } = {}
): Promise<SlugProbeResult | null> {
  const fetcher = options.fetcher || fetch;
  for (const slug of slugCandidates(domain, options.extraSlugs)) {
    for (const provider of PROBED_PROVIDERS) {
      const endpoint = canonicalEndpoint(provider, slug);
      if (!endpoint) continue;
      const payload = await fetchJson(endpoint, fetcher);
      if (!payload || !isCompleteProviderPayload(provider, payload)) continue;
      if (provider === "greenhouse") {
        const boardName = await greenhouseBoardName(slug, fetcher);
        if (!boardNameMatches(boardName, companyName, slug)) continue;
        return {
          provider,
          boardId: slug,
          careersUrl: `https://job-boards.greenhouse.io/${slug}`,
          confirmedBy: "board_name",
        };
      }
      // Lever and Ashby do not publish an employer name, so the slug itself is
      // the only identifier; require it to derive from the registrable domain
      // rather than from a directory alias.
      const domainLabel = domain.split(".")[0].toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (slug.replaceAll("-", "") !== domainLabel) continue;
      return {
        provider,
        boardId: slug,
        careersUrl: provider === "lever"
          ? `https://jobs.lever.co/${slug}`
          : `https://jobs.ashbyhq.com/${slug}`,
        confirmedBy: "board_url",
      };
    }
  }
  return null;
}
