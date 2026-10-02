import {
  buildStartupDomainPilot,
  registrableDomain,
  type DomainPermissionStatus,
  type StartupDomainEvidenceInput,
} from "./domain-registry";

/** Inert rows: validation produces registry-shaped evidence, never a DB mutation. */
export type CohortRow = {
  name: string;
  website_url: string;
  domain: string;
  sector: string;
  ats_hint: string;
  careers_url: string | null;
  access_mode: "public_page" | "manual_import" | "awaiting_permission";
  terms_url: string | null;
  evidence_url: string;
  permission_review?: {
    status: "permitted";
    scope: "automated_access_and_reuse";
    evidence_url: string;
    reviewed_at: string;
    reviewer: string;
  };
};

type StagedRow = {
  domain: string;
  permission_status: DomainPermissionStatus;
  runnable: boolean;
  permission_evidence_url: string | null;
  registry_evidence: StartupDomainEvidenceInput;
};

const https = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
};

function boardEvidenceSlug(evidenceUrl: string) {
  const host = new URL(evidenceUrl).hostname.toLowerCase();
  const match = host.match(/^([a-z0-9-]+)\.jobs\.personio\.(?:de|com)$/) ||
    host.match(/^([a-z0-9-]+)\.recruitee\.com$/);
  return match?.[1] && match[1] !== "www" ? match[1] : null;
}

export function stageCohortRows(values: unknown[], observedAt: string) {
  const staged: StagedRow[] = [];
  const issues: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("invalid_observed_at");
  for (const [index, value] of values.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push({ index, reason: "row_not_object" });
      continue;
    }
    const row = value as Partial<CohortRow>;
    const website = https(row.website_url);
    const evidence = https(row.evidence_url);
    const terms = row.terms_url === null ? null : https(row.terms_url);
    const careers = row.careers_url === null ? null : https(row.careers_url);
    const domain = website ? registrableDomain(website) : null;
    if (!row.name?.trim() || !row.sector?.trim() || !row.ats_hint?.trim() ||
      !website || !evidence || !domain || domain !== row.domain?.toLowerCase() ||
      (row.terms_url !== null && !terms) || (row.careers_url !== null && !careers) ||
      !["public_page", "manual_import", "awaiting_permission"].includes(row.access_mode || "")) {
      issues.push({ index, reason: "invalid_cohort_row" });
      continue;
    }
    if (seen.has(domain)) {
      issues.push({ index, reason: "duplicate_domain" });
      continue;
    }
    seen.add(domain);
    const review = row.permission_review;
    const explicitPermission = row.access_mode === "public_page" &&
      review?.status === "permitted" && review.scope === "automated_access_and_reuse" &&
      Boolean(https(review.evidence_url)) && Boolean(review.reviewer?.trim()) &&
      Number.isFinite(Date.parse(review.reviewed_at)) && Boolean(terms);
    const permissionStatus: DomainPermissionStatus = row.access_mode === "manual_import"
      ? "manual_only"
      : explicitPermission ? "permitted" : "awaiting_permission";
    if (review && !explicitPermission) {
      issues.push({ index, reason: "contradictory_or_incomplete_permission_review" });
    }
    const slug = boardEvidenceSlug(evidence);
    const record: StartupDomainEvidenceInput = {
      companyName: row.name.trim(),
      websiteUrl: website,
      sourceKind: "curated_cohort",
      sourceId: slug ? `curated:${slug}` : `curated:${domain}`,
      sourceClassification: permissionStatus === "permitted"
        ? "general_v1_poc" : "general_v1_staged",
      evidenceUrl: evidence,
      sourceTermsUrl: terms || undefined,
      permissionProvenance: explicitPermission ? {
        evidenceUrl: https(review!.evidence_url)!,
        scope: "automated_access_and_reuse",
        reviewedAt: review!.reviewed_at,
        reviewer: review!.reviewer.trim(),
      } : undefined,
      permissionStatus,
      observedAt,
      activityState: "unknown",
      reviewStatus: "pending",
    };
    if (buildStartupDomainPilot([record], 1).entries.length !== 1) {
      issues.push({ index, reason: "registry_contract_rejected" });
      continue;
    }
    staged.push({
      domain,
      permission_status: permissionStatus,
      runnable: permissionStatus === "permitted",
      permission_evidence_url: explicitPermission ? https(review!.evidence_url) : null,
      registry_evidence: record,
    });
  }
  return { staged, issues };
}
