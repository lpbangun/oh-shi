import { classifyRole, isUsEligible, summarizeCanonicalJob } from "./job-normalization";
import { parsePersonioPositions } from "./personio-xml";
import { boundedText } from "./public-web";
import type { AtsProvider } from "./source-registry";
import { fetchStructuredCareerSource } from "./structured-career-page";

export const ATS_ADAPTER_VERSION = "1.0";
export const ATS_DETECTION_VERSION = "1.1";

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
  observedJobs?: Array<{
    externalId: string;
    canonicalUrl: string;
  }>;
};

export class CanonicalHttpError extends Error {
  constructor(
    public status: number,
    public retryAfterMs: number | null,
    message: string
  ) {
    super(message);
    this.name = "CanonicalHttpError";
  }
}

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

function detectionFromLink(link: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(link); } catch { return null; }
  const segments = url.pathname.split("/").filter(Boolean);
  const safeBoard = (value: string) => {
    let decoded = "";
    try { decoded = decodeURIComponent(value); } catch { return ""; }
    return /^[a-z0-9][a-z0-9._-]{0,119}$/i.test(decoded) ? decoded : "";
  };
  if (url.hostname === "jobs.ashbyhq.com" && segments[0]) {
    const boardId = safeBoard(segments[0]);
    return boardId ? {
      provider: "ashby",
      boardId,
      careersUrl: `https://jobs.ashbyhq.com/${encodeURIComponent(boardId)}`,
    } : null;
  }
  if (
    ["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(url.hostname) &&
    segments[0]
  ) {
    const embedBoards = url.searchParams.getAll("for");
    const boardId = segments[0] === "embed" && segments[1] === "job_board"
      ? embedBoards.length === 1
        ? safeBoard(embedBoards[0])
        : ""
      : safeBoard(segments[0]);
    return boardId ? {
      provider: "greenhouse",
      boardId,
      careersUrl: `https://job-boards.greenhouse.io/${encodeURIComponent(boardId)}`,
    } : null;
  }
  if (url.hostname === "jobs.lever.co" && segments[0]) {
    const boardId = safeBoard(segments[0]);
    return boardId ? {
      provider: "lever",
      boardId,
      careersUrl: `https://jobs.lever.co/${encodeURIComponent(boardId)}`,
    } : null;
  }
  if (url.hostname === "apply.workable.com" && segments[0]) {
    const boardId = safeBoard(segments[0]);
    return boardId ? {
      provider: "workable",
      boardId,
      careersUrl: `https://apply.workable.com/${encodeURIComponent(boardId)}/`,
    } : null;
  }
  const recruitee = url.hostname.match(/^([a-z0-9-]+)\.recruitee\.com$/i);
  if (recruitee && !["www", "api", "app"].includes(recruitee[1].toLowerCase())) {
    const boardId = safeBoard(recruitee[1].toLowerCase());
    return boardId ? {
      provider: "recruitee",
      boardId,
      careersUrl: `https://${boardId}.recruitee.com/`,
    } : null;
  }
  const personio = url.hostname.match(/^([a-z0-9-]+)\.jobs\.personio\.(de|com)$/i);
  if (personio) {
    const boardId = url.hostname.toLowerCase();
    return {
      provider: "personio",
      boardId,
      careersUrl: `https://${boardId}/`,
    };
  }
  if (
    ["jobs.smartrecruiters.com", "careers.smartrecruiters.com"].includes(url.hostname) &&
    segments[0]
  ) {
    const boardId = safeBoard(segments[0]);
    return boardId ? {
      provider: "smartrecruiters",
      boardId,
      careersUrl: `https://careers.smartrecruiters.com/${encodeURIComponent(boardId)}`,
    } : null;
  }
  return null;
}

export function detectAtsCandidatesFromLinks(links: string[]) {
  const unique = new Map<string, AtsDetection>();
  for (const link of links) {
    const detection = detectionFromLink(link);
    if (!detection) continue;
    unique.set(`${detection.provider}:${detection.boardId.toLowerCase()}`, detection);
  }
  return [...unique.values()].sort((left, right) =>
    `${left.provider}:${left.boardId.toLowerCase()}`.localeCompare(
      `${right.provider}:${right.boardId.toLowerCase()}`
    )
  );
}

