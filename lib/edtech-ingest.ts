import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  CanonicalHttpError,
  dedupeNormalizedJobs,
  type NormalizedJob,
} from "./ats-adapters";
import type { EdtechPackRow } from "./edtech-pack";
import {
  changeEventId,
  planCanonicalClosures,
  stableIdentityHash,
} from "./ingestion-core";

/** Matches worker refresh budget; safe for Node pack ingest without cloudflare:workers. */
export const DEFAULT_EDTECH_INGEST_CONCURRENCY = 6;

export async function mapBounded<T, R>(
  values: T[],
  concurrency: number,
  work: (value: T) => Promise<R>
) {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length || 1) },
    async () => {
      while (cursor < values.length) {
        const index = cursor++;
        output[index] = await work(values[index]);
      }
    }
  );
  await Promise.all(workers);
  return output;
}

const SNAPSHOT_FILE_PATTERN = /^edtech-ingest-.+\.json$/;

export async function loadPreviousEdtechSnapshot(
  outputDir: string
): Promise<EdtechBoardSnapshotStore> {
  let entries: string[] = [];
  try {
    entries = await readdir(outputDir);
  } catch {
    return { jobs: [] };
  }
  const snapshots = entries
    .filter((name) => SNAPSHOT_FILE_PATTERN.test(name))
    .sort()
    .reverse();
  if (!snapshots.length) return { jobs: [] };
  try {
    const payload = JSON.parse(
      await readFile(path.join(outputDir, snapshots[0]), "utf8")
    ) as { jobs?: CompactEdtechJob[] };
    return { jobs: Array.isArray(payload.jobs) ? payload.jobs : [] };
  } catch {
    return { jobs: [] };
  }
}

export type CompactEdtechJob = {
  id: string;
  board_id: string;
  provider: EdtechPackRow["provider"];
  external_id: string;
  title: string;
  role_family: string;
  location: string;
  employment_type: string;
  canonical_url: string;
  apply_url: string;
  status: "verified_open" | "verified_closed";
  vertical: "edtech";
  employer_kind?: string;
};

export type EdtechIngestChangeKind = "opened" | "closed" | "updated";

export type EdtechIngestChangeEvent = {
  id: string;
  kind: EdtechIngestChangeKind;
  job_id: string;
  external_id: string;
  title: string;
  occurred_at: string;
};

export type EdtechBoardSnapshotStore = {
  jobs: CompactEdtechJob[];
};

export type EdtechBoardIngestStatus = "success" | "quarantined" | "failed";

export type EdtechBoardIngestResult = {
  status: EdtechBoardIngestStatus;
  jobs: CompactEdtechJob[];
  events: EdtechIngestChangeEvent[];
  observedCount: number;
  opened: number;
  closed: number;
  updated: number;
  quarantineReason?: string;
  error?: string;
};

export type EdtechFetchResolution =
  | {
    complete: true;
    jobs: NormalizedJob[];
    observedExternalIds: string[];
  }
  | {
    complete: false;
    status: "quarantined" | "failed";
    reason: string;
    observedExternalIds: null;
    error?: string;
  };

const COMPACT_MATERIAL_FIELDS = [
  "title",
  "role_family",
  "location",
  "employment_type",
  "canonical_url",
  "apply_url",
] as const;

export function edtechJobId(
  provider: EdtechPackRow["provider"],
  boardId: string,
  externalId: string
) {
  const identity = `${provider}\u0000${boardId}\u0000${externalId}`;
  const safe = `${provider}_${boardId}_${externalId}`
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .slice(0, 140);
  return `edtech_${safe}_${stableIdentityHash(identity)}`;
}

export function toCompactEdtechJob(
  job: NormalizedJob,
  board: Pick<EdtechPackRow, "provider" | "board_id" | "employer_kind">,
  status: CompactEdtechJob["status"] = "verified_open"
): CompactEdtechJob {
  return {
    id: edtechJobId(board.provider, board.board_id, job.externalId),
    board_id: board.board_id,
    provider: board.provider,
    external_id: job.externalId,
    title: job.title,
    role_family: job.roleFamily,
    location: job.location,
    employment_type: job.employmentType,
    canonical_url: job.canonicalUrl,
    apply_url: job.canonicalUrl,
    status,
    vertical: "edtech",
    employer_kind: board.employer_kind,
  };
}

export function filterCompactJobs(
  jobs: CompactEdtechJob[],
  filters: { boardIds?: string[]; titles?: string[] }
) {
  const boardIds = filters.boardIds?.map((value) => value.toLowerCase());
  const titles = filters.titles?.map((value) => value.toLowerCase());
  return jobs.filter((job) => {
    if (boardIds?.length && !boardIds.includes(job.board_id.toLowerCase())) return false;
    if (titles?.length && !titles.some((title) => job.title.toLowerCase().includes(title))) {
      return false;
    }
    return true;
  });
}

function boardScopedJobs(store: EdtechBoardSnapshotStore, board: EdtechPackRow) {
  return store.jobs.filter(
    (job) =>
      job.provider === board.provider &&
      job.board_id.toLowerCase() === board.board_id.toLowerCase()
  );
}

