import { registrableDomain } from "./domain-registry";

/**
 * Employer-first cohort manifest contract (architecture.md §3.2).
 *
 * The manifest is data, not an activation: rows carry an honest `access_mode`
 * and real receipt URLs, and only `public_page` rows map to `permitted` at
 * import time. This module owns the row schema plus the composition accounting
 * so the builder script, the evals, and reviewers all read the same rules.
 */

export type CohortAccessMode =
  | "public_page"
  | "manual_import"
  | "awaiting_permission";

export type CohortAtsFamily =
  | "ashby"
  | "greenhouse"
  | "lever"
  | "structured"
  | "workable"
  | "personio"
  | "recruitee"
  | "smartrecruiters";

export type CohortAtsHint = CohortAtsFamily | "unknown";

export const COHORT_KEY = "general-v1";
export const COHORT_HUMAN_LABEL = "general:v1";
export const COHORT_MANIFEST_PATH = "data/cohorts/general-v1.jsonl";
export const COHORT_CANDIDATES_PATH = "data/cohorts/general-v1-poc-candidates.json";
export const COHORT_ENUMERATION_RECEIPT_PATH =
  "evidence/cohorts/general-v1-enumeration-receipt.json";
export const COHORT_IMPORT_RECEIPT_PATH =
  "evidence/cohorts/general-v1-import-receipt.json";
export const COHORT_POC_NOTE = "general:v1 POC seed";
export const COHORT_STAGED_NOTE = "general:v1 staged";

export const COHORT_ACCESS_MODES: readonly CohortAccessMode[] = [
  "public_page",
  "manual_import",
  "awaiting_permission",
];

export const COHORT_ATS_FAMILIES: readonly CohortAtsFamily[] = [
  "ashby",
  "greenhouse",
  "lever",
  "structured",
  "workable",
  "personio",
  "recruitee",
  "smartrecruiters",
];

export const COHORT_ATS_HINTS: readonly CohortAtsHint[] = [
  ...COHORT_ATS_FAMILIES,
  "unknown",
];

/** Composition floors from architecture.md §3.2 (binding). */
export const COHORT_FLOORS = {
  pocRows: 50,
  pocRowsPerFamily: 1,
  totalRows: 1_000,
  stagedPendingShare: 0.5,
} as const;

export type CohortManifestRow = {
  name: string;
  website_url: string;
  domain: string;
  sector: string;
  ats_hint: CohortAtsHint;
  careers_url: string | null;
  access_mode: CohortAccessMode;
  terms_url: string;
  evidence_url: string;
  notes: string;
};

const ROW_KEYS = [
  "name",
  "website_url",
  "domain",
  "sector",
  "ats_hint",
  "careers_url",
  "access_mode",
  "terms_url",
  "evidence_url",
  "notes",
] as const;

const https = (value: unknown) => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

export type CohortRowValidation =
  | { ok: true; row: CohortManifestRow }
  | { ok: false; reason: string };

export function validateCohortManifestRow(value: unknown): CohortRowValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "row_not_an_object" };
  }
  const record = value as Record<string, unknown>;
  for (const key of ROW_KEYS) {
    if (!(key in record)) return { ok: false, reason: `missing_field:${key}` };
  }
  const name = String(record.name ?? "").trim();
  if (!name) return { ok: false, reason: "empty_name" };
  // The Wikidata label service can echo the entity id; a manifest name is the
  // employer's human label, never "Q1234".
  if (/^Q\d+$/i.test(name)) return { ok: false, reason: "name_is_wikidata_id" };
  const website = https(record.website_url);
  if (!website) return { ok: false, reason: "website_url_not_https" };
  const domain = registrableDomain(website);
  if (!domain) return { ok: false, reason: "website_url_without_registrable_domain" };
  if (String(record.domain ?? "").trim().toLowerCase() !== domain) {
    return { ok: false, reason: "domain_mismatch" };
  }
  const sector = String(record.sector ?? "").trim();
  if (!sector) return { ok: false, reason: "empty_sector" };
  const atsHint = record.ats_hint;
  if (
    typeof atsHint !== "string" ||
    !(COHORT_ATS_HINTS as readonly string[]).includes(atsHint)
  ) {
    return { ok: false, reason: "invalid_ats_hint" };
  }
  const careersUrl = record.careers_url === null ? null : https(record.careers_url);
  if (record.careers_url !== null && !careersUrl) {
    return { ok: false, reason: "careers_url_not_https" };
  }
  const accessMode = record.access_mode;
  if (
    typeof accessMode !== "string" ||
    !(COHORT_ACCESS_MODES as readonly string[]).includes(accessMode)
  ) {
    return { ok: false, reason: "invalid_access_mode" };
  }
  const terms = https(record.terms_url);
  if (!terms) return { ok: false, reason: "terms_url_not_https" };
  const evidence = https(record.evidence_url);
  if (!evidence) return { ok: false, reason: "evidence_url_not_https" };
  const notes = String(record.notes ?? "").trim();
  if (!notes) return { ok: false, reason: "empty_notes" };
  const expectedNote = accessMode === "public_page" ? COHORT_POC_NOTE : COHORT_STAGED_NOTE;
  if (!notes.startsWith(expectedNote)) {
    return { ok: false, reason: `notes_missing_label:${expectedNote}` };
  }
  return {
    ok: true,
    row: {
      name,
      website_url: website,
      domain,
      sector,
      ats_hint: atsHint as CohortAtsHint,
      careers_url: careersUrl,
      access_mode: accessMode as CohortAccessMode,
      terms_url: terms,
      evidence_url: evidence,
      notes,
    },
  };
}

