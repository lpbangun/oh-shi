import {
  normalizeRoleFamily,
  ROLE_FAMILIES,
  ROLE_FAMILY_ALIASES,
  type RoleFamily,
} from "./job-normalization";

export const EMPLOYMENT_TYPES = [
  "Full time",
  "Part time",
  "Contract",
  "Temporary",
  "Internship",
] as const;

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

const EMPLOYMENT_TYPE_ALIASES: Readonly<Record<string, EmploymentType>> = {
  fulltime: "Full time",
  "full-time": "Full time",
  "full time": "Full time",
  permanent: "Full time",
  parttime: "Part time",
  "part-time": "Part time",
  "part time": "Part time",
  contract: "Contract",
  contractor: "Contract",
  freelance: "Contract",
  temporary: "Temporary",
  temp: "Temporary",
  internship: "Internship",
  intern: "Internship",
};

export function normalizeEmploymentType(value: string): EmploymentType | null {
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  const canonical = EMPLOYMENT_TYPES.find(
    (type) => type.toLowerCase() === normalized
  );
  return canonical || EMPLOYMENT_TYPE_ALIASES[normalized.replace(/ /g, "")] ||
    EMPLOYMENT_TYPE_ALIASES[normalized] || null;
}

export type NaturalLanguageJobFilters = {
  q: string | null;
  status: "verified_open" | "verified_closed" | "all" | null;
  company: string | null;
  role_family: RoleFamily | null;
  location: string | null;
  remote_status: "Remote" | "Hybrid" | "On-site" | null;
  employment_type: EmploymentType | null;
  new_since: string | null;
};

export type NaturalLanguageJobQuery = {
  input: string;
  filters: NaturalLanguageJobFilters;
  interpretation: string;
  warnings: string[];
};

const ROLE_PHRASES = [
  ...ROLE_FAMILIES.map((role) => [role, role] as const),
  ...Object.entries(ROLE_FAMILY_ALIASES).map(([alias, role]) =>
    [alias.replace(/_/g, " "), role] as const
  ),
].sort(([left], [right]) => right.length - left.length);

const ARRANGEMENTS = [
  ["work from home", "Remote"],
  ["work-from-home", "Remote"],
  ["on site", "On-site"],
  ["on-site", "On-site"],
  ["onsite", "On-site"],
  ["remote", "Remote"],
  ["wfh", "Remote"],
  ["hybrid", "Hybrid"],
] as const;

const EMPLOYMENT_PHRASES = [
  ...EMPLOYMENT_TYPES.map((type) => [type, type] as const),
  ...Object.entries(EMPLOYMENT_TYPE_ALIASES).map(([alias, type]) =>
    [alias.replace(/_/g, " "), type] as const
  ),
].sort(([left], [right]) => right.length - left.length);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function consumePhrase(
  text: string,
  phrases: readonly (readonly [string, string])[]
) {
  for (const [phrase, value] of phrases) {
    const match = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i").exec(text);
    if (!match) continue;
    return {
      value,
      text: text.slice(0, match.index) + " " +
        text.slice(match.index + match[0].length),
    };
  }
  return { value: null, text };
}

function consumeCapturedPhrase(text: string, expression: RegExp) {
  const match = expression.exec(text);
  if (!match?.[1]) return { value: null, text };
  return {
    value: match[1].trim(),
    text: text.slice(0, match.index) + " " +
      text.slice(match.index + match[0].length),
  };
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function newSinceForPhrase(phrase: string, now: Date) {
  const start = startOfUtcDay(now);
  if (phrase === "today") return start;
  if (phrase === "last 24 hours") return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (phrase === "this week") {
    const daysSinceMonday = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - daysSinceMonday);
    return start;
  }
  return null;
}