function mergeBoardJobs(
  store: EdtechBoardSnapshotStore,
  board: EdtechPackRow,
  boardJobs: CompactEdtechJob[]
) {
  const retained = store.jobs.filter(
    (job) =>
      job.provider !== board.provider ||
      job.board_id.toLowerCase() !== board.board_id.toLowerCase()
  );
  return { jobs: [...retained, ...boardJobs] };
}

function materialChanged(left: CompactEdtechJob, right: CompactEdtechJob) {
  return COMPACT_MATERIAL_FIELDS.some((field) => left[field] !== right[field]);
}

export function resolveEdtechFetch(
  fetchResult: { jobs: NormalizedJob[] } | null,
  error: unknown
): EdtechFetchResolution {
  if (fetchResult) {
    const jobs = dedupeNormalizedJobs(fetchResult.jobs);
    return {
      complete: true,
      jobs,
      observedExternalIds: jobs.map((job) => job.externalId),
    };
  }
  if (error instanceof CanonicalHttpError && (error.status === 403 || error.status === 429)) {
    return {
      complete: false,
      status: "quarantined",
      reason: `http_${error.status}`,
      observedExternalIds: null,
      error: error.message,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/incomplete payload/i.test(message)) {
    return {
      complete: false,
      status: "quarantined",
      reason: "incomplete_payload",
      observedExternalIds: null,
      error: message,
    };
  }
  return {
    complete: false,
    status: "failed",
    reason: "fetch_failed",
    observedExternalIds: null,
    error: message,
  };
}

export function ingestEdtechBoardSnapshot(input: {
  board: EdtechPackRow;
  previous: EdtechBoardSnapshotStore;
  fetch: EdtechFetchResolution;
  now: string;
  runId: string;
}): EdtechBoardIngestResult {
  const { board, previous, fetch, now, runId } = input;
  const existingForBoard = boardScopedJobs(previous, board);
  const emptyEvents: EdtechIngestChangeEvent[] = [];

  if (!fetch.complete) {
    return {
      status: fetch.status,
      jobs: previous.jobs,
      events: emptyEvents,
      observedCount: 0,
      opened: 0,
      closed: 0,
      updated: 0,
      quarantineReason: fetch.reason,
      error: fetch.error,
    };
  }

  if (fetch.observedExternalIds === null) {
    return {
      status: "quarantined",
      jobs: previous.jobs,
      events: emptyEvents,
      observedCount: 0,
      opened: 0,
      closed: 0,
      updated: 0,
      quarantineReason: "missing_observed_ids",
    };
  }

  const existingOpen = existingForBoard
    .filter((job) => job.status === "verified_open")
    .map((job) => ({
      id: job.id,
      externalId: job.external_id,
      status: job.status,
    }));
  const closurePlan = planCanonicalClosures(existingOpen, fetch.observedExternalIds);
  if (closurePlan.assessment.status === "quarantined") {
    return {
      status: "quarantined",
      jobs: previous.jobs,
      events: emptyEvents,
      observedCount: fetch.jobs.length,
      opened: 0,
      closed: 0,
      updated: 0,
      quarantineReason: closurePlan.assessment.reason || "mass_deletion_guard",
    };
  }

  const existingByExternal = new Map(
    existingForBoard.map((job) => [job.external_id, job])
  );
  const closingIds = new Set(closurePlan.closingJobIds);
  const nextByExternal = new Map<string, CompactEdtechJob>();
  const events: EdtechIngestChangeEvent[] = [];
  let opened = 0;
  let updated = 0;
  let closed = 0;

  for (const job of existingForBoard) {
    if (job.status === "verified_closed") {
      nextByExternal.set(job.external_id, job);
    }
  }

  for (const job of fetch.jobs) {
    const compact = toCompactEdtechJob(job, board, "verified_open");
    const prior = existingByExternal.get(job.externalId);
    if (!prior || prior.status !== "verified_open") {
      opened += 1;
      events.push({
        id: changeEventId("open", compact.id, runId),
        kind: "opened",
        job_id: compact.id,
        external_id: compact.external_id,
        title: compact.title,
        occurred_at: now,
      });
    } else if (materialChanged(prior, compact)) {
      updated += 1;
      const changed = COMPACT_MATERIAL_FIELDS.filter((field) => prior[field] !== compact[field]);
      events.push({
        id: changeEventId("update", compact.id, `${runId}\u0000${changed.join(",")}`),
        kind: "updated",
        job_id: compact.id,
        external_id: compact.external_id,
        title: compact.title,
        occurred_at: now,
      });
    }
    nextByExternal.set(compact.external_id, compact);
  }

  for (const job of existingForBoard) {
    if (!closingIds.has(job.id)) continue;
    closed += 1;
    const closedJob = { ...job, status: "verified_closed" as const };
    nextByExternal.set(job.external_id, closedJob);
    events.push({
      id: changeEventId("close", job.id, runId),
      kind: "closed",
      job_id: job.id,
      external_id: job.external_id,
      title: job.title,
      occurred_at: now,
    });
  }

  const reconciledBoardJobs = [...nextByExternal.values()];

  return {
    status: "success",
    jobs: mergeBoardJobs(previous, board, reconciledBoardJobs).jobs,
    events,
    observedCount: fetch.jobs.length,
    opened,
    closed,
    updated,
  };
}
