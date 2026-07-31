const USER_AGENT = "OH-SHI/1.0 structured-career-verifier";
const MAX_PUBLIC_DOCUMENT_BYTES = 2_000_000;

function directivesFor(robots: string, userAgent: string) {
  const groups: Array<{ agents: string[]; directives: string[] }> = [];
  let current: { agents: string[]; directives: string[] } | null = null;
  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.replace(/\s*#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || current.directives.length) {
        current = { agents: [], directives: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (field === "allow" || field === "disallow")) {
      current.directives.push(`${field}:${value}`);
    }
  }
  const normalizedAgent = userAgent.toLowerCase();
  const exact = groups.filter((group) =>
    group.agents.some((agent) => agent !== "*" && normalizedAgent.includes(agent))
  );
  return exact.length ? exact : groups.filter((group) => group.agents.includes("*"));
}

function pathMatches(rule: string, path: string) {
  if (!rule) return false;
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  const escaped = body
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`).test(path);
}

export function robotsAllows(robots: string, path: string, userAgent = USER_AGENT) {
  let winner: { allowed: boolean; length: number } | null = null;
  for (const group of directivesFor(robots, userAgent)) {
    for (const directive of group.directives) {
      const separator = directive.indexOf(":");
      const field = directive.slice(0, separator);
      const rule = directive.slice(separator + 1);
      if (!pathMatches(rule, path)) continue;
      const candidate = { allowed: field === "allow", length: rule.length };
      if (
        !winner ||
        candidate.length > winner.length ||
        (candidate.length === winner.length && candidate.allowed)
      ) winner = candidate;
    }
  }
  return winner?.allowed ?? true;
}

export function linksFromHtml(html: string, baseUrl: string) {
  const links = new Set<string>();
  for (const match of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const url = new URL(match[1], baseUrl);
      if (url.protocol === "https:") links.add(url.href);
    } catch {
      // Invalid links are not candidates.
    }
  }
  return [...links];
}

export function sitemapUrlsFromRobots(robots: string) {
  return [...robots.matchAll(/^\s*sitemap\s*:\s*(https:\/\/\S+)/gim)]
    .map((match) => match[1]);
}

export function urlsFromSitemap(xml: string) {
  return [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
    .flatMap((match) => {
      const value = match[1].replace(/&amp;/g, "&").trim();
      try {
        const url = new URL(value);
        return url.protocol === "https:" ? [url.href] : [];
      } catch {
        return [];
      }
    });
}

export async function boundedText(
  response: Response,
  maxBytes = MAX_PUBLIC_DOCUMENT_BYTES
) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("public_document_too_large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("public_document_too_large");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

export class PublicWebSession {
  private robots = new Map<string, string>();

  constructor(
    private fetcher: typeof fetch = fetch,
    private userAgent = USER_AGENT
  ) {}

  async robotsFor(origin: string) {
    const root = new URL(origin).origin;
    const cached = this.robots.get(root);
    if (cached !== undefined) return cached;
    let current = new URL("/robots.txt", root);
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const response = await this.fetcher(current, {
        redirect: "manual",
        headers: { "User-Agent": this.userAgent },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("robots_redirect_missing_location");
        const next = new URL(location, current);
        if (next.protocol !== "https:") throw new Error("robots_redirect_not_https");
        current = next;
        continue;
      }
      const value = response.ok ? await boundedText(response, 250_000) : "";
      this.robots.set(root, value);
      return value;
    }
    throw new Error("robots_redirect_limit_exceeded");
  }

  async sitemapUrls(origin: string) {
    const robots = await this.robotsFor(origin);
    const explicit = sitemapUrlsFromRobots(robots);
    return explicit.length ? explicit : [new URL("/sitemap.xml", origin).href];
  }

  async fetch(url: string, maxRedirects = 5): Promise<Response> {
    let current = new URL(url);
    if (current.protocol !== "https:") throw new Error("public_web_requires_https");
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      const robots = await this.robotsFor(current.origin);
      const robotsPath = `${current.pathname}${current.search}`;
      if (!robotsAllows(robots, robotsPath, this.userAgent)) {
        throw new Error("robots_policy_disallows_discovery");
      }
      const response = await this.fetcher(current, {
        redirect: "manual",
        headers: { "User-Agent": this.userAgent },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("discovery_redirect_missing_location");
        const next = new URL(location, current);
        if (next.protocol !== "https:") throw new Error("discovery_redirect_not_https");
        current = next;
        continue;
      }
      return response;
    }
    throw new Error("discovery_redirect_limit_exceeded");
  }
}

export async function permittedFetch(url: string, fetcher: typeof fetch) {
  const response = await new PublicWebSession(fetcher).fetch(url);
  if (!response.ok) throw new Error(`discovery_source_http_${response.status}`);
  return response;
}
