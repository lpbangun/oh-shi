import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const companies = sqliteTable("companies", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  domain: text("domain").notNull(),
  description: text("description").notNull(),
  foundedYear: integer("founded_year"),
  headquarters: text("headquarters").notNull(),
  employeeRange: text("employee_range").notNull(),
  industry: text("industry").notNull(),
  sector: text("sector").notNull(),
  stage: text("stage").notNull(),
  fundingMode: text("funding_mode").notNull(),
  lifecycleStatus: text("lifecycle_status").notNull(),
  hiringScore: integer("hiring_score").notNull(),
  evidenceConfidence: integer("evidence_confidence").notNull(),
  latestFundingLabel: text("latest_funding_label").notNull(),
  latestFundingDate: text("latest_funding_date"),
  careersUrl: text("careers_url").notNull(),
  sourceUrl: text("source_url").notNull(),
  openJobCount: integer("open_job_count").notNull(),
  lastVerifiedAt: text("last_verified_at").notNull(),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  externalId: text("external_id").notNull(),
  provider: text("provider").notNull().default("ashby"),
  sourceId: text("source_id").notNull().default("legacy"),
  title: text("title").notNull(),
  roleFamily: text("role_family").notNull(),
  location: text("location").notNull(),
  remoteStatus: text("remote_status").notNull(),
  employmentType: text("employment_type").notNull(),
  compensation: text("compensation").notNull(),
  canonicalUrl: text("canonical_url").notNull().unique(),
  source: text("source").notNull(),
  status: text("status").notNull(),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  sourceUpdatedAt: text("source_updated_at"),
  publishedAt: text("published_at"),
  lastVerifiedAt: text("last_verified_at").notNull(),
  closedAt: text("closed_at"),
  rawUrl: text("raw_url").notNull(),
  discoveryChannel: text("discovery_channel").notNull(),
  evidenceUrl: text("evidence_url").notNull(),
  parserVersion: text("parser_version").notNull(),
  snapshotRunId: text("snapshot_run_id").notNull(),
  linkedInPresenceState: text("linkedin_presence_state").notNull().default("unknown"),
  linkedInEvidenceUrl: text("linkedin_evidence_url"),
  linkedInCheckedAt: text("linkedin_checked_at"),
  summary: text("summary").notNull(),
}, (table) => [
  index("jobs_company_idx").on(table.companyId, table.status),
  index("jobs_source_status_idx").on(table.provider, table.sourceId, table.status),
  uniqueIndex("jobs_provider_identity_idx")
    .on(table.provider, table.sourceId, table.externalId),
  check(
    "jobs_linkedin_presence_state_check",
    sql`${table.linkedInPresenceState} IN ('confirmed','not_observed','unknown')`
  ),
  check(
    "jobs_linkedin_evidence_required_check",
    sql`${table.linkedInPresenceState} = 'unknown' OR (${table.linkedInEvidenceUrl} IS NOT NULL AND ${table.linkedInCheckedAt} IS NOT NULL)`
  ),
]);

export const jobObservations = sqliteTable("job_observations", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  companyId: text("company_id").notNull(),
  provider: text("provider").notNull(),
  sourceId: text("source_id").notNull(),
  externalId: text("external_id").notNull(),
  canonicalUrl: text("canonical_url").notNull(),
  normalizedCanonicalUrl: text("normalized_canonical_url").notNull(),
  title: text("title").notNull(),
  location: text("location").notNull(),
  employmentType: text("employment_type").notNull(),
  summary: text("summary").notNull(),
  publishedAt: text("published_at"),
  status: text("status").notNull(),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  lastVerifiedAt: text("last_verified_at").notNull(),
  closedAt: text("closed_at"),
  rawUrl: text("raw_url").notNull(),
  evidenceUrl: text("evidence_url").notNull(),
  parserVersion: text("parser_version").notNull(),
  snapshotRunId: text("snapshot_run_id").notNull(),
  matchMethod: text("match_method").notNull(),
  matchScoreBps: integer("match_score_bps").notNull(),
}, (table) => [
  uniqueIndex("job_observations_source_identity_idx")
    .on(table.provider, table.sourceId, table.externalId),
  index("job_observations_job_status_idx").on(table.jobId, table.status),
  index("job_observations_company_url_idx")
    .on(table.companyId, table.normalizedCanonicalUrl),
  index("job_observations_source_status_idx")
    .on(table.provider, table.sourceId, table.status),
  check(
    "job_observations_match_method_check",
    sql`${table.matchMethod} IN ('new','stable_id','canonical_url','high_confidence','backfill')`
  ),
  check(
    "job_observations_match_score_check",
    sql`${table.matchScoreBps} BETWEEN 0 AND 10000`
  ),
]);

