import path from "node:path";
import {
  filterCompactJobs,
  loadPreviousEdtechSnapshot,
  type CompactEdtechJob,
  type EdtechBoardSnapshotStore,
} from "./edtech-ingest";
import type { PackArtifactVertical, PackVertical } from "./edtech-pack";
import { normalizeRoleFamily, ROLE_FAMILIES } from "./job-normalization";

export const EDTECH_AGENT_PARAMETERS = new Set(["boards", "titles", "role_family", "vertical"]);

const BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "outputs");

export function resolveEdtechSnapshotDir() {
  const configured = process.env.EDTECH_SNAPSHOT_DIR?.trim();
  return configured ? path.resolve(configured) : DEFAULT_OUTPUT_DIR;
}

export class EdtechAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdtechAgentError";
  }
}

export type AgentVerticalFilter = PackVertical | "all";

export type EdtechAgentFilters = {
  boardIds: string[];
  titles: string[];
  roleFamilies: string[];
  vertical: AgentVerticalFilter;
};

export type EdtechAgentPublicJob = {
  id: string;
  boardId: string;
  provider: string;
  externalId: string;
  title: string;
  roleFamily: string;
  location: string;
  employmentType: string;
  canonicalUrl: string;
  applyUrl: string;
  status: "verified_open" | "verified_closed";
  vertical: PackVertical;
  employerKind?: string;
};

export function parseEdtechBoardId(value: string) {
  const trimmed = value.trim();
  if (!trimmed || !BOARD_ID_PATTERN.test(trimmed)) {
    throw new EdtechAgentError(`Invalid board id "${value}".`);
  }
  return trimmed;
}

function collectDelimitedValues(params: URLSearchParams, name: string) {
  const values: string[] = [];
  for (const raw of params.getAll(name)) {
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (trimmed) values.push(trimmed);
    }
  }
  return values;
}

function parseVerticalFilter(params: URLSearchParams): AgentVerticalFilter {
  const values = params.getAll("vertical");
  if (values.length > 1) {
    throw new EdtechAgentError('Parameter "vertical" may appear only once.');
  }
  const raw = values[0]?.trim().toLowerCase();
  if (!raw) return "edtech";
  if (raw === "edtech" || raw === "other" || raw === "all") return raw;
  throw new EdtechAgentError('Parameter "vertical" must be edtech, other, or all.');
}

export function parseEdtechAgentParams(params: URLSearchParams): EdtechAgentFilters {
  const unknown = [...new Set(params.keys())].filter((key) => !EDTECH_AGENT_PARAMETERS.has(key));
  if (unknown.length) {
    throw new EdtechAgentError(`Unknown parameter "${unknown[0]}".`);
  }

  const roleFamilyValues = params.getAll("role_family");
  if (roleFamilyValues.length > 1) {
    throw new EdtechAgentError('Parameter "role_family" may appear only once.');
  }

  const boardIds = collectDelimitedValues(params, "boards").map(parseEdtechBoardId);
  const titles = collectDelimitedValues(params, "titles");
  const roleFamilies: string[] = [];
  if (roleFamilyValues[0]) {
    for (const part of roleFamilyValues[0].split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const normalized = normalizeRoleFamily(trimmed);
      if (!normalized) {
        throw new EdtechAgentError(
          `role_family must be one of: ${ROLE_FAMILIES.join(", ")}.`
        );
      }
      roleFamilies.push(normalized);
    }
  }

  return { boardIds, titles, roleFamilies, vertical: parseVerticalFilter(params) };
}

export function toEdtechAgentPublicJob(job: CompactEdtechJob): EdtechAgentPublicJob {
  const publicJob: EdtechAgentPublicJob = {
    id: job.id,
    boardId: job.board_id,
    provider: job.provider,
    externalId: job.external_id,
    title: job.title,
    roleFamily: job.role_family,
    location: job.location,
    employmentType: job.employment_type,
    canonicalUrl: job.canonical_url,
    applyUrl: job.apply_url,
    status: job.status,
    vertical: job.vertical,
  };
  if (job.employer_kind) publicJob.employerKind = job.employer_kind;
  return publicJob;
}

export function queryEdtechAgent(
  store: EdtechBoardSnapshotStore,
  filters: EdtechAgentFilters
) {
  const scoped = filterCompactJobs(store.jobs, {
    boardIds: filters.boardIds,
    titles: filters.titles.length ? filters.titles : undefined,
  })
    .filter((job) => job.status === "verified_open")
    .filter((job) => filters.vertical === "all" || job.vertical === filters.vertical);

  const roleFiltered = filters.roleFamilies.length
    ? scoped.filter((job) =>
      filters.roleFamilies.some(
        (family) => family.toLowerCase() === job.role_family.toLowerCase()
      )
    )
    : scoped;

  const jobs = [...roleFiltered].sort((left, right) => {
    const boardCmp = left.board_id.localeCompare(right.board_id);
    if (boardCmp !== 0) return boardCmp;
    const titleCmp = left.title.localeCompare(right.title);
    if (titleCmp !== 0) return titleCmp;
    return left.id.localeCompare(right.id);
  });

  return {
    count: jobs.length,
    jobs: jobs.map(toEdtechAgentPublicJob),
  };
}

export async function loadEdtechAgentStore(outputDir?: string) {
  return loadPreviousEdtechSnapshot(outputDir ?? resolveEdtechSnapshotDir());
}

export function buildEdtechAgentJobsPayload(
  params: URLSearchParams,
  store: EdtechBoardSnapshotStore,
  generatedAt = new Date().toISOString()
) {
  const filters = parseEdtechAgentParams(params);
  if (!params.has("boards")) {
    throw new EdtechAgentError('Parameter "boards" is required.');
  }

  const result = filters.boardIds.length
    ? queryEdtechAgent(store, filters)
    : { count: 0, jobs: [] as EdtechAgentPublicJob[] };

  const appliedFilters: Record<string, unknown> = {
    boards: filters.boardIds,
    vertical: filters.vertical,
  };
  if (filters.titles.length) appliedFilters.titles = filters.titles;
  if (filters.roleFamilies.length) appliedFilters.role_family = filters.roleFamilies;

  const responseVertical: PackArtifactVertical = filters.vertical;

  return {
    count: result.count,
    schema_version: "1.0",
    generated_at: generatedAt,
    vertical: responseVertical,
    license:
      "CC BY 4.0 applies only to project-owned material; source rights remain with their owners.",
    applied_filters: appliedFilters,
    jobs: result.jobs,
    incremental: {
      after: generatedAt,
      changes_url: `/api/v1/changes?after=${encodeURIComponent(generatedAt)}`,
      instruction:
        "Use the canonical change feed for OH SHI jobs. Edtech pack rows are compact and omit posting bodies by default.",
    },
  };
}
