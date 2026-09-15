import { env } from "cloudflare:workers";
import { ensureDatabase } from "./data";
import type { ChangeEvent } from "./types";

type Checkpoint = { occurredAt: string; id: string };

export class ChangeFeedError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "invalid_request") {
    super(message);
    this.name = "ChangeFeedError";
    this.status = status;
    this.code = code;
  }
}

export function encodeChangeCursor(checkpoint: Checkpoint) {
  return `v1.${btoa(JSON.stringify({ t: checkpoint.occurredAt, i: checkpoint.id }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export function decodeChangeCursor(value: string): Checkpoint {
  try {
    const encoded = value.replace(/^v1\./, "").replaceAll("-", "+").replaceAll("_", "/");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded)) as { t?: unknown; i?: unknown };
    if (typeof parsed.t !== "string" || typeof parsed.i !== "string" ||
        !Number.isFinite(Date.parse(parsed.t))) throw new Error("invalid checkpoint");
    return { occurredAt: new Date(Date.parse(parsed.t)).toISOString(), id: parsed.i };
  } catch {
    throw new ChangeFeedError("Invalid change cursor.");
  }
}

function parseLimit(params: URLSearchParams) {
  const raw = params.get("limit");
  if (raw === null) return 100;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) {
    throw new ChangeFeedError("limit must be between 1 and 100.");
  }
  return Number(raw);
}

export async function readChangeFeed(params: URLSearchParams) {
  for (const name of params.keys()) {
    if (!["cursor", "after", "limit"].includes(name)) {
      throw new ChangeFeedError(`Unknown change feed parameter "${name}".`);
    }
    if (params.getAll(name).length > 1) {
      throw new ChangeFeedError(`Parameter "${name}" may appear only once.`);
    }
  }
  if (params.has("cursor") && params.has("after")) {
    throw new ChangeFeedError("Use cursor or after, not both.");
  }
  const limit = parseLimit(params);
  const cursorValue = params.get("cursor");
  const after = params.get("after");
  let checkpoint: Checkpoint | null = cursorValue ? decodeChangeCursor(cursorValue) : null;
  if (after) {
    if (!Number.isFinite(Date.parse(after))) throw new ChangeFeedError("after must be an ISO-8601 timestamp.");
    checkpoint = { occurredAt: new Date(Date.parse(after)).toISOString(), id: "" };
  }
  await ensureDatabase();
  const oldest = await env.DB.prepare("SELECT MIN(occurred_at) AS value FROM changes")
    .first<{ value: string | null }>();
  if (cursorValue && checkpoint && oldest?.value && checkpoint.occurredAt < oldest.value) {
    throw new ChangeFeedError(
      "This checkpoint predates the retained change history. Run a fresh jobs query and restart from its generated_at.",
      410,
      "checkpoint_expired"
    );
  }
  const columns = `id, entity_type as entityType, entity_id as entityId,
    change_type as changeType, title, description, occurred_at as occurredAt,
    source_url as sourceUrl`;
  const statement = checkpoint
    ? env.DB.prepare(`SELECT ${columns} FROM changes
        WHERE occurred_at > ? OR (occurred_at = ? AND id > ?)
        ORDER BY occurred_at ASC, id ASC LIMIT ?`)
      .bind(checkpoint.occurredAt, checkpoint.occurredAt, checkpoint.id, limit + 1)
    : env.DB.prepare(`SELECT ${columns} FROM changes
        ORDER BY occurred_at ASC, id ASC LIMIT ?`).bind(limit + 1);
  const result = await statement.all<ChangeEvent>();
  const hasMore = result.results.length > limit;
  const data = result.results.slice(0, limit);
  const last = data.at(-1);
  const highWater = last
    ? { occurredAt: last.occurredAt, id: last.id }
    : checkpoint || { occurredAt: new Date().toISOString(), id: "" };
  return {
    data,
    page: {
      limit,
      returned: data.length,
      has_more: hasMore,
      next_cursor: encodeChangeCursor(highWater),
    },
  };
}
