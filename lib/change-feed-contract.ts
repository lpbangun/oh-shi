export type ChangeCheckpoint = { occurredAt: string; id: string };

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

export function encodeChangeCursor(checkpoint: ChangeCheckpoint) {
  return `v1.${btoa(JSON.stringify({ t: checkpoint.occurredAt, i: checkpoint.id }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export function decodeChangeCursor(value: string): ChangeCheckpoint {
  try {
    if (!value.startsWith("v1.")) throw new Error("invalid cursor version");
    const encoded = value.slice(3).replaceAll("-", "+").replaceAll("_", "/");
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

export function parseChangeFeedParams(params: URLSearchParams) {
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
  if (params.has("cursor") && !cursorValue) {
    throw new ChangeFeedError("cursor must not be empty.");
  }
  if (params.has("after") && !after) {
    throw new ChangeFeedError("after must not be empty.");
  }
  let checkpoint: ChangeCheckpoint | null = cursorValue ? decodeChangeCursor(cursorValue) : null;
  if (after) {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(after) || !Number.isFinite(Date.parse(after))) {
      throw new ChangeFeedError("after must be an ISO-8601 timestamp with a time component.");
    }
    checkpoint = { occurredAt: new Date(Date.parse(after)).toISOString(), id: "" };
  }
  return { limit, cursorValue, checkpoint };
}
