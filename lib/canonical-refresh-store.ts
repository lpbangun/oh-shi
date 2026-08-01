import {
  ATS_ADAPTER_VERSION,
  type NormalizedJob,
} from "./ats-adapters";
import { STRUCTURED_CAREER_ADAPTER_VERSION } from "./structured-career-page";
import {
  planCanonicalClosures,
  snapshotFingerprint,
} from "./ingestion-core";
import {
  normalizeCanonicalJobUrl,
  selectCanonicalJobMatch,
  type CanonicalJobCandidate,
} from "./job-canonicalization";
import type { AtsProvider } from "./source-registry";

export type CanonicalCompanySource = {
  id: string;
  companyId: string;
  provider: AtsProvider;
  boardId: string;
};

export type SourceRefreshResult = {
  sourceId: string;
  companyId: string;
  provider: AtsProvider;
  status: "success" | "failed" | "quarantined";
  snapshotId?: string;
  observed: number;
  verified: number;
  opened: number;
  closed: number;
  error?: string;
  quarantineReason?: string;
};

function stableJobId(source: CanonicalCompanySource, externalId: string) {
  const safe = `${source.provider}_${source.boardId}_${externalId}`
    .toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 180);
  return `job_${safe}`;
}

function observationId(source: CanonicalCompanySource, externalId: string) {
  const safe = `${source.provider}_${source.id}_${externalId}`
    .toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 180);
  return `observation_${safe}`;
}

// D1 limits each Worker invocation to 1000 queries; a single canonical board
// can emit hundreds of per-job statements. Chunking keeps large boards under
// the limit. The per-job statements are idempotent (ON CONFLICT upserts,
// INSERT OR IGNORE changes, replayable stable IDs), so a mid-chunk failure
// converges on the next refresh rather than leaving divergent state.
async function batchInChunks(
  database: D1Database,
  statements: D1PreparedStatement[],
  size = 50
) {
  for (let index = 0; index < statements.length; index += size) {
    await database.batch(statements.slice(index, index + size));
  }
}

const parserVersionFor = (provider: AtsProvider) =>
  provider === "structured"
    ? `structured-${STRUCTURED_CAREER_ADAPTER_VERSION}`
    : ATS_ADAPTER_VERSION;

const discoveryChannelFor = (provider: AtsProvider) =>
  provider === "structured" ? "first_party_career_page" : "public_ats";

