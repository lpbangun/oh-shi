import { CanonicalHttpError, fetchCanonicalBoard } from "./ats-adapters";
import type { AtsProvider } from "./source-registry";

export type CanonicalFetchSource = {
  provider: AtsProvider;
  boardId: string;
};

const transient = (error: unknown) =>
  error instanceof TypeError ||
  (error instanceof CanonicalHttpError &&
    (error.status === 429 || error.status >= 500)) ||
  (error instanceof Error && /timeout|abort|429|5\d\d/i.test(error.message));

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function retryCanonicalFetch(
  source: CanonicalFetchSource,
  fetcher: typeof fetch = fetch,
  attempts = 3,
  sleep: (milliseconds: number) => Promise<unknown> = delay
) {
  // SmartRecruiters pagination fetches many independent resources. Its adapter
  // retries only the failed request so a late throttle cannot replay the board.
  if (source.provider === "smartrecruiters") {
    return fetchCanonicalBoard(source.provider, source.boardId, fetcher);
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchCanonicalBoard(source.provider, source.boardId, fetcher);
    } catch (error) {
      lastError = error;
      if (!transient(error) || attempt === attempts) break;
      const retryAfter = error instanceof CanonicalHttpError
        ? error.retryAfterMs
        : null;
      await sleep(Math.min(10_000, retryAfter ?? 250 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
