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
  publishedAt: text("published_at"),
  lastVerifiedAt: text("last_verified_at").notNull(),
  closedAt: text("closed_at"),
  summary: text("summary").notNull(),
}, (table) => [
  index("jobs_company_idx").on(table.companyId, table.status),
  index("jobs_source_status_idx").on(table.provider, table.sourceId, table.status),
  uniqueIndex("jobs_provider_identity_idx")
    .on(table.provider, table.sourceId, table.externalId),
]);

export const investorSources = sqliteTable("investor_sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  portfolioUrl: text("portfolio_url").notNull(),
  jobsUrl: text("jobs_url"),
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

export const ingestionRuns = sqliteTable("ingestion_runs", {
  id: text("id").primaryKey(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  status: text("status").notNull(),
  metricsJson: text("metrics_json").notNull().default("{}"),
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