export function detectAtsFromLinks(links: string[]): AtsDetection | null {
  const candidates = detectAtsCandidatesFromLinks(links);
  return candidates.length === 1 ? candidates[0] : null;
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

function workableRecords(payload: unknown) {
  const root = object(payload);
  return Array.isArray(root.jobs)
    ? root.jobs
    : Array.isArray(root.results) ? root.results : [];
}

type WorkableLocation = {
  label: string;
  country: string;
  countryCode: string;
};

function workableLocations(job: JsonRecord): WorkableLocation[] {
  const values: WorkableLocation[] = [];
  const add = (location: JsonRecord, fallback: JsonRecord = {}) => {
    const country = text(location.country || location.country_name || fallback.country);
    const countryCode = text(
      location.countryCode ||
      location.country_code ||
      fallback.countryCode ||
      fallback.country_code
    );
    const label = text(location.location_str) || [
      text(location.city || fallback.city),
      text(location.region || location.state || fallback.region || fallback.state),
      country,
    ].filter(Boolean).join(", ");
    if (label || country || countryCode) values.push({ label, country, countryCode });
  };
  const location = object(job.location);
  if (Object.keys(location).length) add(location, job);
  for (const raw of array(job.locations)) add(object(raw), job);
  if (!values.length) add(job);
  return values;
}

function workableUsLocation(location: WorkableLocation) {
  return /^US$/i.test(location.countryCode) ||
    /^(?:United States|US|USA)$/i.test(location.country) ||
    /\b(?:United States|USA|U\.S\.|Remote[- /]US)\b/i.test(location.label);
}

function workableLocationLabel(group: JsonRecord[]) {
  const all = group.flatMap(workableLocations);
  const us = all.filter(workableUsLocation);
  const selected = us.length ? us : all;
  return [...new Set(selected.map((location) => location.label).filter(Boolean))].join("; ");
}

function normalizedWorkableUrl(value: unknown) {
  try {
    const url = new URL(text(value));
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function workableUrlMatches(value: unknown, externalId: string, application: boolean) {
  try {
    const url = new URL(text(value));
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "workable.com" || url.hostname.endsWith(".workable.com"))
    ) return false;
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const jobMarker = segments.findIndex((segment) => segment.toLowerCase() === "j");
    if (jobMarker < 0 || segments[jobMarker + 1]?.toLowerCase() !== externalId.toLowerCase()) {
      return false;
    }
    return application
      ? segments.slice(jobMarker + 2).some((segment) => segment.toLowerCase() === "apply")
      : true;
  } catch {
    return false;
  }
}

export function normalizeWorkable(payload: unknown): NormalizedJob[] {
  const groups = new Map<string, JsonRecord[]>();
  for (const raw of workableRecords(payload)) {
    const job = object(raw);
    const externalId = String(job.shortcode || job.id || "").trim();
    if (!externalId) continue;
    const group = groups.get(externalId) || [];
    group.push(job);
    groups.set(externalId, group);
  }
  return [...groups.entries()].flatMap(([externalId, group]) => {
    const job = group[0];
    const location = object(job.location);
    const salary = object(job.salary);
    const description = group.map((item) => text(item.description)).find(Boolean) || "";
    if (isApplicationPool(text(job.title), description)) return [];
    const result = normalized({
      externalId,
      title: job.title,
      department: job.department,
      location: workableLocationLabel(group),
      remote: group.some((item) =>
        item.remote === true ||
        item.telecommuting === true ||
        object(item.location).telecommuting === true ||
        /remote/i.test(text(object(item.location).location_str))
      ),
      workplace: location.workplace_type || job.workplace,
      employmentType: job.employment_type,
      compensation: salary.salary_from
        ? `${String(salary.salary_currency || "").toUpperCase()} ${salary.salary_from}–${salary.salary_to || salary.salary_from}`
        : "",
      url: job.url || job.shortlink,
      publishedAt: job.published_on || job.created_at,
      description,
    });
    return result ? [result] : [];
  });
}

function recruiteeLocation(job: JsonRecord) {
  const locations = array(job.locations).map(object);
  const parts = locations.flatMap((location) => [
    text(location.name),
    text(location.city),
    text(location.state),
    text(location.country),
  ]).filter(Boolean);
  if (!parts.length) {
    parts.push(
      text(job.location),
      text(job.city),
      text(job.state_name),
      text(job.country)
    );
  }
  return [...new Set(parts.filter(Boolean))].join(", ");
}

function recruiteeSalary(job: JsonRecord) {
  const salary = object(job.salary);
  if (salary.min === null && salary.max === null) return "";
  if (salary.min === undefined && salary.max === undefined) return "";
  const min = salary.min ?? salary.max;
  const max = salary.max ?? salary.min;
  return `${text(salary.currency)} ${String(min)}–${String(max)}`.trim();
}

export function normalizeRecruitee(payload: unknown): NormalizedJob[] {
  return array(object(payload).offers).flatMap((raw) => {
    const job = object(raw);
    const description = plain(`${text(job.description)} ${text(job.requirements)}`);
    if (text(job.status).toLowerCase() !== "published") return [];
    if (
      /(?:general|open|speculative|unsolicited)\s+application/i.test(text(job.title)) ||
      /don't see an active job opening|do not see an active job opening/i.test(description)
    ) return [];
    const result = normalized({
      externalId: job.id || job.guid,
      title: job.title,
      department: job.department,
      location: recruiteeLocation(job),
      remote: job.remote === true,
      workplace: job.hybrid === true ? "Hybrid" : job.on_site === true ? "On-site" : "",
      employmentType: job.employment_type_code,
      compensation: recruiteeSalary(job),
      url: job.careers_url,
      publishedAt: job.published_at || job.created_at,
      description,
    });
    return result ? [result] : [];
  });
}

function personioHost(boardId: string) {
  const host = boardId.trim().toLowerCase();
  if (!/^[a-z0-9-]+\.jobs\.personio\.(?:de|com)$/.test(host)) {
    throw new Error("Invalid Personio board ID.");
  }
  return host;
}

function personioSalary(salary: ReturnType<typeof parsePersonioPositions>[number]["salary"]) {
  if (!salary || (!salary.min && !salary.max)) return "";
  const minimum = salary.min || salary.max;
  const maximum = salary.max || salary.min;
  const currency = salary.currencyCode || salary.currencySymbol;
  const period = salary.type ? ` per ${salary.type.replace(/ly$/i, "")}` : "";
  return `${currency} ${minimum}–${maximum}${period}`.trim();
}

export function normalizePersonio(payload: unknown, boardId: string): NormalizedJob[] {
  if (typeof payload !== "string") return [];
  const host = personioHost(boardId);
  return parsePersonioPositions(payload).flatMap((job) => {
    const description = job.descriptions.join(" ");
    if (
      /(?:general|open|speculative|unsolicited)\s+application/i.test(job.title) ||
      /\binitiativbewerbung\b/i.test(job.title) ||
      /\bno active (?:role|opening|vacancy)\b/i.test(plain(description))
    ) return [];
    const result = normalized({
      externalId: job.id,
      title: job.title,
      department: job.department,
      location: job.office,
      remote: /\bremote\b|home.?office/i.test(job.office),
      employmentType: [job.schedule, job.employmentType].filter(Boolean).join(" "),
      compensation: personioSalary(job.salary),
      url: `https://${host}/job/${encodeURIComponent(job.id)}?language=en`,
      publishedAt: job.createdAt,
      description,
    });
    return result ? [result] : [];
  });
}

function smartRecruitersBoardId(boardId: string) {
  const id = boardId.trim();
  if (!/^[a-z0-9_-]{1,100}$/i.test(id)) {
    throw new Error("Invalid SmartRecruiters board ID.");
  }
  return id;
}

function smartRecruitersLocation(job: JsonRecord) {
  const location = object(job.location);
  const parts = text(location.fullLocation)
    ? [text(location.fullLocation)]
    : [text(location.city), text(location.region)];
  if (text(location.country).toLowerCase() === "us" &&
      !parts.some((part) => /united states|\busa?\b/i.test(part))) {
    parts.push("United States");
  }
  return [...new Set(parts.filter(Boolean))].join(", ");
}

function smartRecruitersCompensation(job: JsonRecord) {
  const compensation = object(job.compensation);
  if (compensation.min === undefined && compensation.max === undefined) return "";
  const minimum = compensation.min ?? compensation.max;
  const maximum = compensation.max ?? compensation.min;
  const currency = text(compensation.currency).toUpperCase();
  const period = text(compensation.period);
  return `${currency} ${String(minimum)}–${String(maximum)}${period ? ` per ${period.toLowerCase()}` : ""}`.trim();
}

function smartRecruitersDescription(job: JsonRecord) {
  const sections = object(object(job.jobAd).sections);
  return Object.values(sections)
    .map((section) => text(object(section).text))
    .filter(Boolean)
    .join(" ");
}

function isApplicationPool(title: string, description: string) {
  return /(?:general|open|speculative|unsolicited)\s+application|talent\s+pool/i.test(title) ||
    /don't see an active job opening|do not see an active job opening|no active (?:role|opening|vacancy)/i
      .test(plain(description));
}

export function normalizeSmartRecruiters(payload: unknown): NormalizedJob[] {
  return array(payload).flatMap((raw) => {
    const job = object(raw);
    const description = smartRecruitersDescription(job);
    if (job.active !== true || text(job.visibility) !== "PUBLIC") return [];
    if (isApplicationPool(text(job.name), description)) return [];
    const location = object(job.location);
    const result = normalized({
      externalId: job.id,
      title: job.name,
      department: object(job.department).label,
      location: smartRecruitersLocation(job),
      remote: location.remote === true,
      workplace: location.hybrid === true ? "Hybrid" : location.remote === true ? "Remote" : "On-site",
      employmentType: object(job.typeOfEmployment).label,
      compensation: smartRecruitersCompensation(job),
      url: job.postingUrl,
      publishedAt: job.releasedDate,
      description,
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
  if (provider === "recruitee") {
    if (!/^[a-z0-9-]+$/i.test(boardId)) throw new Error("Invalid Recruitee board ID.");
    return `https://${boardId.toLowerCase()}.recruitee.com/api/offers/`;
  }
  if (provider === "personio") {
    return `https://${personioHost(boardId)}/xml?language=en`;
  }
  if (provider === "smartrecruiters") {
    const company = encodeURIComponent(smartRecruitersBoardId(boardId));
    return `https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=100&offset=0`;
  }
  if (provider === "structured") return boardId;
  throw new Error("Manual sources do not have a canonical endpoint.");
}

export function normalizeProvider(provider: AtsProvider, payload: unknown, boardId = "") {
  if (provider === "ashby") return normalizeAshby(payload);
  if (provider === "greenhouse") return normalizeGreenhouse(payload);
  if (provider === "lever") return normalizeLever(payload);
  if (provider === "workable") return normalizeWorkable(payload);
  if (provider === "recruitee") return normalizeRecruitee(payload);
  if (provider === "personio") return normalizePersonio(payload, boardId);
  if (provider === "smartrecruiters") return normalizeSmartRecruiters(payload);
  return [];
}

function observedProviderJobs(provider: AtsProvider, payload: unknown) {
  if (provider !== "ashby") return undefined;
  return array(object(payload).jobs).flatMap((raw) => {
    const job = object(raw);
    const externalId = text(job.id);
    const canonicalUrl = text(job.jobUrl);
    return job.isListed !== false &&
      externalId &&
      /^https:\/\//.test(canonicalUrl)
      ? [{ externalId, canonicalUrl }]
      : [];
  });
}

export function isCompleteProviderPayload(provider: AtsProvider, payload: unknown) {
  if (provider === "personio") {
    if (typeof payload !== "string") return false;
    try {
      parsePersonioPositions(payload);
      return true;
    } catch {
      return false;
    }
  }
  const root = object(payload);
  if (provider === "smartrecruiters") {
    return Array.isArray(payload) && payload.every((raw) => {
      const job = object(raw);
      return Boolean(
        text(job.id) &&
        text(job.name) &&
        job.active === true &&
        text(job.visibility) === "PUBLIC" &&
        /^https:\/\//.test(text(job.postingUrl)) &&
        /^https:\/\//.test(text(job.applyUrl)) &&
        text(object(object(object(job.jobAd).sections).jobDescription).text)
      );
    });
  }
  const records = provider === "lever"
    ? payload
    : provider === "recruitee"
      ? root.offers
    : provider === "workable" && !Array.isArray(root.jobs)
      ? root.results
      : root.jobs;
  if (!Array.isArray(records)) return false;
  if (provider === "workable") {
    const identities = new Map<string, string>();
    return records.every((raw) => {
      const job = object(raw);
      const externalId = String(job.shortcode || job.id || "").trim();
      const title = text(job.title);
      const canonicalUrl = normalizedWorkableUrl(job.url || job.shortlink);
      const applicationUrl = normalizedWorkableUrl(job.application_url);
      const state = text(job.state).toLowerCase();
      if (
        !externalId ||
        !title ||
        /^(?:draft|closed|archived|internal|confidential)$/.test(state) ||
        !workableUrlMatches(canonicalUrl, externalId, false) ||
        !workableUrlMatches(applicationUrl, externalId, true) ||
        !iso(job.published_on || job.created_at) ||
        !text(job.description) ||
        (!workableLocations(job).length &&
          job.remote !== true &&
          job.telecommuting !== true)
      ) return false;
      const identity = JSON.stringify([title, canonicalUrl, applicationUrl]);
      const prior = identities.get(externalId);
      if (prior && prior !== identity) return false;
      identities.set(externalId, identity);
      return true;
    });
  }
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
    if (provider === "recruitee") {
      return Boolean(
        String(job.id || job.guid || "").trim() &&
        text(job.title) &&
        text(job.status).toLowerCase() === "published" &&
        /^https:\/\//.test(text(job.careers_url)) &&
        /^https:\/\//.test(text(job.careers_apply_url))
      );
    }
    return false;
  });
}

type SmartRecruitersListItem = {
  id: string;
  uuid: string;
  raw: JsonRecord;
};

function retryAfterMilliseconds(response: Response) {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function smartRecruitersUrlMatches(
  value: unknown,
  hostname: string,
  boardId: string,
  postingId?: string
) {
  try {
    const url = new URL(text(value));
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (url.protocol !== "https:" || url.hostname !== hostname) return false;
    if (hostname === "api.smartrecruiters.com") {
      return segments[0] === "v1" &&
        segments[1] === "companies" &&
        segments[2]?.toLowerCase() === boardId.toLowerCase() &&
        segments[3] === "postings" &&
        (!postingId || segments[4] === postingId) &&
        segments.length === (postingId ? 5 : 4);
    }
    return segments[0]?.toLowerCase() === boardId.toLowerCase();
  } catch {
    return false;
  }
}

function smartRecruitersIncomplete(boardId: string, reason: string): never {
  throw new Error(`smartrecruiters board ${boardId} returned an incomplete payload: ${reason}`);
}

function validateSmartRecruitersListPage(
  payload: unknown,
  boardId: string,
  expectedOffset: number,
  expectedTotal: number | null
) {
  const root = object(payload);
  const offset = root.offset;
  const limit = root.limit;
  const totalFound = root.totalFound;
  if (!Number.isInteger(offset) || Number(offset) !== expectedOffset) {
    smartRecruitersIncomplete(boardId, "pagination offset mismatch");
  }
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) {
    smartRecruitersIncomplete(boardId, "invalid pagination limit");
  }
  if (!Number.isInteger(totalFound) || Number(totalFound) < 0) {
    smartRecruitersIncomplete(boardId, "invalid totalFound");
  }
  if (expectedTotal !== null && Number(totalFound) !== expectedTotal) {
    smartRecruitersIncomplete(boardId, "totalFound changed during pagination");
  }
  if (!Array.isArray(root.content) || root.content.length > Number(limit)) {
    smartRecruitersIncomplete(boardId, "invalid page content");
  }
  const records: SmartRecruitersListItem[] = root.content.map((raw, index) => {
    const item = object(raw);
    const id = text(item.id);
    const uuid = text(item.uuid);
    const company = object(item.company);
    const location = object(item.location);
    if (
      !id ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid) ||
      !text(item.name) ||
      text(company.identifier).toLowerCase() !== boardId.toLowerCase() ||
      !iso(item.releasedDate) ||
      !text(location.country) ||
      !(text(location.fullLocation) || text(location.city)) ||
      text(item.visibility) !== "PUBLIC" ||
      !smartRecruitersUrlMatches(
        item.ref,
        "api.smartrecruiters.com",
        boardId,
        id
      )
    ) {
      smartRecruitersIncomplete(boardId, `invalid list item at offset ${expectedOffset + index}`);
    }
    return { id, uuid, raw: item };
  });
  return {
    offset: Number(offset),
    totalFound: Number(totalFound),
    records,
  };
}

function validateSmartRecruitersDetail(
  payload: unknown,
  boardId: string,
  listItem: SmartRecruitersListItem
) {
  const detail = object(payload);
  const company = object(detail.company);
  const location = object(detail.location);
  const description = text(
    object(object(object(detail.jobAd).sections).jobDescription).text
  );
  if (
    text(detail.id) !== listItem.id ||
    text(detail.uuid).toLowerCase() !== listItem.uuid.toLowerCase() ||
    text(detail.name) !== text(listItem.raw.name) ||
    text(company.identifier).toLowerCase() !== boardId.toLowerCase() ||
    !iso(detail.releasedDate) ||
    !text(location.country) ||
    !(text(location.fullLocation) || text(location.city)) ||
    detail.active !== true ||
    text(detail.visibility) !== "PUBLIC" ||
    !description ||
    !smartRecruitersUrlMatches(
      detail.postingUrl,
      "jobs.smartrecruiters.com",
      boardId
    ) ||
    !smartRecruitersUrlMatches(
      detail.applyUrl,
      "jobs.smartrecruiters.com",
      boardId
    )
  ) {
    smartRecruitersIncomplete(boardId, `invalid detail for posting ${listItem.id}`);
  }
  return detail;
}

function smartRecruitersUsEligible(item: SmartRecruitersListItem) {
  const location = object(item.raw.location);
  return /^(?:us|usa|united states)$/i.test(text(location.country)) ||
    /united states|\busa?\b/i.test(text(location.fullLocation));
}

async function mapSmartRecruitersDetails<T, R>(
  values: T[],
  work: (value: T) => Promise<R>
) {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(4, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor++;
        output[index] = await work(values[index]);
      }
    }
  );
  await Promise.all(workers);
  return output;
}

