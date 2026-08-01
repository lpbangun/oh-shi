import { getDomain } from "tldts";

export type DomainPermissionStatus =
  | "permitted"
  | "manual_only"
  | "awaiting_permission"
  | "prohibited";

export type DomainActivityState = "unknown" | "active" | "inactive";
export type DomainReviewStatus = "pending" | "verified" | "rejected";
export type DomainAcquisitionRelation = "acquired_from" | "acquired_by";

export type DomainRelationEvidence = {
  evidenceUrl: string;
  permissionStatus: DomainPermissionStatus;
  sourceTermsUrl?: string;
  observedAt: string;
};

export type StartupDomainEvidenceInput = {
  companyName: string;
  websiteUrl: string;
  observedWebsiteUrls?: string[];
  aliases?: Array<DomainRelationEvidence & {
    aliasDomain: string;
  }>;
  acquisitions?: Array<DomainRelationEvidence & {
    relatedDomain: string;
    relation: DomainAcquisitionRelation;
  }>;
  sourceId: string;
  sourceKind: string;
  sourceClassification: string;
  evidenceUrl: string;
  permissionStatus: DomainPermissionStatus;
  sourceTermsUrl?: string;
  observedAt: string;
  activityState?: DomainActivityState;
  reviewStatus?: DomainReviewStatus;
};

export type StartupDomainEvidence = {
  sourceId: string;
  sourceKind: string;
  sourceClassification: string;
  evidenceUrl: string;
  permissionStatus: DomainPermissionStatus;
  sourceTermsUrl: string | null;
  observedAt: string;
  observedWebsiteUrls: string[];
};

export type StartupDomainAlias = {
  aliasDomain: string;
  evidenceUrl: string;
  permissionStatus: DomainPermissionStatus;
  sourceTermsUrl: string | null;
  observedAt: string;
};

export type StartupDomainEntry = {
  canonicalDomain: string;
  companyName: string;
  websiteUrl: string;
  aliases: StartupDomainAlias[];
  acquisitions: Array<{
    relatedDomain: string;
    relation: DomainAcquisitionRelation;
    evidenceUrl: string;
    permissionStatus: DomainPermissionStatus;
    sourceTermsUrl: string | null;
    observedAt: string;
  }>;
  activityState: DomainActivityState;
  reviewStatus: DomainReviewStatus;
  pilotCohort: string;
  evidence: StartupDomainEvidence[];
};

const PERMISSION_STATUSES = new Set<DomainPermissionStatus>([
  "permitted",
  "manual_only",
  "awaiting_permission",
  "prohibited",
]);
const ACTIVITY_STATES = new Set<DomainActivityState>([
  "unknown",
  "active",
  "inactive",
]);
const REVIEW_STATUSES = new Set<DomainReviewStatus>([
  "pending",
  "verified",
  "rejected",
]);

function httpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function registrableDomain(value: string) {
  const candidate = value.trim().toLowerCase();
  if (!candidate) return "";
  const normalized = candidate.replace(/\.$/, "");
  const domain = getDomain(normalized, {
    allowIcannDomains: true,
    allowPrivateDomains: true,
    detectIp: true,
    validateHostname: true,
  });
  return domain?.toLowerCase().replace(/\.$/, "") || "";
}

export function careerFingerprint(
  provider: string,
  boardId: string,
  careersUrl: string
) {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedBoard = boardId.trim().toLowerCase();
  const url = httpsUrl(careersUrl);
  if (!normalizedProvider || !normalizedBoard || !url) return "";
  return `${normalizedProvider}:${normalizedBoard}:${url.hostname.toLowerCase().replace(/^www\./, "")}`;
}

