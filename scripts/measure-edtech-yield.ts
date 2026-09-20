/**
 * Measure live edtech pack board yield for benchmark writeup.
 *
 * Options:
 *   --limit=N          max prioritized boards (default 27: coursera/duolingo + well-known)
 *   --all              measure every pack row (bounded concurrency, not for CI)
 *   --concurrency=N    parallel fetches (default 6, max 6)
 *   --timeout-ms=N     per-board fetch timeout (default 15000)
 *   --receipts=PATH    receipts JSON output (default evals/fixtures/edtech-benchmark/receipts.json)
 *   --benchmark=PATH   markdown output (default artifacts/edtech-benchmark.md)
 *   --previous=PATH    prior receipts for snapshot diff (defaults to receipts path if it exists)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CanonicalHttpError, fetchCanonicalBoard } from "../lib/ats-adapters";
import {
  assertValidEdtechPack,
  loadEdtechPack,
  type EdtechPackRow,
} from "../lib/edtech-pack";
import {
  DEFAULT_EDTECH_INGEST_CONCURRENCY,
  mapBounded,
  resolveEdtechFetch,
} from "../lib/edtech-ingest";

export const EDTECH_COM_BENCHMARK = {
  companies: 756,
  openJobs: 2003,
  checkedDate: "2026-09-19",
  notScraped: true as const,
};

/** Well-known education boards used for bounded live measurement (matches pack tests). */
export const PRIORITY_BOARD_IDS = [
  "coursera",
  "duolingo",
  "khanacademy",
  "instructure",
  "quizlet-2",
  "classdojo",
  "udemy",
  "masterclass",
  "newsela",
  "outschool",
  "amplify",
  "degreed",
  "datacamp",
  "brilliant",
  "aofl",
  "handshake",
  "babbel",
  "clever",
  "seesaw",
  "edpuzzle",
  "skillsoft",
  "gostudent",
  "givecampus",
  "teachablecareers",
  "learnupon",
  "magicschool",
  "brisk-teaching",
] as const;

export type RoleFamilyBucket = "GTM" | "Operations" | "Engineering" | "Product" | "Other";

export type EdtechBoardReceipt = {
  schemaVersion: "1.0";
  name: string;
  provider: EdtechPackRow["provider"];
  board_id: string;
  website: string;
  pack_identity: true;
  fetch_status: "success" | "quarantined" | "failed";
  live_complete: boolean;
  http_status?: number;
  quarantine_reason?: string;
  error?: string;
  observed_open_jobs: number;
  role_family_histogram: Record<RoleFamilyBucket, number>;
  sample_titles: string[];
  external_ids: string[];
  elapsed_ms: number;
};

export type EdtechSnapshotDiff = {
  prior_generated_at: string;
  boards_compared: number;
  jobs_opened: number;
  jobs_closed: number;
  per_board: Array<{
    board_id: string;
    name: string;
    opened: number;
    closed: number;
  }>;
};

export type EdtechBenchmarkArtifact = {
  schemaVersion: "1.0";
  generatedAt: string;
  packRows: number;
  boardsAttempted: number;
  boardsComplete: number;
  boardsQuarantined: number;
  boardsFailed: number;
  totalOpenJobs: number;
  selection: "bounded" | "all";
  limit?: number;
  receipts: EdtechBoardReceipt[];
  snapshot_diff?: EdtechSnapshotDiff;
  edtech_com_benchmark: typeof EDTECH_COM_BENCHMARK;
};

