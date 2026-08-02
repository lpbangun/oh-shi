import { env } from "cloudflare:workers";
import {
  fetchCanonicalBoard,
  type AtsDetection,
  type NormalizedJob,
} from "./ats-adapters";
import { ensureDatabase } from "./data";
import {
  activateDiscoveredCandidate,
  DEFAULT_PROMOTION_LIMIT,
  promoteRegistryDomains,
  resolveCanonicalSource,
  type Candidate,
} from "./discovery";
import { snapshotFingerprint } from "./ingestion-core";

const ACTIVE_REVIEW_STATUSES = [
  "queued", "processing", "ready", "needs_review", "failed", "approved",
] as const;

export const MAX_REVIEW_BATCH_SIZE = 500;
export const MAX_REVIEW_PROCESS_LIMIT = 30;
export const MAX_REVIEW_APPROVAL_SIZE = 25;

type ReviewBatchRow = {
  id: string;
  requestedCount: number;
  assignedCount: number;
  processedCount: number;
  readyCount: number;
  needsReviewCount: number;
  failedCount: number;
  status: string;
  createdAt: string;
  completedAt: string | null;
};

type ReviewCandidateRow = {
  batchId: string;
  candidateId: string;
  status: string;
  companyName: string;
  normalizedDomain: string;
  websiteUrl: string;
  provider: string | null;
  boardId: string | null;
  careersUrl: string | null;
  jobCount: number;
  jobsJson: string;
  fingerprint: string | null;
  observedAt: string | null;
  lastAttemptedAt: string | null;
  lastError: string | null;
  reviewedAt: string | null;
  reviewReason: string | null;
  investorSourceId?: string;
  evidenceUrl?: string;
};

const batchColumns = `id, requested_count as requestedCount,
  assigned_count as assignedCount, processed_count as processedCount,
  ready_count as readyCount, needs_review_count as needsReviewCount,
  failed_count as failedCount, status, created_at as createdAt,
  completed_at as completedAt`;

const candidateColumns = `batch_id as batchId, candidate_id as candidateId,
  status, company_name as companyName, normalized_domain as normalizedDomain,
  website_url as websiteUrl, provider, board_id as boardId,
  careers_url as careersUrl, job_count as jobCount, jobs_json as jobsJson,
  fingerprint, observed_at as observedAt, last_attempted_at as lastAttemptedAt,
  last_error as lastError, reviewed_at as reviewedAt,
  review_reason as reviewReason`;

const validBatchId = (value: string) =>
  /^[a-z0-9][a-z0-9._:-]{7,159}$/i.test(value);

async function batchInChunks(statements: D1PreparedStatement[], size = 50) {
  for (let index = 0; index < statements.length; index += size) {
    await env.DB.batch(statements.slice(index, index + size));
  }
}

function reviewJobs(jobs: NormalizedJob[]) {
  return jobs.map((job) => ({
    externalId: job.externalId,
    title: job.title,
    roleFamily: job.roleFamily,
    location: job.location,
    remoteStatus: job.remoteStatus,
    employmentType: job.employmentType,
    compensation: job.compensation,
    canonicalUrl: job.canonicalUrl,
    publishedAt: job.publishedAt,
  }));
}

async function readBatchRow(batchId: string) {
  return env.DB.prepare(`SELECT ${batchColumns}
    FROM discovery_review_batches WHERE id=?`)
    .bind(batchId).first<ReviewBatchRow>();
}