function cleanResidual(text: string) {
  return text
    .replace(/[,.!?]/g, " ")
    .replace(
      /\b(?:find|show|search|looking for|please|give me|jobs?|roles?|positions?|openings?|that|with|and|or|for|of|the|posted|added|new|since|this|week|today)\b/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim() || null;
}

function interpretationFor(filters: NaturalLanguageJobFilters, input: string) {
  const parts = [
    filters.status === "verified_closed" ? "verified closed" : null,
    filters.status === "all" ? "all job states" : null,
    filters.role_family,
    filters.employment_type,
    filters.remote_status,
    filters.location ? `near ${filters.location}` : null,
    filters.company ? `at ${filters.company}` : null,
    filters.new_since ? `added since ${filters.new_since.slice(0, 10)}` : null,
    filters.q ? `matching “${filters.q}”` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length
    ? `Searching ${parts.join(" · ")}`
    : `Searching for “${input.trim()}”`;
}

export function parseNaturalLanguageJobSearch(
  input: string,
  now = new Date()
): NaturalLanguageJobQuery {
  const original = input.trim().replace(/\s+/g, " ");
  let remaining = original;
  const warnings: string[] = [];
  const filters: NaturalLanguageJobFilters = {
    q: null,
    status: null,
    company: null,
    role_family: null,
    location: null,
    remote_status: null,
    employment_type: null,
    new_since: null,
  };

  const status = consumePhrase(remaining, [
    ["closed", "verified_closed"],
    ["open", "verified_open"],
    ["all", "all"],
  ]);
  filters.status = status.value as NaturalLanguageJobFilters["status"];
  remaining = status.text;

  const arrangement = consumePhrase(remaining, ARRANGEMENTS);
  filters.remote_status = arrangement.value as NaturalLanguageJobFilters["remote_status"];
  remaining = arrangement.text;

  const employment = consumePhrase(remaining, EMPLOYMENT_PHRASES);
  filters.employment_type = employment.value as NaturalLanguageJobFilters["employment_type"];
  remaining = employment.text;

  const role = consumePhrase(
    remaining,
    ROLE_PHRASES.map(([phrase, value]) => [phrase, normalizeRoleFamily(value) || value] as const)
  );
  filters.role_family = role.value as RoleFamily | null;
  remaining = role.text;

  const relativeDate = /\b(?:(?:added|posted|new)\s+)?(last 24 hours|today|this week)\b/i.exec(remaining);
  if (relativeDate) {
    filters.new_since = newSinceForPhrase(relativeDate[1].toLowerCase(), now)?.toISOString() || null;
    remaining = remaining.slice(0, relativeDate.index) + " " +
      remaining.slice(relativeDate.index + relativeDate[0].length);
  } else {
    const explicitDate = /\bsince\s+([a-z]+\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})\b/i.exec(remaining);
    if (explicitDate) {
      const parsed = Date.parse(explicitDate[1]);
      if (Number.isFinite(parsed)) filters.new_since = new Date(parsed).toISOString();
      remaining = remaining.slice(0, explicitDate.index) + " " +
        remaining.slice(explicitDate.index + explicitDate[0].length);
    }
  }

  const company = consumeCapturedPhrase(
    remaining,
    /\b(?:at|from|with)\s+(.+?)(?=\s+(?:in|near|around|remote|hybrid|on[- ]?site|full[- ]?time|part[- ]?time|contract(?:or)?|temporary|intern(?:ship)?|jobs?|roles?|positions?|added|posted|since)\b|$)/i
  );
  filters.company = company.value;
  remaining = company.text;

  const location = consumeCapturedPhrase(
    remaining,
    /\b(?:in|near|around)\s+(.+?)(?=\s+(?:at|from|with|remote|hybrid|on[- ]?site|full[- ]?time|part[- ]?time|contract(?:or)?|temporary|intern(?:ship)?|jobs?|roles?|positions?|added|posted|since)\b|$)/i
  );
  filters.location = location.value;
  remaining = location.text;

  filters.q = cleanResidual(remaining);
  if (filters.q && filters.q.length < 2) {
    warnings.push(`The remaining search text “${filters.q}” is very short.`);
  }

  return {
    input: original,
    filters,
    interpretation: interpretationFor(filters, original),
    warnings,
  };
}
