import type { AtsDetection } from "./ats-adapters";
import { careerFingerprint } from "./domain-registry";
import { DISCOVERY_PIPELINE_VERSION } from "./discovery-version";
import { resolveDiscoveredCompanySlug, companySlugFromDomain,
  discoveryEvidencePermissionSql } from "./discovery-policy";
import { sourceKey } from "./source-registry";
import { normalizeSector } from "./types";

export type ActivationCandidate = {
  id: string;
  normalizedDomain: string;
  companyName: string;
  websiteUrl: string;
  evidenceUrl?: string;
};

export class ActivationIdentityConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivationIdentityConflict";
  }
}

export class ActivationWriteRace extends Error {
  constructor() {
    super("activation_write_race_retry");
    this.name = "ActivationWriteRace";
  }
}

function companyIdForDomain(domain: string) {
  let hash = 2166136261;
  for (const character of domain) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `company_${(hash >>> 0).toString(36)}`;
}

/** D1 batch is one transaction: a uniqueness or write failure rolls back every activation row. */
export async function activateDiscoveredCandidateInDatabase(
  database: D1Database,
  candidate: ActivationCandidate,
  detection: AtsDetection,
  now: string,
  options: { sourceEnabled?: boolean; approvedReviewBatchId?: string } = {}
) {
  const queue = await database.prepare(`SELECT status FROM discovery_queue
    WHERE id=? AND normalized_domain=?`).bind(candidate.id, candidate.normalizedDomain)
    .first<{ status: string }>();
  if (!queue || queue.status === "rejected") throw new ActivationIdentityConflict("candidate_not_eligible");
  const permission = await database.prepare(`SELECT 1 as permitted FROM startup_domain_evidence
    WHERE canonical_domain=? AND ${discoveryEvidencePermissionSql("startup_domain_evidence")} LIMIT 1`)
    .bind(candidate.normalizedDomain).first();
  if (!permission) throw new ActivationIdentityConflict("candidate_permission_missing");
  const registry = await database.prepare(`SELECT company_id as companyId, review_status as reviewStatus
    FROM startup_domains WHERE canonical_domain=?`).bind(candidate.normalizedDomain)
    .first<{ companyId: string | null; reviewStatus: string }>();
  if (!registry || registry.reviewStatus === "rejected") {
    throw new ActivationIdentityConflict("candidate_registry_blocked");
  }
  const reviews = await database.prepare(`SELECT batch_id as batchId, status
    FROM discovery_candidate_reviews WHERE candidate_id=?
      AND status NOT IN ('rejected','activated')`).bind(candidate.id)
    .all<{ batchId: string; status: string }>();
  if (reviews.results.length && (!options.approvedReviewBatchId ||
    reviews.results.some((review) => review.batchId !== options.approvedReviewBatchId || review.status !== "ready"))) {
    throw new ActivationIdentityConflict("candidate_review_pending");
  }
  const existingCompany = await database.prepare(`SELECT id, domain FROM companies
    WHERE lower(domain)=? LIMIT 1`).bind(candidate.normalizedDomain)
    .first<{ id: string; domain: string }>();
  const companyId = existingCompany?.id || companyIdForDomain(candidate.normalizedDomain);
  if (registry.companyId && registry.companyId !== companyId) {
    throw new ActivationIdentityConflict("registry_company_conflict");
  }
  const canonicalSourceId = sourceKey(detection.provider, detection.boardId);
  const owner = await database.prepare(`SELECT company_id as companyId FROM company_sources
    WHERE provider=? AND board_id=? LIMIT 1`).bind(detection.provider, detection.boardId)
    .first<{ companyId: string }>();
  // A shared board can host multiple employers. It is never alias evidence.
  if (owner && owner.companyId !== companyId) {
    throw new ActivationIdentityConflict("shared_board_requires_identity_review");
  }
  if (queue.status === "active" && owner?.companyId === companyId && registry.companyId === companyId) {
    return { companyId, canonicalSourceId };
  }
  const baseSlug = companySlugFromDomain(candidate.normalizedDomain);
  const slugOccupant = !existingCompany && baseSlug
    ? await database.prepare("SELECT domain FROM companies WHERE slug=? LIMIT 1")
      .bind(baseSlug).first<{ domain: string }>()
    : null;
  const slug = resolveDiscoveredCompanySlug(candidate.normalizedDomain, slugOccupant?.domain || null);
  const discoveredIndustry = "Not published";
  const discoveredSector = normalizeSector(discoveredIndustry, {
    name: candidate.companyName,
    domain: candidate.normalizedDomain,
  });
  const statements: D1PreparedStatement[] = [];
  if (!existingCompany) {
    statements.push(database.prepare(`INSERT INTO companies (
      id, slug, name, domain, description, founded_year, headquarters, employee_range,
      industry, sector, stage, funding_mode, lifecycle_status, hiring_score,
      evidence_confidence, latest_funding_label, latest_funding_date, careers_url,
      source_url, open_job_count, last_verified_at
    ) VALUES (?, ?, ?, ?, 'Profile discovered from an official investor portfolio; industry not published.',
      NULL, 'Not published', 'Not published', ?, ?, 'Not published',
      'Not published', 'active', 0, 0, 'Not published', NULL, ?, ?, 0, ?)`)
      .bind(companyId, slug, candidate.companyName, candidate.normalizedDomain,
        discoveredIndustry, discoveredSector, detection.careersUrl,
        candidate.evidenceUrl || candidate.websiteUrl, now));
  }
  statements.push(database.prepare(`UPDATE companies SET sector=? WHERE id=?
    AND lower(trim(industry)) IN ('', 'other', 'unknown', 'not published',
      'not specified', 'unspecified', 'n/a', 'na', 'none', 'general')`)
    .bind(discoveredSector, companyId));
  if (!owner) {
    statements.push(database.prepare(`INSERT INTO company_sources (
      id, company_id, provider, board_id, careers_url, enabled, discovery_status,
      first_discovered_at, consecutive_failures, review_notes
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0, 'Automatically detected and canonically verified')`)
      .bind(canonicalSourceId, companyId, detection.provider, detection.boardId,
        detection.careersUrl, options.sourceEnabled === false ? 0 : 1, now));
  }
  statements.push(
    database.prepare(`INSERT OR IGNORE INTO company_investors (
      company_id, investor_source_id, first_discovered_at, evidence_url
    ) SELECT ?, investor_source_id, first_discovered_at, evidence_url
      FROM discovery_queue_investors WHERE candidate_id=?`).bind(companyId, candidate.id),
    database.prepare(`UPDATE discovery_queue SET status='active', last_error=NULL,
      last_outcome='activated', discovery_version=?, next_attempt_at=NULL,
      review_notes='Canonical source verified with US-eligible open jobs.' WHERE id=?`)
      .bind(DISCOVERY_PIPELINE_VERSION, candidate.id),
    database.prepare(`UPDATE startup_domains SET company_id=?, activity_state='active',
      review_status='verified', careers_url=?, ats_provider=?, ats_board_id=?,
      career_fingerprint=?, last_discovery_attempt_at=?, last_seen_at=?
      WHERE canonical_domain=?`).bind(companyId, detection.careersUrl,
        detection.provider, detection.boardId,
        careerFingerprint(detection.provider, detection.boardId, detection.careersUrl),
        now, now, candidate.normalizedDomain),
  );
  try {
    await database.batch(statements);
  } catch (error) {
    // A concurrent winner may have taken the board or slug after the preflight.
    // The failed batch has no effects, so the caller can review or retry safely.
    const currentOwner = await database.prepare(`SELECT company_id as companyId
      FROM company_sources WHERE provider=? AND board_id=?`)
      .bind(detection.provider, detection.boardId).first<{ companyId: string }>();
    if (currentOwner && currentOwner.companyId !== companyId) {
      throw new ActivationIdentityConflict("shared_board_requires_identity_review");
    }
    const slugOwner = await database.prepare("SELECT domain FROM companies WHERE slug=?")
      .bind(slug).first<{ domain: string }>();
    if (slugOwner && slugOwner.domain.toLowerCase() !== candidate.normalizedDomain.toLowerCase()) {
      throw new ActivationWriteRace();
    }
    const completed = await database.prepare(`SELECT q.status, d.company_id as companyId
      FROM discovery_queue q JOIN startup_domains d
        ON d.canonical_domain=q.normalized_domain WHERE q.id=?`)
      .bind(candidate.id).first<{ status: string; companyId: string | null }>();
    if (completed?.status === "active" && completed.companyId === companyId &&
      currentOwner?.companyId === companyId) {
      return { companyId, canonicalSourceId };
    }
    throw error;
  }
  return { companyId, canonicalSourceId };
}
