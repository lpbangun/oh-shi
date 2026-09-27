#!/usr/bin/env tsx
/**
 * Syncs the employer-first cohort manifest `data/cohorts/general-v1.jsonl` into
 * the experimental deployment's domain registry through the existing import
 * endpoint `POST /api/internal/discovery/domains` (architecture.md §3.2), and
 * records the batch transcript in the manifest's import receipt.
 *
 * Rows are evidence, never activation. The endpoint writes `startup_domains`,
 * `startup_domain_cohorts`, `startup_domain_evidence`
 * (`source_kind='curated_cohort'`, `permission_status` derived from
 * `access_mode`), and the `startup_domain_imports` receipt; only `permitted`
 * rows ever run downstream (promotion gate, runnable predicate, enqueue
 * refusal). A record the registry contract refuses (e.g. `permitted` without
 * `source_terms_url`) is dropped fail-closed and listed in the receipt — never
 * sent, because the endpoint rejects a whole batch when one record is invalid.
 *
 * Usage:
 *   OH_SHI_BASE_URL=https://oh-shi-experimental.lpbangun.workers.dev \
 *   OH_SHI_INGEST_TOKEN=<experimental token> \
 *   pnpm exec tsx scripts/sync-cohort-manifest.ts
 *
 * Flags: --manifest, --base, --token, --cohort, --batch-size, --import-receipt,
 *        --observed-at, --d1-observation.
 *
 * Evidence: the import receipt lives under `<missionDir>/evidence/cohorts`
 * (override with OH_SHI_COHORT_EVIDENCE); receipt paths are quoted relative to
 * the mission directory ("evidence/cohorts/..."). `--d1-observation` merges a
 * `wrangler d1 execute … --json` observation of the `startup_domain_imports`
 * row into the same receipt, so the live row and the transcript sit together.
 * Re-running is idempotent: the endpoint upserts domains, evidence, and
 * cohort membership.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  COHORT_HUMAN_LABEL,
  COHORT_IMPORT_RECEIPT_PATH,
  COHORT_KEY,
  COHORT_MANIFEST_PATH,
  parseCohortManifest,
} from "../lib/cohort-manifest";
import { cohortEvidenceRecords } from "../lib/cohort-manifest-import";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const MISSION_EVIDENCE = process.env.OH_SHI_COHORT_EVIDENCE?.trim() ||
  "/home/logani/.factory/missions/793db9ad-27bf-4cf5-a822-dddd1b77dd0e/evidence";
/** Evidence paths are quoted relative to the mission directory. */
const MISSION_ROOT = path.resolve(MISSION_EVIDENCE, "..");
const missionPath = (value: string) =>
  path.isAbsolute(value) ? value : path.resolve(MISSION_ROOT, value);

/** The import endpoint accepts 1 to 1,000 evidence records per request. */
const ENDPOINT_BATCH_LIMIT = 1_000;
const COHORT_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{2,99}$/i;

type Flags = Record<string, string | true>;

function parseFlags(): Flags {
  const parsed: Flags = {};
  for (const argument of process.argv.slice(2)) {
    if (!argument.startsWith("--")) continue;
    const body = argument.slice(2);
    const separator = body.indexOf("=");
    if (separator < 0) parsed[body] = true;
    else parsed[body.slice(0, separator)] = body.slice(separator + 1);
  }
  return parsed;
}