export function serializeCohortManifestRow(row: CohortManifestRow) {
  const ordered: Record<string, unknown> = {};
  for (const key of ROW_KEYS) ordered[key] = row[key];
  return JSON.stringify(ordered);
}

export type CohortManifestParse = {
  rows: CohortManifestRow[];
  issues: Array<{ line: number; reason: string }>;
};

export function parseCohortManifest(text: string): CohortManifestParse {
  const rows: CohortManifestRow[] = [];
  const issues: CohortManifestParse["issues"] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      issues.push({ line: index + 1, reason: "invalid_json" });
      continue;
    }
    const result = validateCohortManifestRow(parsed);
    if (!result.ok) {
      issues.push({ line: index + 1, reason: result.reason });
      continue;
    }
    rows.push(result.row);
  }
  return { rows, issues };
}

export type CohortManifestSummary = {
  total: number;
  byAccessMode: Record<CohortAccessMode, number>;
  pocRows: number;
  stagedRows: number;
  stagedPendingRows: number;
  stagedPendingShare: number;
  families: Array<{ family: CohortAtsFamily; pocRows: number; employers: string[] }>;
  missingFamilies: CohortAtsFamily[];
  duplicateDomains: string[];
};

export function summarizeCohortManifest(rows: CohortManifestRow[]): CohortManifestSummary {
  const byAccessMode: Record<CohortAccessMode, number> = {
    public_page: 0,
    manual_import: 0,
    awaiting_permission: 0,
  };
  const domains = new Map<string, number>();
  for (const row of rows) {
    byAccessMode[row.access_mode] += 1;
    domains.set(row.domain, (domains.get(row.domain) || 0) + 1);
  }
  const pocRows = rows.filter((row) => row.access_mode === "public_page");
  const stagedRows = rows.filter((row) => row.access_mode !== "public_page");
  const stagedPending = stagedRows.filter((row) =>
    row.access_mode === "awaiting_permission" || row.access_mode === "manual_import"
  );
  const families = COHORT_ATS_FAMILIES.map((family) => {
    const members = pocRows.filter((row) => row.ats_hint === family);
    return {
      family,
      pocRows: members.length,
      employers: members.map((row) => row.name).sort(),
    };
  });
  return {
    total: rows.length,
    byAccessMode,
    pocRows: pocRows.length,
    stagedRows: stagedRows.length,
    stagedPendingRows: stagedPending.length,
    stagedPendingShare: stagedRows.length
      ? stagedPending.length / stagedRows.length
      : 0,
    families,
    missingFamilies: families.filter((entry) => entry.pocRows === 0).map((entry) => entry.family),
    duplicateDomains: [...domains.entries()]
      .filter(([, count]) => count > 1)
      .map(([domain]) => domain)
      .sort(),
  };
}

export function cohortCompositionFailures(summary: CohortManifestSummary) {
  const failures: string[] = [];
  if (summary.pocRows < COHORT_FLOORS.pocRows) {
    failures.push(`poc_rows_below_floor:${summary.pocRows}<${COHORT_FLOORS.pocRows}`);
  }
  if (summary.missingFamilies.length) {
    failures.push(`poc_families_missing:${summary.missingFamilies.join(",")}`);
  }
  if (summary.total < COHORT_FLOORS.totalRows) {
    failures.push(`total_rows_below_floor:${summary.total}<${COHORT_FLOORS.totalRows}`);
  }
  if (summary.stagedRows === 0) {
    failures.push("staged_rows_missing");
  } else if (summary.stagedPendingShare <= COHORT_FLOORS.stagedPendingShare) {
    failures.push(
      `staged_pending_share_not_above_floor:${summary.stagedPendingShare.toFixed(4)}`
    );
  }
  if (summary.duplicateDomains.length) {
    failures.push(`duplicate_domains:${summary.duplicateDomains.slice(0, 5).join(",")}`);
  }
  return failures;
}

/**
 * Website selection before registration. Mirrors the normalization contract in
 * `scripts/build-startup-domain-pilot.ts`: HTTPS only, a registrable domain is
 * required, and the shortest path/host wins so the canonical site (not a deep
 * page) is registered.
 */
export function canonicalWebsiteCandidates(websites: string[]) {
  return [...new Set(websites)].filter((value) => {
    try {
      return new URL(value).protocol === "https:" && Boolean(registrableDomain(value));
    } catch {
      return false;
    }
  }).sort((left, right) => {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.pathname.length - rightUrl.pathname.length ||
      leftUrl.hostname.length - rightUrl.hostname.length ||
      left.localeCompare(right)
    );
  });
}

export function cohortPocNotes(receiptPath: string) {
  return `${COHORT_POC_NOTE}; probe receipt ${receiptPath}`;
}

export function cohortStagedNotes(receiptPath: string) {
  return `${COHORT_STAGED_NOTE}; enumeration receipt ${receiptPath}`;
}

export function cohortManifestText(rows: CohortManifestRow[]) {
  return `${rows.map(serializeCohortManifestRow).join("\n")}\n`;
}