type MeasureOptions = {
  all: boolean;
  limit: number;
  concurrency: number;
  timeoutMs: number;
  receiptsPath: string;
  benchmarkPath: string;
  previousPath?: string;
};

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = argument(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function selectBenchmarkBoards(
  rows: EdtechPackRow[],
  options: { all?: boolean; limit?: number } = {}
): EdtechPackRow[] {
  if (options.all) return rows;
  const byBoardId = new Map(rows.map((row) => [row.board_id.toLowerCase(), row]));
  const selected: EdtechPackRow[] = [];
  const seen = new Set<string>();
  for (const boardId of PRIORITY_BOARD_IDS) {
    const row = byBoardId.get(boardId.toLowerCase());
    if (!row || seen.has(boardId.toLowerCase())) continue;
    selected.push(row);
    seen.add(boardId.toLowerCase());
  }
  const limit = options.limit ?? 27;
  return selected.slice(0, limit);
}

function emptyHistogram(): Record<RoleFamilyBucket, number> {
  return { GTM: 0, Operations: 0, Engineering: 0, Product: 0, Other: 0 };
}

function bucketRoleFamily(value: string): RoleFamilyBucket {
  if (value === "GTM" || value === "Operations" || value === "Engineering" || value === "Product") {
    return value;
  }
  return "Other";
}

function histogramFromJobs(
  jobs: Array<{ roleFamily: string }>
): Record<RoleFamilyBucket, number> {
  const histogram = emptyHistogram();
  for (const job of jobs) {
    histogram[bucketRoleFamily(job.roleFamily)] += 1;
  }
  return histogram;
}

function httpStatusFromError(error: unknown): number | undefined {
  if (error instanceof CanonicalHttpError) return error.status;
  const message = error instanceof Error ? error.message : String(error);
  const match = /\b(?:HTTP?\s*)?([45]\d{2})\b/.exec(message);
  return match ? Number(match[1]) : undefined;
}

async function measureBoard(
  row: EdtechPackRow,
  timeoutMs: number
): Promise<EdtechBoardReceipt> {
  const started = Date.now();
  const base = {
    schemaVersion: "1.0" as const,
    name: row.name,
    provider: row.provider,
    board_id: row.board_id,
    website: row.website,
    pack_identity: true as const,
  };
  try {
    const fetched = await fetchCanonicalBoard(row.provider, row.board_id, fetch, timeoutMs);
    const resolution = resolveEdtechFetch(fetched, null);
    if (!resolution.complete) {
      return {
        ...base,
        fetch_status: resolution.status,
        live_complete: false,
        http_status: httpStatusFromError(resolution.error),
        quarantine_reason: resolution.reason,
        error: resolution.error,
        observed_open_jobs: 0,
        role_family_histogram: emptyHistogram(),
        sample_titles: [],
        external_ids: [],
        elapsed_ms: Date.now() - started,
      };
    }
    const jobs = resolution.jobs;
    return {
      ...base,
      fetch_status: "success",
      live_complete: true,
      observed_open_jobs: jobs.length,
      role_family_histogram: histogramFromJobs(jobs),
      sample_titles: [...new Set(jobs.map((job) => job.title))].sort().slice(0, 12),
      external_ids: jobs.map((job) => job.externalId).sort(),
      elapsed_ms: Date.now() - started,
    };
  } catch (error) {
    const resolution = resolveEdtechFetch(null, error);
    return {
      ...base,
      fetch_status: resolution.complete ? "success" : resolution.status,
      live_complete: false,
      http_status: httpStatusFromError(error),
      quarantine_reason: resolution.complete ? undefined : resolution.reason,
      error: resolution.complete ? undefined : resolution.error,
      observed_open_jobs: 0,
      role_family_histogram: emptyHistogram(),
      sample_titles: [],
      external_ids: [],
      elapsed_ms: Date.now() - started,
    };
  }
}

export function computeSnapshotDiff(
  previous: EdtechBenchmarkArtifact,
  current: EdtechBoardReceipt[]
): EdtechSnapshotDiff {
  const priorByBoard = new Map(
    previous.receipts
      .filter((receipt) => receipt.live_complete)
      .map((receipt) => [receipt.board_id.toLowerCase(), receipt])
  );
  const perBoard: EdtechSnapshotDiff["per_board"] = [];
  let jobsOpened = 0;
  let jobsClosed = 0;
  let boardsCompared = 0;

  for (const receipt of current) {
    if (!receipt.live_complete) continue;
    const prior = priorByBoard.get(receipt.board_id.toLowerCase());
    if (!prior) continue;
    boardsCompared += 1;
    const priorIds = new Set(prior.external_ids);
    const currentIds = new Set(receipt.external_ids);
    const opened = receipt.external_ids.filter((id) => !priorIds.has(id)).length;
    const closed = prior.external_ids.filter((id) => !currentIds.has(id)).length;
    jobsOpened += opened;
    jobsClosed += closed;
    if (opened || closed) {
      perBoard.push({
        board_id: receipt.board_id,
        name: receipt.name,
        opened,
        closed,
      });
    }
  }

  return {
    prior_generated_at: previous.generatedAt,
    boards_compared: boardsCompared,
    jobs_opened: jobsOpened,
    jobs_closed: jobsClosed,
    per_board: perBoard.sort((left, right) =>
      left.board_id.localeCompare(right.board_id)
    ),
  };
}

export function aggregateBenchmark(
  packRows: number,
  receipts: EdtechBoardReceipt[],
  selection: "bounded" | "all",
  limit?: number,
  snapshotDiff?: EdtechSnapshotDiff
): EdtechBenchmarkArtifact {
  const complete = receipts.filter((receipt) => receipt.live_complete);
  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    packRows,
    boardsAttempted: receipts.length,
    boardsComplete: complete.length,
    boardsQuarantined: receipts.filter((receipt) => receipt.fetch_status === "quarantined").length,
    boardsFailed: receipts.filter((receipt) => receipt.fetch_status === "failed").length,
    totalOpenJobs: complete.reduce((sum, receipt) => sum + receipt.observed_open_jobs, 0),
    selection,
    limit,
    receipts,
    snapshot_diff: snapshotDiff,
    edtech_com_benchmark: EDTECH_COM_BENCHMARK,
  };
}