async function fetchSmartRecruitersBoard(
  boardIdInput: string,
  fetcher: typeof fetch,
  timeoutMs: number
): Promise<CanonicalFetch> {
  const boardId = smartRecruitersBoardId(boardIdInput);
  const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(boardId)}/postings`;
  const userAgent = "OH-SHI/1.0 canonical-job-verifier";
  const paceRequests = fetcher === fetch;
  let nextRequestAt = 0;
  let startQueue = Promise.resolve();

  const waitForStart = async () => {
    if (!paceRequests) return;
    let release: () => void = () => undefined;
    const previous = startQueue;
    startQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    nextRequestAt = Date.now() + 125;
    release();
  };

  const fetchJson = async (url: string, label: string, maxBytes: number) => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response: Response;
      try {
        await waitForStart();
        response = await fetcher(url, {
          headers: { "User-Agent": userAgent, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
          continue;
        }
        smartRecruitersIncomplete(
          boardId,
          `${label} request failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < 3) {
          const retryAfter = retryAfterMilliseconds(response);
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(10_000, retryAfter ?? 250 * 2 ** (attempt - 1)))
          );
          continue;
        }
        smartRecruitersIncomplete(boardId, `${label} returned ${response.status}`);
      }
      if (!/\bjson\b/i.test(response.headers.get("content-type") || "")) {
        smartRecruitersIncomplete(boardId, `${label} returned a non-JSON response`);
      }
      let body: string;
      try {
        body = await boundedText(response, maxBytes);
      } catch (error) {
        smartRecruitersIncomplete(
          boardId,
          `${label} ${error instanceof Error ? error.message : String(error)}`
        );
      }
      try {
        return JSON.parse(body);
      } catch {
        smartRecruitersIncomplete(boardId, `${label} returned invalid JSON`);
      }
    }
    smartRecruitersIncomplete(boardId, `${label} exhausted retries`);
  };

  const allItems: SmartRecruitersListItem[] = [];
  const seen = new Set<string>();
  let expectedTotal: number | null = null;
  let offset = 0;
  for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
    const payload = await fetchJson(
      `${base}?limit=100&offset=${offset}`,
      `list page ${pageNumber}`,
      5_000_000
    );
    const page = validateSmartRecruitersListPage(payload, boardId, offset, expectedTotal);
    expectedTotal ??= page.totalFound;
    if (expectedTotal > 2_000) {
      smartRecruitersIncomplete(boardId, "totalFound exceeds the bounded collection limit");
    }
    for (const item of page.records) {
      if (seen.has(item.id)) {
        smartRecruitersIncomplete(boardId, `duplicate posting ${item.id}`);
      }
      seen.add(item.id);
      allItems.push(item);
    }
    if (allItems.length === expectedTotal) break;
    if (!page.records.length || allItems.length > expectedTotal) {
      smartRecruitersIncomplete(boardId, "pagination ended before totalFound");
    }
    offset += page.records.length;
    if (pageNumber === 20) {
      smartRecruitersIncomplete(boardId, "pagination exceeds the bounded page limit");
    }
  }
  if (expectedTotal === null || allItems.length !== expectedTotal) {
    smartRecruitersIncomplete(boardId, "collected count does not match totalFound");
  }

  const eligible = allItems.filter(smartRecruitersUsEligible);
  const details = await mapSmartRecruitersDetails(eligible, async (item) => {
    const payload = await fetchJson(
      `${base}/${encodeURIComponent(item.id)}`,
      `posting ${item.id}`,
      2_000_000
    );
    return validateSmartRecruitersDetail(payload, boardId, item);
  });
  return { complete: true, jobs: normalizeSmartRecruiters(details) };
}

