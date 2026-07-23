import { env } from "cloudflare:workers";
import { seedChanges, seedCompanies, seedJobs } from "./seed";
import type { ChangeEvent, Company, Job } from "./types";

let initialization: Promise<void> | null = null;

const companyColumns = `
  id, slug, name, domain, description, founded_year as foundedYear,
  headquarters, employee_range as employeeRange, industry, stage,
  funding_mode as fundingMode, lifecycle_status as lifecycleStatus,
  hiring_score as hiringScore, evidence_confidence as evidenceConfidence,
  latest_funding_label as latestFundingLabel, latest_funding_date as latestFundingDate,
  careers_url as careersUrl, source_url as sourceUrl,
  open_job_count as openJobCount, last_verified_at as lastVerifiedAt
`;

const jobColumns = `
  id, company_id as companyId, external_id as externalId, title,
  role_family as roleFamily, location, remote_status as remoteStatus,
  employment_type as employmentType, compensation, canonical_url as canonicalUrl,
  source, status, first_seen_at as firstSeenAt, last_verified_at as lastVerifiedAt,
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
  ]);

  const existing = await env.DB.prepare("SELECT COUNT(*) as count FROM companies").first<{ count: number }>();
  if (Number(existing?.count || 0) > 0) return;

  const companyStatements = seedCompanies.map((company) =>
    env.DB.prepare(`INSERT OR IGNORE INTO companies (
      id, slug, name, domain, description, founded_year, headquarters, employee_range,
      industry, stage, funding_mode, lifecycle_status, hiring_score, evidence_confidence,
      latest_funding_label, latest_funding_date, careers_url, source_url, open_job_count,
      last_verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      company.id, company.slug, company.name, company.domain, company.description,
      company.foundedYear, company.headquarters, company.employeeRange, company.industry,
      company.stage, company.fundingMode, company.lifecycleStatus, company.hiringScore,
      company.evidenceConfidence, company.latestFundingLabel, company.latestFundingDate,
      company.careersUrl, company.sourceUrl, company.openJobCount, company.lastVerifiedAt
    )
  );

  const jobStatements = seedJobs.map((job) =>
    env.DB.prepare(`INSERT OR IGNORE INTO jobs (
      id, company_id, external_id, title, role_family, location, remote_status,
      employment_type, compensation, canonical_url, source, status, first_seen_at,
      last_verified_at, closed_at, summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      job.id, job.companyId, job.externalId, job.title, job.roleFamily, job.location,
      job.remoteStatus, job.employmentType, job.compensation, job.canonicalUrl,
      job.source, job.status, job.firstSeenAt, job.lastVerifiedAt, job.closedAt, job.summary
    )
  );

  const changeStatements = seedChanges.map((change) =>
    env.DB.prepare(`INSERT OR IGNORE INTO changes (
      id, entity_type, entity_id, change_type, title, description, occurred_at, source_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      change.id, change.entityType, change.entityId, change.changeType,
      change.title, change.description, change.occurredAt, change.sourceUrl
    )
  );

  await env.DB.batch([...companyStatements, ...jobStatements, ...changeStatements]);
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
  const result = await env.DB.prepare(
    `SELECT ${companyColumns} FROM companies ORDER BY hiring_score DESC, name ASC`
  ).all<Company>();
  return result.results;
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
