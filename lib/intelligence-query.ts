export const INTELLIGENCE_VIEWS = ["jobs", "companies", "movements", "sectors"] as const;

export type IntelligenceView = (typeof INTELLIGENCE_VIEWS)[number];

const COMMON = new Set(["view", "q", "limit", "cursor"]);
const VIEW_PARAMETERS: Record<IntelligenceView, Set<string>> = {
  jobs: new Set([
    ...COMMON,
    "status",
    "company",
    "sector",
    "role_family",
    "location",
    "remote_status",
  ]),
  companies: new Set([...COMMON, "sector", "min_signal", "min_confidence"]),
  movements: new Set([
    ...COMMON,
    "after",
    "before",
    "type",
    "company",
    "sector",
    "group",
  ]),
  sectors: new Set([...COMMON]),
};

const DEFAULT_LIMIT: Record<IntelligenceView, number> = {
  jobs: 25,
  companies: 10,
  movements: 25,
  sectors: 25,
};

export class IntelligenceQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntelligenceQueryError";
  }
}

function oneValue(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  if (values.length > 1) throw new IntelligenceQueryError(`Parameter "${name}" may appear only once.`);
  return values[0] ?? null;
}

export function parseView(params: URLSearchParams): IntelligenceView | null {
  const raw = oneValue(params, "view");
  if (raw === null) return null;
  if (!(INTELLIGENCE_VIEWS as readonly string[]).includes(raw)) {
    throw new IntelligenceQueryError(
      `Invalid view "${raw}". Expected one of: ${INTELLIGENCE_VIEWS.join(", ")}.`
    );
  }
  return raw as IntelligenceView;
}

export function validateParameters(params: URLSearchParams, view: IntelligenceView | null) {
  const allowed = view ? VIEW_PARAMETERS[view] : new Set(["view"]);
  for (const name of params.keys()) {
    if (!allowed.has(name)) {
      throw new IntelligenceQueryError(
        view
          ? `Unknown parameter "${name}" for view "${view}".`
          : `Select a view before using parameter "${name}".`
      );
    }
  }
}

export function parseLimit(params: URLSearchParams, view: IntelligenceView) {
  const raw = oneValue(params, "limit");
  if (raw === null) return DEFAULT_LIMIT[view];
  if (!/^\d+$/.test(raw)) throw new IntelligenceQueryError("limit must be a positive integer.");
  const parsed = Number(raw);
  if (parsed < 1 || parsed > 100) {
    throw new IntelligenceQueryError("limit must be between 1 and 100.");
  }
  return parsed;
}

export function encodeCursor(view: IntelligenceView, offset: number) {
  return `v1.${view}.${offset}`;
}

export function parseCursor(params: URLSearchParams, view: IntelligenceView) {
  const raw = oneValue(params, "cursor");
  if (raw === null) return 0;
  const match = /^v1\.(jobs|companies|movements|sectors)\.(\d+)$/.exec(raw);
  if (!match || match[1] !== view) {
    throw new IntelligenceQueryError(`Invalid cursor for view "${view}".`);
  }
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new IntelligenceQueryError(`Invalid cursor for view "${view}".`);
  }
  return offset;
}

export function pageData<T>(
  rows: T[],
  view: IntelligenceView,
  offset: number,
  limit: number
) {
  if (offset > rows.length) throw new IntelligenceQueryError("Cursor is beyond the available results.");
  const data = rows.slice(offset, offset + limit);
  const nextOffset = offset + data.length;
  return {
    data,
    page: {
      limit,
      returned: data.length,
      next_cursor: nextOffset < rows.length ? encodeCursor(view, nextOffset) : null,
      total: rows.length,
    },
  };
}

export function parseNumberFilter(params: URLSearchParams, name: string) {
  const raw = oneValue(params, name);
  if (raw === null) return null;
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new IntelligenceQueryError(`${name} must be a number from 0 to 100.`);
  }
  const parsed = Number(raw);
  if (parsed < 0 || parsed > 100) {
    throw new IntelligenceQueryError(`${name} must be a number from 0 to 100.`);
  }
  return parsed;
}

export function parseIsoFilter(params: URLSearchParams, name: string) {
  const raw = oneValue(params, name);
  if (raw === null) return null;
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    throw new IntelligenceQueryError(`${name} must be an ISO-8601 timestamp.`);
  }
  return new Date(time).toISOString();
}

export function stringFilter(params: URLSearchParams, name: string) {
  const raw = oneValue(params, name);
  return raw?.trim() || null;
}

export function enumFilter<const T extends readonly string[]>(
  params: URLSearchParams,
  name: string,
  values: T
): T[number] | null {
  const raw = stringFilter(params, name);
  if (raw === null) return null;
  if (!(values as readonly string[]).includes(raw)) {
    throw new IntelligenceQueryError(
      `Invalid ${name} "${raw}". Expected one of: ${values.join(", ")}.`
    );
  }
  return raw as T[number];
}
