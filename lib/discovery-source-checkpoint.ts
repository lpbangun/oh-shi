export type PortfolioCandidate = { name: string; websiteUrl: string; evidenceUrl: string };
export type PortfolioItemFailure = { url: string; error: string };

/** The page cursor advances only after every detail and candidate upsert succeeds. */
export async function checkpointPortfolioCandidates(
  candidates: PortfolioCandidate[],
  currentCursor: number,
  nextCursor: number,
  detailFailures: PortfolioItemFailure[],
  enqueue: (candidate: PortfolioCandidate) => Promise<{ created: boolean }>
) {
  const failures = [...detailFailures];
  let discovered = 0;
  let processed = 0;
  for (const candidate of candidates) {
    try {
      if ((await enqueue(candidate)).created) discovered += 1;
      processed += 1;
    } catch (error) {
      failures.push({ url: candidate.evidenceUrl,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
    }
  }
  return failures.length
    ? { discovered, processed, nextCursor: currentCursor, status: "failed" as const,
      error: failures.map((item) => `${item.url}: ${item.error}`).join("; ").slice(0, 500) }
    : { discovered, processed, nextCursor, status: "completed" as const, error: null };
}