function normalizedRecord(
  input: StartupDomainEvidenceInput,
  pilotCohort: string
): StartupDomainEntry | null {
  const companyName = input.companyName.trim().replace(/\s+/g, " ").slice(0, 200);
  const website = httpsUrl(input.websiteUrl);
  const evidence = httpsUrl(input.evidenceUrl);
  const terms = input.sourceTermsUrl ? httpsUrl(input.sourceTermsUrl) : null;
  const sourceId = input.sourceId.trim().slice(0, 200);
  const sourceKind = input.sourceKind.trim().slice(0, 100);
  const sourceClassification = input.sourceClassification.trim().slice(0, 100);
  const observedAt = new Date(input.observedAt);
  const activityState = input.activityState || "unknown";
  const reviewStatus = input.reviewStatus || "pending";
  if (
    !companyName ||
    !website ||
    !evidence ||
    (input.sourceTermsUrl !== undefined && !terms) ||
    (input.permissionStatus === "permitted" && !terms) ||
    !sourceId ||
    !sourceKind ||
    !sourceClassification ||
    !PERMISSION_STATUSES.has(input.permissionStatus) ||
    !ACTIVITY_STATES.has(activityState) ||
    !REVIEW_STATUSES.has(reviewStatus) ||
    !Number.isFinite(observedAt.valueOf())
  ) return null;
  const canonicalDomain = registrableDomain(website.href);
  if (!canonicalDomain) return null;

  const observedWebsiteUrls: string[] = [];
  for (const value of input.observedWebsiteUrls || []) {
    const observedWebsite = httpsUrl(value);
    if (!observedWebsite) return null;
    if (observedWebsite.href !== website.href) observedWebsiteUrls.push(observedWebsite.href);
  }
  const aliases: StartupDomainAlias[] = [];
  for (const item of input.aliases || []) {
    const aliasDomain = registrableDomain(item.aliasDomain);
    const aliasEvidence = httpsUrl(item.evidenceUrl);
    const aliasTerms = item.sourceTermsUrl ? httpsUrl(item.sourceTermsUrl) : null;
    const aliasObservedAt = new Date(item.observedAt);
    if (
      !aliasDomain ||
      aliasDomain === canonicalDomain ||
      !aliasEvidence ||
      !PERMISSION_STATUSES.has(item.permissionStatus) ||
      (item.sourceTermsUrl !== undefined && !aliasTerms) ||
      !Number.isFinite(aliasObservedAt.valueOf())
    ) return null;
    aliases.push({
      aliasDomain,
      evidenceUrl: aliasEvidence.href,
      permissionStatus: item.permissionStatus,
      sourceTermsUrl: aliasTerms?.href || null,
      observedAt: aliasObservedAt.toISOString(),
    });
  }
  aliases.sort((left, right) => left.aliasDomain.localeCompare(right.aliasDomain));
  const acquisitions: StartupDomainEntry["acquisitions"] = [];
  for (const item of input.acquisitions || []) {
    const relatedDomain = registrableDomain(item.relatedDomain);
    const relationEvidence = httpsUrl(item.evidenceUrl);
    const relationTerms = item.sourceTermsUrl ? httpsUrl(item.sourceTermsUrl) : null;
    const relationObservedAt = new Date(item.observedAt);
    if (
      !relatedDomain ||
      relatedDomain === canonicalDomain ||
      !relationEvidence ||
      !["acquired_from", "acquired_by"].includes(item.relation) ||
      !PERMISSION_STATUSES.has(item.permissionStatus) ||
      (item.sourceTermsUrl !== undefined && !relationTerms) ||
      !Number.isFinite(relationObservedAt.valueOf())
    ) return null;
    acquisitions.push({
      relatedDomain,
      relation: item.relation,
      evidenceUrl: relationEvidence.href,
      permissionStatus: item.permissionStatus,
      sourceTermsUrl: relationTerms?.href || null,
      observedAt: relationObservedAt.toISOString(),
    });
  }
  acquisitions.sort((left, right) =>
    `${left.relation}:${left.relatedDomain}`.localeCompare(
      `${right.relation}:${right.relatedDomain}`
    )
  );
  return {
    canonicalDomain,
    companyName,
    websiteUrl: website.href,
    aliases,
    acquisitions,
    activityState,
    reviewStatus,
    pilotCohort: pilotCohort.trim().slice(0, 100),
    evidence: [{
      sourceId,
      sourceKind,
      sourceClassification,
      evidenceUrl: evidence.href,
      permissionStatus: input.permissionStatus,
      sourceTermsUrl: terms?.href || null,
      observedAt: observedAt.toISOString(),
      observedWebsiteUrls: [...new Set(observedWebsiteUrls)].sort(),
    }],
  };
}

