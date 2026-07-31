import type { HiringSignalImport } from "./hiring-signals";
import type { HiringSignal, OffBoardVerifiedOpening } from "./types";

const signalColumns = `
  id, company_id as companyId, company_name as companyName,
  company_domain as companyDomain, role_function as roleFunction, summary,
  source_kind as sourceKind, source_url as sourceUrl, evidence_url as evidenceUrl,
  source_rights_url as sourceRightsUrl, application_url as applicationUrl,
  permission_status as permissionStatus, confidence, status,
  observed_at as observedAt, last_verified_at as lastVerifiedAt,
  expires_at as expiresAt, promoted_job_id as promotedJobId
`;

export async function persistHiringSignalRecords(
  database: D1Database,
  signals: HiringSignalImport[]
) {
  const statements = signals.map((signal) =>
    database.prepare(`INSERT INTO hiring_signals (
      id, company_id, company_name, company_domain, role_function, summary,
      source_kind, source_url, evidence_url, source_rights_url, application_url,
      permission_status, confidence, status, observed_at, last_verified_at,
      expires_at, promoted_job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      company_id=excluded.company_id,
      company_name=excluded.company_name,
      company_domain=excluded.company_domain,
      role_function=excluded.role_function,
      summary=excluded.summary,
      source_kind=excluded.source_kind,
      source_url=excluded.source_url,
      evidence_url=excluded.evidence_url,
      source_rights_url=excluded.source_rights_url,
      application_url=excluded.application_url,
      permission_status=excluded.permission_status,
      confidence=excluded.confidence,
      observed_at=excluded.observed_at,
      last_verified_at=excluded.last_verified_at,
      expires_at=excluded.expires_at,
      status=CASE WHEN hiring_signals.status='promoted' THEN 'promoted' ELSE 'active' END`)
      .bind(
        signal.id,
        signal.companyId || null,
        signal.companyName,
        signal.companyDomain,
        signal.roleFunction,
        signal.summary,
        signal.sourceKind,
        signal.sourceUrl,
        signal.evidenceUrl,
        signal.sourceRightsUrl,
        signal.applicationUrl,
        signal.permissionStatus,
        signal.confidence,
        signal.observedAt,
        signal.lastVerifiedAt,
        signal.expiresAt
      )
  );
  if (statements.length) await database.batch(statements);
  return statements.length;
}

export async function listActiveHiringSignalRecords(
  database: D1Database,
  now = new Date()
): Promise<HiringSignal[]> {
  const result = await database.prepare(`SELECT ${signalColumns}
    FROM hiring_signals
    WHERE status='active' AND expires_at > ?
    ORDER BY confidence DESC, last_verified_at DESC, id ASC`)
    .bind(now.toISOString())
    .all<HiringSignal>();
  return result.results;
}

export async function listOffBoardVerifiedOpeningRecords(
  database: D1Database
): Promise<OffBoardVerifiedOpening[]> {
  const result = await database.prepare(`SELECT
    promotion.signal_id as signalId, promotion.job_id as jobId,
    promotion.company_id as companyId, company.name as companyName,
    company.domain as companyDomain, jobs.title, jobs.location,
    jobs.employment_type as employmentType,
    jobs.canonical_url as canonicalUrl,
    promotion.evidence_url as evidenceUrl,
    promotion.source_rights_url as sourceRightsUrl,
    promotion.discovery_source_kind as discoverySourceKind,
    promotion.verified_at as verifiedAt
    FROM hiring_signal_promotions promotion
    JOIN jobs ON jobs.id=promotion.job_id
    JOIN companies company ON company.id=promotion.company_id
    WHERE jobs.status='verified_open'
    ORDER BY promotion.verified_at DESC, promotion.signal_id`)
    .all<OffBoardVerifiedOpening>();
  return result.results;
}
