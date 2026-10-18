/**
 * Daily discovery engine — shared types.
 *
 * One core pipeline, two acquisition lanes (direct vs TinyFish). The lane is the
 * only deliberate variable; identity, US-HQ and funding verification rules,
 * persistence and reporting are shared.
 */

export type LaneId = "direct" | "tinyfish";

/** A candidate surfaced by an acquisition lane. A search hit is a lead, not verification. */
export type AcquisitionCandidate = {
  companyName: string;
  websiteUrl: string;
  evidenceUrl: string;
  publisher: string;
  /** Announcement/observation timestamp when the source supplied one; "" when absent. */
  observedAt: string;
  kind: "new_company" | "funding_event";
  /** Lane-provided headquarters evidence (e.g. Wikidata P159/P17). Verification still applies. */
  headquartersHint?: {
    location: string;
    method: string;
    evidenceUrl: string;
  } | null;
  /** Retained fetched document, never a search snippet. Permission is checked by adapters. */
  document?: { title: string; text: string; publishedAt: string; permission: "permitted" };
  /** For funding_event candidates. */
  funding?: {
    label: string | null;
    stage: string | null;
    /** completed = past-tense raise verbs; announced = present-tense announcement. */
    status: "announced" | "completed";
  } | null;
};

export type SourceReceipt = {
  sourceId: string;
  lane: LaneId;
  status: "completed" | "failed" | "blocked" | "deferred";
  requests: number;
  documentsChecked: number;
  candidatesFound: number;
  error?: string;
  /** Exact prerequisite text when status=blocked (e.g. missing credentials). */
  missingPrerequisite?: string;
  documentErrors?: Array<{ url: string; error: string }>;
};

export type LaneCheckpoint = {
  sourceId: string;
  cursor: string;
  status: "completed" | "partial";
  completedAt: string;
};

/** Shared mutable cap counter handed to lanes and the verifier. */
export type CapCounter = {
  fetchRequests: number;
  searchRequests: number;
  maxFetchRequests: number;
  maxSearchRequests: number;
  deadlineAt: number;
  exceeded: boolean;
};

export type HQStatus = "verified_us" | "non_us" | "unknown";

export type HQEvidence = {
  status: HQStatus;
  method: string;
  evidenceUrl: string | null;
  /** The exact location text that matched, when any. */
  matchedText: string | null;
  observedAt: string;
  /** Why status is unknown (failed retrieval is unknown, never non-US). */
  reason?: string;
};

export type VerifiedFundingEvent = {
  id: string;
  companyName: string;
  companyDomain: string;
  companyExisting: boolean;
  title: string;
  description: string;
  /** Announcement date from the source; empty string when the source omits it. */
  occurredAt: string;
  discoveredAt: string;
  lastCheckedAt: string;
  sourceUrl: string;
  sourceKind: "official" | "reputable";
  publisher: string;
  latestFundingLabel: string;
  stage: string | null;
  status: "announced" | "completed";
  evidenceGaps: string[];
};

/** A verified company record. Companies may exist with zero open jobs. */
export type EngineCompanyRecord = {
  id: string;
  slug: string;
  name: string;
  domain: string;
  description: string;
  headquarters: string;
  hqStatus: HQStatus;
  hqEvidenceUrl: string | null;
  hqMethod: string | null;
  foundedYear: number | null;
  employeeRange: string;
  industry: string;
  stage: string;
  fundingMode: string;
  lifecycleStatus: string;
  latestFundingLabel: string;
  latestFundingDate: string | null;
  careersUrl: string;
  sourceUrl: string;
  evidenceUrl: string;
  openJobCount: number;
  discoveredAt: string;
  lastCheckedAt: string;
  lane: LaneId;
};

export type EngineRecord = {
  company: EngineCompanyRecord;
  fundingEvents: VerifiedFundingEvent[];
  isNewCompany: boolean;
};

export type StageReceipt = {
  stage: "acquire" | "identity" | "us_hq" | "funding" | "persist" | "report";
  ok: boolean;
  detail: string;
  errors: string[];
};

export type EngineCounts = {
  candidatesAcquired: number;
  distinctDomains: number;
  duplicatesSkipped: number;
  baselineKnownSkipped: number;
  usHqVerified: number;
  usHqUnknown: number;
  nonUsExcluded: number;
  newCompaniesPersisted: number;
  /** All retained events, including pending-HQ companies; not verified-US counts. */
  fundingEventsNewCompanies: number;
  fundingEventsExistingCompanies: number;
  verifiedFundingEventsNewCompanies: number;
  verifiedFundingEventsExistingCompanies: number;
  pendingHqFundingEvents: number;
  fundingEventsWithoutDate: number;
  speculativeExcluded: number;
  falsePositivesExcluded: number;
};

export type EngineRunResult = {
  engineVersion: string;
  lane: LaneId;
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  lookbackDays: number;
  counts: EngineCounts;
  caps: {
    fetchRequests: number;
    searchRequests: number;
    fetchCap: number;
    searchCap: number;
    deadlineHit: boolean;
    elapsedMs: number;
  };
  stageReceipts: StageReceipt[];
  sourceReceipts: SourceReceipt[];
  records: EngineRecord[];
  checkpoint: LaneCheckpoint[];
};

export type AcquisitionLane = {
  id: LaneId;
  /** Acquire raw candidates per source, resuming from checkpoint, honoring caps. */
  acquire(context: {
    now: string;
    lookbackDays: number;
    caps: CapCounter;
    checkpoint: LaneCheckpoint[];
    /** Existing companies (maintenance lane); lanes may refresh their funding. */
    existingCompanies: Array<{ id: string; name: string; domain: string; sourceUrl: string }>;
  }): Promise<{
    candidates: AcquisitionCandidate[];
    receipts: SourceReceipt[];
    checkpoints: LaneCheckpoint[];
  }>;
};