async function refreshBatchCounts(batchId: string) {
  const counts = await env.DB.prepare(`SELECT
    COUNT(*) as assignedCount,
    SUM(CASE WHEN status NOT IN ('queued','processing') THEN 1 ELSE 0 END) as processedCount,
    SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) as readyCount,
    SUM(CASE WHEN status='needs_review' THEN 1 ELSE 0 END) as needsReviewCount,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failedCount,
    SUM(CASE WHEN status IN ('queued','processing') THEN 1 ELSE 0 END) as remainingCount,
    SUM(CASE WHEN status IN ('ready','approved') THEN 1 ELSE 0 END) as awaitingDecisionCount
    FROM discovery_candidate_reviews WHERE batch_id=?`)
    .bind(batchId).first<{
      assignedCount: number;
      processedCount: number | null;
      readyCount: number | null;
      needsReviewCount: number | null;
      failedCount: number | null;
      remainingCount: number | null;
      awaitingDecisionCount: number | null;
    }>();
  const remaining = counts?.remainingCount || 0;
  const awaitingDecision = counts?.awaitingDecisionCount || 0;
  const status = remaining > 0
    ? "processing"
    : awaitingDecision > 0
      ? "ready"
      : "completed";
  const completedAt = remaining > 0 ? null : new Date().toISOString();
  await env.DB.prepare(`UPDATE discovery_review_batches SET
    assigned_count=?, processed_count=?, ready_count=?, needs_review_count=?,
    failed_count=?, status=?, completed_at=? WHERE id=?`).bind(
    counts?.assignedCount || 0,
    counts?.processedCount || 0,
    counts?.readyCount || 0,
    counts?.needsReviewCount || 0,
    counts?.failedCount || 0,
    status,
    completedAt,
    batchId
  ).run();
  return readBatchRow(batchId);
}

export async function createDiscoveryReviewBatch(options: {
  batchId: string;
  requestedCount: number;
  now?: string;
}) {
  const { batchId } = options;
  const requestedCount = Math.trunc(options.requestedCount);
  if (!validBatchId(batchId)) throw new Error("A valid review batch ID is required.");
  if (
    !Number.isInteger(options.requestedCount) ||
    requestedCount < 1 || requestedCount > MAX_REVIEW_BATCH_SIZE
  ) {
    throw new Error(`Review batches must contain 1 to ${MAX_REVIEW_BATCH_SIZE} candidates.`);
  }
  await ensureDatabase();
  const existing = await readBatchRow(batchId);
  if (existing) {
    if (existing.requestedCount !== requestedCount) {
      throw new Error("The review batch ID is already bound to another requested count.");
    }
    return existing;
  }

  const now = options.now || new Date().toISOString();
  await promoteRegistryDomains(Math.max(requestedCount, DEFAULT_PROMOTION_LIMIT), now);
  const placeholders = ACTIVE_REVIEW_STATUSES.map(() => "?").join(",");
  const candidates = await env.DB.prepare(`SELECT q.id, q.company_name as companyName,
    q.normalized_domain as normalizedDomain, q.website_url as websiteUrl
    FROM discovery_queue q
    WHERE q.status IN ('discovered','canonical_source_found')
      AND NOT EXISTS (
        SELECT 1 FROM discovery_candidate_reviews review
        WHERE review.candidate_id=q.id AND review.status IN (${placeholders})
      )
    ORDER BY q.first_discovered_at, q.id LIMIT ?`).bind(
      ...ACTIVE_REVIEW_STATUSES,
      requestedCount
    ).all<{
      id: string;
      companyName: string;
      normalizedDomain: string;
      websiteUrl: string;
    }>();

  await env.DB.prepare(`INSERT INTO discovery_review_batches (
    id, requested_count, assigned_count, processed_count, ready_count,
    needs_review_count, failed_count, status, created_at
  ) VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?)`).bind(
    batchId,
    requestedCount,
    candidates.results.length,
    candidates.results.length ? "queued" : "completed",
    now
  ).run();
  await batchInChunks(candidates.results.map((candidate) =>
    env.DB.prepare(`INSERT INTO discovery_candidate_reviews (
      batch_id, candidate_id, status, company_name, normalized_domain,
      website_url, job_count, jobs_json
    ) VALUES (?, ?, 'queued', ?, ?, ?, 0, '[]')`).bind(
      batchId,
      candidate.id,
      candidate.companyName,
      candidate.normalizedDomain,
      candidate.websiteUrl
    )
  ));
  return readBatchRow(batchId);
}