export async function persistCanonicalSource(
  database: D1Database,
  source: CanonicalCompanySource,
  normalized: NormalizedJob[],
  now: string,
  runId: string
): Promise<SourceRefreshResult> {
  type ObservationRow = {
    id: string;
    jobId: string;
    provider: AtsProvider;
    sourceId: string;
    externalId: string;
    canonicalUrl: string;
    status: string;
  };
  const observations = await database.prepare(`SELECT id, job_id as jobId, provider,
    source_id as sourceId, external_id as externalId, canonical_url as canonicalUrl,
    status FROM job_observations WHERE company_id=?`).bind(source.companyId)
    .all<ObservationRow>();
  const existing = observations.results
    .filter((item) => item.provider === source.provider && item.sourceId === source.id)
    .map((item) => ({ id: item.jobId, externalId: item.externalId, status: item.status }));
  const currentByExternal = new Map(
    observations.results
      .filter((item) => item.provider === source.provider && item.sourceId === source.id)
      .map((item) => [item.externalId, item])
  );
  const observed = new Set(normalized.map((job) => job.externalId));
  const closurePlan = planCanonicalClosures(existing, [...observed]);
  const snapshot = closurePlan.assessment;
  const snapshotId = `${runId}:${source.id}`;
  const snapshotStatement = database.prepare(`INSERT INTO canonical_source_snapshots (
    id, run_id, source_id, provider, captured_at, parser_version, status,
    existing_open_count, observed_open_count, missing_count, missing_ratio_bps,
    fingerprint, quarantine_reason, board_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    snapshotId,
    runId,
    source.id,
    source.provider,
    now,
    parserVersionFor(source.provider),
    snapshot.status,
    snapshot.existingOpenCount,
    snapshot.observedOpenCount,
    snapshot.missingCount,
    Math.round(snapshot.missingRatio * 10_000),
    snapshotFingerprint([...observed]),
    snapshot.reason,
    source.boardId
  );
  if (snapshot.status === "quarantined") {
    const error =
      `mass_deletion_guard: ${snapshot.missingCount} of ` +
      `${snapshot.existingOpenCount} previously open jobs disappeared`;
    const open = existing.filter((item) => item.status === "verified_open");
    const missing = open.filter((item) => !observed.has(item.externalId));
    await batchInChunks(database, [
      snapshotStatement,
      ...[...observed].map((externalId) =>
        database.prepare(`INSERT INTO canonical_snapshot_members (
          snapshot_id, external_id, kind
        ) VALUES (?, ?, 'observed')`).bind(snapshotId, externalId)
      ),
      ...missing.map((item) =>
        database.prepare(`INSERT INTO canonical_snapshot_members (
          snapshot_id, external_id, kind
        ) VALUES (?, ?, 'missing')`).bind(snapshotId, item.externalId)
      ),
      ...open.map((item) =>
        database.prepare(`INSERT INTO canonical_snapshot_members (
          snapshot_id, external_id, kind
        ) VALUES (?, ?, 'existing')`).bind(snapshotId, item.externalId)
      ),
      database.prepare(`UPDATE company_sources SET last_attempted_at=?, last_error=?,
        consecutive_failures=consecutive_failures+1,
        discovery_status='quarantined', quarantine_snapshot_id=?,
        quarantine_application_id=NULL WHERE id=?`)
        .bind(now, error, snapshotId, source.id),
    ]);
    return {
      sourceId: source.id,
      companyId: source.companyId,
      provider: source.provider,
      status: "quarantined",
      snapshotId,
      observed: normalized.length,
      verified: 0,
      opened: 0,
      closed: 0,
      error,
      quarantineReason: snapshot.reason || "mass_deletion_guard",
    };
  }

  const statements: D1PreparedStatement[] = [snapshotStatement];
  const canonical = await database.prepare(`SELECT id, company_id as companyId,
    provider, source_id as sourceId, external_id as externalId,
    canonical_url as canonicalUrl, title, location, employment_type as employmentType,
    summary, published_at as publishedAt, status FROM jobs WHERE company_id=?`)
    .bind(source.companyId)
    .all<CanonicalJobCandidate>();
  const canonicalById = new Map(canonical.results.map((item) => [item.id, item]));
  const candidates = [...canonical.results];
  for (const observation of observations.results) {
    const primary = canonicalById.get(observation.jobId);
    if (!primary) continue;
    candidates.push({
      ...primary,
      provider: observation.provider,
      sourceId: observation.sourceId,
      externalId: observation.externalId,
      canonicalUrl: observation.canonicalUrl,
    });
  }
  const resolvedJobIds = new Set<string>();
  const openedJobIds = new Set<string>();
  let opened = 0;
  let closed = 0;
  for (const job of normalized) {
    const current = currentByExternal.get(job.externalId);
    const match = current
      ? { jobId: current.jobId, method: "stable_id" as const, score: 1 }
      : selectCanonicalJobMatch(
        { companyId: source.companyId, provider: source.provider, sourceId: source.id },
        job,
        candidates
      );
    const id = match?.jobId || stableJobId(source, job.externalId);
    const primary = canonicalById.get(id);
    const wasOpen = primary?.status === "verified_open";
    const ownsCanonical = primary &&
      primary.provider === source.provider &&
      primary.sourceId === source.id &&
      primary.externalId === job.externalId;
    if (!primary) {
      statements.push(database.prepare(`INSERT OR IGNORE INTO jobs (
        id, company_id, external_id, provider, source_id, title, role_family, location,
        remote_status, employment_type, compensation, canonical_url, source, status,
        first_seen_at, last_seen_at, source_updated_at, published_at, last_verified_at,
        closed_at, raw_url, discovery_channel, evidence_url, parser_version,
        snapshot_run_id, linkedin_presence_state, linkedin_evidence_url,
        linkedin_checked_at, summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified_open', ?, ?, ?, ?, ?,
        NULL, ?, ?, ?, ?, ?, 'unknown', NULL, NULL, ?)`).bind(
          id, source.companyId, job.externalId, source.provider, source.id, job.title,
          job.roleFamily, job.location, job.remoteStatus, job.employmentType,
          job.compensation, job.canonicalUrl, source.provider, now, now,
          job.publishedAt, job.publishedAt, now, job.canonicalUrl,
          discoveryChannelFor(source.provider), job.canonicalUrl,
          parserVersionFor(source.provider), runId, job.summary
        ));
      const added: CanonicalJobCandidate = {
        id,
        companyId: source.companyId,
        provider: source.provider,
        sourceId: source.id,
        externalId: job.externalId,
        canonicalUrl: job.canonicalUrl,
        title: job.title,
        location: job.location,
        employmentType: job.employmentType,
        summary: job.summary,
        publishedAt: job.publishedAt,
        status: "verified_open",
      };
      canonicalById.set(id, added);
      candidates.push(added);
    } else if (ownsCanonical) {
      statements.push(database.prepare(`UPDATE jobs SET title=?, role_family=?,
        location=?, remote_status=?, employment_type=?, compensation=?,
        canonical_url=?, status='verified_open', last_seen_at=?,
        source_updated_at=COALESCE(?, source_updated_at),
        published_at=COALESCE(published_at, ?), last_verified_at=?, closed_at=NULL,
        raw_url=?, discovery_channel=?, evidence_url=?, parser_version=?,
        snapshot_run_id=?, summary=? WHERE id=?`).bind(
          job.title, job.roleFamily, job.location, job.remoteStatus,
          job.employmentType, job.compensation, job.canonicalUrl, now,
          job.publishedAt, job.publishedAt, now, job.canonicalUrl,
          discoveryChannelFor(source.provider), job.canonicalUrl,
          parserVersionFor(source.provider), runId, job.summary, id
        ));
    } else {
      statements.push(database.prepare(`UPDATE jobs SET status='verified_open',
        last_seen_at=?, last_verified_at=?, closed_at=NULL WHERE id=?`)
        .bind(now, now, id));
    }
    const method = match?.method || "new";
    statements.push(database.prepare(`INSERT INTO job_observations (
      id, job_id, company_id, provider, source_id, external_id, canonical_url,
      normalized_canonical_url, title, location, employment_type, summary,
      published_at, status, first_seen_at, last_seen_at, last_verified_at,
      closed_at, raw_url, evidence_url, parser_version, snapshot_run_id,
      match_method, match_score_bps
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified_open', ?, ?, ?,
      NULL, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, source_id, external_id) DO UPDATE SET
      job_id=excluded.job_id, company_id=excluded.company_id,
      canonical_url=excluded.canonical_url,
      normalized_canonical_url=excluded.normalized_canonical_url,
      title=excluded.title, location=excluded.location,
      employment_type=excluded.employment_type, summary=excluded.summary,
      published_at=COALESCE(job_observations.published_at, excluded.published_at),
      status='verified_open', last_seen_at=excluded.last_seen_at,
      last_verified_at=excluded.last_verified_at, closed_at=NULL,
      raw_url=excluded.raw_url, evidence_url=excluded.evidence_url,
      parser_version=excluded.parser_version,
      snapshot_run_id=excluded.snapshot_run_id`).bind(
        current?.id || observationId(source, job.externalId),
        id, source.companyId, source.provider, source.id, job.externalId,
        job.canonicalUrl, normalizeCanonicalJobUrl(job.canonicalUrl), job.title,
        job.location, job.employmentType, job.summary, job.publishedAt,
        now, now, now, job.canonicalUrl, job.canonicalUrl,
        parserVersionFor(source.provider), runId, method,
        Math.round((match?.score || 1) * 10_000)
      ));
    resolvedJobIds.add(id);
    if (source.provider === "structured") {
      statements.push(database.prepare(
        "DELETE FROM fragile_job_misses WHERE job_id=? AND source_id=?"
      ).bind(id, source.id));
    }
    if (!wasOpen && !openedJobIds.has(id)) {
      openedJobIds.add(id);
      opened += 1;
      statements.push(database.prepare(`INSERT OR IGNORE INTO changes (
        id, entity_type, entity_id, change_type, title, description, occurred_at, source_url
      ) VALUES (?, 'job', ?, 'job_opened', ?, ?, ?, ?)`).bind(
        `change_open_${id}_${now.slice(0, 10)}`, id, `${job.title} opened`,
        `Canonical ${source.provider} posting verified open.`, now, job.canonicalUrl
      ));
    }
  }

  // Absence is meaningful only after the adapter validates a complete
  // authoritative response. Callers must never invoke this for partial data.
  const closingExternalIds = new Set(closurePlan.closingExternalIds);
  const fragileMisses = source.provider === "structured"
    ? await database.prepare(`SELECT job_id as jobId, first_miss_at as firstMissAt,
        last_miss_at as lastMissAt, clean_miss_count as cleanMissCount,
        last_run_id as lastRunId FROM fragile_job_misses WHERE source_id=?`)
      .bind(source.id)
      .all<{
        jobId: string;
        firstMissAt: string;
        lastMissAt: string;
        cleanMissCount: number;
        lastRunId: string;
      }>()
    : { results: [] };
  const fragileByJob = new Map(fragileMisses.results.map((miss) => [miss.jobId, miss]));
  const actualClosures: typeof existing = [];
  for (const job of existing) {
    if (!closingExternalIds.has(job.externalId)) continue;
    if (source.provider === "structured") {
      const miss = fragileByJob.get(job.id);
      if (miss?.lastRunId === runId) continue;
      const elapsed = miss ? Date.parse(now) - Date.parse(miss.firstMissAt) : 0;
      if (!miss || elapsed > 172_800_000) {
        statements.push(database.prepare(`INSERT INTO fragile_job_misses (
          job_id, source_id, first_miss_at, last_miss_at, clean_miss_count, last_run_id
        ) VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(job_id, source_id) DO UPDATE SET
          first_miss_at=excluded.first_miss_at, last_miss_at=excluded.last_miss_at,
          clean_miss_count=1, last_run_id=excluded.last_run_id`).bind(
          job.id, source.id, now, now, runId
        ));
        continue;
      }
      if (elapsed < 86_400_000) {
        statements.push(database.prepare(`UPDATE fragile_job_misses SET
          last_miss_at=?, clean_miss_count=clean_miss_count+1, last_run_id=?
          WHERE job_id=? AND source_id=?`).bind(now, runId, job.id, source.id));
        continue;
      }
      statements.push(database.prepare(
        "DELETE FROM fragile_job_misses WHERE job_id=? AND source_id=?"
      ).bind(job.id, source.id));
    }
    actualClosures.push(job);
  }
  const closingObservationKeys = new Set(
    actualClosures.map((item) => `${source.provider}\n${source.id}\n${item.externalId}`)
  );
  const activeAfterRefresh = new Map<string, number>();
  for (const observation of observations.results) {
    if (observation.status !== "verified_open") continue;
    const key = `${observation.provider}\n${observation.sourceId}\n${observation.externalId}`;
    if (closingObservationKeys.has(key)) continue;
    activeAfterRefresh.set(
      observation.jobId,
      (activeAfterRefresh.get(observation.jobId) || 0) + 1
    );
  }
  for (const id of resolvedJobIds) {
    activeAfterRefresh.set(id, Math.max(1, activeAfterRefresh.get(id) || 0));
  }
  const canonicalClosures = new Set<string>();
  for (const job of actualClosures) {
    statements.push(database.prepare(`UPDATE job_observations
      SET status='verified_closed', closed_at=?, last_verified_at=?
      WHERE provider=? AND source_id=? AND external_id=?`)
      .bind(now, now, source.provider, source.id, job.externalId));
    if ((activeAfterRefresh.get(job.id) || 0) > 0 || canonicalClosures.has(job.id)) continue;
    canonicalClosures.add(job.id);
    closed += 1;
    statements.push(database.prepare(`UPDATE jobs SET status='verified_closed',
      closed_at=?, last_verified_at=? WHERE id=?`)
      .bind(now, now, job.id));
    statements.push(database.prepare(`INSERT OR IGNORE INTO changes (
      id, entity_type, entity_id, change_type, title, description, occurred_at, source_url
    ) SELECT ?, 'job', id, 'job_closed', title || ' closed', ?,
      ?, canonical_url FROM jobs WHERE id=?`).bind(
      `change_close_${job.id}_${now.slice(0, 10)}`,
      source.provider === "structured"
        ? "First-party career source omitted this role in two clean snapshots 24–48 hours apart."
        : `Canonical ${source.provider} source no longer lists this role.`,
      now,
      job.id
    ));
  }

  statements.push(database.prepare(`UPDATE company_sources SET last_attempted_at=?,
    last_successful_at=?, last_error=NULL, consecutive_failures=0,
    discovery_status='active', quarantine_snapshot_id=NULL,
    quarantine_application_id=NULL WHERE id=?`).bind(now, now, source.id));
  await batchInChunks(database, statements);
  return {
    sourceId: source.id,
    companyId: source.companyId,
    provider: source.provider,
    status: "success",
    snapshotId,
    observed: normalized.length,
    verified: normalized.length,
    opened,
    closed,
  };
}

function unsafeSnapshotReason(error: unknown) {
  if (error instanceof SyntaxError) return "parser_error";
  const message = error instanceof Error ? error.message : String(error);
  if (/incomplete payload/i.test(message)) return "incomplete_payload";
  if (/unexpected (?:end|token)|json parse|invalid json/i.test(message)) {
    return "parser_error";
  }
  return null;
}

export async function persistCanonicalFailure(
  database: D1Database,
  source: CanonicalCompanySource,
  now: string,
  runId: string,
  error: unknown
): Promise<SourceRefreshResult> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const quarantineReason = unsafeSnapshotReason(error);
  if (!quarantineReason) {
    await database.prepare(`UPDATE company_sources SET last_attempted_at=?, last_error=?,
      consecutive_failures=consecutive_failures+1 WHERE id=?`).bind(now, message, source.id).run();
    return {
      sourceId: source.id,
      companyId: source.companyId,
      provider: source.provider,
      status: "failed",
      observed: 0,
      verified: 0,
      opened: 0,
      closed: 0,
      error: message,
    };
  }

  const existing = await database.prepare(`SELECT COUNT(*) AS count FROM job_observations
    WHERE provider=? AND source_id=? AND status='verified_open'`)
    .bind(source.provider, source.id)
    .first<{ count: number }>();
  const existingOpenCount = Number(existing?.count || 0);
  const snapshotId = `${runId}:${source.id}`;
  await database.batch([
    database.prepare(`INSERT INTO canonical_source_snapshots (
      id, run_id, source_id, provider, captured_at, parser_version, status,
      existing_open_count, observed_open_count, missing_count, missing_ratio_bps,
      fingerprint, quarantine_reason, board_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'quarantined', ?, 0, ?, ?, ?, ?, ?)`).bind(
      snapshotId,
      runId,
      source.id,
      source.provider,
      now,
      parserVersionFor(source.provider),
      existingOpenCount,
      existingOpenCount,
      existingOpenCount ? 10_000 : 0,
      snapshotFingerprint([]),
      quarantineReason,
      source.boardId
    ),
    database.prepare(`UPDATE company_sources SET last_attempted_at=?, last_error=?,
      consecutive_failures=consecutive_failures+1,
      discovery_status='quarantined', quarantine_snapshot_id=?,
      quarantine_application_id=NULL WHERE id=?`)
      .bind(now, message, snapshotId, source.id),
  ]);
  return {
    sourceId: source.id,
    companyId: source.companyId,
    provider: source.provider,
    status: "quarantined",
    snapshotId,
    observed: 0,
    verified: 0,
    opened: 0,
    closed: 0,
    error: message,
    quarantineReason,
  };
}
