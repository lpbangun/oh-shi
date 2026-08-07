export const SECTOR_TAXONOMY = [
  "Healthcare",
  "Biotechnology & Life Sciences",
  "Artificial Intelligence",
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
  "Hardware & Robotics",
  "Government & Defense",
  "Real Estate",
  "Human Resources",
  "Legal Technology",
  "Other",
] as const;

export type SectorName = (typeof SECTOR_TAXONOMY)[number];

export type SectorContext = {
  /** Company name is source data and may be used when no industry is published. */
  name?: string | null;
  /** A stored company description may contain an explicit product category. */
  description?: string | null;
  /** Domain context is only used for explicit category words in the hostname. */
  domain?: string | null;
};

const normalizeSectorText = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[\/_&+-]+/g, " ")
    .replace(/\s+/g, " ");

const hasAny = (value: string, patterns: RegExp[]) => patterns.some((pattern) => pattern.test(value));

/**
 * Return a sector only when the label contains a recognizable category signal.
 * Rules are ordered from specific/domain-led to broad/platform-led so a label
 * such as "AI / Healthcare" stays in Healthcare rather than the generic AI
 * bucket. The original industry value is never rewritten.
 */
function classifyIndustryLabel(value: string): SectorName | null {
  if (hasAny(value, [
    /\bbiotech(?:nology)?\b/,
    /\blife science(?:s)?\b/,
    /\bgenomic(?:s)?\b/,
    /\bgenetic(?:s)?\b/,
    /\bdrug discovery\b/,
    /\bsynthetic biolog(?:y|ies)\b/,
    /\bbioinformatics\b/,
    /\bpharma(?:ceutical)?s?\b/,
    /\btherapeutics?\b/,
    /\bmolecular biolog(?:y|ies)\b/,
  ])) return "Biotechnology & Life Sciences";

  if (hasAny(value, [
    /\bhealth(?:care| tech|tech)?\b/,
    /\bdigital health\b/,
    /\bmedical\b/,
    /\bmedicine\b/,
    /\bclinical\b/,
    /\bmedtech\b/,
    /\bpatient\b/,
    /\bhospital\b/,
    /\bdiagnostic(?:s)?\b/,
    /\btelehealth\b/,
    /\bprecision medicine\b/,
    /\bcare delivery\b/,
  ])) return "Healthcare";

  if (hasAny(value, [
    /\bfintech\b/,
    /\bfinancial technology\b/,
    /\bfinancial service(?:s)?\b/,
    /\bbanking\b/,
    /\bpayments?\b/,
    /\bpayment processing\b/,
    /\blending\b/,
    /\bcredit\b/,
    /\binsur(?:ance|tech)\b/,
    /\bwealth(?:tech)?\b/,
    /\binvest(?:ment|ing)\b/,
    /\baccounting\b/,
    /\bexpense management\b/,
    /\bcorporate cards?\b/,
    /\bbusiness finance\b/,
  ])) return "Financial Technology";

  if (hasAny(value, [
    /\beducation\b/,
    /\bedtech\b/,
    /\blearning\b/,
    /\bschool\b/,
    /\bstudent\b/,
    /\btutoring\b/,
    /\buniversity\b/,
  ])) return "Education Technology";

  if (hasAny(value, [
    /\bcyber(?:security)?\b/,
    /\binformation security\b/,
    /\binfosec\b/,
    /\bapp(?:lication)? security\b/,
    /\bnetwork security\b/,
    /\bidentity(?: and access)?\b/,
    /\biam\b/,
    /\bfraud detection\b/,
    /\btrust management\b/,
    /\bsecurity\b/,
  ])) return "Cybersecurity";

  if (hasAny(value, [
    /\bclimate\b/,
    /\bclimate tech\b/,
    /\bclean(?:tech| tech| technology| energy)\b/,
    /\brenewable(?: energy)?\b/,
    /\bcarbon\b/,
    /\bemissions?\b/,
    /\bsustainab(?:ility|le)\b/,
    /\bdecarbon(?:ization|isation)?\b/,
    /\bsolar\b/,
    /\bwind energy\b/,
    /\benergy storage\b/,
  ])) return "Climate & Energy";

  if (hasAny(value, [
    /\blogistics\b/,
    /\bmobility\b/,
    /\btransport(?:ation)?\b/,
    /\bsupply chain\b/,
    /\bdelivery\b/,
    /\bfreight\b/,
    /\bfleet\b/,
    /\bwarehouse\b/,
    /\bshipping\b/,
    /\blast mile\b/,
    /\bev charging\b/,
    /\bautonomous vehicle(?:s)?\b/,
  ])) return "Logistics & Mobility";

  if (hasAny(value, [
    /\bmedia\b/,
    /\bentertainment\b/,
    /\bgaming\b/,
    /\bgame studio\b/,
    /\bmusic\b/,
    /\bcreator(?: economy)?\b/,
    /\bcontent\b/,
    /\bstreaming\b/,
    /\bpublishing\b/,
    /\bpodcast(?:s)?\b/,
    /\bvideo\b/,
  ])) return "Media & Entertainment";

  if (hasAny(value, [
    /\bgovernment\b/,
    /\bdefen[cs]e\b/,
    /\bpublic sector\b/,
    /\bcivic\b/,
    /\bgovtech\b/,
    /\bmilitary\b/,
  ])) return "Government & Defense";

  if (hasAny(value, [
    /\breal estate\b/,
    /\bproptech\b/,
    /\bproperty tech\b/,
    /\bproperty management\b/,
    /\bconstruction\b/,
    /\bhomebuilding\b/,
    /\bhousing\b/,
  ])) return "Real Estate";

  if (hasAny(value, [
    /\bhuman resources\b/,
    /\bhr tech\b/,
    /\bhrtech\b/,
    /\bpeople operations\b/,
    /\bpeople ops\b/,
    /\brecruit(?:ing|ment)?\b/,
    /\btalent management\b/,
    /\bworkforce management\b/,
    /\bpayroll\b/,
  ])) return "Human Resources";

  if (hasAny(value, [
    /\blegal\b/,
    /\blaw\b/,
    /\blaw firm\b/,
    /\blegaltech\b/,
    /\bcontract management\b/,
    /\blitigation\b/,
    /\battorney\b/,
    /\blegal ops\b/,
    /\bcompliance\b/,
  ])) return "Legal Technology";

  if (hasAny(value, [
    /\bdeveloper\b/,
    /\bdevtools?\b/,
    /\bdeveloper tools?\b/,
    /\bsoftware engineering\b/,
    /\bprogramming\b/,
    /\bcoding\b/,
    /\bcode hosting\b/,
    /\bapi platform\b/,
    /\bbackend infrastructure\b/,
    /\bfrontend\b/,
  ])) return "Developer Tools";

  if (hasAny(value, [
    /\bscience\b/,
    /\bresearch\b/,
    /\blaborator(?:y|ies)\b/,
    /\blab\b/,
    /\bdiscovery\b/,
    /\bquantum\b/,
    /\bmaterials science\b/,
    /\bscientific\b/,
  ])) return "Science & Research";

  if (hasAny(value, [
    /\bhardware\b/,
    /\brobotics?\b/,
    /\bsemiconductor(?:s)?\b/,
    /\bchips?\b/,
    /\belectronics\b/,
    /\bindustrial tech\b/,
    /\bmanufacturing\b/,
    /\biot\b/,
    /\binternet of things\b/,
    /\bdrones?\b/,
    /\b3d printing\b/,
  ])) return "Hardware & Robotics";

  if (hasAny(value, [
    /\bfood\b/,
    /\brestaurant\b/,
    /\bgrocery\b/,
    /\bretail\b/,
    /\bcommerce\b/,
    /\be commerce\b/,
    /\becommerce\b/,
    /\bmarketplace\b/,
    /\bconsumer goods\b/,
    /\bhospitality\b/,
  ])) return "Food & Commerce";

  if (hasAny(value, [
    /\benterprise\b/,
    /\bsaas\b/,
    /\bsoftware as a service\b/,
    /\bb2b\b/,
    /\bbusiness software\b/,
    /\bworkflow\b/,
    /\bautomation\b/,
    /\bcrm\b/,
    /\berp\b/,
    /\bvertical software\b/,
    /\bcloud software\b/,
    /\boperations software\b/,
    /\binfrastructure software\b/,
  ])) return "Enterprise Software";

  if (hasAny(value, [
    /\bartificial intelligence\b/,
    /\bmachine learning\b/,
    /\bdeep learning\b/,
    /\bgenerative ai\b/,
    /\blarge language model\b/,
    /\bllm\b/,
    /\bfoundation model\b/,
    /\bcomputer vision\b/,
    /\bnatural language processing\b/,
    /\bai agents?\b/,
    /\bautonomous software\b/,
    /\bai\b/,
    /\bml\b/,
  ])) return "Artificial Intelligence";

  if (hasAny(value, [
    /\bconsumer\b/,
    /\bsocial\b/,
    /\btravel\b/,
    /\bpersonal\b/,
    /\blifestyle\b/,
    /\bwellness\b/,
    /\bdating\b/,
    /\bpets?\b/,
    /\bhome services\b/,
  ])) return "Consumer";

  return null;
}