export const hiringSignals = sqliteTable("hiring_signals", {
  id: text("id").primaryKey(),
  companyId: text("company_id"),
  companyName: text("company_name").notNull(),
  companyDomain: text("company_domain").notNull(),
  roleFunction: text("role_function").notNull(),
  summary: text("summary").notNull(),
  sourceKind: text("source_kind").notNull(),
  sourceUrl: text("source_url").notNull(),
  evidenceUrl: text("evidence_url").notNull(),
  sourceRightsUrl: text("source_rights_url").notNull(),
  applicationUrl: text("application_url"),
  permissionStatus: text("permission_status").notNull(),
  confidence: integer("confidence").notNull(),
  status: text("status").notNull().default("active"),
  observedAt: text("observed_at").notNull(),
  lastVerifiedAt: text("last_verified_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  promotedJobId: text("promoted_job_id"),
}, (table) => [
  check(
    "hiring_signals_source_kind_check",
    sql`${table.sourceKind} IN ('company_blog','rss','github','hacker_news','authorized_api','submission')`
  ),
  check(
    "hiring_signals_permission_status_check",
    sql`${table.permissionStatus} IN ('permitted','authorized','manual_reviewed')`
  ),
  check(
    "hiring_signals_confidence_check",
    sql`${table.confidence} BETWEEN 0 AND 100`
  ),
  check(
    "hiring_signals_status_check",
    sql`${table.status} IN ('active','expired','unverifiable','promoted')`
  ),
  check(
    "hiring_signals_expiry_check",
    sql`${table.expiresAt} > ${table.observedAt}`
  ),
  check(
    "hiring_signals_promotion_check",
    sql`(${table.status} = 'promoted' AND ${table.promotedJobId} IS NOT NULL) OR (${table.status} <> 'promoted' AND ${table.promotedJobId} IS NULL)`
  ),
  index("hiring_signals_active_idx").on(table.status, table.expiresAt),
  index("hiring_signals_company_idx").on(table.companyDomain, table.status),
]);

export const hiringSignalPromotions = sqliteTable("hiring_signal_promotions", {
  signalId: text("signal_id").primaryKey(),
  jobId: text("job_id").notNull(),
  companyId: text("company_id").notNull(),
  provider: text("provider").notNull(),
  sourceId: text("source_id").notNull(),
  externalId: text("external_id").notNull(),
  canonicalUrl: text("canonical_url").notNull(),
  evidenceUrl: text("evidence_url").notNull(),
  sourceRightsUrl: text("source_rights_url").notNull(),
  discoverySourceKind: text("discovery_source_kind").notNull(),
  verifiedAt: text("verified_at").notNull(),
  runId: text("run_id").notNull(),
}, (table) => [
  index("hiring_signal_promotions_job_idx").on(table.jobId),
  index("hiring_signal_promotions_company_idx").on(table.companyId, table.verifiedAt),
]);

export const investorSources = sqliteTable("investor_sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  portfolioUrl: text("portfolio_url").notNull(),
  jobsUrl: text("jobs_url"),
  termsUrl: text("terms_url"),
  accessMode: text("access_mode").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  mandatory: integer("mandatory", { mode: "boolean" }).notNull().default(false),
  reviewNotes: text("review_notes").notNull().default(""),
  discoveryCursor: integer("discovery_cursor").notNull().default(0),
  lastAttemptedAt: text("last_attempted_at"),
  lastSuccessfulAt: text("last_successful_at"),
  lastError: text("last_error"),
});