async function finishCandidate(options: {
  batchId: string;
  candidateId: string;
  status: "ready" | "needs_review" | "failed";
  queueStatus: "canonical_source_found" | "needs_review" | "discovered";
  note: string;
  error?: string | null;
  detection?: AtsDetection;
  jobs?: NormalizedJob[];
  now: string;
}) {
  const jobs = options.jobs || [];
  const fingerprint = jobs.length
    ? snapshotFingerprint(jobs.map((job) => job.externalId))
    : null;
  await env.DB.batch([
    env.DB.prepare(`UPDATE discovery_candidate_reviews SET status=?, provider=?,
      board_id=?, careers_url=?, job_count=?, jobs_json=?, fingerprint=?,
      observed_at=?, last_error=? WHERE batch_id=? AND candidate_id=?`).bind(
      options.status,
      options.detection?.provider || null,
      options.detection?.boardId || null,
      options.detection?.careersUrl || null,
      jobs.length,
      JSON.stringify(reviewJobs(jobs)),
      fingerprint,
      options.now,
      options.error?.slice(0, 500) || null,
      options.batchId,
      options.candidateId
    ),
    env.DB.prepare(`UPDATE discovery_queue SET status=?, last_error=?, review_notes=?
      WHERE id=?`).bind(
      options.queueStatus,
      options.error?.slice(0, 500) || null,
      options.note,
      options.candidateId
    ),
  ]);
}

