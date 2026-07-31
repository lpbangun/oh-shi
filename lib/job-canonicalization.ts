import type { NormalizedJob } from "./ats-adapters";
import type { AtsProvider } from "./source-registry";

export type CanonicalJobCandidate = {
  id: string;
  companyId: string;
  provider: AtsProvider;
  sourceId: string;
  externalId: string;
  canonicalUrl: string;
  title: string;
  location: string;
  employmentType: string;
  summary: string;
  publishedAt: string | null;
  status: string;
};

export type CanonicalJobMatch = {
  jobId: string;
  method: "stable_id" | "canonical_url" | "high_confidence";
  score: number;
};

const TRACKING_PARAMETERS = new Set([
  "gh_src",
  "lever-source",
  "source",
  "ref",
  "referrer",
  "trk",
]);

export function normalizeCanonicalJobUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    ) url.port = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    return url.toString();
  } catch {
    return value.trim();
  }
}

const normalizeText = (value: string) => value
  .normalize("NFKD")
  .toLowerCase()
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .replace(/\s+/g, " ");

const employmentType = (value: string) => {
  const normalized = normalizeText(value).replace(/\s/g, "");
  const aliases: Record<string, string> = {
    fulltime: "fulltime",
    permanent: "fulltime",
    parttime: "parttime",
    contract: "contract",
    contractor: "contract",
    temporary: "temporary",
    temp: "temporary",
    internship: "internship",
    intern: "internship",
  };
  return aliases[normalized] || normalized;
};

const tokens = (value: string) => new Set(
  normalizeText(value).split(" ").filter((token) => token.length > 1)
);

function jaccard(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function locationSimilarity(left: string, right: string) {
  const leftNormalized = normalizeText(left);
  const rightNormalized = normalizeText(right);
  if (!leftNormalized || !rightNormalized) return 0;
  if (leftNormalized === rightNormalized) return 1;
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  return jaccard(leftTokens, rightTokens);
}

function publishedWithinWindow(left: string | null, right: string | null) {
  if (!left || !right) return false;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) &&
    Number.isFinite(rightTime) &&
    Math.abs(leftTime - rightTime) <= 14 * 86_400_000;
}

function highConfidenceScore(job: NormalizedJob, candidate: CanonicalJobCandidate) {
  if (normalizeText(job.title) !== normalizeText(candidate.title)) return null;
  if (
    !employmentType(job.employmentType) ||
    employmentType(job.employmentType) !== employmentType(candidate.employmentType)
  ) return null;
  const location = locationSimilarity(job.location, candidate.location);
  if (location < 0.6) return null;
  const description = jaccard(tokens(job.summary), tokens(candidate.summary));
  if (description < 0.55) return null;
  if (!publishedWithinWindow(job.publishedAt, candidate.publishedAt)) return null;
  return 0.35 + 0.15 + (location * 0.2) + (description * 0.2) + 0.1;
}

export function selectCanonicalJobMatch(
  source: {
    companyId: string;
    provider: AtsProvider;
    sourceId: string;
  },
  job: NormalizedJob,
  candidates: CanonicalJobCandidate[]
): CanonicalJobMatch | null {
  const sameCompany = candidates.filter((candidate) => candidate.companyId === source.companyId);
  const stable = sameCompany.find((candidate) =>
    candidate.provider === source.provider &&
    candidate.sourceId === source.sourceId &&
    candidate.externalId === job.externalId
  );
  if (stable) return { jobId: stable.id, method: "stable_id", score: 1 };

  const normalizedUrl = normalizeCanonicalJobUrl(job.canonicalUrl);
  const urlMatches = new Set(
    sameCompany
      .filter((candidate) =>
        normalizeCanonicalJobUrl(candidate.canonicalUrl) === normalizedUrl
      )
      .map((candidate) => candidate.id)
  );
  if (urlMatches.size === 1) {
    return { jobId: [...urlMatches][0], method: "canonical_url", score: 1 };
  }

  const scoredByJob = new Map<string, { candidate: CanonicalJobCandidate; score: number }>();
  for (const item of sameCompany
    .filter((candidate) =>
      candidate.status === "verified_open" &&
      (candidate.provider !== source.provider || candidate.sourceId !== source.sourceId)
    )
    .map((candidate) => ({ candidate, score: highConfidenceScore(job, candidate) }))
    .filter((item): item is { candidate: CanonicalJobCandidate; score: number } =>
      item.score !== null
    )) {
    const current = scoredByJob.get(item.candidate.id);
    if (!current || item.score > current.score) scoredByJob.set(item.candidate.id, item);
  }
  const scored = [...scoredByJob.values()]
    .sort((left, right) => right.score - left.score);
  if (!scored.length) return null;
  if (scored[1] && scored[0].score - scored[1].score < 0.05) return null;
  return {
    jobId: scored[0].candidate.id,
    method: "high_confidence",
    score: scored[0].score,
  };
}