function mergeEntry(current: StartupDomainEntry, incoming: StartupDomainEntry) {
  const aliases = new Map(current.aliases.map((item) => [item.aliasDomain, item]));
  for (const item of incoming.aliases) aliases.set(item.aliasDomain, item);
  current.aliases = [...aliases.values()]
    .sort((left, right) => left.aliasDomain.localeCompare(right.aliasDomain));
  const acquisitions = new Map(current.acquisitions.map((item) => [
    `${item.relation}:${item.relatedDomain}`,
    item,
  ]));
  for (const item of incoming.acquisitions) {
    acquisitions.set(`${item.relation}:${item.relatedDomain}`, item);
  }
  current.acquisitions = [...acquisitions.values()].sort((left, right) =>
    `${left.relation}:${left.relatedDomain}`.localeCompare(
      `${right.relation}:${right.relatedDomain}`
    )
  );
  const evidence = new Map(current.evidence.map((item) => [
    `${item.sourceKind}:${item.sourceId}:${item.evidenceUrl}`,
    item,
  ]));
  for (const item of incoming.evidence) {
    const key = `${item.sourceKind}:${item.sourceId}:${item.evidenceUrl}`;
    const previous = evidence.get(key);
    evidence.set(key, previous ? {
      ...item,
      observedWebsiteUrls: [...new Set([
        ...previous.observedWebsiteUrls,
        ...item.observedWebsiteUrls,
      ])].sort(),
    } : item);
  }
  current.evidence = [...evidence.values()].sort((left, right) =>
    `${left.sourceKind}:${left.sourceId}:${left.evidenceUrl}`.localeCompare(
      `${right.sourceKind}:${right.sourceId}:${right.evidenceUrl}`
    )
  );
  if (current.activityState === "unknown" && incoming.activityState !== "unknown") {
    current.activityState = incoming.activityState;
  }
  if (current.reviewStatus === "pending" && incoming.reviewStatus !== "pending") {
    current.reviewStatus = incoming.reviewStatus;
  }
}

export function registryIdentityConflicts(entries: StartupDomainEntry[]) {
  const canonicalDomains = new Set(entries.map((entry) => entry.canonicalDomain));
  const aliasOwners = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      if (canonicalDomains.has(alias.aliasDomain)) {
        conflicts.add(`alias_is_canonical:${alias.aliasDomain}`);
      }
      const owner = aliasOwners.get(alias.aliasDomain);
      if (owner && owner !== entry.canonicalDomain) {
        conflicts.add(`alias_has_multiple_owners:${alias.aliasDomain}`);
      } else {
        aliasOwners.set(alias.aliasDomain, entry.canonicalDomain);
      }
    }
  }
  return [...conflicts].sort();
}

/**
 * The pilot was capped at 500 while the cohort was hand-reviewed. Discovery now
 * runs continuously against an open startup directory, so the ceiling only
 * exists to bound a single run's memory.
 */
export const MAX_PILOT_DOMAINS = 25_000;

export function buildStartupDomainPilot(
  inputs: StartupDomainEvidenceInput[],
  limit = 500,
  pilotCohort = ""
) {
  const boundedLimit = Math.min(MAX_PILOT_DOMAINS, Math.max(1, Math.trunc(limit)));
  const entries = new Map<string, StartupDomainEntry>();
  let validRecords = 0;
  let rejectedRecords = 0;
  for (const input of inputs) {
    const normalized = normalizedRecord(input, pilotCohort);
    if (!normalized) {
      rejectedRecords += 1;
      continue;
    }
    validRecords += 1;
    const current = entries.get(normalized.canonicalDomain);
    if (current) mergeEntry(current, normalized);
    else entries.set(normalized.canonicalDomain, normalized);
  }
  const allEntries = [...entries.values()]
    .sort((left, right) => left.canonicalDomain.localeCompare(right.canonicalDomain));
  const acceptedEntries = allEntries.slice(0, boundedLimit);
  const identityConflicts = registryIdentityConflicts(acceptedEntries);
  return {
    entries: acceptedEntries,
    identityConflicts,
    receipt: {
      inputRecords: inputs.length,
      validRecords,
      rejectedRecords,
      duplicateDomains: validRecords - allEntries.length,
      eligibleDomains: allEntries.length,
      accepted: acceptedEntries.length,
      truncatedDomains: Math.max(0, allEntries.length - acceptedEntries.length),
      limit: boundedLimit,
      reconciled: validRecords + rejectedRecords === inputs.length,
      identityGraphValid: identityConflicts.length === 0,
    },
  };
}

export function resolveCanonicalRegistryDomain(
  value: string,
  entries: StartupDomainEntry[]
) {
  const domain = registrableDomain(value);
  if (!domain) return "";
  const direct = entries.find((entry) => entry.canonicalDomain === domain);
  if (direct) return direct.canonicalDomain;
  const aliased = entries.find((entry) =>
    entry.aliases.some((alias) => alias.aliasDomain === domain)
  );
  return aliased?.canonicalDomain || domain;
}
