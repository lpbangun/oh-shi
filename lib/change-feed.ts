import { env } from "cloudflare:workers";
import { ensureDatabase } from "./data";
import type { ChangeEvent } from "./types";
import {
  ChangeFeedError,
  encodeChangeCursor,
  parseChangeFeedParams,
} from "./change-feed-contract";

export { ChangeFeedError, decodeChangeCursor, encodeChangeCursor, parseChangeFeedParams }
  from "./change-feed-contract";

export async function readChangeFeed(params: URLSearchParams) {
  const { limit, cursorValue, checkpoint } = parseChangeFeedParams(params);
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