const flag = parseFlags();
const stringFlag = (value: unknown) => typeof value === "string" ? value.trim() : "";
const unit = (value: unknown, fallback: number) => {
  const parsed = Number(typeof value === "string" ? value : NaN);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const nowIso = () => new Date().toISOString();
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

const baseUrlValue = stringFlag(flag.base) || process.env.OH_SHI_BASE_URL?.trim() || "";
const ingestToken = stringFlag(flag.token) || process.env.OH_SHI_INGEST_TOKEN?.trim() || "";
if (!baseUrlValue) {
  throw new Error("Cohort sync failed: OH_SHI_BASE_URL (or --base) is not configured.");
}
if (!ingestToken) {
  throw new Error("Cohort sync failed: OH_SHI_INGEST_TOKEN (or --token) is not configured.");
}
const baseUrl = new URL(baseUrlValue);
if (baseUrl.protocol !== "https:") {
  throw new Error("Cohort sync failed: the deployment base URL must use HTTPS.");
}

const cohort = stringFlag(flag.cohort) || COHORT_KEY;
if (!COHORT_KEY_PATTERN.test(cohort)) {
  throw new Error(
    `Cohort sync failed: cohort key "${cohort}" is not endpoint-legal ` +
      `(${COHORT_KEY_PATTERN.source}); the human label ${COHORT_HUMAN_LABEL} stays in prose.`
  );
}
const batchSize = Math.min(
  ENDPOINT_BATCH_LIMIT,
  Math.max(1, Math.trunc(unit(flag["batch-size"], ENDPOINT_BATCH_LIMIT)))
);

const manifestPath = stringFlag(flag.manifest) || COHORT_MANIFEST_PATH;
const manifestText = await readFile(path.resolve(ROOT, manifestPath), "utf8");
const manifestDigest = sha256(manifestText);
const { rows, issues } = parseCohortManifest(manifestText);
if (issues.length) {
  throw new Error(
    `Cohort sync failed: ${manifestPath} has ${issues.length} invalid row(s): ` +
      issues.slice(0, 5).map((issue) => `line ${issue.line} ${issue.reason}`).join(", ")
  );
}
if (!rows.length) throw new Error(`Cohort sync failed: ${manifestPath} has no rows.`);

const importReceiptPath = stringFlag(flag["import-receipt"]) || COHORT_IMPORT_RECEIPT_PATH;
const existingReceipt = await readJson<Record<string, unknown>>(
  missionPath(importReceiptPath),
  {}
);
const recordedManifest = (existingReceipt.manifest as Record<string, unknown> | undefined) || {};
const recordedDigest = recordedManifest.sha256;
if (typeof recordedDigest === "string" && recordedDigest !== manifestDigest) {
  throw new Error(
    `Cohort sync failed: ${manifestPath} does not match the digest recorded in ` +
      `${importReceiptPath} (the import must carry the manifest the receipt names).`
  );
}

const observedAt = stringFlag(flag["observed-at"]) || nowIso();
const { records, drops } = cohortEvidenceRecords(rows, observedAt);

console.log(
  `Cohort sync: ${manifestPath} rows=${rows.length} sha256=${manifestDigest} ` +
    `cohort=${cohort} binding=${baseUrl.origin}`
);
console.log(
  `Cohort sync: ${records.length} registry evidence records, ` +
    `${drops.length} fail-closed drop(s), batch size ${batchSize}.`
);
for (const drop of drops) {
  console.warn(
    `Cohort sync drop: ${drop.domain} (${drop.access_mode}→${drop.permission_status}) ` +
      `refused: ${drop.reason}`
  );
}

const batches: Array<{
  batch: number;
  records: number;
  expected_domains: number;
  http_status: number;
  accepted: boolean;
  persisted_domains: number | null;
  persisted_evidence: number | null;
  receipt: Record<string, unknown> | null;
  error: string | null;
}> = [];
const failures: string[] = [];
let persistedDomains = 0;
let persistedEvidence = 0;

const importUrl = new URL("/api/internal/discovery/domains", baseUrl);
for (let index = 0; index < records.length; index += batchSize) {
  const batchNumber = Math.floor(index / batchSize) + 1;
  const batch = records.slice(index, index + batchSize);
  const response = await fetch(importUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ingestToken}`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ cohort, records: batch }),
  });
  const body = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const receipt = (parsed?.receipt as Record<string, unknown> | undefined) || null;
  const persisted = (parsed?.persisted as Record<string, unknown> | undefined) || null;
  const accepted = response.status === 202;
  if (accepted) {
    persistedDomains += Number(persisted?.domains || 0);
    persistedEvidence += Number(persisted?.evidence || 0);
  } else {
    failures.push(
      `batch ${batchNumber} returned HTTP ${response.status}: ${body.slice(0, 300)}`
    );
  }
  batches.push({
    batch: batchNumber,
    records: batch.length,
    expected_domains: batch.length,
    http_status: response.status,
    accepted,
    persisted_domains: accepted ? Number(persisted?.domains || 0) : null,
    persisted_evidence: accepted ? Number(persisted?.evidence || 0) : null,
    receipt: receipt && {
      input_records: receipt.inputRecords ?? null,
      valid_records: receipt.validRecords ?? null,
      accepted: receipt.accepted ?? null,
      rejected_records: receipt.rejectedRecords ?? null,
      duplicate_domains: receipt.duplicateDomains ?? null,
      reconciled: receipt.reconciled ?? null,
      identity_graph_valid: receipt.identityGraphValid ?? null,
    },
    error: accepted ? null : body.slice(0, 300),
  });
  console.log(
    `Cohort sync: batch ${batchNumber}/${Math.ceil(records.length / batchSize)} ` +
      `records=${batch.length} HTTP ${response.status} ` +
      `persisted_domains=${accepted ? persistedDomains : "n/a"}`
  );
}
for (const failure of failures) console.error(`Cohort sync failure: ${failure}`);
if (failures.length) {
  console.error(`Cohort sync: ${failures.length} batch(es) were not accepted.`);
}

// ---------------------------------------------------------------------------
// live reconciliation (public coverage endpoint, same deploy)
// ---------------------------------------------------------------------------

let coverage: Record<string, unknown> | null = null;
try {
  const response = await fetch(new URL("/api/v1/coverage", baseUrl), {
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  if (response.ok) {
    const body = await response.json() as {
      deployed_sha?: string;
      generated_at?: string;
      data?: {
        startupDomains?: number;
        pilotStartupDomains?: number;
        discoveryFunnel?: { registry?: Record<string, unknown> };
      };
    };
    coverage = {
      deployed_sha: body.deployed_sha ?? null,
      generated_at: body.generated_at ?? null,
      startup_domains: body.data?.startupDomains ?? null,
      pilot_startup_domains: body.data?.pilotStartupDomains ?? null,
      registry: body.data?.discoveryFunnel?.registry ?? null,
    };
    console.log(
      `Cohort sync: coverage startupDomains=${coverage.startup_domains} ` +
        `pilotStartupDomains=${coverage.pilot_startup_domains} ` +
        `promotionUniverse=${(coverage.registry as Record<string, unknown> | null)
          ?.promotionUniverse ?? "n/a"} ` +
        `eligibleForPromotion=${(coverage.registry as Record<string, unknown> | null)
          ?.eligibleForPromotion ?? "n/a"}`
    );
  } else {
    console.warn(`Cohort sync note: coverage returned HTTP ${response.status}.`);
  }
} catch (error) {
  console.warn(
    `Cohort sync note: coverage unavailable ` +
      `(${error instanceof Error ? error.message : String(error)}).`
  );
}

const observedD1Path = stringFlag(flag["d1-observation"]);
const observedD1 = observedD1Path
  ? await readJson<Record<string, unknown> | null>(missionPath(observedD1Path), null)
  : null;
/** Literal values of the `startup_domain_imports` row for cohort `general-v1`. */
const observedImportRow = (() => {
  const queries = (observedD1?.queries as Record<string, unknown> | undefined) || {};
  const query = (queries.startup_domain_imports as Record<string, unknown> | undefined) || {};
  const rows = Array.isArray(query.rows) ? query.rows as Array<Record<string, unknown>> : [];
  return rows.find((row) => row.cohort === cohort) || rows[0] || null;
})();

const totals = {
  batches: batches.length,
  records_posted: batches.reduce((total, batch) => total + batch.records, 0),
  http_202: batches.filter((batch) => batch.accepted).length,
  persisted_domains: persistedDomains,
  persisted_evidence: persistedEvidence,
};
const reconciled = !failures.length &&
  totals.records_posted === totals.persisted_domains;

const importBlock = {
  status: failures.length ? "failed" : "completed",
  note: failures.length
    ? "Import failed: see errors. Batches that answered 202 are persisted; re-running is idempotent."
    : "Imported by scripts/sync-cohort-manifest.ts through the existing registry endpoint. " +
      "The endpoint upserts one startup_domain_imports row per cohort per request, so a manifest " +
      "larger than the 1,000-record body cap cannot be represented by that single row: the " +
      "reconciled totals are the batch transcript below, and the live cross-check is " +
      "coverage.pilotStartupDomains (cohort memberships joined to the completed import).",
  endpoint: "/api/internal/discovery/domains",
  cohort_key: cohort,
  human_label: COHORT_HUMAN_LABEL,
  base_url: baseUrl.origin,
  ran_at: nowIso(),
  observed_at: observedAt,
  manifest_path: manifestPath,
  manifest_rows: rows.length,
  manifest_sha256: manifestDigest,
  batch_size_limit: ENDPOINT_BATCH_LIMIT,
  batch_size_used: batchSize,
  batches,
  totals,
  reconciled,
  startup_domain_imports: {
    cohort,
    // Reconciled against the manifest: records posted and persisted, plus the
    // fail-closed drops, account for every manifest row.
    expected_domains: totals.records_posted,
    persisted_domains: totals.persisted_domains,
    delta: totals.records_posted - totals.persisted_domains,
    manifest_rows: rows.length,
    fail_closed_drops: drops.length,
    reconciles_manifest_rows:
      totals.persisted_domains + drops.length === rows.length,
    db_row_values: observedImportRow && {
      expected_domains: observedImportRow.expected_domains ?? null,
      persisted_domains: observedImportRow.persisted_domains ?? null,
      status: observedImportRow.status ?? null,
      started_at: observedImportRow.started_at ?? null,
      completed_at: observedImportRow.completed_at ?? null,
    },
    db_row_matches_manifest_rows: observedImportRow
      ? observedImportRow.persisted_domains === rows.length
      : null,
    per_request_semantics:
      "startup_domain_imports carries one row per cohort, rewritten by each request's " +
      "expected_domains/persisted_domains (then status='completed'), so the row reflects the " +
      "final request of the transcript; a manifest larger than the 1,000-record body cap cannot " +
      "be represented by that single row. The reconciled figures above are the transcript " +
      "totals, db_row_values records the live row verbatim, and the live end-to-end cross-check " +
      "is the cohort-membership count (startup_domain_cohorts, surfaced as " +
      "coverage.pilotStartupDomains).",
    observed_d1: observedD1,
  },
  coverage,
  fail_closed_drops: drops,
  errors: failures,
};

await writeJson(missionPath(importReceiptPath), {
  ...existingReceipt,
  manifest: {
    ...recordedManifest,
    path: manifestPath,
    rows: rows.length,
    sha256: manifestDigest,
  },
  import: importBlock,
});

console.log(
  `Cohort sync receipt: ${importReceiptPath} (status=${importBlock.status}, ` +
    `records=${totals.records_posted}, persisted=${totals.persisted_domains}, ` +
    `drops=${drops.length})`
);
if (failures.length) process.exitCode = 1;
