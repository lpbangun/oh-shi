import type { NormalizedJob } from "./ats-adapters";
import { retryCanonicalFetch } from "./canonical-fetch-retry";
import { snapshotFingerprint } from "./ingestion-core";
import type { AtsProvider } from "./source-registry";

type SnapshotRow = {
  snapshotId: string;
  sourceId: string;
  provider: AtsProvider;
  boardId: string | null;
  capturedAt: string;
  status: string;
  existingOpenCount: number;
  observedOpenCount: number;
  missingCount: number;
  missingRatioBps: number;
  fingerprint: string;
  quarantineReason: string | null;
  companyId: string;
  currentProvider: AtsProvider;
  currentBoardId: string;
  sourceStatus: string;
  enabled: number;
  quarantineSnapshotId: string | null;
  quarantineApplicationId: string | null;
};

type ApplicationRow = {
  idempotencyKey: string;
  snapshotId: string;
  sourceId: string;
  provider: AtsProvider;
  boardId: string;
  status: "running" | "applied" | "rejected" | "failed" | "uncertain";
  reason: string;
  originalFingerprint: string;
  freshFingerprint: string | null;
  originalExistingCount: number;
  freshExistingCount: number | null;
  originalObservedCount: number;
  freshObservedCount: number | null;
  originalMissingCount: number;
  freshMissingCount: number | null;
  requestedAt: string;
  completedAt: string | null;
  openedCount: number;
  closedCount: number;
  error: string | null;
};

type SnapshotMember = {
  externalId: string;
  kind: "observed" | "missing" | "existing";
};

export type CanonicalSnapshotInspection = {
  found: boolean;
  snapshot: SnapshotRow | null;
  confirmable: boolean;
  blockers: string[];
  observedExternalIds: string[];
  missingExternalIds: string[];
  existingExternalIds: string[];
  application: ApplicationRow | null;
};

const applicationSelect = `SELECT idempotency_key AS idempotencyKey,
  snapshot_id AS snapshotId, source_id AS sourceId, provider, board_id AS boardId,
  status, reason, original_fingerprint AS originalFingerprint,
  fresh_fingerprint AS freshFingerprint,
  original_existing_count AS originalExistingCount,
  fresh_existing_count AS freshExistingCount,
  original_observed_count AS originalObservedCount,
  fresh_observed_count AS freshObservedCount,
  original_missing_count AS originalMissingCount,
  fresh_missing_count AS freshMissingCount, requested_at AS requestedAt,
  completed_at AS completedAt, opened_count AS openedCount,
  closed_count AS closedCount, error FROM canonical_snapshot_applications`;

async function readApplication(
  database: D1Database,
  column: "snapshot_id" | "idempotency_key",
  value: string
) {
  return database.prepare(`${applicationSelect} WHERE ${column}=?`)
    .bind(value).first<ApplicationRow>();
}