export const companySources = sqliteTable("company_sources", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  provider: text("provider").notNull(),
  boardId: text("board_id").notNull(),
  careersUrl: text("careers_url").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  discoveryStatus: text("discovery_status").notNull().default("active"),
  firstDiscoveredAt: text("first_discovered_at").notNull(),
  lastAttemptedAt: text("last_attempted_at"),
  lastSuccessfulAt: text("last_successful_at"),
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  reviewNotes: text("review_notes").notNull().default(""),
  quarantineSnapshotId: text("quarantine_snapshot_id"),
  quarantineApplicationId: text("quarantine_application_id"),
}, (table) => [
  unique("company_sources_provider_board_unique").on(table.provider, table.boardId),
  index("company_sources_company_idx").on(table.companyId, table.enabled),
]);

export const companyInvestors = sqliteTable("company_investors", {
  companyId: text("company_id").notNull(),
  investorSourceId: text("investor_source_id").notNull(),
  firstDiscoveredAt: text("first_discovered_at").notNull(),
  evidenceUrl: text("evidence_url").notNull(),
}, (table) => [
  primaryKey({ columns: [table.companyId, table.investorSourceId] }),
]);

export const discoveryQueue = sqliteTable("discovery_queue", {
  id: text("id").primaryKey(),
  normalizedDomain: text("normalized_domain").notNull().unique(),
  companyName: text("company_name").notNull(),
  websiteUrl: text("website_url").notNull(),
  status: text("status").notNull(),
  firstDiscoveredAt: text("first_discovered_at").notNull(),
  lastAttemptedAt: text("last_attempted_at"),
  lastError: text("last_error"),
  reviewNotes: text("review_notes").notNull().default(""),
}, (table) => [
  check(
    "discovery_queue_status_check",
    sql`${table.status} IN ('discovered','resolving','canonical_source_found','active','needs_review','unsupported','rejected')`
  ),
]);

