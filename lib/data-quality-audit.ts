import {
  detectAtsFromLinks,
  type CanonicalFetch,
} from "./ats-adapters";
import { normalizeCanonicalJobUrl } from "./job-canonicalization";
import type { AtsProvider } from "./source-registry";

export type QualityAuditJob = {
  id: string;
  companyId: string;
  externalId: string;
  title: string;
  location: string;
  employmentType: string;
  canonicalUrl: string;
  source: string;
  status: string;
  lastVerifiedAt: string;
  company?: {
    name: string;
    careersUrl: string;
  };
};

export type QualityAuditSource = {
  provider: Exclude<AtsProvider, "manual">;
  boardId: string;
};

export type QualityAuditRow = {
  id: string;
  companyId: string;
  companyName: string;
  externalId: string;
  title: string;
  location: string;
  employmentType: string;
  canonicalUrl: string;
  provider: string | null;
  boardId: string | null;
  freshness: "fresh" | "stale" | "ineligible" | "inconclusive";
  freshnessReason: string;
  duplicateOf: string | null;
  reviewClusterSize: number;
};

export type QualityAuditResult = {
  inventorySize: number;
  sampleSize: number;
  requestedSampleSize: number;
  sourceCollections: number;
  sourceErrors: Array<{ source: string; reason: string }>;
  auditedSourceEligibleObservations: number;
  auditedSourceEligibleNotInInventory: number;
  fresh: number;
  stale: number;
  ineligible: number;
  inconclusive: number;
  exactDuplicates: number;
  reviewClusters: number;
  staleRate: number | null;
  ineligibleRate: number | null;
  exactDuplicateRate: number;
  rows: QualityAuditRow[];
};

export type QualityAuditCollection = CanonicalFetch;

const hash = (value: string) => {
  let current = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    current ^= value.charCodeAt(index);
    current = Math.imul(current, 16_777_619);
  }
  return current >>> 0;
};

const ranked = (jobs: QualityAuditJob[], seed: string) =>
  [...jobs].sort((left, right) => {
    const difference = hash(`${seed}:${left.id}`) - hash(`${seed}:${right.id}`);
    return difference || left.id.localeCompare(right.id);
  });

export function selectDeterministicAuditSample(
  jobs: QualityAuditJob[],
  requestedSize = 200,
  seed = "oh-shi-quality-v1"
) {
  const size = Math.max(0, Math.min(Math.floor(requestedSize), jobs.length));
  if (!size) return [];

  const selected = new Map<string, QualityAuditJob>();
  const byCompany = new Map<string, QualityAuditJob[]>();
  for (const job of jobs) {
    const group = byCompany.get(job.companyId) || [];
    group.push(job);
    byCompany.set(job.companyId, group);
  }

  if (size >= byCompany.size) {
    for (const companyId of [...byCompany.keys()].sort()) {
      const first = ranked(byCompany.get(companyId) || [], seed)[0];
      if (first) selected.set(first.id, first);
    }
  }
  for (const job of ranked(jobs, seed)) {
    if (selected.size === size) break;
    selected.set(job.id, job);
  }
  return [...selected.values()];
}

export function inferQualityAuditSource(
  job: QualityAuditJob
): QualityAuditSource | null {
  const detected = detectAtsFromLinks([
    job.company?.careersUrl || "",
    job.canonicalUrl,
  ]);
  return detected
    ? { provider: detected.provider, boardId: detected.boardId }
    : null;
}

const sourceKey = (source: QualityAuditSource) =>
  `${source.provider}:${source.boardId}`;

const comparable = (value: string) =>
  value.toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").trim();

const reviewKey = (job: QualityAuditJob) =>
  [
    job.companyId,
    comparable(job.title),
    comparable(job.location),
    comparable(job.employmentType),
  ].join("|");

