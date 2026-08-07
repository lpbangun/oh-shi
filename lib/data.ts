import { env } from "cloudflare:workers";
import { companyDiverseJobs } from "./derive";
import {
  buildStartupDomainPilot,
  careerFingerprint,
  registryIdentityConflicts,
  registrableDomain,
  type StartupDomainEntry,
  type StartupDomainEvidenceInput,
} from "./domain-registry";
import { companyScoreReceipts } from "./hiring-score";
import type { FundingDiscovery } from "./funding-discovery";
import { persistFundingDiscoveryRecords } from "./funding-store";
import type { HiringSignalImport } from "./hiring-signals";
import { prepareSeedJobStatement } from "./job-store";
import { seedChanges, seedCompanies, seedJobs } from "./seed";
import {
  listActiveHiringSignalRecords,
  listOffBoardVerifiedOpeningRecords,
  persistHiringSignalRecords,
} from "./signal-store";
import { promoteHiringSignal } from "./signal-promotion";
import { isBoardTracked } from "./tracked-boards";
import { COMPANY_SOURCE_SEEDS, INVESTOR_SOURCE_SEEDS, sourceKey } from "./source-registry";
import {
  normalizeSector,
  type ChangeEvent,
  type Company,
  type CoverageMetrics,
  type DashboardJob,
  type HiringSignal,
  type Job,
} from "./types";

let initialization: Promise<void> | null = null;

const companyColumns = `
  id, slug, name, domain, description, founded_year as foundedYear,
  headquarters, employee_range as employeeRange, industry, sector, stage,
  funding_mode as fundingMode, lifecycle_status as lifecycleStatus,
  hiring_score as hiringScore, evidence_confidence as evidenceConfidence,
  latest_funding_label as latestFundingLabel, latest_funding_date as latestFundingDate,
  careers_url as careersUrl, source_url as sourceUrl,
  open_job_count as openJobCount, last_verified_at as lastVerifiedAt
`;

const jobColumns = `
  id, company_id as companyId, external_id as externalId, provider, source_id as sourceId, title,
  role_family as roleFamily, location, remote_status as remoteStatus,
  employment_type as employmentType, compensation, canonical_url as canonicalUrl,
  source, status, first_seen_at as firstSeenAt, last_seen_at as lastSeenAt,
  source_updated_at as sourceUpdatedAt, published_at as publishedAt,
  last_verified_at as lastVerifiedAt, closed_at as closedAt,
  raw_url as rawUrl, discovery_channel as discoveryChannel,
  evidence_url as evidenceUrl, parser_version as parserVersion,
  snapshot_run_id as snapshotRunId, linkedin_presence_state as linkedInPresenceState,
  linkedin_evidence_url as linkedInEvidenceUrl, linkedin_checked_at as linkedInCheckedAt,
  summary
`;

const changeColumns = `
  id, entity_type as entityType, entity_id as entityId, change_type as changeType,
  title, description, occurred_at as occurredAt, source_url as sourceUrl
`;

const dashboardJobColumns = `
  id, company_id as companyId, provider, title, role_family as roleFamily,
  location, remote_status as remoteStatus, employment_type as employmentType,
  compensation, canonical_url as canonicalUrl, source, status,
  first_seen_at as firstSeenAt, last_verified_at as lastVerifiedAt,
  closed_at as closedAt, summary
`;

async function batchInChunks(statements: D1PreparedStatement[], size = 50) {
  for (let index = 0; index < statements.length; index += size) {
    await env.DB.batch(statements.slice(index, index + size));
  }
}

