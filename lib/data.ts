import { env } from "cloudflare:workers";
import { companyScoreReceipts } from "./hiring-score";
import { seedChanges, seedCompanies, seedJobs } from "./seed";
import { isBoardTracked } from "./tracked-boards";
import { COMPANY_SOURCE_SEEDS, INVESTOR_SOURCE_SEEDS, sourceKey } from "./source-registry";
import { normalizeSector, type ChangeEvent, type Company, type CoverageMetrics, type Job } from "./types";

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
  source, status, first_seen_at as firstSeenAt, published_at as publishedAt, last_verified_at as lastVerifiedAt,
  closed_at as closedAt, summary
`;

const changeColumns = `
  id, entity_type as entityType, entity_id as entityId, change_type as changeType,
  title, description, occurred_at as occurredAt, source_url as sourceUrl
`;

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
      last_verified_at TEXT NOT NULL,
      closed_at TEXT,
      summary TEXT NOT NULL
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
      jobs_url TEXT, access_mode TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
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
      UNIQUE(provider, board_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS company_investors (
      company_id TEXT NOT NULL, investor_source_id TEXT NOT NULL, first_discovered_at TEXT NOT NULL,
      evidence_url TEXT NOT NULL, PRIMARY KEY(company_id, investor_source_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS discovery_queue (
      id TEXT PRIMARY KEY, normalized_domain TEXT NOT NULL UNIQUE, company_name TEXT NOT NULL,
      website_url TEXT NOT NULL, status TEXT NOT NULL, first_discovered_at TEXT NOT NULL,
      last_attempted_at TEXT, last_error TEXT, review_notes TEXT NOT NULL DEFAULT ''
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS discovery_queue_investors (
      candidate_id TEXT NOT NULL, investor_source_id TEXT NOT NULL, evidence_url TEXT NOT NULL,
      first_discovered_at TEXT NOT NULL, PRIMARY KEY(candidate_id, investor_source_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ingestion_runs (
      id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT,
      status TEXT NOT NULL, metrics_json TEXT NOT NULL DEFAULT '{}'
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ingestion_source_results (
      run_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
      status TEXT NOT NULL, attempted_at TEXT NOT NULL, completed_at TEXT,
      discovered_count INTEGER NOT NULL DEFAULT 0, verified_count INTEGER NOT NULL DEFAULT 0,
      opened_count INTEGER NOT NULL DEFAULT 0, closed_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT, error_message TEXT,
      PRIMARY KEY(run_id, source_kind, source_id)
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
  const investorInfo = await env.DB.prepare("PRAGMA table_info(investor_sources)")
    .all<{ name: string }>();
  if (!investorInfo.results.some((column) => column.name === "discovery_cursor")) {
    await env.DB.prepare(
      "ALTER TABLE investor_sources ADD COLUMN discovery_cursor INTEGER NOT NULL DEFAULT 0"
    ).run();
  }
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS jobs_source_status_idx ON jobs(provider, source_id, status)"
  ).run();
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
      industry=excluded.industry, sector=excluded.sector, stage=excluded.stage,
      funding_mode=excluded.funding_mode, lifecycle_status=excluded.lifecycle_status,
      latest_funding_label=excluded.latest_funding_label,
      latest_funding_date=excluded.latest_funding_date,
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
      id, name, kind, portfolio_url, jobs_url, access_mode, enabled, mandatory, review_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind,
      portfolio_url=excluded.portfolio_url, jobs_url=excluded.jobs_url,
      access_mode=excluded.access_mode, enabled=excluded.enabled,
      mandatory=excluded.mandatory, review_notes=excluded.review_notes`).bind(
      source.id, source.name, source.kind, source.portfolioUrl, source.jobsUrl,
      source.access, source.enabled ? 1 : 0, source.mandatory ? 1 : 0, source.reviewNotes
    )),
    ...COMPANY_SOURCE_SEEDS.map((source) => env.DB.prepare(`INSERT OR IGNORE INTO company_sources (
      id, company_id, provider, board_id, careers_url, enabled, discovery_status,
      first_discovered_at, consecutive_failures, review_notes
    ) VALUES (?, ?, ?, ?, ?, 1, 'active', ?, 0, 'Typed bootstrap source')`).bind(
      sourceKey(source.provider, source.boardId), source.companyId, source.provider,
      source.boardId, source.careersUrl, discoveredAt
    )),
  ]);
  if (!hadCompanies) {
    const jobStatements = seedJobs.map((job) => {
      const canonicalSource = COMPANY_SOURCE_SEEDS.find(
        (source) => source.companyId === job.companyId
      );
      if (!canonicalSource) {
        throw new Error(`Seed job ${job.id} has no canonical company source.`);
      }
      return (
      env.DB.prepare(`INSERT OR IGNORE INTO jobs (
      id, company_id, external_id, provider, source_id, title, role_family, location, remote_status,
      employment_type, compensation, canonical_url, source, status, first_seen_at,
      published_at, last_verified_at, closed_at, summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`).bind(
      job.id, job.companyId, job.externalId, canonicalSource.provider,
      sourceKey(canonicalSource.provider, canonicalSource.boardId), job.title,
      job.roleFamily, job.location, job.remoteStatus, job.employmentType,
      job.compensation, job.canonicalUrl, job.source, job.status, job.firstSeenAt,
      job.lastVerifiedAt, job.closedAt, job.summary
    )
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
    provider=COALESCE((SELECT provider FROM company_sources s WHERE s.company_id=jobs.company_id LIMIT 1), provider),
    source_id=COALESCE((SELECT id FROM company_sources s WHERE s.company_id=jobs.company_id LIMIT 1), source_id)
    WHERE source_id='legacy'`).run();
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

export async function ensureDatabase() {
  initialization ??= initializeDatabase().catch((error) => {
    initialization = null;
    throw error;
  });
  await initialization;
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

export async function listJobs(includeClosed = false): Promise<Job[]> {
  await ensureDatabase();
  const where = includeClosed ? "" : "WHERE status = 'verified_open'";
  const [result, companies] = await Promise.all([
    env.DB.prepare(
      `SELECT ${jobColumns} FROM jobs ${where} ORDER BY first_seen_at DESC`
    ).all<Job>(),
    listCompanies(),
  ]);
  const companiesById = new Map(companies.map((company) => [company.id, company]));
  return result.results.map((job) => ({
    ...job,
    company: companiesById.get(job.companyId),
  }));
}

export async function listChanges(): Promise<ChangeEvent[]> {
  await ensureDatabase();
  const result = await env.DB.prepare(
    `SELECT ${changeColumns} FROM changes ORDER BY occurred_at DESC`
  ).all<ChangeEvent>();
  return result.results;
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
  const [totals, recentCompanies, recentDayCompanies, recentJobs, investors, providers, failures, discoveryFailures, discovery, refresh, latestCompany] =
    await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) as jobs, COUNT(DISTINCT company_id) as companies
        FROM jobs WHERE status='verified_open'`).first<{ jobs: number; companies: number }>(),
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
    ]);
  const daysWithoutGrowth = latestCompany?.value
    ? Math.max(0, Math.floor((now.valueOf() - Date.parse(latestCompany.value)) / 86_400_000))
    : 0;
  return {
    verifiedOpenJobs: Number(totals?.jobs || 0),
    activeCompanies: Number(totals?.companies || 0),
    companiesAddedLast7Days: Number(recentCompanies?.count || 0),
    companiesAddedLast1Day: Number(recentDayCompanies?.count || 0),
    jobsAddedLast24Hours: Number(recentJobs?.count || 0),
    lastDiscoveryRun: discovery?.value || null,
    lastCanonicalRefresh: refresh?.value || null,
    consecutiveDaysWithoutCompanyGrowth: daysWithoutGrowth,
    companyGrowthWarning: Number(totals?.companies || 0) < 50 && daysWithoutGrowth >= 3,
    investors: Object.fromEntries(investors.results.map((item) => [item.name, Number(item.count)])),
    providers: Object.fromEntries(providers.results.map((item) => [item.provider, Number(item.count)])),
    sourceFailures: failures.results,
    discoverySourceFailures: discoveryFailures.results,
  };
}