const contextEligibleIndustry = (value: string) =>
  !value || /^(?:other|unknown|not published|not specified|unspecified|n ?a|none|general)$/i.test(value);

function classifyContext(context: SectorContext) {
  const nameAndDomain = normalizeSectorText(
    [context.name, context.domain].filter(Boolean).join(" ")
  );
  const fromName = classifyIndustryLabel(nameAndDomain);
  if (fromName) return fromName;

  // Descriptions are consulted only when the industry field is a placeholder.
  // This keeps generic employer copy from overriding an explicit source label.
  return classifyIndustryLabel(normalizeSectorText(context.description || ""));
}

/**
 * Convert source-provided industry labels into the stable public taxonomy.
 *
 * Industry remains the verbatim source label; sector is deliberately broader
 * so consumers do not need to reconcile dozens of near-duplicate labels.
 */
export function normalizeSector(industry: string, context: SectorContext = {}): SectorName {
  const value = normalizeSectorText(industry);
  const fromIndustry = classifyIndustryLabel(value);
  if (fromIndustry) return fromIndustry;
  if (contextEligibleIndustry(value)) return classifyContext(context) || "Other";
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

/** Lean record serialized into the interactive homepage job board. */
export type DashboardJob = Pick<
  Job,
  | "id"
  | "companyId"
  | "provider"
  | "title"
  | "roleFamily"
  | "location"
  | "remoteStatus"
  | "employmentType"
  | "compensation"
  | "canonicalUrl"
  | "source"
  | "status"
  | "firstSeenAt"
  | "lastVerifiedAt"
  | "closedAt"
  | "summary"
>;

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