export async function auditDataQuality(
  inventory: QualityAuditJob[],
  options: {
    sampleSize?: number;
    seed?: string;
    fetchSource: (
      source: QualityAuditSource
    ) => Promise<QualityAuditCollection>;
  }
): Promise<QualityAuditResult> {
  const requestedSampleSize = options.sampleSize ?? 200;
  const sample = selectDeterministicAuditSample(
    inventory.filter((job) => job.status === "verified_open"),
    requestedSampleSize,
    options.seed
  );
  const sources = new Map<string, QualityAuditSource>();
  const sourceByJob = new Map<string, QualityAuditSource>();
  for (const job of sample) {
    const source = inferQualityAuditSource(job);
    if (!source) continue;
    sources.set(sourceKey(source), source);
    sourceByJob.set(job.id, source);
  }

  const collections = new Map<string, QualityAuditCollection>();
  const failures = new Map<string, string>();
  await Promise.all([...sources.entries()].map(async ([key, source]) => {
    try {
      const result = await options.fetchSource(source);
      if (!result || result.complete !== true || !Array.isArray(result.jobs)) {
        throw new Error("source response was not a complete canonical collection");
      }
      collections.set(key, result);
    } catch (error) {
      failures.set(
        key,
        error instanceof Error ? error.message : "unknown source failure"
      );
    }
  }));

  const inventoryStableIdentities = new Set<string>();
  const inventoryCanonicalUrls = new Set<string>();
  for (const job of inventory) {
    const source = inferQualityAuditSource(job);
    if (!source) continue;
    const key = sourceKey(source);
    inventoryStableIdentities.add(`${key}:${job.externalId}`);
    inventoryCanonicalUrls.add(normalizeCanonicalJobUrl(job.canonicalUrl));
  }
  let auditedSourceEligibleObservations = 0;
  let auditedSourceEligibleNotInInventory = 0;
  const countedSourceObservations = new Set<string>();
  for (const [key, collection] of collections) {
    for (const current of collection.jobs) {
      const stableIdentity = `${key}:${current.externalId}`;
      if (countedSourceObservations.has(stableIdentity)) continue;
      countedSourceObservations.add(stableIdentity);
      auditedSourceEligibleObservations += 1;
      if (
        !inventoryStableIdentities.has(stableIdentity) &&
        !inventoryCanonicalUrls.has(
          normalizeCanonicalJobUrl(current.canonicalUrl)
        )
      ) {
        auditedSourceEligibleNotInInventory += 1;
      }
    }
  }

  const stableIdentityOwner = new Map<string, string>();
  const canonicalUrlOwner = new Map<string, string>();
  const reviewGroups = new Map<string, number>();
  for (const job of sample) {
    const key = reviewKey(job);
    reviewGroups.set(key, (reviewGroups.get(key) || 0) + 1);
  }

  const rows = sample.map<QualityAuditRow>((job) => {
    const source = sourceByJob.get(job.id);
    let freshness: QualityAuditRow["freshness"] = "inconclusive";
    let freshnessReason = "supported canonical source could not be inferred";
    let duplicateOf: string | null = null;

    if (source) {
      const key = sourceKey(source);
      const failure = failures.get(key);
      const collection = collections.get(key);
      if (failure) {
        freshnessReason = `canonical source failed: ${failure}`;
      } else if (collection) {
        const canonicalUrl = normalizeCanonicalJobUrl(job.canonicalUrl);
        const match = collection.jobs.find((current) =>
          current.externalId === job.externalId ||
          normalizeCanonicalJobUrl(current.canonicalUrl) === canonicalUrl
        );
        if (match) {
          freshness = "fresh";
          freshnessReason = match.externalId === job.externalId
            ? "stable source ID is present in the complete current eligible collection"
            : "canonical URL is present in the complete current eligible collection";
        } else if (collection.observedJobs) {
          const observed = collection.observedJobs.find((current) =>
            current.externalId === job.externalId ||
            normalizeCanonicalJobUrl(current.canonicalUrl) === canonicalUrl
          );
          freshness = observed ? "ineligible" : "stale";
          freshnessReason = observed
            ? "role is still published, but the canonical adapter rejects it as ineligible"
            : "stable source ID and canonical URL are absent from the complete raw current collection";
        } else {
          freshnessReason =
            "record is absent from the eligible collection, but raw publication coverage is unavailable";
        }

        const stableKey = `${key}:${job.externalId}`;
        const stableOwner = stableIdentityOwner.get(stableKey);
        const urlOwner = canonicalUrlOwner.get(canonicalUrl);
        duplicateOf = stableOwner || urlOwner || null;
        stableIdentityOwner.set(stableKey, stableOwner || job.id);
        canonicalUrlOwner.set(canonicalUrl, urlOwner || job.id);
      }
    }

    return {
      id: job.id,
      companyId: job.companyId,
      companyName: job.company?.name || job.companyId,
      externalId: job.externalId,
      title: job.title,
      location: job.location,
      employmentType: job.employmentType,
      canonicalUrl: job.canonicalUrl,
      provider: source?.provider || null,
      boardId: source?.boardId || null,
      freshness,
      freshnessReason,
      duplicateOf,
      reviewClusterSize: reviewGroups.get(reviewKey(job)) || 1,
    };
  });

  const fresh = rows.filter((row) => row.freshness === "fresh").length;
  const stale = rows.filter((row) => row.freshness === "stale").length;
  const ineligible = rows.filter((row) => row.freshness === "ineligible").length;
  const inconclusive = rows.length - fresh - stale - ineligible;
  const exactDuplicates = rows.filter((row) => row.duplicateOf).length;
  const conclusive = fresh + stale + ineligible;
  const reviewClusters = new Set(
    sample
      .filter((job) => (reviewGroups.get(reviewKey(job)) || 0) > 1)
      .map(reviewKey)
  ).size;

  return {
    inventorySize: inventory.length,
    sampleSize: rows.length,
    requestedSampleSize,
    sourceCollections: collections.size,
    sourceErrors: [...failures.entries()].map(([source, reason]) => ({
      source,
      reason,
    })),
    auditedSourceEligibleObservations,
    auditedSourceEligibleNotInInventory,
    fresh,
    stale,
    ineligible,
    inconclusive,
    exactDuplicates,
    reviewClusters,
    staleRate: conclusive ? stale / conclusive : null,
    ineligibleRate: conclusive ? ineligible / conclusive : null,
    exactDuplicateRate: rows.length ? exactDuplicates / rows.length : 0,
    rows,
  };
}
