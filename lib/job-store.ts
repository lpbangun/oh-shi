import type { Job } from "./types";

export function prepareSeedJobStatement(
  database: D1Database,
  job: Job,
  provider: string,
  sourceId: string
) {
  return database.prepare(`INSERT OR IGNORE INTO jobs (
    id, company_id, external_id, provider, source_id, title, role_family, location,
    remote_status, employment_type, compensation, canonical_url, source, status,
    first_seen_at, last_seen_at, source_updated_at, published_at, last_verified_at,
    closed_at, raw_url, discovery_channel, evidence_url, parser_version,
    snapshot_run_id, linkedin_presence_state, linkedin_evidence_url,
    linkedin_checked_at, summary
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?)`).bind(
    job.id,
    job.companyId,
    job.externalId,
    provider,
    sourceId,
    job.title,
    job.roleFamily,
    job.location,
    job.remoteStatus,
    job.employmentType,
    job.compensation,
    job.canonicalUrl,
    job.source,
    job.status,
    job.firstSeenAt,
    job.lastSeenAt,
    job.sourceUpdatedAt,
    job.publishedAt || null,
    job.lastVerifiedAt,
    job.closedAt,
    job.rawUrl,
    job.discoveryChannel,
    job.evidenceUrl,
    job.parserVersion,
    job.snapshotRunId,
    job.linkedInPresenceState,
    job.linkedInEvidenceUrl,
    job.linkedInCheckedAt,
    job.summary
  );
}