let workableRequestQueue = Promise.resolve();
let workableNextRequestAt = 0;

async function paceWorkableRequest() {
  let release: () => void = () => undefined;
  const previous = workableRequestQueue;
  workableRequestQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const waitMs = Math.max(0, workableNextRequestAt - Date.now());
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  // Workable documents ten API requests per ten seconds. One request start per
  // second keeps concurrent board refreshes within that shared account limit.
  workableNextRequestAt = Date.now() + 1_000;
  release();
}

export async function fetchCanonicalBoard(
  provider: AtsProvider,
  boardId: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 15_000
): Promise<CanonicalFetch> {
  if (provider === "structured") {
    return fetchStructuredCareerSource(boardId, fetcher);
  }
  if (provider === "smartrecruiters") {
    return fetchSmartRecruitersBoard(boardId, fetcher, timeoutMs);
  }
  if (provider === "workable" && fetcher === fetch) {
    await paceWorkableRequest();
  }
  const response = await fetcher(canonicalEndpoint(provider, boardId), {
    headers: { "User-Agent": "OH-SHI/1.0 canonical-job-verifier" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const retryAfterMs = retryAfterMilliseconds(response);
    throw new CanonicalHttpError(
      response.status,
      retryAfterMs,
      `${provider} board ${boardId} returned ${response.status}`
    );
  }
  let payload: unknown;
  if (provider === "personio") {
    if (!/\bxml\b/i.test(response.headers.get("content-type") || "")) {
      throw new Error(`personio board ${boardId} returned an incomplete payload: non-XML response`);
    }
    try {
      payload = await boundedText(response);
    } catch (error) {
      throw new Error(
        `personio board ${boardId} returned an incomplete payload: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  } else if (provider === "workable") {
    if (!/\bjson\b/i.test(response.headers.get("content-type") || "")) {
      throw new Error(`workable board ${boardId} returned an incomplete payload: non-JSON response`);
    }
    try {
      payload = JSON.parse(await boundedText(response, 5_000_000));
    } catch (error) {
      throw new Error(
        `workable board ${boardId} returned an incomplete payload: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  } else {
    payload = await response.json();
  }
  if (!isCompleteProviderPayload(provider, payload)) {
    throw new Error(`${provider} board ${boardId} returned an incomplete payload`);
  }
  return {
    complete: true,
    jobs: normalizeProvider(provider, payload, boardId),
    observedJobs: observedProviderJobs(provider, payload),
  };
}