export async function inspectCanonicalSnapshot(
  database: D1Database,
  snapshotId: string
): Promise<CanonicalSnapshotInspection> {
  const snapshot = await database.prepare(`SELECT
    snap.id AS snapshotId, snap.source_id AS sourceId, snap.provider,
    snap.board_id AS boardId, snap.captured_at AS capturedAt, snap.status,
    snap.existing_open_count AS existingOpenCount,
    snap.observed_open_count AS observedOpenCount,
    snap.missing_count AS missingCount,
    snap.missing_ratio_bps AS missingRatioBps, snap.fingerprint,
    snap.quarantine_reason AS quarantineReason,
    source.company_id AS companyId, source.provider AS currentProvider,
    source.board_id AS currentBoardId, source.discovery_status AS sourceStatus,
    source.enabled, source.quarantine_snapshot_id AS quarantineSnapshotId,
    source.quarantine_application_id AS quarantineApplicationId
    FROM canonical_source_snapshots snap
    JOIN company_sources source ON source.id=snap.source_id
    WHERE snap.id=?`).bind(snapshotId).first<SnapshotRow>();
  if (!snapshot) {
    return {
      found: false,
      snapshot: null,
      confirmable: false,
      blockers: ["snapshot_not_found"],
      observedExternalIds: [],
      missingExternalIds: [],
      existingExternalIds: [],
      application: null,
    };
  }
  const [members, application] = await Promise.all([
    database.prepare(`SELECT external_id AS externalId, kind
      FROM canonical_snapshot_members WHERE snapshot_id=?
      ORDER BY kind, external_id`).bind(snapshotId).all<SnapshotMember>(),
    readApplication(database, "snapshot_id", snapshotId),
  ]);
  const observedExternalIds = members.results
    .filter((item) => item.kind === "observed").map((item) => item.externalId);
  const missingExternalIds = members.results
    .filter((item) => item.kind === "missing").map((item) => item.externalId);
  const existingExternalIds = members.results
    .filter((item) => item.kind === "existing").map((item) => item.externalId);
  const blockers: string[] = [];
  if (snapshot.status !== "quarantined") blockers.push("snapshot_not_quarantined");
  if (snapshot.quarantineReason !== "mass_deletion_guard") {
    blockers.push("unsupported_quarantine_reason");
  }
  if (!snapshot.boardId) blockers.push("legacy_snapshot_without_board_identity");
  if (
    snapshot.provider !== snapshot.currentProvider ||
    snapshot.boardId !== snapshot.currentBoardId
  ) blockers.push("source_identity_changed");
  if (!snapshot.enabled) blockers.push("source_disabled");
  if (snapshot.quarantineSnapshotId !== snapshot.snapshotId) {
    blockers.push("snapshot_is_not_current_quarantine");
  }
  if (!["quarantined", "applying_quarantine"].includes(snapshot.sourceStatus)) {
    blockers.push("source_not_quarantined");
  }
  if (
    observedExternalIds.length !== snapshot.observedOpenCount ||
    missingExternalIds.length !== snapshot.missingCount ||
    existingExternalIds.length !== snapshot.existingOpenCount
  ) blockers.push("exact_membership_unavailable");
  if (application && !["failed"].includes(application.status)) {
    blockers.push(`application_${application.status}`);
  }
  return {
    found: true,
    snapshot,
    confirmable: blockers.length === 0,
    blockers,
    observedExternalIds,
    missingExternalIds,
    existingExternalIds,
    application,
  };
}

function sameMembers(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...new Set(left)].sort();
  const sortedRight = [...new Set(right)].sort();
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index]);
}

function publicApplication(application: ApplicationRow) {
  return {
    snapshotId: application.snapshotId,
    idempotencyKey: application.idempotencyKey,
    status: application.status,
    sourceId: application.sourceId,
    provider: application.provider,
    boardId: application.boardId,
    requestedAt: application.requestedAt,
    completedAt: application.completedAt,
    opened: application.openedCount,
    closed: application.closedCount,
    error: application.error,
  };
}

async function finishWithoutMutation(
  database: D1Database,
  application: ApplicationRow,
  status: "failed" | "rejected",
  now: string,
  error: string,
  fresh?: {
    fingerprint: string;
    existingCount: number;
    observedCount: number;
    missingCount: number;
  }
) {
  await database.batch([
    database.prepare(`UPDATE canonical_snapshot_applications SET status=?,
      completed_at=?, error=?, fresh_fingerprint=?,
      fresh_existing_count=?, fresh_observed_count=?, fresh_missing_count=?
      WHERE idempotency_key=? AND status='running'`).bind(
        status, now, error.slice(0, 500), fresh?.fingerprint || null,
        fresh?.existingCount ?? null, fresh?.observedCount ?? null,
        fresh?.missingCount ?? null, application.idempotencyKey
      ),
    database.prepare(`UPDATE company_sources SET discovery_status='quarantined',
      quarantine_application_id=NULL
      WHERE id=? AND discovery_status='applying_quarantine'
        AND quarantine_snapshot_id=? AND quarantine_application_id=?`).bind(
        application.sourceId, application.snapshotId, application.idempotencyKey
      ),
  ]);
  const stored = await readApplication(
    database, "idempotency_key", application.idempotencyKey
  );
  if (!stored) throw new Error("Snapshot application audit disappeared.");
  return publicApplication(stored);
}