function aggregateRoleMix(receipts: EdtechBoardReceipt[]) {
  const totals = emptyHistogram();
  for (const receipt of receipts.filter((item) => item.live_complete)) {
    for (const bucket of Object.keys(totals) as RoleFamilyBucket[]) {
      totals[bucket] += receipt.role_family_histogram[bucket];
    }
  }
  return totals;
}

function formatPercent(numerator: number, denominator: number) {
  if (!denominator) return "0.0%";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

export function renderBenchmarkMarkdown(artifact: EdtechBenchmarkArtifact): string {
  const roleMix = aggregateRoleMix(artifact.receipts);
  const complete = artifact.receipts.filter((receipt) => receipt.live_complete);
  const incomplete = artifact.receipts.filter((receipt) => !receipt.live_complete);
  const companyRatio = formatPercent(complete.length, EDTECH_COM_BENCHMARK.companies);
  const jobRatio = formatPercent(artifact.totalOpenJobs, EDTECH_COM_BENCHMARK.openJobs);
  const sampleTitles = complete
    .flatMap((receipt) => receipt.sample_titles)
    .sort();
  const hasSales = sampleTitles.some((title) => /account executive|sales|gtm|business development/i.test(title));
  const hasCurriculum = sampleTitles.some((title) =>
    /curriculum|instructional|content designer|learning designer/i.test(title)
  );
  const hasOps = sampleTitles.some((title) =>
    /operations|customer success|implementation|support/i.test(title)
  );
  const hasCs = sampleTitles.some((title) =>
    /software engineer|engineering|platform|backend|frontend|sre|devops/i.test(title)
  );

  const boardTable = artifact.receipts
    .map((receipt) => {
      const status = receipt.live_complete
        ? "live complete"
        : receipt.fetch_status === "quarantined"
          ? `quarantined (${receipt.quarantine_reason || "unknown"})`
          : `failed (${receipt.error || receipt.quarantine_reason || "unknown"})`;
      return `| ${receipt.name} | ${receipt.provider} | ${receipt.board_id} | ${status} | ${receipt.observed_open_jobs} |`;
    })
    .join("\n");

  const gapLines = [
    `- Pack identities (${artifact.packRows}) exceed live-complete boards measured here (${complete.length}); many rows are LastRound-confirmed identities not re-verified in this bounded run.`,
    `- Incomplete boards in this run: ${incomplete.length} (${incomplete.map((row) => row.board_id).join(", ") || "none"}).`,
    `- Live counts come from \`fetchCanonicalBoard\`, which keeps US-eligible roles (explicit US location or remote-US/global remote). Non-US-only postings are dropped by the canonical adapter.`,
    `- Edtech.com directory employers on unsupported ATS vendors or without public JSON boards are not in this pack.`,
    `- Growth path: join the vendored LastRound 9,935-row ATS directory for additional education employers instead of scraping Edtech.com HTML.`,
  ];

  const snapshotSection = artifact.snapshot_diff
    ? [
      "## Open/close snapshot diff",
      "",
      `Compared against prior receipts from ${artifact.snapshot_diff.prior_generated_at}.`,
      "",
      `- Boards compared: ${artifact.snapshot_diff.boards_compared}`,
      `- Jobs opened: ${artifact.snapshot_diff.jobs_opened}`,
      `- Jobs closed: ${artifact.snapshot_diff.jobs_closed}`,
      "",
      artifact.snapshot_diff.per_board.length
        ? [
          "| Board | Opened | Closed |",
          "| --- | ---: | ---: |",
          ...artifact.snapshot_diff.per_board.map(
            (row) => `| ${row.name} (${row.board_id}) | ${row.opened} | ${row.closed} |`
          ),
        ].join("\n")
        : "_No per-board diffs in this comparison window._",
      "",
    ].join("\n")
    : "";

  return [
    "# Edtech live benchmark",
    "",
    `Generated: ${artifact.generatedAt}`,
    "",
    "## Edtech.com reference (not scraped)",
    "",
    `Edtech.com benchmark reminder: ~${EDTECH_COM_BENCHMARK.companies} companies / ~${EDTECH_COM_BENCHMARK.openJobs.toLocaleString()} open jobs (checked ${EDTECH_COM_BENCHMARK.checkedDate}). This measurement does **not** scrape Edtech.com; it fetches public ATS JSON boards from the reviewed pack only.`,
    "",
    "## Pack and measurement scope",
    "",
    `- Reviewed pack rows (company identities): **${artifact.packRows}**`,
    `- Boards attempted in this run (${artifact.selection}${artifact.limit ? `, limit=${artifact.limit}` : ""}): **${artifact.boardsAttempted}**`,
    `- Live complete boards: **${artifact.boardsComplete}**`,
    `- Quarantined boards: **${artifact.boardsQuarantined}**`,
    `- Failed boards: **${artifact.boardsFailed}**`,
    `- Open jobs observed on complete boards: **${artifact.totalOpenJobs}**`,
    "",
    "## Honest ratios vs Edtech.com",
    "",
    `- Complete live boards / ~${EDTECH_COM_BENCHMARK.companies} companies: **${complete.length} / ${EDTECH_COM_BENCHMARK.companies} (${companyRatio})**`,
    `- Observed open jobs / ~${EDTECH_COM_BENCHMARK.openJobs.toLocaleString()} jobs: **${artifact.totalOpenJobs} / ${EDTECH_COM_BENCHMARK.openJobs} (${jobRatio})**`,
    "",
    "Pack identity and live-complete board are tracked separately: a row may remain in the pack as a named public board identity while failing live fetch (404, empty non-complete payload, or quarantine).",
    "",
    "## Role mix (live complete boards)",
    "",
    "| Role family | Count |",
    "| --- | ---: |",
    `| GTM / sales | ${roleMix.GTM} |`,
    `| Operations | ${roleMix.Operations} |`,
    `| Engineering | ${roleMix.Engineering} |`,
    `| Product | ${roleMix.Product} |`,
    `| Other (curriculum, design, etc.) | ${roleMix.Other} |`,
    "",
    "Live title coverage in this run:",
    `- Sales / GTM titles present: ${hasSales ? "yes" : "no (not observed on complete boards in this run)"}`,
    `- Curriculum / instructional titles present: ${hasCurriculum ? "yes" : "no (not observed on complete boards in this run)"}`,
    `- Operations / customer-success titles present: ${hasOps ? "yes" : "no (not observed on complete boards in this run)"}`,
    `- Engineering titles present: ${hasCs ? "yes" : "no (not observed on complete boards in this run)"}`,
    "",
    "## Per-board receipts",
    "",
    "| Company | Provider | board_id | Status | Open jobs |",
    "| --- | --- | --- | --- | ---: |",
    boardTable,
    "",
    snapshotSection,
    "## Gaps and growth path",
    "",
    ...gapLines,
    "",
    "Receipts JSON for offline tests: `evals/fixtures/edtech-benchmark/receipts.json`.",
    "",
  ].join("\n");
}

async function loadPreviousArtifact(filePath: string): Promise<EdtechBenchmarkArtifact | null> {
  try {
    const payload = JSON.parse(await readFile(filePath, "utf8")) as EdtechBenchmarkArtifact;
    if (payload.schemaVersion !== "1.0" || !Array.isArray(payload.receipts)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function measureEdtechYield(options: MeasureOptions) {
  const pack = await loadEdtechPack();
  assertValidEdtechPack(pack);
  const rows = selectBenchmarkBoards(pack.rows, {
    all: options.all,
    limit: options.all ? undefined : options.limit,
  });
  const receipts = await mapBounded(rows, options.concurrency, (row) =>
    measureBoard(row, options.timeoutMs)
  );
  const previousPath = options.previousPath ?? options.receiptsPath;
  const previous = await loadPreviousArtifact(previousPath);
  const snapshotDiff = previous ? computeSnapshotDiff(previous, receipts) : undefined;
  const artifact = aggregateBenchmark(
    pack.rows.length,
    receipts,
    options.all ? "all" : "bounded",
    options.all ? undefined : options.limit,
    snapshotDiff
  );

  await mkdir(path.dirname(options.receiptsPath), { recursive: true });
  await mkdir(path.dirname(options.benchmarkPath), { recursive: true });
  await writeFile(options.receiptsPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await writeFile(options.benchmarkPath, `${renderBenchmarkMarkdown(artifact)}\n`, "utf8");

  return artifact;
}

async function main() {
  const all = process.argv.includes("--all");
  const limit = boundedInteger("limit", 27, 1, 500);
  const concurrency = boundedInteger(
    "concurrency",
    DEFAULT_EDTECH_INGEST_CONCURRENCY,
    1,
    DEFAULT_EDTECH_INGEST_CONCURRENCY
  );
  const timeoutMs = boundedInteger("timeout-ms", 15_000, 3_000, 60_000);
  const receiptsPath = path.resolve(
    argument("receipts") || "evals/fixtures/edtech-benchmark/receipts.json"
  );
  const benchmarkPath = path.resolve(
    argument("benchmark") || "artifacts/edtech-benchmark.md"
  );
  const previousArg = argument("previous");

  const artifact = await measureEdtechYield({
    all,
    limit,
    concurrency,
    timeoutMs,
    receiptsPath,
    benchmarkPath,
    previousPath: previousArg ? path.resolve(previousArg) : undefined,
  });

  console.log(JSON.stringify({
    packRows: artifact.packRows,
    boardsAttempted: artifact.boardsAttempted,
    boardsComplete: artifact.boardsComplete,
    boardsQuarantined: artifact.boardsQuarantined,
    boardsFailed: artifact.boardsFailed,
    totalOpenJobs: artifact.totalOpenJobs,
    snapshotDiff: artifact.snapshot_diff,
    receipts: artifact.receipts.map((receipt) => ({
      board_id: receipt.board_id,
      status: receipt.fetch_status,
      live_complete: receipt.live_complete,
      jobs: receipt.observed_open_jobs,
    })),
    benchmark: benchmarkPath,
  }, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
