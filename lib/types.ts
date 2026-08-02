export const SECTOR_TAXONOMY = [
  "Healthcare",
  "Developer Tools",
  "Enterprise Software",
  "Science & Research",
  "Food & Commerce",
  "Financial Technology",
  "Education Technology",
  "Climate & Energy",
  "Consumer",
  "Cybersecurity",
  "Logistics & Mobility",
  "Media & Entertainment",
  "Government & Defense",
  "Real Estate",
  "Human Resources",
  "Legal Technology",
  "Other",
] as const;

export type SectorName = (typeof SECTOR_TAXONOMY)[number];

/**
 * Convert source-provided industry labels into the stable public taxonomy.
 *
 * Industry remains the verbatim source label; sector is deliberately broader
 * so consumers do not need to reconcile dozens of near-duplicate labels.
 */
export function normalizeSector(industry: string): SectorName {
  const value = industry.trim().toLowerCase();
  const matches = (pattern: RegExp) => pattern.test(value);

  if (matches(/health|medical|medicine|clinical|biotech|pharma|life science/)) {
    return "Healthcare";
  }
  if (matches(/developer|devtool|software engineering|code|programming/)) {
    return "Developer Tools";
  }
  if (matches(/cyber|security|identity|fraud/)) return "Cybersecurity";
  if (matches(/fintech|financial|banking|payments|insurance/)) {
    return "Financial Technology";
  }
  if (matches(/education|edtech|learning|school/)) return "Education Technology";
  if (matches(/climate|energy|carbon|sustainab|cleantech/)) return "Climate & Energy";
  if (matches(/logistics|mobility|transport|supply chain|delivery/)) {
    return "Logistics & Mobility";
  }
  if (matches(/media|entertainment|gaming|music|creator/)) {
    return "Media & Entertainment";
  }
  if (matches(/government|defense|public sector|civic/)) return "Government & Defense";
  if (matches(/real estate|proptech|property|construction/)) return "Real Estate";
  if (matches(/human resources|hr tech|recruit|people operations/)) return "Human Resources";
  if (matches(/legal|law|compliance/)) return "Legal Technology";
  if (matches(/science|research|laboratory|discovery/)) return "Science & Research";
  if (matches(/food|restaurant|commerce|retail|marketplace/)) return "Food & Commerce";
  if (matches(/enterprise|b2b|business software|saas|automation/)) {
    return "Enterprise Software";
  }
  if (matches(/consumer|social|travel|wellness|personal/)) return "Consumer";
  return "Other";
}

export type Company = {
  id: string;
  slug: string;
  name: string;
  domain: string;
  description: string;
  foundedYear: number | null;
  headquarters: string;
  employeeRange: string;
  industry: string;
  sector: SectorName;
  stage: string;
  fundingMode: string;
  lifecycleStatus: string;
  hiringScore: number;
  evidenceConfidence: number;
  latestFundingLabel: string;
  latestFundingDate: string | null;
  careersUrl: string;
  sourceUrl: string;
  openJobCount: number;
  lastVerifiedAt: string;
  firstDiscoveredAt?: string | null;
  investors?: string[];
  providers?: string[];
};

export type Job = {
  id: string;
  companyId: string;
  externalId: string;
  provider?: string;
  sourceId?: string;
  title: string;
  roleFamily: string;
  location: string;
  remoteStatus: string;
  employmentType: string;
  compensation: string;
  canonicalUrl: string;
  source: string;
  status: string;
  firstSeenAt: string;
  lastSeenAt: string;
  sourceUpdatedAt: string | null;
  publishedAt?: string | null;
  lastVerifiedAt: string;
  closedAt: string | null;
  rawUrl: string;
  discoveryChannel: string;
  evidenceUrl: string;
  parserVersion: string;
  snapshotRunId: string;
  linkedInPresenceState: "confirmed" | "not_observed" | "unknown";
  linkedInEvidenceUrl: string | null;
  linkedInCheckedAt: string | null;
  summary: string;
  company?: Company;
};

export const HIRING_SIGNAL_SOURCE_KINDS = [
  "company_blog",
  "rss",
  "github",
  "hacker_news",
  "authorized_api",
  "submission",
] as const;

export type HiringSignalSourceKind = (typeof HIRING_SIGNAL_SOURCE_KINDS)[number];

export type HiringSignal = {
  id: string;
  companyId: string | null;
  companyName: string;
  companyDomain: string;
  roleFunction: string;
  summary: string;
  sourceKind: HiringSignalSourceKind;
  sourceUrl: string;
  evidenceUrl: string;
  sourceRightsUrl: string;
  applicationUrl: string | null;
  permissionStatus: "permitted" | "authorized" | "manual_reviewed";
  confidence: number;
  status: "active" | "expired" | "unverifiable" | "promoted";
  observedAt: string;
  lastVerifiedAt: string;
  expiresAt: string;
  promotedJobId: string | null;
};

export type OffBoardVerifiedOpening = {
  signalId: string;
  jobId: string;
  companyId: string;
  companyName: string;
  companyDomain: string;
  title: string;
  location: string;
  employmentType: string;
  canonicalUrl: string;
  evidenceUrl: string;
  sourceRightsUrl: string;
  discoverySourceKind: HiringSignalSourceKind;
  verifiedAt: string;
};

export type CoverageMetrics = {
  verifiedOpenJobs: number;
  activeHiringSignals: number;
  offBoardVerifiedOpenings: number;
  offBoardVerifiedCompanies: number;
  activeCompanies: number;
  startupDomains: number;
  pilotStartupDomains: number;
  pendingStartupDomains: number;
  verifiedActiveStartupDomains: number;
  companiesAddedLast7Days: number;
  companiesAddedLast1Day: number;
  jobsAddedLast24Hours: number;
  lastDiscoveryRun: string | null;
  lastCanonicalRefresh: string | null;
  consecutiveDaysWithoutCompanyGrowth: number;
  companyGrowthWarning: boolean;
  investors: Record<string, number>;
  providers: Record<string, number>;
  sourceFailures: Array<{
    sourceId: string;
    provider: string;
    lastError: string;
    consecutiveFailures: number;
    lastSuccessfulAt: string | null;
  }>;
  discoverySourceFailures: Array<{
    sourceId: string;
    lastError: string;
    lastSuccessfulAt: string | null;
  }>;
};

export type ChangeEvent = {
  id: string;
  entityType: string;
  entityId: string;
  changeType: string;
  title: string;
  description: string;
  occurredAt: string;
  sourceUrl: string;
};

export type MovementJobEvidence = {
  id: string;
  title: string;
  changeType: "job_opened" | "job_closed";
  canonicalUrl: string;
  sourceUrl: string;
};

export type MarketMovement = {
  /** Stable across refreshes: movement:<group>:<day>:<entity key>. */
  id: string;
  group: "company" | "sector";
  type: "opened" | "closed" | "mixed" | "funding";
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  title: string;
  description: string;
  sector: SectorName;
  companyId: string | null;
  companySlug: string | null;
  openedCount: number;
  closedCount: number;
  netChange: number;
  jobs: MovementJobEvidence[];
  evidenceCount: number;
  sourceUrls: string[];
  /** Current calibrated company score for company movements. */
  hiringScore: number | null;
  /** Internal destination suitable for a clickable movement row. */
  href: string;
};