export const discoveryQueueInvestors = sqliteTable("discovery_queue_investors", {
  candidateId: text("candidate_id").notNull(),
  investorSourceId: text("investor_source_id").notNull(),
  evidenceUrl: text("evidence_url").notNull(),
  firstDiscoveredAt: text("first_discovered_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.candidateId, table.investorSourceId] }),
]);

export const startupDomains = sqliteTable("startup_domains", {
  canonicalDomain: text("canonical_domain").primaryKey(),
  companyId: text("company_id").unique(),
  companyName: text("company_name").notNull(),
  websiteUrl: text("website_url").notNull(),
  activityState: text("activity_state").notNull().default("unknown"),
  reviewStatus: text("review_status").notNull().default("pending"),
  pilotCohort: text("pilot_cohort"),
  careersUrl: text("careers_url"),
  atsProvider: text("ats_provider"),
  atsBoardId: text("ats_board_id"),
  careerFingerprint: text("career_fingerprint"),
  lastDiscoveryAttemptAt: text("last_discovery_attempt_at"),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, (table) => [
  check(
    "startup_domains_activity_state_check",
    sql`${table.activityState} IN ('unknown','active','inactive')`
  ),
  check(
    "startup_domains_review_status_check",
    sql`${table.reviewStatus} IN ('pending','verified','rejected')`
  ),
  index("startup_domains_pilot_idx").on(table.pilotCohort, table.reviewStatus),
]);

export const startupDomainAliases = sqliteTable("startup_domain_aliases", {
  aliasDomain: text("alias_domain").primaryKey(),
  canonicalDomain: text("canonical_domain").notNull(),
  relation: text("relation").notNull().default("alias"),
  evidenceUrl: text("evidence_url").notNull(),
  permissionStatus: text("permission_status").notNull(),
  sourceTermsUrl: text("source_terms_url"),
  observedAt: text("observed_at").notNull(),
}, (table) => [
  check(
    "startup_domain_aliases_distinct_check",
    sql`${table.aliasDomain} <> ${table.canonicalDomain}`
  ),
  check(
    "startup_domain_aliases_relation_check",
    sql`${table.relation} = 'alias'`
  ),
  index("startup_domain_aliases_canonical_idx").on(table.canonicalDomain),
]);

export const startupDomainAcquisitions = sqliteTable("startup_domain_acquisitions", {
  canonicalDomain: text("canonical_domain").notNull(),
  relatedDomain: text("related_domain").notNull(),
  relation: text("relation").notNull(),
  evidenceUrl: text("evidence_url").notNull(),
  permissionStatus: text("permission_status").notNull(),
  sourceTermsUrl: text("source_terms_url"),
  observedAt: text("observed_at").notNull(),
}, (table) => [
  primaryKey({
    columns: [
      table.canonicalDomain,
      table.relatedDomain,
      table.relation,
      table.evidenceUrl,
    ],
  }),
  check(
    "startup_domain_acquisitions_relation_check",
    sql`${table.relation} IN ('acquired_from','acquired_by')`
  ),
  check(
    "startup_domain_acquisitions_distinct_check",
    sql`${table.canonicalDomain} <> ${table.relatedDomain}`
  ),
  index("startup_domain_acquisitions_related_idx").on(table.relatedDomain),
]);

export const startupDomainEvidence = sqliteTable("startup_domain_evidence", {
  canonicalDomain: text("canonical_domain").notNull(),
  sourceKind: text("source_kind").notNull(),
  sourceId: text("source_id").notNull(),
  sourceClassification: text("source_classification").notNull(),
  evidenceUrl: text("evidence_url").notNull(),
  permissionStatus: text("permission_status").notNull(),
  sourceTermsUrl: text("source_terms_url"),
  observedAt: text("observed_at").notNull(),
  observedWebsiteUrlsJson: text("observed_website_urls_json").notNull().default("[]"),
}, (table) => [
  primaryKey({
    columns: [
      table.canonicalDomain,
      table.sourceKind,
      table.sourceId,
      table.evidenceUrl,
    ],
  }),
  index("startup_domain_evidence_source_idx").on(table.sourceKind, table.sourceId),
]);

export const startupDomainImports = sqliteTable("startup_domain_imports", {
  cohort: text("cohort").primaryKey(),
  expectedDomains: integer("expected_domains").notNull(),
  persistedDomains: integer("persisted_domains").notNull().default(0),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  errorMessage: text("error_message"),
}, (table) => [
  check(
    "startup_domain_imports_status_check",
    sql`${table.status} IN ('running','completed','failed')`
  ),
]);

export const startupDomainCohorts = sqliteTable("startup_domain_cohorts", {
  canonicalDomain: text("canonical_domain").notNull(),
  cohort: text("cohort").notNull(),
  includedAt: text("included_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.canonicalDomain, table.cohort] }),
  index("startup_domain_cohorts_cohort_idx").on(table.cohort),
]);

export const ingestionRuns = sqliteTable("ingestion_runs", {
  id: text("id").primaryKey(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  status: text("status").notNull(),
  metricsJson: text("metrics_json").notNull().default("{}"),
});

export const refreshRuns = sqliteTable("refresh_runs", {
  runKey: text("run_key").primaryKey(),
  requestedAt: text("requested_at").notNull(),
  completedAt: text("completed_at"),
  status: text("status").notNull(),
  httpStatus: integer("http_status"),
  responseJson: text("response_json"),
});

export const ingestionSourceResults = sqliteTable("ingestion_source_results", {
  runId: text("run_id").notNull(),
  sourceKind: text("source_kind").notNull(),
  sourceId: text("source_id").notNull(),
  status: text("status").notNull(),
  attemptedAt: text("attempted_at").notNull(),
  completedAt: text("completed_at"),
  discoveredCount: integer("discovered_count").notNull().default(0),
  verifiedCount: integer("verified_count").notNull().default(0),
  openedCount: integer("opened_count").notNull().default(0),
  closedCount: integer("closed_count").notNull().default(0),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
}, (table) => [
  primaryKey({ columns: [table.runId, table.sourceKind, table.sourceId] }),
]);

export const canonicalSourceSnapshots = sqliteTable("canonical_source_snapshots", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  sourceId: text("source_id").notNull(),
  provider: text("provider").notNull(),
  capturedAt: text("captured_at").notNull(),
  parserVersion: text("parser_version").notNull(),
  status: text("status").notNull(),
  existingOpenCount: integer("existing_open_count").notNull(),
  observedOpenCount: integer("observed_open_count").notNull(),
  missingCount: integer("missing_count").notNull(),
  missingRatioBps: integer("missing_ratio_bps").notNull(),
  fingerprint: text("fingerprint").notNull(),
  quarantineReason: text("quarantine_reason"),
  boardId: text("board_id"),
}, (table) => [
  check(
    "canonical_source_snapshots_status_check",
    sql`${table.status} IN ('accepted','quarantined')`
  ),
  unique("canonical_source_snapshots_run_source_unique").on(table.runId, table.sourceId),
  index("canonical_source_snapshots_source_idx").on(table.sourceId, table.capturedAt),
]);

export const canonicalSnapshotMembers = sqliteTable("canonical_snapshot_members", {
  snapshotId: text("snapshot_id").notNull(),
  externalId: text("external_id").notNull(),
  kind: text("kind").notNull(),
}, (table) => [
  check(
    "canonical_snapshot_members_kind_check",
    sql`${table.kind} IN ('observed','missing','existing')`
  ),
  primaryKey({ columns: [table.snapshotId, table.externalId, table.kind] }),
  index("canonical_snapshot_members_snapshot_idx").on(table.snapshotId, table.kind),
]);

export const canonicalSnapshotApplications = sqliteTable("canonical_snapshot_applications", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  snapshotId: text("snapshot_id").notNull().unique(),
  sourceId: text("source_id").notNull(),
  provider: text("provider").notNull(),
  boardId: text("board_id").notNull(),
  status: text("status").notNull(),
  reason: text("reason").notNull(),
  originalFingerprint: text("original_fingerprint").notNull(),
  freshFingerprint: text("fresh_fingerprint"),
  originalExistingCount: integer("original_existing_count").notNull(),
  freshExistingCount: integer("fresh_existing_count"),
  originalObservedCount: integer("original_observed_count").notNull(),
  freshObservedCount: integer("fresh_observed_count"),
  originalMissingCount: integer("original_missing_count").notNull(),
  freshMissingCount: integer("fresh_missing_count"),
  requestedAt: text("requested_at").notNull(),
  completedAt: text("completed_at"),
  openedCount: integer("opened_count").notNull().default(0),
  closedCount: integer("closed_count").notNull().default(0),
  error: text("error"),
}, (table) => [
  check(
    "canonical_snapshot_applications_status_check",
    sql`${table.status} IN ('running','applied','rejected','failed','uncertain')`
  ),
  index("canonical_snapshot_applications_source_idx").on(table.sourceId, table.requestedAt),
]);

export const fragileJobMisses = sqliteTable("fragile_job_misses", {
  jobId: text("job_id").notNull(),
  sourceId: text("source_id").notNull(),
  firstMissAt: text("first_miss_at").notNull(),
  lastMissAt: text("last_miss_at").notNull(),
  cleanMissCount: integer("clean_miss_count").notNull(),
  lastRunId: text("last_run_id").notNull(),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.sourceId] }),
  check("fragile_job_misses_count_check", sql`${table.cleanMissCount} >= 1`),
  index("fragile_job_misses_source_idx").on(table.sourceId, table.firstMissAt),
]);

export const changes = sqliteTable("changes", {
  id: text("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  changeType: text("change_type").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  occurredAt: text("occurred_at").notNull(),
  sourceUrl: text("source_url").notNull(),
}, (table) => [
  index("changes_occurred_idx").on(sql`${table.occurredAt} DESC`),
]);
