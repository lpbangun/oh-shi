import { COMPANY_SOURCE_SEEDS } from "./source-registry";

/** Compatibility export for score receipts and older consumers. Runtime refresh
 * reads company_sources from D1; this is bootstrap data, not the live registry. */
export const TRACKED_BOARDS = COMPANY_SOURCE_SEEDS.map((source) => ({
  companyId: source.companyId,
  slug: source.companyId.replace(/^company_/, ""),
  board: source.boardId,
}));

export function isBoardTracked(companyId: string) {
  return TRACKED_BOARDS.some((source) => source.companyId === companyId);
}
