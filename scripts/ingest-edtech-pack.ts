/**
 * Ingest reviewed edtech pack boards via canonical ATS adapters.
 *
 * Options:
 *   --limit=N          ingest only the first N pack rows (dev)
 *   --boards=IDS       comma-separated board_id filter (e.g. coursera,duolingo)
 *   --dry-run          fetch and merge without writing outputs/
 *   --fresh            ignore prior edtech-ingest-*.json snapshots in the output dir
 *   --concurrency=N    parallel board fetches (default 6)
 *   --output=DIR       snapshot directory (default outputs/)
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CanonicalHttpError, fetchCanonicalBoard } from "../lib/ats-adapters";
import { assertValidEdtechPack, loadEdtechPack, type EdtechPackRow } from "../lib/edtech-pack";
import {
  DEFAULT_EDTECH_INGEST_CONCURRENCY,
  ingestEdtechBoardSnapshot,
  loadPreviousEdtechSnapshot,
  mapBounded,
  resolveEdtechFetch,
  type EdtechBoardSnapshotStore,
} from "../lib/edtech-ingest";

type CliOptions = {
  limit?: number;
  boards?: string[];
  dryRun: boolean;
  fresh: boolean;
  concurrency: number;
  outputDir: string;
};

type BoardReceipt = {
  board_id: string;
  provider: EdtechPackRow["provider"];
  name: string;
  status: "success" | "quarantined" | "failed";
  observed: number;
  opened: number;
  closed: number;
  updated: number;
  error?: string;
  quarantineReason?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    fresh: false,
    concurrency: DEFAULT_EDTECH_INGEST_CONCURRENCY,
    outputDir: path.join(process.cwd(), "outputs"),
  };
  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--fresh") {
      options.fresh = true;
      continue;
    }
    const limitMatch = /^--limit=(\d+)$/.exec(arg);
    if (limitMatch) {
      options.limit = Number(limitMatch[1]);
      continue;
    }
    const boardsMatch = /^--boards=(.+)$/.exec(arg);
    if (boardsMatch) {
      options.boards = boardsMatch[1]
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      continue;
    }
    const concurrencyMatch = /^--concurrency=(\d+)$/.exec(arg);
    if (concurrencyMatch) {
      options.concurrency = Number(concurrencyMatch[1]);
      continue;
    }
    const outputMatch = /^--output=(.+)$/.exec(arg);
    if (outputMatch) {
      options.outputDir = path.resolve(outputMatch[1]);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function fetchBoardRow(row: EdtechPackRow) {
  try {
    const complete = await fetchCanonicalBoard(row.provider, row.board_id);
    if (!complete.jobs) {
      return resolveEdtechFetch(null, new Error(`${row.provider} board ${row.board_id} returned an incomplete payload`));
    }
    return resolveEdtechFetch(complete, null);
  } catch (error) {
    if (error instanceof CanonicalHttpError) {
      return resolveEdtechFetch(null, error);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/incomplete payload/i.test(message)) {
      return resolveEdtechFetch(null, error);
    }
    return resolveEdtechFetch(null, error);
  }
}

export async function ingestEdtechPack(options: CliOptions) {
  const pack = await loadEdtechPack();
  assertValidEdtechPack(pack);
  let rows = pack.rows;
  if (options.boards?.length) {
    const boardIds = new Set(options.boards);
    rows = pack.rows.filter((row) => boardIds.has(row.board_id.toLowerCase()));
    if (!rows.length) {
      throw new Error(`No pack rows match --boards=${options.boards.join(",")}`);
    }
  } else if (options.limit) {
    rows = pack.rows.slice(0, options.limit);
  }
  const now = new Date().toISOString();
  const runId = `edtech-pack-${now}`;
  const previous = options.fresh
    ? { jobs: [] }
    : await loadPreviousEdtechSnapshot(options.outputDir);
  const resumedFrom = previous.jobs.length;
  let store: EdtechBoardSnapshotStore = previous;
  const receipts: BoardReceipt[] = [];

  const fetched = await mapBounded(rows, options.concurrency, async (row) => ({
    row,
    fetch: await fetchBoardRow(row),
  }));

  const results = [];
  for (const { row, fetch } of fetched) {
    const ingested = ingestEdtechBoardSnapshot({
      board: row,
      previous: store,
      fetch,
      now,
      runId,
    });
    store = { jobs: ingested.jobs };
    results.push({ row, ingested });
  }

  for (const { row, ingested } of results) {
    receipts.push({
      board_id: row.board_id,
      provider: row.provider,
      name: row.name,
      status: ingested.status,
      observed: ingested.observedCount,
      opened: ingested.opened,
      closed: ingested.closed,
      updated: ingested.updated,
      error: ingested.error,
      quarantineReason: ingested.quarantineReason,
    });
  }

  const artifact = {
    schemaVersion: "1.0",
    vertical: "edtech",
    generatedAt: now,
    runId,
    dryRun: options.dryRun,
    fresh: options.fresh,
    resumedFrom,
    boards: rows.length,
    jobs: store.jobs,
    receipts,
    summary: {
      success: receipts.filter((receipt) => receipt.status === "success").length,
      quarantined: receipts.filter((receipt) => receipt.status === "quarantined").length,
      failed: receipts.filter((receipt) => receipt.status === "failed").length,
      openJobs: store.jobs.filter((job) => job.status === "verified_open").length,
    },
  };

  if (!options.dryRun) {
    await mkdir(options.outputDir, { recursive: true });
    const outputPath = path.join(
      options.outputDir,
      `edtech-ingest-${now.replace(/[:.]/g, "-")}.json`
    );
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    console.log(`Wrote ${outputPath}`);
  }

  console.log(
    JSON.stringify(
      {
        ...artifact.summary,
        receipts: receipts.map((receipt) => ({
          board_id: receipt.board_id,
          status: receipt.status,
          observed: receipt.observed,
          opened: receipt.opened,
          closed: receipt.closed,
          updated: receipt.updated,
        })),
      },
      null,
      2
    )
  );
  return artifact;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  ingestEdtechPack(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