export async function processDiscoveryReviewBatch(options: {
  batchId: string;
  limit?: number;
  fetcher?: typeof fetch;
  now?: string;
}) {
  const { batchId } = options;
  const limit = Math.trunc(options.limit ?? 25);
  if (!validBatchId(batchId)) throw new Error("A valid review batch ID is required.");
  if (
    !Number.isInteger(options.limit ?? 25) ||
    limit < 1 || limit > MAX_REVIEW_PROCESS_LIMIT
  ) {
    throw new Error(`Process 1 to ${MAX_REVIEW_PROCESS_LIMIT} candidates per request.`);
  }
  await ensureDatabase();
  if (!await readBatchRow(batchId)) throw new Error("Review batch was not found.");
  const now = options.now || new Date().toISOString();
  const staleBefore = new Date(Date.parse(now) - 15 * 60_000).toISOString();
  const rows = await env.DB.prepare(`SELECT ${candidateColumns},
    qi.investor_source_id as investorSourceId, qi.evidence_url as evidenceUrl
    FROM discovery_candidate_reviews review
    LEFT JOIN discovery_queue_investors qi ON qi.candidate_id=review.candidate_id
    WHERE review.batch_id=? AND (
      review.status='queued' OR (
        review.status='processing' AND review.last_attempted_at < ?
      )
    ) GROUP BY review.candidate_id
    ORDER BY review.candidate_id LIMIT ?`).bind(batchId, staleBefore, limit)
    .all<ReviewCandidateRow>();
  const fetcher = options.fetcher || fetch;
  let ready = 0;
  let needsReview = 0;
  let failed = 0;

  for (const row of rows.results) {
    const attemptedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE discovery_candidate_reviews SET status='processing',
        last_attempted_at=?, last_error=NULL WHERE batch_id=? AND candidate_id=?`)
        .bind(attemptedAt, batchId, row.candidateId),
      env.DB.prepare(`UPDATE discovery_queue SET status='resolving',
        last_attempted_at=? WHERE id=?`).bind(attemptedAt, row.candidateId),
    ]);
    const candidate: Candidate = {
      id: row.candidateId,
      normalizedDomain: row.normalizedDomain,
      companyName: row.companyName,
      websiteUrl: row.websiteUrl,
      status: "resolving",
      investorSourceId: row.investorSourceId,
      evidenceUrl: row.evidenceUrl,
    };
    try {
      const detection = await resolveCanonicalSource(candidate, fetcher);
      if (!detection) {
        needsReview += 1;
        await finishCandidate({
          batchId,
          candidateId: row.candidateId,
          status: "needs_review",
          queueStatus: "needs_review",
          note: "Review scan found no supported public ATS; no public records were created.",
          error: "canonical_ats_not_detected",
          now: attemptedAt,
        });
        continue;
      }
      const canonical = await fetchCanonicalBoard(
        detection.provider,
        detection.boardId,
        fetcher
      );
      if (!canonical.jobs.length) {
        needsReview += 1;
        await finishCandidate({
          batchId,
          candidateId: row.candidateId,
          status: "needs_review",
          queueStatus: "needs_review",
          note: "Review scan verified the board but found no US-eligible open jobs; no public records were created.",
          error: "no_verified_us_open_jobs",
          detection,
          now: attemptedAt,
        });
        continue;
      }
      ready += 1;
      await finishCandidate({
        batchId,
        candidateId: row.candidateId,
        status: "ready",
        queueStatus: "canonical_source_found",
        note: "Canonical source and jobs staged for manual review; no public records were created.",
        detection,
        jobs: canonical.jobs,
        now: attemptedAt,
      });
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      await finishCandidate({
        batchId,
        candidateId: row.candidateId,
        status: "failed",
        queueStatus: "discovered",
        note: "Review scan failed; candidate remains gated from automatic activation.",
        error: message,
        now: attemptedAt,
      });
    }
  }
  const batch = await refreshBatchCounts(batchId);
  return {
    batch,
    processedThisRequest: rows.results.length,
    readyThisRequest: ready,
    needsReviewThisRequest: needsReview,
    failedThisRequest: failed,
    hasMore: batch?.status === "processing",
    activation: "none",
  };
}

export async function readDiscoveryReviewBatch(batchId: string) {
  if (!validBatchId(batchId)) throw new Error("A valid review batch ID is required.");
  await ensureDatabase();
  const batch = await readBatchRow(batchId);
  if (!batch) return null;
  const rows = await env.DB.prepare(`SELECT ${candidateColumns}
    FROM discovery_candidate_reviews WHERE batch_id=?
    ORDER BY status, company_name, candidate_id`).bind(batchId)
    .all<ReviewCandidateRow>();
  return {
    batch,
    candidates: rows.results.map((row) => ({
      ...row,
      jobs: (() => {
        try {
          const parsed = JSON.parse(row.jobsJson);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
      jobsJson: undefined,
    })),
    publication: "none",
  };
}

export async function activateDiscoveryReviewCandidates(options: {
  batchId: string;
  candidateIds: string[];
  expectedFingerprints: Record<string, string>;
  reason: string;
  fetcher?: typeof fetch;
}) {
  const candidateIds = [...new Set(options.candidateIds)];
  if (!validBatchId(options.batchId)) throw new Error("A valid review batch ID is required.");
  if (!candidateIds.length || candidateIds.length > MAX_REVIEW_APPROVAL_SIZE) {
    throw new Error(`Approve 1 to ${MAX_REVIEW_APPROVAL_SIZE} candidates per request.`);
  }
  if (options.reason.trim().length < 12 || options.reason.trim().length > 500) {
    throw new Error("A review reason between 12 and 500 characters is required.");
  }
  await ensureDatabase();
  const fetcher = options.fetcher || fetch;
  const activated: Array<{ candidateId: string; companyId: string; jobCount: number }> = [];
  const rejected: Array<{ candidateId: string; reason: string }> = [];
  for (const candidateId of candidateIds) {
    const row = await env.DB.prepare(`SELECT ${candidateColumns},
      qi.investor_source_id as investorSourceId, qi.evidence_url as evidenceUrl
      FROM discovery_candidate_reviews review
      LEFT JOIN discovery_queue_investors qi ON qi.candidate_id=review.candidate_id
      WHERE review.batch_id=? AND review.candidate_id=?
      GROUP BY review.candidate_id`).bind(options.batchId, candidateId)
      .first<ReviewCandidateRow>();
    if (!row) {
      rejected.push({ candidateId, reason: "candidate_not_found" });
      continue;
    }
    if (row.status === "activated") {
      rejected.push({ candidateId, reason: "already_activated" });
      continue;
    }
    if (
      row.status !== "ready" || !row.provider || !row.boardId ||
      !row.careersUrl || !row.fingerprint
    ) {
      rejected.push({ candidateId, reason: `candidate_not_ready:${row.status}` });
      continue;
    }
    if (options.expectedFingerprints[candidateId] !== row.fingerprint) {
      rejected.push({ candidateId, reason: "staged_fingerprint_mismatch" });
      continue;
    }
    try {
      const detection: AtsDetection = {
        provider: row.provider as AtsDetection["provider"],
        boardId: row.boardId,
        careersUrl: row.careersUrl,
      };
      const canonical = await fetchCanonicalBoard(
        detection.provider,
        detection.boardId,
        fetcher
      );
      const freshFingerprint = snapshotFingerprint(
        canonical.jobs.map((job) => job.externalId)
      );
      if (!canonical.jobs.length || freshFingerprint !== row.fingerprint) {
        rejected.push({ candidateId, reason: "canonical_board_changed_since_review" });
        continue;
      }
      const now = new Date().toISOString();
      const activatedCandidate = await activateDiscoveredCandidate({
        id: candidateId,
        normalizedDomain: row.normalizedDomain,
        companyName: row.companyName,
        websiteUrl: row.websiteUrl,
        status: "canonical_source_found",
        investorSourceId: row.investorSourceId,
        evidenceUrl: row.evidenceUrl,
      }, detection, now, { sourceEnabled: false });
      await env.DB.batch([
        env.DB.prepare(`UPDATE discovery_candidate_reviews SET
          status='activated', reviewed_at=?, review_reason=?, observed_at=?,
          job_count=?, jobs_json=?, fingerprint=?, last_error=NULL
          WHERE batch_id=? AND candidate_id=?`).bind(
          now,
          options.reason.trim(),
          now,
          canonical.jobs.length,
          JSON.stringify(reviewJobs(canonical.jobs)),
          freshFingerprint,
          options.batchId,
          candidateId
        ),
        env.DB.prepare(`UPDATE company_sources SET enabled=1
          WHERE id=? AND company_id=?`).bind(
          activatedCandidate.canonicalSourceId,
          activatedCandidate.companyId
        ),
      ]);
      activated.push({
        candidateId,
        companyId: activatedCandidate.companyId,
        jobCount: canonical.jobs.length,
      });
    } catch (error) {
      rejected.push({
        candidateId,
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
  }
  const batch = await refreshBatchCounts(options.batchId);
  return { batch, activated, rejected, canonicalRefreshRequired: activated.length > 0 };
}

export async function rejectDiscoveryReviewCandidates(options: {
  batchId: string;
  candidateIds: string[];
  reason: string;
}) {
  const candidateIds = [...new Set(options.candidateIds)];
  if (!validBatchId(options.batchId)) throw new Error("A valid review batch ID is required.");
  if (!candidateIds.length || candidateIds.length > MAX_REVIEW_APPROVAL_SIZE) {
    throw new Error(`Reject 1 to ${MAX_REVIEW_APPROVAL_SIZE} candidates per request.`);
  }
  if (options.reason.trim().length < 12 || options.reason.trim().length > 500) {
    throw new Error("A review reason between 12 and 500 characters is required.");
  }
  await ensureDatabase();
  const now = new Date().toISOString();
  for (const candidateId of candidateIds) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE discovery_candidate_reviews SET status='rejected',
        reviewed_at=?, review_reason=? WHERE batch_id=? AND candidate_id=?
        AND status IN ('ready','needs_review','failed')`).bind(
          now, options.reason.trim(), options.batchId, candidateId
        ),
      env.DB.prepare(`UPDATE discovery_queue SET status='rejected',
        review_notes=? WHERE id=? AND EXISTS (
          SELECT 1 FROM discovery_candidate_reviews review
          WHERE review.batch_id=? AND review.candidate_id=?
            AND review.status='rejected'
        )`).bind(options.reason.trim(), candidateId, options.batchId, candidateId),
      env.DB.prepare(`UPDATE startup_domains SET review_status='rejected'
        WHERE canonical_domain=(SELECT normalized_domain FROM discovery_queue WHERE id=?)
          AND EXISTS (
            SELECT 1 FROM discovery_candidate_reviews review
            WHERE review.batch_id=? AND review.candidate_id=?
              AND review.status='rejected'
          )
          AND company_id IS NULL`).bind(candidateId, options.batchId, candidateId),
    ]);
  }
  const batch = await refreshBatchCounts(options.batchId);
  return { batch, rejected: candidateIds };
}
