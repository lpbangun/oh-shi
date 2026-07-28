import { classifyRole, isUsEligible, summarizeCanonicalJob } from "./job-normalization";
import type { AtsProvider } from "./source-registry";

export type NormalizedJob = {
  externalId: string;
  title: string;
  roleFamily: string;
  location: string;
  remoteStatus: string;
  employmentType: string;
  compensation: string;
  canonicalUrl: string;
  publishedAt: string | null;
  summary: string;
};

export type CanonicalFetch = {
  complete: true;
  jobs: NormalizedJob[];
};

export type AtsDetection = {
  provider: Exclude<AtsProvider, "manual">;
  boardId: string;
  careersUrl: string;
};

type JsonRecord = Record<string, unknown>;

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): JsonRecord => value && typeof value === "object" ? value as JsonRecord : {};
const array = (value: unknown) => Array.isArray(value) ? value : [];
const iso = (value: unknown) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
};
const plain = (value: unknown) => text(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

export function detectAtsFromLinks(links: string[]): AtsDetection | null {
  for (const link of links) {
    let url: URL;
    try { url = new URL(link); } catch { continue; }
    const segments = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "jobs.ashbyhq.com" && segments[0]) {
      const boardId = decodeURIComponent(segments[0]);
      return {
        provider: "ashby",
        boardId,
        careersUrl: `https://jobs.ashbyhq.com/${encodeURIComponent(boardId)}`,
      };
    }
    if (
      ["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(url.hostname) &&
      segments[0]
    ) return {
      provider: "greenhouse",
      boardId: segments[0],
      careersUrl: `https://job-boards.greenhouse.io/${encodeURIComponent(segments[0])}`,
    };
    if (url.hostname === "jobs.lever.co" && segments[0]) {
      return {
        provider: "lever",
        boardId: segments[0],
        careersUrl: `https://jobs.lever.co/${encodeURIComponent(segments[0])}`,
      };
    }
    if (url.hostname === "apply.workable.com" && segments[0]) {
      return {
        provider: "workable",
        boardId: segments[0],
        careersUrl: `https://apply.workable.com/${encodeURIComponent(segments[0])}/`,
      };
    }
  }
  return null;
}

function normalized(input: {
  externalId: unknown; title: unknown; department?: unknown; location?: unknown;
  remote?: boolean | null; workplace?: unknown; employmentType?: unknown;
  compensation?: unknown; url: unknown; publishedAt?: unknown; description?: unknown;
}): NormalizedJob | null {
  const title = text(input.title);
  const externalId = String(input.externalId ?? "").trim();
  const canonicalUrl = text(input.url);
  if (!title || !externalId || !/^https:\/\//.test(canonicalUrl)) return null;
  const location = text(input.location) || "Location not specified";
  const jobInput = {
    title,
    department: text(input.department),
    location,
    isRemote: input.remote,
    descriptionPlain: plain(input.description),
  };
  if (!isUsEligible(jobInput)) return null;
  return {
    externalId,
    title,
    roleFamily: classifyRole(title, text(input.department)),
    location,
    remoteStatus: input.remote ? "Remote" : text(input.workplace) || "See posting",
    employmentType: text(input.employmentType) || "See posting",
    compensation: text(input.compensation) || "See posting",
    canonicalUrl,
    publishedAt: iso(input.publishedAt),
    summary: summarizeCanonicalJob(jobInput),
  };
}

export function normalizeAshby(payload: unknown): NormalizedJob[] {
  return array(object(payload).jobs).flatMap((raw) => {
    const job = object(raw);
    if (job.isListed === false) return [];
    const result = normalized({
      externalId: job.id, title: job.title, department: job.department,
      location: job.location, remote: job.isRemote === true,
      workplace: job.workplaceType, employmentType: job.employmentType,
      compensation: object(job.compensation).compensationTierSummary,
      url: job.jobUrl, publishedAt: job.publishedAt, description: job.descriptionPlain,
    });
    return result ? [result] : [];
  });
}

export function normalizeGreenhouse(payload: unknown): NormalizedJob[] {
  return array(object(payload).jobs).flatMap((raw) => {
    const job = object(raw);
    const metadata = array(job.metadata).map(object);
    const result = normalized({
      externalId: job.id, title: job.title,
      department: array(job.departments).map((item) => text(object(item).name)).filter(Boolean).join(", "),
      location: text(object(job.location).name),
      remote: /remote/i.test(text(object(job.location).name)),
      employmentType: text(metadata.find((item) => /employment.?type/i.test(text(item.name)))?.value),
      compensation: text(object(job.pay_input_ranges).formatted_pay_range),
      url: job.absolute_url, publishedAt: job.updated_at, description: job.content,
    });
    return result ? [result] : [];
  });
}

export function normalizeLever(payload: unknown): NormalizedJob[] {
  return array(payload).flatMap((raw) => {
    const job = object(raw);
    const categories = object(job.categories);
    const result = normalized({
      externalId: job.id, title: job.text, department: categories.department || categories.team,
      location: categories.location, remote: String(job.workplaceType).toLowerCase() === "remote",
      workplace: job.workplaceType, employmentType: categories.commitment,
      compensation: text(object(job.salaryRange).min)
        ? `${object(job.salaryRange).currency || ""} ${object(job.salaryRange).min}–${object(job.salaryRange).max}`
        : "",
      url: job.hostedUrl || job.applyUrl, publishedAt: job.createdAt,
      description: job.descriptionPlain || job.description,
    });
    return result ? [result] : [];
  });
}

export function normalizeWorkable(payload: unknown): NormalizedJob[] {
  const root = object(payload);
  return array(root.jobs || root.results).flatMap((raw) => {
    const job = object(raw);
    const location = object(job.location);
    const salary = object(job.salary);
    const result = normalized({
      externalId: job.shortcode || job.id, title: job.title,
      department: job.department,
      location: location.location_str || [job.city, job.state, job.country].filter(Boolean).join(", "),
      remote: job.remote === true || location.telecommuting === true ||
        /remote/i.test(text(location.location_str)),
      workplace: location.workplace_type || job.workplace,
      employmentType: job.employment_type,
      compensation: salary.salary_from
        ? `${String(salary.salary_currency || "").toUpperCase()} ${salary.salary_from}–${salary.salary_to || salary.salary_from}`
        : "",
      url: job.url || job.application_url || job.shortlink,
      publishedAt: job.published_on || job.created_at,
      description: job.description,
    });
    return result ? [result] : [];
  });
}

export function canonicalEndpoint(provider: AtsProvider, boardId: string) {
  const id = encodeURIComponent(boardId);
  if (provider === "ashby") return `https://api.ashbyhq.com/posting-api/job-board/${id}`;
  if (provider === "greenhouse") return `https://boards-api.greenhouse.io/v1/boards/${id}/jobs?content=true`;
  if (provider === "lever") return `https://api.lever.co/v0/postings/${id}?mode=json`;
  if (provider === "workable") return `https://www.workable.com/api/accounts/${id}?details=true`;
  throw new Error("Manual sources do not have a canonical endpoint.");
}

export function normalizeProvider(provider: AtsProvider, payload: unknown) {
  if (provider === "ashby") return normalizeAshby(payload);
  if (provider === "greenhouse") return normalizeGreenhouse(payload);
  if (provider === "lever") return normalizeLever(payload);
  if (provider === "workable") return normalizeWorkable(payload);
  return [];
}

export function isCompleteProviderPayload(provider: AtsProvider, payload: unknown) {
  const root = object(payload);
  const records = provider === "lever"
    ? payload
    : provider === "workable" && !Array.isArray(root.jobs)
      ? root.results
      : root.jobs;
  if (!Array.isArray(records)) return false;
  return records.every((raw) => {
    const job = object(raw);
    if (provider === "ashby") {
      return Boolean(text(job.id) && text(job.title) && text(job.jobUrl));
    }
    if (provider === "greenhouse") {
      return Boolean(String(job.id ?? "").trim() && text(job.title) && text(job.absolute_url));
    }
    if (provider === "lever") {
      return Boolean(text(job.id) && text(job.text) && text(job.hostedUrl || job.applyUrl));
    }
    if (provider === "workable") {
      return Boolean(
        String(job.shortcode || job.id || "").trim() &&
        text(job.title) &&
        text(job.url || job.application_url || job.shortlink)
      );
    }
    return false;
  });
}

export async function fetchCanonicalBoard(
  provider: AtsProvider,
  boardId: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 15_000
): Promise<CanonicalFetch> {
  const response = await fetcher(canonicalEndpoint(provider, boardId), {
    headers: { "User-Agent": "OH-SHI/1.0 canonical-job-verifier" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${provider} board ${boardId} returned ${response.status}`);
  const payload = await response.json();
  if (!isCompleteProviderPayload(provider, payload)) {
    throw new Error(`${provider} board ${boardId} returned an incomplete payload`);
  }
  return { complete: true, jobs: normalizeProvider(provider, payload) };
}
