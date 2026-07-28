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

export function changeEventId(kind: "open" | "close", jobId: string, occurredAt: string) {
  return `change_${kind}_${jobId}_${occurredAt.slice(0, 10)}`;
}
