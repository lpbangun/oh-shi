import { normalizeDomain, type AtsProvider } from "./source-registry";

export type DiscoveryCandidateInput = {
  name: string;
  websiteUrl: string;
  investorId: string;
  evidenceUrl: string;
};

export type MergedDiscoveryCandidate = {
  name: string;
  domain: string;
  websiteUrl: string;
  investors: Array<{ investorId: string; evidenceUrl: string }>;
};

export function mergeDiscoveryCandidates(inputs: DiscoveryCandidateInput[]) {
  const merged = new Map<string, MergedDiscoveryCandidate>();
  for (const input of inputs) {
    const domain = normalizeDomain(input.websiteUrl);
    if (!domain) continue;
    const current = merged.get(domain) || {
      name: input.name,
      domain,
      websiteUrl: input.websiteUrl,
      investors: [],
    };
    if (!current.investors.some((item) => item.investorId === input.investorId)) {
      current.investors.push({ investorId: input.investorId, evidenceUrl: input.evidenceUrl });
      current.investors.sort((a, b) => a.investorId.localeCompare(b.investorId));
    }
    merged.set(domain, current);
  }
  return [...merged.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

export type ExistingJobIdentity = {
  id: string;
  provider: AtsProvider;
  sourceId: string;
  externalId: string;
  status: string;
};

export function jobsToCloseAfterFetch(
  existing: ExistingJobIdentity[],
  source: { provider: AtsProvider; sourceId: string },
  observedExternalIds: string[] | null
) {
  // null means failed or incomplete. Absence cannot be inferred.
  if (observedExternalIds === null) return [];
  const observed = new Set(observedExternalIds);
  return existing.filter((job) =>
    job.provider === source.provider &&
    job.sourceId === source.sourceId &&
    job.status === "verified_open" &&
    !observed.has(job.externalId)
  ).map((job) => job.id);
}

export const MASS_DELETION_GUARD = {
  minimumExistingOpen: 20,
  minimumMissing: 10,
  maximumAcceptedMissingRatio: 0.5,
} as const;

export function assessCanonicalSnapshot(
  existingOpenCount: number,
  observedOpenCount: number
) {
  const existing = Math.max(0, Math.trunc(existingOpenCount));
  const observed = Math.max(0, Math.trunc(observedOpenCount));
  const missingCount = Math.max(0, existing - observed);
  const missingRatio = existing ? missingCount / existing : 0;
  const quarantined =
    existing >= MASS_DELETION_GUARD.minimumExistingOpen &&
    missingCount >= MASS_DELETION_GUARD.minimumMissing &&
    missingRatio > MASS_DELETION_GUARD.maximumAcceptedMissingRatio;
  return {
    status: quarantined ? "quarantined" as const : "accepted" as const,
    existingOpenCount: existing,
    observedOpenCount: observed,
    missingCount,
    missingRatio,
    reason: quarantined ? "mass_deletion_guard" as const : null,
  };
}

export function planCanonicalClosures(
  existing: Array<{ id: string; externalId: string; status: string }>,
  observedExternalIds: string[]
) {
  const open = existing.filter((job) => job.status === "verified_open");
  const observed = new Set(observedExternalIds);
  const missing = open.filter((job) => !observed.has(job.externalId));
  const retainedExistingCount = open.length - missing.length;
  const assessment = {
    ...assessCanonicalSnapshot(open.length, retainedExistingCount),
    // Keep the durable receipt truthful about the entire current payload while
    // deriving disappearance from overlap with the prior identity set.
    observedOpenCount: observed.size,
  };
  if (assessment.status === "quarantined") {
    return {
      assessment,
      closingJobIds: [] as string[],
      closingExternalIds: [] as string[],
    };
  }
  return {
    assessment,
    closingJobIds: missing.map((job) => job.id),
    // A canonical job may have multiple observations even within one source.
    // Closure therefore targets the missing source identity, not every
    // observation that happens to resolve to the same canonical job.
    closingExternalIds: missing.map((job) => job.externalId),
  };
}

export function snapshotFingerprint(externalIds: string[]) {
  const normalized = [...new Set(externalIds.map((value) => value.trim()).filter(Boolean))]
    .sort()
    .join("\n");
  let hash = 2166136261;
  for (const character of normalized) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}:${normalized ? normalized.split("\n").length : 0}`;
}

export function jobIdentity(provider: AtsProvider, sourceId: string, externalId: string) {
  return `${provider}:${sourceId}:${externalId}`;
}

export function refreshOutcome(results: Array<{ status: "success" | "failed" }>, threshold = 0.5) {
  const successes = results.filter((result) => result.status === "success").length;
  const ratio = results.length ? successes / results.length : 0;
  return {
    successes,
    failures: results.length - successes,
    partialSuccess: successes > 0 && successes < results.length,
    meetsThreshold: results.length > 0 && ratio >= threshold,
  };
}

export function portfolioWindow<T>(values: T[], cursor: number, limit = 20) {
  const start = cursor >= 0 && cursor < values.length ? cursor : 0;
  const items = values.slice(start, start + Math.max(1, limit));
  return {
    items,
    nextCursor: start + items.length >= values.length ? 0 : start + items.length,
  };
}

export function groupSourcesByCompany<T extends { companyId: string }>(sources: T[]) {
  const grouped = new Map<string, T[]>();
  for (const source of sources) {
    const group = grouped.get(source.companyId) || [];
    group.push(source);
    grouped.set(source.companyId, group);
  }
  return [...grouped.values()];
}

export async function processSequentiallyIsolated<T, R>(
  values: T[],
  work: (value: T) => Promise<R>,
  onFailure?: (value: T, error: unknown) => Promise<void>
) {
  const results: R[] = [];
  const failures: Array<{ value: T; error: unknown }> = [];
  for (const value of values) {
    try {
      results.push(await work(value));
    } catch (error) {
      failures.push({ value, error });
      try {
        await onFailure?.(value, error);
      } catch {
        // Failure bookkeeping must not prevent the remaining work from running.
      }
    }
  }
  return { results, failures };
}

export async function attemptWithFallback<T>(
  work: () => Promise<T>,
  fallback: (error: unknown) => T
) {
  try {
    return await work();
  } catch (error) {
    return fallback(error);
  }
}

export function changeEventId(kind: "open" | "close", jobId: string, occurredAt: string) {
  return `change_${kind}_${jobId}_${occurredAt.slice(0, 10)}`;
}
