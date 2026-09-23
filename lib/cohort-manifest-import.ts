import {
  type CohortAccessMode,
  type CohortManifestRow,
} from "./cohort-manifest";
import {
  buildStartupDomainPilot,
  registrableDomain,
  type DomainPermissionStatus,
  type StartupDomainEvidenceInput,
} from "./domain-registry";

/**
 * Import contract for the employer-first cohort manifest (architecture.md §3.2).
 *
 * The manifest's honest `access_mode` becomes the registry's `permission_status`
 * here, and only `public_page` rows become `permitted`. A record the registry
 * contract would reject is dropped and reported instead of being sent: the
 * import endpoint answers 400 for a whole batch when one record is invalid, so
 * a silent drop would lose the batch and an optimistic send would lose the
 * manifest. Either way the accounting stays honest.
 */

/** `access_mode` → `permission_status` (architecture.md §3.2, binding). */
export const COHORT_PERMISSION_BY_ACCESS_MODE: Record<
  CohortAccessMode,
  DomainPermissionStatus
> = {
  public_page: "permitted",
  manual_import: "manual_only",
  awaiting_permission: "awaiting_permission",
};

export const COHORT_SOURCE_KIND = "curated_cohort";
export const COHORT_POC_SOURCE_CLASSIFICATION = "general_v1_poc";
export const COHORT_STAGED_SOURCE_CLASSIFICATION = "general_v1_staged";

const WIKIDATA_ENTITY = /^https:\/\/www\.wikidata\.org\/wiki\/(Q\d+)$/;

/**
 * Evidence source id. Enumerated rows cite the Wikidata entity that named the
 * employer; curated rows cite the probed board, whose own slug is both the
 * employer's identifier and the slug the ATS probe retries when a site never
 * advertises its board.
 */
export function cohortEvidenceSourceId(row: CohortManifestRow) {
  const entity = WIKIDATA_ENTITY.exec(row.evidence_url);
  if (entity) return `wikidata:${entity[1]}`;
  const board = row.careers_url || row.evidence_url;
  try {
    const segments = new URL(board).pathname.split("/").filter(Boolean);
    const slug = (segments[segments.length - 1] || row.domain).toLowerCase();
    return `curated:${slug.slice(0, 80)}`;
  } catch {
    return `curated:${row.domain}`;
  }
}

export function cohortEvidenceRecord(
  row: CohortManifestRow,
  observedAt: string
): StartupDomainEvidenceInput {
  return {
    companyName: row.name,
    websiteUrl: row.website_url,
    sourceId: cohortEvidenceSourceId(row),
    sourceKind: COHORT_SOURCE_KIND,
    sourceClassification: row.access_mode === "public_page"
      ? COHORT_POC_SOURCE_CLASSIFICATION
      : COHORT_STAGED_SOURCE_CLASSIFICATION,
    evidenceUrl: row.evidence_url,
    permissionStatus: COHORT_PERMISSION_BY_ACCESS_MODE[row.access_mode],
    sourceTermsUrl: row.terms_url,
    observedAt,
  };
}

/**
 * Why a record is refused, in the registry contract's own order. `permitted`
 * without `source_terms_url` is the fail-closed rule (`lib/domain-registry.ts`):
 * a row that claims automated permission but names no terms never runs.
 */
export function cohortRecordRefusalReason(record: StartupDomainEvidenceInput) {
  if (!record.companyName.trim()) return "empty_company_name";
  if (!record.sourceId.trim()) return "empty_source_id";
  if (!record.evidenceUrl.startsWith("https://")) return "evidence_url_not_https";
  if (!record.sourceTermsUrl) {
    return record.permissionStatus === "permitted"
      ? "permitted_requires_source_terms"
      : "missing_source_terms_url";
  }
  if (!record.sourceTermsUrl.startsWith("https://")) return "source_terms_url_not_https";
  if (!registrableDomain(record.websiteUrl)) {
    return "website_url_without_registrable_domain";
  }
  if (!Number.isFinite(Date.parse(record.observedAt))) return "invalid_observed_at";
  return "";
}

export type CohortImportDrop = {
  domain: string;
  name: string;
  access_mode: CohortAccessMode;
  permission_status: DomainPermissionStatus;
  reason: string;
};

/**
 * Maps manifest rows to registry evidence records, minus the rows the registry
 * contract refuses. Refused rows are returned, never dropped silently.
 */
export function cohortEvidenceRecords(
  rows: CohortManifestRow[],
  observedAt: string
) {
  const records: StartupDomainEvidenceInput[] = [];
  const drops: CohortImportDrop[] = [];
  for (const row of rows) {
    const record = cohortEvidenceRecord(row, observedAt);
    const reason = cohortRecordRefusalReason(record) ||
      (buildStartupDomainPilot([record], 1).entries.length === 1
        ? ""
        : "registry_contract_rejected");
    if (reason) {
      drops.push({
        domain: row.domain,
        name: row.name,
        access_mode: row.access_mode,
        permission_status: record.permissionStatus,
        reason,
      });
      continue;
    }
    records.push(record);
  }
  return { records, drops };
}