export async function applyCanonicalSnapshot(options: {
  database: D1Database;
  snapshotId: string;
  idempotencyKey: string;
  expectedFingerprint: string;
  reason: string;
  now?: string;
  fetchSource?: (source: {
    provider: AtsProvider;
    boardId: string;
  }) => Promise<{ jobs: NormalizedJob[] }>;
}) {
  const {
    database, snapshotId, idempotencyKey, expectedFingerprint,
  } = options;
  const reason = options.reason.trim();
  const now = options.now || new Date().toISOString();
  if (!/^[a-z0-9][a-z0-9._:-]{7,159}$/i.test(idempotencyKey)) {
    throw new Error("A valid idempotency key is required.");
  }
  if (reason.length < 12 || reason.length > 500) {
    throw new Error("A review reason between 12 and 500 characters is required.");
  }
  const keyed = await readApplication(database, "idempotency_key", idempotencyKey);
  if (keyed && keyed.snapshotId !== snapshotId) {
    throw new Error("The idempotency key is already bound to another snapshot.");
  }
  const existingApplication = keyed ||
    await readApplication(database, "snapshot_id", snapshotId);
  if (existingApplication && existingApplication.idempotencyKey !== idempotencyKey) {
    return publicApplication(existingApplication);
  }
  if (
    existingApplication &&
    ["applied", "rejected", "running", "uncertain"].includes(existingApplication.status)
  ) return publicApplication(existingApplication);

  const inspection = await inspectCanonicalSnapshot(database, snapshotId);
  if (!inspection.confirmable || !inspection.snapshot) {
    throw new Error(`Snapshot is not confirmable: ${inspection.blockers.join(", ")}.`);
  }
  if (inspection.snapshot.fingerprint !== expectedFingerprint) {
    throw new Error("The expected fingerprint does not match the frozen snapshot.");
  }
  const snapshot = inspection.snapshot;
  let claimResults: D1Result[];
  if (existingApplication?.status === "failed") {
    claimResults = await database.batch([
      database.prepare(`UPDATE canonical_snapshot_applications SET status='running',
        reason=?, requested_at=?, completed_at=NULL, fresh_fingerprint=NULL,
        fresh_existing_count=NULL, fresh_observed_count=NULL,
        fresh_missing_count=NULL, error=NULL
        WHERE idempotency_key=? AND status='failed'
          AND EXISTS (SELECT 1 FROM company_sources WHERE id=?
            AND discovery_status='quarantined' AND quarantine_snapshot_id=?
            AND quarantine_application_id IS NULL)`).bind(
              reason, now, idempotencyKey, snapshot.sourceId, snapshotId
            ),
      database.prepare(`UPDATE company_sources SET
        discovery_status='applying_quarantine', quarantine_application_id=?
        WHERE id=? AND discovery_status='quarantined'
          AND quarantine_snapshot_id=? AND quarantine_application_id IS NULL`)
        .bind(idempotencyKey, snapshot.sourceId, snapshotId),
    ]);
  } else {
    claimResults = await database.batch([
      database.prepare(`INSERT INTO canonical_snapshot_applications (
        idempotency_key, snapshot_id, source_id, provider, board_id, status,
        reason, original_fingerprint, original_existing_count,
        original_observed_count, original_missing_count, requested_at
      ) SELECT ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM company_sources WHERE id=?
        AND discovery_status='quarantined' AND quarantine_snapshot_id=?
        AND quarantine_application_id IS NULL)`).bind(
          idempotencyKey, snapshotId, snapshot.sourceId, snapshot.provider,
          snapshot.boardId, reason, snapshot.fingerprint,
          snapshot.existingOpenCount, snapshot.observedOpenCount,
          snapshot.missingCount, now, snapshot.sourceId, snapshotId
        ),
      database.prepare(`UPDATE company_sources SET
        discovery_status='applying_quarantine', quarantine_application_id=?
        WHERE id=? AND discovery_status='quarantined'
          AND quarantine_snapshot_id=? AND quarantine_application_id IS NULL`)
        .bind(idempotencyKey, snapshot.sourceId, snapshotId),
    ]);
  }
  if (
    Number(claimResults[0]?.meta?.changes || 0) !== 1 ||
    Number(claimResults[1]?.meta?.changes || 0) !== 1
  ) {
    const winner = await readApplication(database, "snapshot_id", snapshotId);
    if (winner) return publicApplication(winner);
    throw new Error("The snapshot application lease could not be acquired.");
  }
  const application = await readApplication(database, "idempotency_key", idempotencyKey);
  if (!application) throw new Error("Snapshot application audit was not created.");

  const fetchSource = options.fetchSource ||
    ((source: { provider: AtsProvider; boardId: string }) => retryCanonicalFetch(source));
  let jobs: NormalizedJob[];
  try {
    jobs = (await fetchSource({
      provider: snapshot.provider,
      boardId: snapshot.boardId!,
    })).jobs;
  } catch (error) {
    return finishWithoutMutation(
      database,
      application,
      "failed",
      now,
      error instanceof Error ? error.message : String(error)
    );
  }

  const current = await database.prepare(`SELECT id, job_id AS jobId,
    external_id AS externalId FROM job_observations
    WHERE provider=? AND source_id=? AND status='verified_open'
    ORDER BY external_id`).bind(snapshot.provider, snapshot.sourceId)
    .all<{ id: string; jobId: string; externalId: string }>();
  const freshObserved = [...new Set(jobs.map((item) => item.externalId))].sort();
  const currentIds = current.results.map((item) => item.externalId);
  const freshSet = new Set(freshObserved);
  const freshMissing = currentIds.filter((externalId) => !freshSet.has(externalId)).sort();
  const fresh = {
    fingerprint: snapshotFingerprint(freshObserved),
    existingCount: currentIds.length,
    observedCount: freshObserved.length,
    missingCount: freshMissing.length,
  };
  const exactMatch =
    fresh.fingerprint === snapshot.fingerprint &&
    fresh.existingCount === snapshot.existingOpenCount &&
    fresh.observedCount === snapshot.observedOpenCount &&
    fresh.missingCount === snapshot.missingCount &&
    sameMembers(freshObserved, inspection.observedExternalIds) &&
    sameMembers(freshMissing, inspection.missingExternalIds) &&
    sameMembers(currentIds, inspection.existingExternalIds);
  if (!exactMatch) {
    return finishWithoutMutation(
      database,
      application,
      "rejected",
      now,
      "Fresh complete source membership does not exactly match the frozen quarantine.",
      fresh
    );
  }

  const targetExternalIds = new Set(inspection.missingExternalIds);
  const targetObservations = current.results.filter(
    (item) => targetExternalIds.has(item.externalId)
  );
  const allOpen = await database.prepare(`SELECT job_id AS jobId, provider,
    source_id AS sourceId, external_id AS externalId
    FROM job_observations WHERE company_id=? AND status='verified_open'`)
    .bind(snapshot.companyId)
    .all<{ jobId: string; provider: string; sourceId: string; externalId: string }>();
  const targetKeys = new Set(targetObservations.map(
    (item) => `${snapshot.provider}\n${snapshot.sourceId}\n${item.externalId}`
  ));
  const jobsToClose = new Set<string>();
  for (const target of targetObservations) {
    const remainsOpen = allOpen.results.some((item) =>
      item.jobId === target.jobId &&
      !targetKeys.has(`${item.provider}\n${item.sourceId}\n${item.externalId}`)
    );
    if (!remainsOpen) jobsToClose.add(target.jobId);
  }
  const leaseExists = `EXISTS (SELECT 1 FROM company_sources
    WHERE id=? AND discovery_status='applying_quarantine'
      AND quarantine_snapshot_id=? AND quarantine_application_id=?)`;
  const leaseBindings = [snapshot.sourceId, snapshotId, idempotencyKey];
  const statements: D1PreparedStatement[] = [];
  for (const target of targetObservations) {
    statements.push(database.prepare(`UPDATE job_observations SET
      status='verified_closed', closed_at=?, last_verified_at=?
      WHERE id=? AND ${leaseExists}`).bind(
        now, now, target.id, ...leaseBindings
      ));
  }
  for (const jobId of jobsToClose) {
    statements.push(database.prepare(`UPDATE jobs SET status='verified_closed',
      closed_at=?, last_verified_at=? WHERE id=? AND ${leaseExists}`)
      .bind(now, now, jobId, ...leaseBindings));
    statements.push(database.prepare(`INSERT OR IGNORE INTO changes (
      id, entity_type, entity_id, change_type, title, description,
      occurred_at, source_url
    ) SELECT ?, 'job', id, 'job_closed', title || ' closed',
      'Operator-reviewed canonical snapshot confirmed this role is no longer listed.',
      ?, canonical_url FROM jobs WHERE id=? AND ${leaseExists}`).bind(
        `change_close_${jobId}_${now.slice(0, 10)}`,
        now, jobId, ...leaseBindings
      ));
  }
  statements.push(database.prepare(`UPDATE companies SET open_job_count=(
    SELECT COUNT(*) FROM jobs WHERE company_id=? AND status='verified_open'
  ) WHERE id=? AND ${leaseExists}`).bind(
      snapshot.companyId, snapshot.companyId, ...leaseBindings
    ));
  statements.push(database.prepare(`UPDATE canonical_snapshot_applications SET
    status='applied', completed_at=?, fresh_fingerprint=?,
    fresh_existing_count=?, fresh_observed_count=?, fresh_missing_count=?,
    opened_count=0, closed_count=?, error=NULL
    WHERE idempotency_key=? AND status='running' AND ${leaseExists}`).bind(
      now, fresh.fingerprint, fresh.existingCount, fresh.observedCount,
      fresh.missingCount, jobsToClose.size, idempotencyKey, ...leaseBindings
    ));
  const applicationStatementIndex = statements.length - 1;
  statements.push(database.prepare(`UPDATE company_sources SET
    discovery_status='active', quarantine_snapshot_id=NULL,
    quarantine_application_id=NULL, last_attempted_at=?,
    last_error=NULL, consecutive_failures=0
    WHERE id=? AND discovery_status='applying_quarantine'
      AND quarantine_snapshot_id=? AND quarantine_application_id=?`).bind(
        now, snapshot.sourceId, snapshotId, idempotencyKey
      ));
  try {
    const results = await database.batch(statements);
    if (Number(results[applicationStatementIndex]?.meta?.changes || 0) !== 1) {
      throw new Error("The snapshot application lease changed before commit.");
    }
  } catch (error) {
    const stored = await readApplication(database, "idempotency_key", idempotencyKey);
    if (stored?.status === "applied") return publicApplication(stored);
    await database.prepare(`UPDATE canonical_snapshot_applications SET
      status='uncertain', completed_at=?, error=?
      WHERE idempotency_key=? AND status='running'`).bind(
        now,
        (error instanceof Error ? error.message : String(error)).slice(0, 500),
        idempotencyKey
      ).run();
  }
  const stored = await readApplication(database, "idempotency_key", idempotencyKey);
  if (!stored) throw new Error("Snapshot application audit disappeared.");
  return publicApplication(stored);
}