async function initializeDatabase() {
  if (!env.DB) throw new Error("D1 binding DB is unavailable.");

  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      domain TEXT NOT NULL,
      description TEXT NOT NULL,
      founded_year INTEGER,
      headquarters TEXT NOT NULL,
      employee_range TEXT NOT NULL,
      industry TEXT NOT NULL,
      sector TEXT NOT NULL,
      stage TEXT NOT NULL,
      funding_mode TEXT NOT NULL,
      lifecycle_status TEXT NOT NULL,
      hiring_score INTEGER NOT NULL,
      evidence_confidence INTEGER NOT NULL,
      latest_funding_label TEXT NOT NULL,
      latest_funding_date TEXT,
      careers_url TEXT NOT NULL,
      source_url TEXT NOT NULL,
      open_job_count INTEGER NOT NULL,
      last_verified_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      role_family TEXT NOT NULL,
      location TEXT NOT NULL,
      remote_status TEXT NOT NULL,
      employment_type TEXT NOT NULL,
      compensation TEXT NOT NULL,
      canonical_url TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT '',
      source_updated_at TEXT,
      last_verified_at TEXT NOT NULL,
      closed_at TEXT,
      raw_url TEXT NOT NULL DEFAULT '',
      discovery_channel TEXT NOT NULL DEFAULT 'public_ats',
      evidence_url TEXT NOT NULL DEFAULT '',
      parser_version TEXT NOT NULL DEFAULT 'legacy',
      snapshot_run_id TEXT NOT NULL DEFAULT 'legacy',
      linkedin_presence_state TEXT NOT NULL DEFAULT 'unknown' CHECK(
        linkedin_presence_state IN ('confirmed','not_observed','unknown')
      ),
      linkedin_evidence_url TEXT,
      linkedin_checked_at TEXT,
      summary TEXT NOT NULL,
      CHECK(linkedin_presence_state='unknown' OR (
        linkedin_evidence_url IS NOT NULL AND linkedin_checked_at IS NOT NULL
      ))
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS job_observations (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      normalized_canonical_url TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT NOT NULL,
      employment_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      published_at TEXT,
      status TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL,
      closed_at TEXT,
      raw_url TEXT NOT NULL,
      evidence_url TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      snapshot_run_id TEXT NOT NULL,
      match_method TEXT NOT NULL CHECK(match_method IN (
        'new','stable_id','canonical_url','high_confidence','backfill'
      )),
      match_score_bps INTEGER NOT NULL CHECK(match_score_bps BETWEEN 0 AND 10000),
      UNIQUE(provider, source_id, external_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS hiring_signals (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      company_name TEXT NOT NULL,
      company_domain TEXT NOT NULL,
      role_function TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK(source_kind IN (
        'company_blog','rss','github','hacker_news','authorized_api','submission'
      )),
      source_url TEXT NOT NULL,
      evidence_url TEXT NOT NULL,
      source_rights_url TEXT NOT NULL,
      application_url TEXT,
      permission_status TEXT NOT NULL CHECK(permission_status IN (
        'permitted','authorized','manual_reviewed'
      )),
      confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (
        'active','expired','unverifiable','promoted'
      )),
      observed_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL,
      expires_at TEXT NOT NULL CHECK(expires_at > observed_at),
      promoted_job_id TEXT,
      CHECK(
        (status='promoted' AND promoted_job_id IS NOT NULL) OR
        (status<>'promoted' AND promoted_job_id IS NULL)
      )
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS hiring_signal_promotions (
      signal_id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      evidence_url TEXT NOT NULL,
      source_rights_url TEXT NOT NULL,
      discovery_source_kind TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      run_id TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS changes (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      source_url TEXT NOT NULL
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS jobs_company_idx ON jobs(company_id, status)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS changes_occurred_idx ON changes(occurred_at DESC)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS investor_sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, portfolio_url TEXT NOT NULL,
      jobs_url TEXT, terms_url TEXT, access_mode TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      mandatory INTEGER NOT NULL DEFAULT 0, review_notes TEXT NOT NULL DEFAULT '',
      last_attempted_at TEXT, last_successful_at TEXT, last_error TEXT,
      discovery_cursor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS company_sources (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, provider TEXT NOT NULL, board_id TEXT NOT NULL,
      careers_url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      discovery_status TEXT NOT NULL DEFAULT 'active', first_discovered_at TEXT NOT NULL,
      last_attempted_at TEXT, last_successful_at TEXT, last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0, review_notes TEXT NOT NULL DEFAULT '',
      quarantine_snapshot_id TEXT, quarantine_application_id TEXT,
      UNIQUE(provider, board_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS company_investors (
      company_id TEXT NOT NULL, investor_source_id TEXT NOT NULL, first_discovered_at TEXT NOT NULL,
      evidence_url TEXT NOT NULL, PRIMARY KEY(company_id, investor_source_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS discovery_queue (
      id TEXT PRIMARY KEY, normalized_domain TEXT NOT NULL UNIQUE, company_name TEXT NOT NULL,
      website_url TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN (
        'discovered','resolving','canonical_source_found','active',
        'needs_review','unsupported','rejected'
      )), first_discovered_at TEXT NOT NULL,
      last_attempted_at TEXT, last_error TEXT, review_notes TEXT NOT NULL DEFAULT ''
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS discovery_queue_investors (
      candidate_id TEXT NOT NULL, investor_source_id TEXT NOT NULL, evidence_url TEXT NOT NULL,
      first_discovered_at TEXT NOT NULL, PRIMARY KEY(candidate_id, investor_source_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS discovery_review_batches (
      id TEXT PRIMARY KEY, requested_count INTEGER NOT NULL,
      assigned_count INTEGER NOT NULL DEFAULT 0,
      processed_count INTEGER NOT NULL DEFAULT 0,
      ready_count INTEGER NOT NULL DEFAULT 0,
      needs_review_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
        'queued','processing','ready','completed','failed'
      )), created_at TEXT NOT NULL, completed_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS discovery_candidate_reviews (
      batch_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
        'queued','processing','ready','needs_review','failed','approved','rejected','activated'
      )), company_name TEXT NOT NULL, normalized_domain TEXT NOT NULL,
      website_url TEXT NOT NULL, provider TEXT, board_id TEXT, careers_url TEXT,
      job_count INTEGER NOT NULL DEFAULT 0, jobs_json TEXT NOT NULL DEFAULT '[]',
      fingerprint TEXT, observed_at TEXT, last_attempted_at TEXT, last_error TEXT,
      reviewed_at TEXT, review_reason TEXT,
      PRIMARY KEY(batch_id, candidate_id)
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS discovery_candidate_reviews_batch_status_idx
      ON discovery_candidate_reviews(batch_id, status)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS discovery_candidate_reviews_candidate_status_idx
      ON discovery_candidate_reviews(candidate_id, status)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS startup_domains (
      canonical_domain TEXT PRIMARY KEY, company_id TEXT UNIQUE,
      company_name TEXT NOT NULL, website_url TEXT NOT NULL,
      activity_state TEXT NOT NULL DEFAULT 'unknown' CHECK(activity_state IN (
        'unknown','active','inactive'
      )),
      review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN (
        'pending','verified','rejected'
      )),
      pilot_cohort TEXT, careers_url TEXT, ats_provider TEXT, ats_board_id TEXT,
      career_fingerprint TEXT, last_discovery_attempt_at TEXT,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS startup_domain_aliases (
      alias_domain TEXT PRIMARY KEY, canonical_domain TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'alias' CHECK(relation='alias'),
      evidence_url TEXT NOT NULL, permission_status TEXT NOT NULL,
      source_terms_url TEXT, observed_at TEXT NOT NULL,
      CHECK(alias_domain <> canonical_domain)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS startup_domain_acquisitions (
      canonical_domain TEXT NOT NULL, related_domain TEXT NOT NULL,
      relation TEXT NOT NULL CHECK(relation IN ('acquired_from','acquired_by')),
      evidence_url TEXT NOT NULL, permission_status TEXT NOT NULL,
      source_terms_url TEXT, observed_at TEXT NOT NULL,
      PRIMARY KEY(canonical_domain, related_domain, relation, evidence_url),
      CHECK(canonical_domain <> related_domain)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS startup_domain_evidence (
      canonical_domain TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
      source_classification TEXT NOT NULL, evidence_url TEXT NOT NULL,
      permission_status TEXT NOT NULL, source_terms_url TEXT, observed_at TEXT NOT NULL,
      observed_website_urls_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY(canonical_domain, source_kind, source_id, evidence_url)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS startup_domain_imports (
      cohort TEXT PRIMARY KEY, expected_domains INTEGER NOT NULL,
      persisted_domains INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
      started_at TEXT NOT NULL, completed_at TEXT, error_message TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS startup_domain_cohorts (
      canonical_domain TEXT NOT NULL, cohort TEXT NOT NULL, included_at TEXT NOT NULL,
      PRIMARY KEY(canonical_domain, cohort)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ingestion_runs (
      id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT,
      status TEXT NOT NULL, metrics_json TEXT NOT NULL DEFAULT '{}'
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS refresh_runs (
      run_key TEXT PRIMARY KEY, requested_at TEXT NOT NULL, completed_at TEXT,
      status TEXT NOT NULL, http_status INTEGER, response_json TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ingestion_source_results (
      run_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
      status TEXT NOT NULL, attempted_at TEXT NOT NULL, completed_at TEXT,
      discovered_count INTEGER NOT NULL DEFAULT 0, verified_count INTEGER NOT NULL DEFAULT 0,
      opened_count INTEGER NOT NULL DEFAULT 0, closed_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT, error_message TEXT,
      PRIMARY KEY(run_id, source_kind, source_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS canonical_source_snapshots (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source_id TEXT NOT NULL,
      provider TEXT NOT NULL, captured_at TEXT NOT NULL, parser_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('accepted','quarantined')),
      existing_open_count INTEGER NOT NULL, observed_open_count INTEGER NOT NULL,
      missing_count INTEGER NOT NULL, missing_ratio_bps INTEGER NOT NULL,
      fingerprint TEXT NOT NULL, quarantine_reason TEXT, board_id TEXT,
      UNIQUE(run_id, source_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS canonical_snapshot_members (
      snapshot_id TEXT NOT NULL, external_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('observed','missing','existing')),
      PRIMARY KEY(snapshot_id, external_id, kind)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS canonical_snapshot_applications (
      idempotency_key TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL, provider TEXT NOT NULL, board_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'running','applied','rejected','failed','uncertain'
      )),
      reason TEXT NOT NULL, original_fingerprint TEXT NOT NULL,
      fresh_fingerprint TEXT, original_existing_count INTEGER NOT NULL,
      fresh_existing_count INTEGER, original_observed_count INTEGER NOT NULL,
      fresh_observed_count INTEGER, original_missing_count INTEGER NOT NULL,
      fresh_missing_count INTEGER, requested_at TEXT NOT NULL, completed_at TEXT,
      opened_count INTEGER NOT NULL DEFAULT 0,
      closed_count INTEGER NOT NULL DEFAULT 0, error TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS fragile_job_misses (
      job_id TEXT NOT NULL, source_id TEXT NOT NULL,
      first_miss_at TEXT NOT NULL, last_miss_at TEXT NOT NULL,
      clean_miss_count INTEGER NOT NULL CHECK(clean_miss_count >= 1),
      last_run_id TEXT NOT NULL,
      PRIMARY KEY (job_id, source_id)
    )`),
  ]);

  // D1 databases created before normalized sectors existed need a safe,
  // forward-only additive migration before any company SELECT runs.
  const companyInfo = await env.DB.prepare("PRAGMA table_info(companies)")
    .all<{ name: string }>();
  if (!companyInfo.results.some((column) => column.name === "sector")) {
    await env.DB.prepare(
      "ALTER TABLE companies ADD COLUMN sector TEXT NOT NULL DEFAULT 'Other'"
    ).run();
  }
  const sourceInfo = await env.DB.prepare("PRAGMA table_info(company_sources)")
    .all<{ name: string }>();
  if (!sourceInfo.results.some((column) => column.name === "quarantine_snapshot_id")) {
    await env.DB.prepare(
      "ALTER TABLE company_sources ADD COLUMN quarantine_snapshot_id TEXT"
    ).run();
  }
  if (!sourceInfo.results.some((column) => column.name === "quarantine_application_id")) {
    await env.DB.prepare(
      "ALTER TABLE company_sources ADD COLUMN quarantine_application_id TEXT"
    ).run();
  }
  const snapshotInfo = await env.DB.prepare("PRAGMA table_info(canonical_source_snapshots)")
    .all<{ name: string }>();
  if (!snapshotInfo.results.some((column) => column.name === "board_id")) {
    await env.DB.prepare(
      "ALTER TABLE canonical_source_snapshots ADD COLUMN board_id TEXT"
    ).run();
  }
  const jobInfo = await env.DB.prepare("PRAGMA table_info(jobs)").all<{ name: string }>();
  const jobColumnNames = new Set(jobInfo.results.map((column) => column.name));
  if (!jobColumnNames.has("provider")) {
    await env.DB.prepare("ALTER TABLE jobs ADD COLUMN provider TEXT NOT NULL DEFAULT 'ashby'").run();
  }
  if (!jobColumnNames.has("source_id")) {
    await env.DB.prepare("ALTER TABLE jobs ADD COLUMN source_id TEXT NOT NULL DEFAULT 'legacy'").run();
  }
  if (!jobColumnNames.has("published_at")) {
    await env.DB.prepare("ALTER TABLE jobs ADD COLUMN published_at TEXT").run();
  }
  const jobProvenanceColumns = [
    ["last_seen_at", "ALTER TABLE jobs ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT ''"],
    ["source_updated_at", "ALTER TABLE jobs ADD COLUMN source_updated_at TEXT"],
    ["raw_url", "ALTER TABLE jobs ADD COLUMN raw_url TEXT NOT NULL DEFAULT ''"],
    [
      "discovery_channel",
      "ALTER TABLE jobs ADD COLUMN discovery_channel TEXT NOT NULL DEFAULT 'public_ats'",
    ],
    ["evidence_url", "ALTER TABLE jobs ADD COLUMN evidence_url TEXT NOT NULL DEFAULT ''"],
    [
      "parser_version",
      "ALTER TABLE jobs ADD COLUMN parser_version TEXT NOT NULL DEFAULT 'legacy'",
    ],
    [
      "snapshot_run_id",
      "ALTER TABLE jobs ADD COLUMN snapshot_run_id TEXT NOT NULL DEFAULT 'legacy'",
    ],
    ["linkedin_evidence_url", "ALTER TABLE jobs ADD COLUMN linkedin_evidence_url TEXT"],
    ["linkedin_checked_at", "ALTER TABLE jobs ADD COLUMN linkedin_checked_at TEXT"],
    [
      "linkedin_presence_state",
      `ALTER TABLE jobs ADD COLUMN linkedin_presence_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK(linkedin_presence_state IN ('confirmed','not_observed','unknown') AND
          (linkedin_presence_state='unknown' OR
            (linkedin_evidence_url IS NOT NULL AND linkedin_checked_at IS NOT NULL)))`,
    ],
  ] as const;
  for (const [column, statement] of jobProvenanceColumns) {
    if (!jobColumnNames.has(column)) await env.DB.prepare(statement).run();
  }
  await env.DB.prepare(`UPDATE jobs SET
    last_seen_at=CASE WHEN last_seen_at='' THEN last_verified_at ELSE last_seen_at END,
    raw_url=CASE WHEN raw_url='' THEN canonical_url ELSE raw_url END,
    evidence_url=CASE WHEN evidence_url='' THEN canonical_url ELSE evidence_url END
    WHERE last_seen_at='' OR raw_url='' OR evidence_url=''`).run();
  const investorInfo = await env.DB.prepare("PRAGMA table_info(investor_sources)")
    .all<{ name: string }>();
  if (!investorInfo.results.some((column) => column.name === "discovery_cursor")) {
    await env.DB.prepare(
      "ALTER TABLE investor_sources ADD COLUMN discovery_cursor INTEGER NOT NULL DEFAULT 0"
    ).run();
  }
  if (!investorInfo.results.some((column) => column.name === "terms_url")) {
    await env.DB.prepare(
      "ALTER TABLE investor_sources ADD COLUMN terms_url TEXT"
    ).run();
  }
  const aliasInfo = await env.DB.prepare("PRAGMA table_info(startup_domain_aliases)")
    .all<{ name: string }>();
  if (!aliasInfo.results.some((column) => column.name === "source_terms_url")) {
    await env.DB.prepare(
      "ALTER TABLE startup_domain_aliases ADD COLUMN source_terms_url TEXT"
    ).run();
  }
  const registryEvidenceInfo = await env.DB.prepare(
    "PRAGMA table_info(startup_domain_evidence)"
  ).all<{ name: string }>();
  if (
    !registryEvidenceInfo.results.some(
      (column) => column.name === "observed_website_urls_json"
    )
  ) {
    await env.DB.prepare(
      "ALTER TABLE startup_domain_evidence ADD COLUMN observed_website_urls_json TEXT NOT NULL DEFAULT '[]'"
    ).run();
  }
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS jobs_source_status_idx ON jobs(provider, source_id, status)"
  ).run();
  await env.DB.batch([
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS job_observations_job_status_idx
      ON job_observations(job_id, status)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS job_observations_company_url_idx
      ON job_observations(company_id, normalized_canonical_url)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS job_observations_source_status_idx
      ON job_observations(provider, source_id, status)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS startup_domains_pilot_idx
      ON startup_domains(pilot_cohort, review_status)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS startup_domain_aliases_canonical_idx
      ON startup_domain_aliases(canonical_domain)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS startup_domain_acquisitions_related_idx
      ON startup_domain_acquisitions(related_domain)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS startup_domain_evidence_source_idx
      ON startup_domain_evidence(source_kind, source_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS startup_domain_cohorts_cohort_idx
      ON startup_domain_cohorts(cohort)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS canonical_source_snapshots_source_idx
      ON canonical_source_snapshots(source_id, captured_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS canonical_snapshot_members_snapshot_idx
      ON canonical_snapshot_members(snapshot_id, kind)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS canonical_snapshot_applications_source_idx
      ON canonical_snapshot_applications(source_id, requested_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS fragile_job_misses_source_idx
      ON fragile_job_misses(source_id, first_miss_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS hiring_signals_active_idx
      ON hiring_signals(status, expires_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS hiring_signals_company_idx
      ON hiring_signals(company_domain, status)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS hiring_signal_promotions_job_idx
      ON hiring_signal_promotions(job_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS hiring_signal_promotions_company_idx
      ON hiring_signal_promotions(company_id, verified_at)`),
  ]);
  const sectors = await env.DB.prepare(
    "SELECT id, industry, sector FROM companies"
  ).all<{ id: string; industry: string; sector: string }>();
  for (const company of sectors.results) {
    const normalized = normalizeSector(company.industry);
    if (company.sector !== normalized) {
      await env.DB.prepare("UPDATE companies SET sector = ? WHERE id = ?")
        .bind(normalized, company.id)
        .run();
    }
  }

  const existing = await env.DB.prepare("SELECT COUNT(*) as count FROM companies").first<{ count: number }>();
  const hadCompanies = Number(existing?.count || 0) > 0;

  const profileStatements = seedCompanies.map((company) =>
    env.DB.prepare(`INSERT INTO companies (
      id, slug, name, domain, description, founded_year, headquarters, employee_range,
      industry, sector, stage, funding_mode, lifecycle_status, hiring_score, evidence_confidence,
      latest_funding_label, latest_funding_date, careers_url, source_url, open_job_count,
      last_verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      slug=excluded.slug, name=excluded.name, domain=excluded.domain,
      description=excluded.description, founded_year=excluded.founded_year,
      headquarters=excluded.headquarters, employee_range=excluded.employee_range,
      industry=excluded.industry, sector=excluded.sector,
      stage=CASE
        WHEN companies.latest_funding_date IS NULL OR
          (excluded.latest_funding_date IS NOT NULL AND excluded.latest_funding_date > companies.latest_funding_date)
        THEN excluded.stage ELSE companies.stage END,
      funding_mode=excluded.funding_mode, lifecycle_status=excluded.lifecycle_status,
      latest_funding_label=CASE
        WHEN companies.latest_funding_date IS NULL OR
          (excluded.latest_funding_date IS NOT NULL AND excluded.latest_funding_date > companies.latest_funding_date)
        THEN excluded.latest_funding_label ELSE companies.latest_funding_label END,
      latest_funding_date=CASE
        WHEN companies.latest_funding_date IS NULL OR
          (excluded.latest_funding_date IS NOT NULL AND excluded.latest_funding_date > companies.latest_funding_date)
        THEN excluded.latest_funding_date ELSE companies.latest_funding_date END,
      careers_url=excluded.careers_url, source_url=excluded.source_url`).bind(
      company.id, company.slug, company.name, company.domain, company.description,
      company.foundedYear, company.headquarters, company.employeeRange, company.industry,
      company.sector, company.stage, company.fundingMode, company.lifecycleStatus,
      company.hiringScore, company.evidenceConfidence, company.latestFundingLabel,
      company.latestFundingDate, company.careersUrl, company.sourceUrl,
      company.openJobCount, company.lastVerifiedAt
    )
  );

  // Profiles are always upserted so a deployment expands an existing D1
  // without resetting live counts, scores, or verification timestamps.
  await env.DB.batch(profileStatements);
  const discoveredAt = new Date().toISOString();
  await env.DB.batch([
    ...INVESTOR_SOURCE_SEEDS.map((source) => env.DB.prepare(`INSERT INTO investor_sources (
      id, name, kind, portfolio_url, jobs_url, terms_url, access_mode,
      enabled, mandatory, review_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind,
      portfolio_url=excluded.portfolio_url, jobs_url=excluded.jobs_url,
      terms_url=excluded.terms_url,
      access_mode=excluded.access_mode, enabled=excluded.enabled,
      mandatory=excluded.mandatory, review_notes=excluded.review_notes`).bind(
      source.id, source.name, source.kind, source.portfolioUrl, source.jobsUrl,
      source.termsUrl || null, source.access, source.enabled ? 1 : 0,
      source.mandatory ? 1 : 0, source.reviewNotes
    )),
    ...COMPANY_SOURCE_SEEDS.map((source) => env.DB.prepare(`INSERT OR IGNORE INTO company_sources (
      id, company_id, provider, board_id, careers_url, enabled, discovery_status,
      first_discovered_at, consecutive_failures, review_notes
    ) VALUES (?, ?, ?, ?, ?, 1, 'active', ?, 0, 'Typed bootstrap source')`).bind(
      sourceKey(source.provider, source.boardId), source.companyId, source.provider,
      source.boardId, source.careersUrl, discoveredAt
    )),
  ]);
  const registryCompanies = await env.DB.prepare(`SELECT
    c.id, c.name, c.domain, c.careers_url as careersUrl, c.source_url as sourceUrl,
    s.provider, s.board_id as boardId
    FROM companies c LEFT JOIN company_sources s ON s.id=(
      SELECT selected.id FROM company_sources selected
      WHERE selected.company_id=c.id ORDER BY selected.enabled DESC, selected.id LIMIT 1
    ) ORDER BY c.id`).all<{
      id: string;
      name: string;
      domain: string;
      careersUrl: string;
      sourceUrl: string;
      provider: string | null;
      boardId: string | null;
    }>();
  const registryObservedAt = new Date().toISOString();
  const registryBackfill: D1PreparedStatement[] = [];
  for (const company of registryCompanies.results) {
    const canonicalDomain = registrableDomain(company.domain);
    if (!canonicalDomain) continue;
    const fingerprint = company.provider && company.boardId
      ? careerFingerprint(company.provider, company.boardId, company.careersUrl)
      : null;
    registryBackfill.push(
      env.DB.prepare(`INSERT INTO startup_domains (
        canonical_domain, company_id, company_name, website_url, activity_state,
        review_status, pilot_cohort, careers_url, ats_provider, ats_board_id,
        career_fingerprint, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, 'active', 'verified', 'production-baseline', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_domain) DO UPDATE SET
        company_id=COALESCE(startup_domains.company_id, excluded.company_id),
        company_name=excluded.company_name, activity_state='active',
        review_status='verified', careers_url=excluded.careers_url,
        ats_provider=excluded.ats_provider, ats_board_id=excluded.ats_board_id,
        career_fingerprint=excluded.career_fingerprint, last_seen_at=excluded.last_seen_at`)
        .bind(
          canonicalDomain,
          company.id,
          company.name,
          `https://${canonicalDomain}/`,
          company.careersUrl,
          company.provider,
          company.boardId,
          fingerprint,
          registryObservedAt,
          registryObservedAt
        ),
      env.DB.prepare(`INSERT OR IGNORE INTO startup_domain_evidence (
        canonical_domain, source_kind, source_id, source_classification,
        evidence_url, permission_status, source_terms_url, observed_at
      ) VALUES (?, 'production_baseline', ?, 'canonically_verified_company',
        ?, 'manual_only', NULL, ?)`)
        .bind(canonicalDomain, company.id, company.sourceUrl, registryObservedAt)
    );
  }
  await batchInChunks(registryBackfill);
  if (!hadCompanies) {
    const jobStatements = seedJobs.map((job) => {
      const canonicalSource = COMPANY_SOURCE_SEEDS.find(
        (source) => source.companyId === job.companyId
      );
      if (!canonicalSource) {
        throw new Error(`Seed job ${job.id} has no canonical company source.`);
      }
      return prepareSeedJobStatement(
        env.DB,
        job,
        canonicalSource.provider,
        sourceKey(canonicalSource.provider, canonicalSource.boardId)
      );
    });

    const changeStatements = seedChanges.map((change) =>
      env.DB.prepare(`INSERT OR IGNORE INTO changes (
      id, entity_type, entity_id, change_type, title, description, occurred_at, source_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      change.id, change.entityType, change.entityId, change.changeType,
      change.title, change.description, change.occurredAt, change.sourceUrl
    )
    );

    // Company rows already exist from the profile upsert above.
    await env.DB.batch([...jobStatements, ...changeStatements]);
  }
  // Backfill before enforcing source identity. This preserves existing rows
  // while avoiding collisions between identical external ids on different boards.
  await env.DB.prepare(`UPDATE jobs SET
    provider=COALESCE((SELECT provider FROM company_sources s
      WHERE s.company_id=jobs.company_id ORDER BY s.id LIMIT 1), provider),
    source_id=COALESCE((SELECT id FROM company_sources s
      WHERE s.company_id=jobs.company_id ORDER BY s.id LIMIT 1), source_id)
    WHERE source_id='legacy'`).run();
  // Every canonical row has at least one source observation on the same
  // initialization pass, including newly inserted seed rows.
  await env.DB.prepare(`INSERT OR IGNORE INTO job_observations (
    id, job_id, company_id, provider, source_id, external_id, canonical_url,
    normalized_canonical_url, title, location, employment_type, summary,
    published_at, status, first_seen_at, last_seen_at, last_verified_at,
    closed_at, raw_url, evidence_url, parser_version, snapshot_run_id,
    match_method, match_score_bps
  ) SELECT 'observation_' || id, id, company_id, provider, source_id, external_id,
    canonical_url, canonical_url, title, location, employment_type, summary,
    published_at, status, first_seen_at, last_seen_at, last_verified_at,
    closed_at, raw_url, evidence_url, parser_version, snapshot_run_id,
    'backfill', 10000 FROM jobs`).run();
  await env.DB.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS jobs_provider_identity_idx ON jobs(provider, source_id, external_id)"
  ).run();

  // Existing deployments may contain scores from an older methodology or seed
  // snapshot. Recompute them from the same stored facts used by public receipts
  // before serving any request, so totals and explanations cannot disagree.
  const [storedCompanies, storedJobs, storedChanges] = await Promise.all([
    env.DB.prepare(`SELECT ${companyColumns} FROM companies`).all<Company>(),
    env.DB.prepare(`SELECT ${jobColumns} FROM jobs`).all<Job>(),
    env.DB.prepare(`SELECT ${changeColumns} FROM changes`).all<ChangeEvent>(),
  ]);
  const calculationTime = new Date().toISOString();
  const scoreStatements = storedCompanies.results.map((company) => {
    const receipts = companyScoreReceipts(
      company,
      storedJobs.results,
      storedChanges.results,
      calculationTime,
      isBoardTracked(company.id)
    );
    const openJobCount = storedJobs.results.filter(
      (job) => job.companyId === company.id && job.status === "verified_open"
    ).length;
    return env.DB.prepare(
      "UPDATE companies SET open_job_count=?, hiring_score=?, evidence_confidence=? WHERE id=?"
    ).bind(
      openJobCount,
      receipts.hiring.value,
      receipts.evidence.value,
      company.id
    );
  });
  if (scoreStatements.length) await env.DB.batch(scoreStatements);
}

function isMissingDatabaseSchema(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /no such (?:table|column)(?::|\s)/i.test(message);
}

async function prepareDatabase() {
  if (!env.DB) throw new Error("D1 binding DB is unavailable.");

  // Sites applies the checked-in Drizzle migrations before serving a deployed
  // version. One compile-time schema probe plus the company existence check
  // replaces the hundreds of schema, backfill, and score-recalculation
  // statements that previously ran on every cold Worker. LIMIT 0 keeps the
  // schema checks read-only while SQLite still resolves every table and column.
  try {
    const readiness = await env.DB.prepare(`SELECT
      EXISTS(SELECT 1 FROM companies LIMIT 1) as hasCompanies,
      EXISTS(SELECT sector FROM companies LIMIT 0) as companiesReady,
      EXISTS(SELECT linkedin_presence_state FROM jobs LIMIT 0) as jobsReady,
      EXISTS(SELECT normalized_canonical_url FROM job_observations LIMIT 0) as observationsReady,
      EXISTS(SELECT promoted_job_id FROM hiring_signals LIMIT 0) as signalsReady,
      EXISTS(SELECT run_id FROM hiring_signal_promotions LIMIT 0) as promotionsReady,
      EXISTS(SELECT occurred_at FROM changes LIMIT 0) as changesReady,
      EXISTS(SELECT discovery_cursor FROM investor_sources LIMIT 0) as investorsReady,
      EXISTS(SELECT quarantine_application_id FROM company_sources LIMIT 0) as sourcesReady,
      EXISTS(SELECT company_id FROM company_investors LIMIT 0) as companyInvestorsReady,
      EXISTS(SELECT review_notes FROM discovery_queue LIMIT 0) as discoveryReady,
      EXISTS(SELECT candidate_id FROM discovery_queue_investors LIMIT 0) as discoveryInvestorsReady,
      EXISTS(SELECT ready_count FROM discovery_review_batches LIMIT 0) as reviewBatchesReady,
      EXISTS(SELECT fingerprint FROM discovery_candidate_reviews LIMIT 0) as reviewsReady,
      EXISTS(SELECT career_fingerprint FROM startup_domains LIMIT 0) as domainsReady,
      EXISTS(SELECT source_terms_url FROM startup_domain_aliases LIMIT 0) as aliasesReady,
      EXISTS(SELECT related_domain FROM startup_domain_acquisitions LIMIT 0) as acquisitionsReady,
      EXISTS(SELECT observed_website_urls_json FROM startup_domain_evidence LIMIT 0) as evidenceReady,
      EXISTS(SELECT expected_domains FROM startup_domain_imports LIMIT 0) as importsReady,
      EXISTS(SELECT cohort FROM startup_domain_cohorts LIMIT 0) as cohortsReady,
      EXISTS(SELECT completed_at FROM ingestion_runs LIMIT 0) as ingestionReady,
      EXISTS(SELECT response_json FROM refresh_runs LIMIT 0) as refreshReady,
      EXISTS(SELECT source_id FROM ingestion_source_results LIMIT 0) as sourceResultsReady,
      EXISTS(SELECT board_id FROM canonical_source_snapshots LIMIT 0) as snapshotsReady,
      EXISTS(SELECT snapshot_id FROM canonical_snapshot_members LIMIT 0) as snapshotMembersReady,
      EXISTS(SELECT idempotency_key FROM canonical_snapshot_applications LIMIT 0) as snapshotApplicationsReady,
      EXISTS(SELECT clean_miss_count FROM fragile_job_misses LIMIT 0) as fragileMissesReady
    `).first<{ hasCompanies: number }>();
    if (Number(readiness?.hasCompanies || 0) > 0) return;
  } catch (error) {
    if (!isMissingDatabaseSchema(error)) throw error;
  }

  // Empty local databases and recognized legacy schemas retain the idempotent
  // bootstrap path. Transport, authentication, and quota errors stay fatal.
  await initializeDatabase();
}

export async function ensureDatabase() {
  initialization ??= prepareDatabase().catch((error) => {
    initialization = null;
    throw error;
  });
  await initialization;
}

export async function persistStartupDomainPilot(entries: StartupDomainEntry[]) {
  await ensureDatabase();
  const internalConflicts = registryIdentityConflicts(entries);
  if (internalConflicts.length) {
    throw new Error(`Domain registry identity conflict: ${internalConflicts.join(", ")}`);
  }
  const cohorts = [...new Set(
    entries.map((entry) => entry.pilotCohort).filter(Boolean)
  )];
  if (cohorts.length > 1) {
    throw new Error("A registry import must contain exactly one pilot cohort.");
  }
  const cohort = cohorts[0] || "";
  const importStartedAt = new Date().toISOString();
  if (cohort) {
    await env.DB.prepare(`INSERT INTO startup_domain_imports (
      cohort, expected_domains, persisted_domains, status, started_at,
      completed_at, error_message
    ) VALUES (?, ?, 0, 'running', ?, NULL, NULL)
    ON CONFLICT(cohort) DO UPDATE SET
      expected_domains=excluded.expected_domains, persisted_domains=0,
      status='running', started_at=excluded.started_at,
      completed_at=NULL, error_message=NULL`)
      .bind(cohort, entries.length, importStartedAt)
      .run();
  }
  const [storedDomains, storedAliases] = await Promise.all([
    env.DB.prepare("SELECT canonical_domain as canonicalDomain FROM startup_domains")
      .all<{ canonicalDomain: string }>(),
    env.DB.prepare(`SELECT alias_domain as aliasDomain,
      canonical_domain as canonicalDomain FROM startup_domain_aliases`)
      .all<{ aliasDomain: string; canonicalDomain: string }>(),
  ]);
  const canonicalDomains = new Set(storedDomains.results.map((item) => item.canonicalDomain));
  const aliasOwners = new Map(
    storedAliases.results.map((item) => [item.aliasDomain, item.canonicalDomain])
  );
  for (const entry of entries) {
    const canonicalOwner = aliasOwners.get(entry.canonicalDomain);
    if (canonicalOwner && canonicalOwner !== entry.canonicalDomain) {
      throw new Error(
        `Domain registry identity conflict: canonical_is_existing_alias:${entry.canonicalDomain}`
      );
    }
    for (const alias of entry.aliases) {
      if (canonicalDomains.has(alias.aliasDomain)) {
        throw new Error(
          `Domain registry identity conflict: alias_is_existing_canonical:${alias.aliasDomain}`
        );
      }
      const owner = aliasOwners.get(alias.aliasDomain);
      if (owner && owner !== entry.canonicalDomain) {
        throw new Error(
          `Domain registry identity conflict: alias_has_existing_owner:${alias.aliasDomain}`
        );
      }
    }
  }
  const statements: D1PreparedStatement[] = [];
  for (const entry of entries) {
    const evidence = entry.evidence[0];
    if (!evidence) continue;
    statements.push(env.DB.prepare(`INSERT INTO startup_domains (
      canonical_domain, company_name, website_url, activity_state, review_status,
      pilot_cohort, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_domain) DO UPDATE SET
      company_name=CASE WHEN startup_domains.review_status='verified'
        THEN startup_domains.company_name ELSE excluded.company_name END,
      website_url=CASE WHEN startup_domains.review_status='verified'
        THEN startup_domains.website_url ELSE excluded.website_url END,
      activity_state=CASE WHEN startup_domains.activity_state='unknown'
        THEN excluded.activity_state ELSE startup_domains.activity_state END,
      review_status=CASE WHEN startup_domains.review_status='pending'
        THEN excluded.review_status ELSE startup_domains.review_status END,
      pilot_cohort=COALESCE(startup_domains.pilot_cohort, excluded.pilot_cohort),
      last_seen_at=excluded.last_seen_at`).bind(
      entry.canonicalDomain,
      entry.companyName,
      entry.websiteUrl,
      entry.activityState,
      entry.reviewStatus,
      entry.pilotCohort || null,
      evidence.observedAt,
      evidence.observedAt
    ));
    if (cohort) {
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO startup_domain_cohorts (
        canonical_domain, cohort, included_at
      ) VALUES (?, ?, ?)`).bind(
        entry.canonicalDomain,
        cohort,
        evidence.observedAt
      ));
    }
    for (const item of entry.evidence) {
      statements.push(env.DB.prepare(`INSERT INTO startup_domain_evidence (
        canonical_domain, source_kind, source_id, source_classification,
        evidence_url, permission_status, source_terms_url, observed_at,
        observed_website_urls_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_domain, source_kind, source_id, evidence_url) DO UPDATE SET
        source_classification=excluded.source_classification,
        permission_status=excluded.permission_status,
        source_terms_url=excluded.source_terms_url,
        observed_at=excluded.observed_at,
        observed_website_urls_json=excluded.observed_website_urls_json`).bind(
        entry.canonicalDomain,
        item.sourceKind,
        item.sourceId,
        item.sourceClassification,
        item.evidenceUrl,
        item.permissionStatus,
        item.sourceTermsUrl,
        item.observedAt,
        JSON.stringify(item.observedWebsiteUrls)
      ));
    }
    for (const alias of entry.aliases) {
      statements.push(env.DB.prepare(`INSERT INTO startup_domain_aliases (
        alias_domain, canonical_domain, relation, evidence_url,
        permission_status, source_terms_url, observed_at
      ) VALUES (?, ?, 'alias', ?, ?, ?, ?)
      ON CONFLICT(alias_domain) DO UPDATE SET
        evidence_url=excluded.evidence_url,
        permission_status=excluded.permission_status,
        source_terms_url=excluded.source_terms_url,
        observed_at=excluded.observed_at`).bind(
        alias.aliasDomain,
        entry.canonicalDomain,
        alias.evidenceUrl,
        alias.permissionStatus,
        alias.sourceTermsUrl,
        alias.observedAt
      ));
    }
    for (const acquisition of entry.acquisitions) {
      statements.push(env.DB.prepare(`INSERT INTO startup_domain_acquisitions (
        canonical_domain, related_domain, relation, evidence_url,
        permission_status, source_terms_url, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_domain, related_domain, relation, evidence_url) DO UPDATE SET
        permission_status=excluded.permission_status,
        source_terms_url=excluded.source_terms_url,
        observed_at=excluded.observed_at`).bind(
        entry.canonicalDomain,
        acquisition.relatedDomain,
        acquisition.relation,
        acquisition.evidenceUrl,
        acquisition.permissionStatus,
        acquisition.sourceTermsUrl,
        acquisition.observedAt
      ));
    }
  }
  try {
    await batchInChunks(statements);
    let persistedDomains = entries.length;
    if (cohort) {
      // Count only the domains in this batch. Comparing against the whole
      // cohort would fail every request after the first, which capped a cohort
      // at a single request body.
      const domains = entries.map((entry) => entry.canonicalDomain);
      let confirmed = 0;
      // D1 allows at most 100 bound parameters per statement, and the cohort
      // itself takes one of them.
      for (let index = 0; index < domains.length; index += 50) {
        const chunk = domains.slice(index, index + 50);
        const persisted = await env.DB.prepare(`SELECT COUNT(*) as count
          FROM startup_domain_cohorts
          WHERE cohort=? AND canonical_domain IN (${chunk.map(() => "?").join(",")})`)
          .bind(cohort, ...chunk)
          .first<{ count: number }>();
        confirmed += Number(persisted?.count || 0);
      }
      persistedDomains = confirmed;
      if (persistedDomains !== entries.length) {
        throw new Error(
          `Domain registry import incomplete: expected ${entries.length}, persisted ${persistedDomains}.`
        );
      }
      await env.DB.prepare(`UPDATE startup_domain_imports SET
        persisted_domains=?, status='completed', completed_at=?, error_message=NULL
        WHERE cohort=?`).bind(
        persistedDomains,
        new Date().toISOString(),
        cohort
      ).run();
    }
    return {
      domains: persistedDomains,
      evidence: entries.reduce((total, entry) => total + entry.evidence.length, 0),
      aliases: entries.reduce((total, entry) => total + entry.aliases.length, 0),
      acquisitions: entries.reduce((total, entry) => total + entry.acquisitions.length, 0),
      importStatus: cohort ? "completed" as const : "untracked" as const,
    };
  } catch (error) {
    if (cohort) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await env.DB.prepare(`UPDATE startup_domain_imports SET status='failed',
        error_message=? WHERE cohort=?`).bind(message, cohort).run();
    }
    throw error;
  }
}

export async function registerStartupDomainEvidence(
  input: StartupDomainEvidenceInput,
  pilotCohort = ""
) {
  const pilot = buildStartupDomainPilot([input], 1, pilotCohort);
  if (pilot.entries.length) await persistStartupDomainPilot(pilot.entries);
  return pilot.receipt;
}

export async function claimRefreshRun(runKey: string, requestedAt: string) {
  await ensureDatabase();
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO refresh_runs (
    run_key, requested_at, status
  ) VALUES (?, ?, 'running')`).bind(runKey, requestedAt).run();
  return Number(result.meta.changes || 0) === 1;
}

export async function readRefreshRun<T>(runKey: string) {
  await ensureDatabase();
  const row = await env.DB.prepare(`SELECT completed_at as completedAt,
    http_status as httpStatus, response_json as responseJson
    FROM refresh_runs WHERE run_key=?`).bind(runKey).first<{
      completedAt: string | null;
      httpStatus: number | null;
      responseJson: string | null;
    }>();
  if (!row?.completedAt || !row.responseJson || !row.httpStatus) return null;
  return {
    completed: true,
    httpStatus: row.httpStatus,
    body: JSON.parse(row.responseJson) as T,
  };
}

export async function completeRefreshRun<T>(
  runKey: string,
  response: { httpStatus: number; body: T }
) {
  await ensureDatabase();
  const completedAt = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE refresh_runs SET completed_at=?, status='completed',
    http_status=?, response_json=? WHERE run_key=? AND status='running'`)
    .bind(completedAt, response.httpStatus, JSON.stringify(response.body), runKey)
    .run();
  if (Number(result.meta.changes || 0) !== 1) {
    throw new Error("Refresh run completion was not durably persisted.");
  }
}

export async function listCompanies(): Promise<Company[]> {
  await ensureDatabase();
  const [result, investors, providers, discovered] = await Promise.all([
    env.DB.prepare(
    `SELECT ${companyColumns} FROM companies ORDER BY hiring_score DESC, name ASC`
    ).all<Company>(),
    env.DB.prepare(`SELECT ci.company_id as companyId, i.name
      FROM company_investors ci JOIN investor_sources i ON i.id=ci.investor_source_id
      ORDER BY i.name`).all<{ companyId: string; name: string }>(),
    env.DB.prepare(`SELECT company_id as companyId, provider FROM company_sources
      WHERE enabled=1 ORDER BY provider`).all<{ companyId: string; provider: string }>(),
    env.DB.prepare(`SELECT company_id as companyId, MIN(first_discovered_at) as firstDiscoveredAt
      FROM company_sources GROUP BY company_id`).all<{ companyId: string; firstDiscoveredAt: string }>(),
  ]);
  return result.results.map((company) => ({
    ...company,
    investors: investors.results.filter((item) => item.companyId === company.id).map((item) => item.name),
    providers: providers.results.filter((item) => item.companyId === company.id).map((item) => item.provider),
    firstDiscoveredAt: discovered.results.find((item) => item.companyId === company.id)?.firstDiscoveredAt || null,
  }));
}

async function listStoredJobs(includeClosed = false): Promise<Job[]> {
  await ensureDatabase();
  const where = includeClosed ? "" : "WHERE status = 'verified_open'";
  const result = await env.DB.prepare(
    `SELECT ${jobColumns} FROM jobs ${where} ORDER BY first_seen_at DESC`
  ).all<Job>();
  return result.results;
}

export async function listDashboardJobs(limit?: number): Promise<DashboardJob[]> {
  await ensureDatabase();
  const query = `SELECT ${dashboardJobColumns} FROM jobs ORDER BY first_seen_at DESC${
    limit ? " LIMIT ?" : ""
  }`;
  const statement = env.DB.prepare(query);
  const result = await (limit ? statement.bind(limit) : statement).all<DashboardJob>();
  return result.results;
}

type MovementJob = Pick<DashboardJob, "id" | "companyId" | "title" | "canonicalUrl">;

async function listMovementJobs(since: string): Promise<MovementJob[]> {
  await ensureDatabase();
  const result = await env.DB.prepare(
    `SELECT DISTINCT jobs.id, jobs.company_id as companyId, jobs.title,
       jobs.canonical_url as canonicalUrl
     FROM jobs JOIN changes ON changes.entity_id=jobs.id
     WHERE changes.occurred_at >= ?
       AND changes.change_type IN ('job_opened', 'job_closed')`
  ).bind(since).all<MovementJob>();
  return result.results;
}

export type HomepageCoverageMetrics = Pick<CoverageMetrics,
  "verifiedOpenJobs" | "activeCompanies" | "companiesAddedLast7Days" |
  "jobsAddedLast24Hours" | "lastCanonicalRefresh"
> & {
  investorSourceCount: number;
  providerCount: number;
};

async function getHomepageCoverageMetrics(now: Date): Promise<HomepageCoverageMetrics> {
  await ensureDatabase();
  const nowIso = now.toISOString();
  const dayAgo = new Date(now.valueOf() - 86_400_000).toISOString();
  const weekAgo = new Date(now.valueOf() - 7 * 86_400_000).toISOString();
  const row = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM jobs WHERE status='verified_open') as verifiedOpenJobs,
    (SELECT COUNT(DISTINCT company_id) FROM jobs WHERE status='verified_open') as activeCompanies,
    (SELECT COUNT(DISTINCT company_id) FROM company_sources
      WHERE discovery_status='active' AND first_discovered_at >= ?) as companiesAddedLast7Days,
    (SELECT COUNT(*) FROM jobs WHERE status='verified_open'
      AND first_seen_at >= ? AND first_seen_at <= ?) as jobsAddedLast24Hours,
    (SELECT COUNT(*) FROM investor_sources WHERE enabled=1) as investorSourceCount,
    (SELECT COUNT(DISTINCT provider) FROM company_sources
      WHERE enabled=1 AND discovery_status='active') as providerCount,
    (SELECT MAX(last_successful_at) FROM company_sources) as lastCanonicalRefresh`
  ).bind(weekAgo, dayAgo, nowIso).first<HomepageCoverageMetrics>();
  return {
    verifiedOpenJobs: Number(row?.verifiedOpenJobs || 0),
    activeCompanies: Number(row?.activeCompanies || 0),
    companiesAddedLast7Days: Number(row?.companiesAddedLast7Days || 0),
    jobsAddedLast24Hours: Number(row?.jobsAddedLast24Hours || 0),
    investorSourceCount: Number(row?.investorSourceCount || 0),
    providerCount: Number(row?.providerCount || 0),
    lastCanonicalRefresh: row?.lastCanonicalRefresh || null,
  };
}

function attachCompaniesToJobs(jobs: Job[], companies: Company[]) {
  const companiesById = new Map(companies.map((company) => [company.id, company]));
  return jobs.map((job) => ({
    ...job,
    company: companiesById.get(job.companyId),
  }));
}

export async function listJobs(includeClosed = false): Promise<Job[]> {
  const [storedJobs, companies] = await Promise.all([
    listStoredJobs(includeClosed),
    listCompanies(),
  ]);
  const jobs = attachCompaniesToJobs(storedJobs, companies);
  return includeClosed ? jobs : companyDiverseJobs(jobs, companies);
}

export async function getHomepageData(now = new Date()) {
  const since = new Date(now.valueOf() - 30 * 86_400_000).toISOString();
  const [companies, jobs, movementJobs, changes, coverage] = await Promise.all([
    listCompanies(),
    listDashboardJobs(100),
    listMovementJobs(since),
    listHomepageChanges(since),
    getHomepageCoverageMetrics(now),
  ]);
  return {
    companies,
    jobs,
    movementJobs,
    changes,
    coverage,
  };
}

export async function listActiveHiringSignals(now = new Date()): Promise<HiringSignal[]> {
  await ensureDatabase();
  return listActiveHiringSignalRecords(env.DB, now);
}

export async function persistHiringSignals(signals: HiringSignalImport[]) {
  await ensureDatabase();
  return persistHiringSignalRecords(env.DB, signals);
}

export async function promoteSignal(signalId: string) {
  await ensureDatabase();
  return promoteHiringSignal(env.DB, signalId);
}

export async function listOffBoardVerifiedOpenings() {
  await ensureDatabase();
  return listOffBoardVerifiedOpeningRecords(env.DB);
}

export async function listChanges(since?: string): Promise<ChangeEvent[]> {
  await ensureDatabase();
  const query = `SELECT ${changeColumns} FROM changes${since ? " WHERE occurred_at >= ?" : ""}
    ORDER BY occurred_at DESC`;
  const statement = env.DB.prepare(query);
  const result = await (since ? statement.bind(since) : statement).all<ChangeEvent>();
  return result.results;
}

async function listHomepageChanges(since: string): Promise<ChangeEvent[]> {
  await ensureDatabase();
  const result = await env.DB.prepare(
    `SELECT ${changeColumns} FROM changes
     WHERE occurred_at >= ? OR change_type='funding_announced'
     ORDER BY occurred_at DESC`
  ).bind(since).all<ChangeEvent>();
  return result.results;
}

/**
 * Publish verified funding announcements and immediately recompute every
 * affected company's calibrated score. Event ids are source-stable, so daily
 * discovery retries cannot duplicate a movement.
 */
export async function persistFundingDiscoveries(discoveries: FundingDiscovery[]) {
  await ensureDatabase();
  if (!discoveries.length) return { announcementsAdded: 0, companiesUpdated: 0, scoresUpdated: 0 };
  const persisted = await persistFundingDiscoveryRecords(env.DB, discoveries);

  const [companies, jobs, changes] = await Promise.all([
    env.DB.prepare(`SELECT ${companyColumns} FROM companies`).all<Company>(),
    env.DB.prepare(`SELECT ${jobColumns} FROM jobs`).all<Job>(),
    env.DB.prepare(`SELECT ${changeColumns} FROM changes`).all<ChangeEvent>(),
  ]);
  const now = new Date().toISOString();
  const affectedIds = new Set(persisted.affectedCompanyIds);
  const scoreStatements = companies.results
    .filter((company) => affectedIds.has(company.id))
    .map((company) => {
      const receipts = companyScoreReceipts(
        company,
        jobs.results,
        changes.results,
        now,
        isBoardTracked(company.id)
      );
      return env.DB.prepare(
        "UPDATE companies SET hiring_score=?, evidence_confidence=? WHERE id=?"
      ).bind(receipts.hiring.value, receipts.evidence.value, company.id);
    });
  if (scoreStatements.length) await env.DB.batch(scoreStatements);
  return {
    announcementsAdded: persisted.announcementsAdded,
    companiesUpdated: persisted.companiesUpdated,
    scoresUpdated: scoreStatements.length,
  };
}

export async function getCompanyBySlug(slug: string): Promise<Company | null> {
  await ensureDatabase();
  return env.DB.prepare(`SELECT ${companyColumns} FROM companies WHERE slug = ?`)
    .bind(slug)
    .first<Company>();
}

export async function getCompanyById(id: string): Promise<Company | null> {
  await ensureDatabase();
  return env.DB.prepare(`SELECT ${companyColumns} FROM companies WHERE id = ?`)
    .bind(id)
    .first<Company>();
}

export async function getJobsForCompany(companyId: string): Promise<Job[]> {
  await ensureDatabase();
  const result = await env.DB.prepare(
    `SELECT ${jobColumns} FROM jobs WHERE company_id = ? ORDER BY first_seen_at DESC`
  ).bind(companyId).all<Job>();
  return result.results;
}

export async function getChangesForCompany(companyId: string): Promise<ChangeEvent[]> {
  await ensureDatabase();
  const jobIds = await env.DB.prepare("SELECT id FROM jobs WHERE company_id = ?")
    .bind(companyId).all<{ id: string }>();
  const ids = jobIds.results.map((item) => item.id);
  const all = await listChanges();
  return all.filter((change) => change.entityId === companyId || ids.includes(change.entityId));
}

export async function getJobById(id: string): Promise<Job | null> {
  await ensureDatabase();
  const job = await env.DB.prepare(`SELECT ${jobColumns} FROM jobs WHERE id = ?`)
    .bind(id).first<Job>();
  if (!job) return null;
  job.company = (await getCompanyById(job.companyId)) || undefined;
  return job;
}

export function apiEnvelope<T>(data: T, cursor = new Date().toISOString()) {
  return {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    cursor,
    license: "CC BY 4.0 applies only to project-owned material; source rights remain with their owners.",
    data,
  };
}

export async function getCoverageMetrics(now = new Date()): Promise<CoverageMetrics> {
  await ensureDatabase();
  const nowIso = now.toISOString();
  const dayAgo = new Date(now.valueOf() - 86_400_000).toISOString();
  const weekAgo = new Date(now.valueOf() - 7 * 86_400_000).toISOString();
  const [totals, activeSignals, offBoardVerified, recentCompanies, recentDayCompanies, recentJobs, investors, providers, failures, discoveryFailures, discovery, refresh, latestCompany, registry] =
    await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) as jobs, COUNT(DISTINCT company_id) as companies
        FROM jobs WHERE status='verified_open'`).first<{ jobs: number; companies: number }>(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM hiring_signals
        WHERE status='active' AND expires_at > ?`)
        .bind(nowIso).first<{ count: number }>(),
      env.DB.prepare(`SELECT COUNT(DISTINCT promotion.job_id) as openings,
        COUNT(DISTINCT promotion.company_id) as companies
        FROM hiring_signal_promotions promotion
        JOIN jobs ON jobs.id=promotion.job_id
        WHERE jobs.status='verified_open'`).first<{
          openings: number;
          companies: number;
        }>(),
      env.DB.prepare(`SELECT COUNT(DISTINCT company_id) as count FROM company_sources
        WHERE discovery_status='active' AND first_discovered_at >= ?`).bind(weekAgo).first<{ count: number }>(),
      env.DB.prepare(`SELECT COUNT(DISTINCT company_id) as count FROM company_sources
        WHERE discovery_status='active' AND first_discovered_at >= ?`).bind(dayAgo).first<{ count: number }>(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM jobs
        WHERE status='verified_open' AND first_seen_at >= ? AND first_seen_at <= ?`)
        .bind(dayAgo, nowIso).first<{ count: number }>(),
      env.DB.prepare(`SELECT i.name, COUNT(DISTINCT ci.company_id) as count
        FROM investor_sources i LEFT JOIN company_investors ci ON ci.investor_source_id=i.id
        WHERE i.enabled=1 GROUP BY i.id ORDER BY i.name`).all<{ name: string; count: number }>(),
      env.DB.prepare(`SELECT provider, COUNT(DISTINCT company_id) as count FROM company_sources
        WHERE enabled=1 AND discovery_status='active' GROUP BY provider ORDER BY provider`)
        .all<{ provider: string; count: number }>(),
      env.DB.prepare(`SELECT id as sourceId, provider, last_error as lastError,
        consecutive_failures as consecutiveFailures, last_successful_at as lastSuccessfulAt
        FROM company_sources WHERE enabled=1 AND last_error IS NOT NULL ORDER BY id`)
        .all<CoverageMetrics["sourceFailures"][number]>(),
      env.DB.prepare(`SELECT id as sourceId, last_error as lastError,
        last_successful_at as lastSuccessfulAt FROM investor_sources
        WHERE enabled=1 AND last_error IS NOT NULL ORDER BY id`)
        .all<CoverageMetrics["discoverySourceFailures"][number]>(),
      env.DB.prepare(`SELECT MAX(completed_at) as value FROM ingestion_runs`)
        .first<{ value: string | null }>(),
      env.DB.prepare(`SELECT MAX(last_successful_at) as value FROM company_sources`)
        .first<{ value: string | null }>(),
      env.DB.prepare(`SELECT MAX(first_discovered_at) as value FROM company_sources
        WHERE discovery_status='active'`).first<{ value: string | null }>(),
      env.DB.prepare(`SELECT
        COUNT(*) as total,
        (SELECT COUNT(*) FROM startup_domain_cohorts memberships
          JOIN startup_domain_imports imports ON imports.cohort=memberships.cohort
          WHERE imports.status='completed') as pilot,
        SUM(CASE WHEN review_status='pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN review_status='verified' AND activity_state='active' THEN 1 ELSE 0 END)
          as verifiedActive
        FROM startup_domains`).first<{
          total: number;
          pilot: number;
          pending: number;
          verifiedActive: number;
        }>(),
    ]);
  const daysWithoutGrowth = latestCompany?.value
    ? Math.max(0, Math.floor((now.valueOf() - Date.parse(latestCompany.value)) / 86_400_000))
    : 0;
  return {
    verifiedOpenJobs: Number(totals?.jobs || 0),
    activeHiringSignals: Number(activeSignals?.count || 0),
    offBoardVerifiedOpenings: Number(offBoardVerified?.openings || 0),
    offBoardVerifiedCompanies: Number(offBoardVerified?.companies || 0),
    activeCompanies: Number(totals?.companies || 0),
    companiesAddedLast7Days: Number(recentCompanies?.count || 0),
    companiesAddedLast1Day: Number(recentDayCompanies?.count || 0),
    jobsAddedLast24Hours: Number(recentJobs?.count || 0),
    lastDiscoveryRun: discovery?.value || null,
    lastCanonicalRefresh: refresh?.value || null,
    consecutiveDaysWithoutCompanyGrowth: daysWithoutGrowth,
    companyGrowthWarning: Number(totals?.companies || 0) < 50 && daysWithoutGrowth >= 3,
    startupDomains: Number(registry?.total || 0),
    pilotStartupDomains: Number(registry?.pilot || 0),
    pendingStartupDomains: Number(registry?.pending || 0),
    verifiedActiveStartupDomains: Number(registry?.verifiedActive || 0),
    investors: Object.fromEntries(investors.results.map((item) => [item.name, Number(item.count)])),
    providers: Object.fromEntries(providers.results.map((item) => [item.provider, Number(item.count)])),
    sourceFailures: failures.results,
    discoverySourceFailures: discoveryFailures.results,
  };
}
