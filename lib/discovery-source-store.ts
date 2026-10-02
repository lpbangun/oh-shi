export type DiscoverySourcePageResult = {
  status: "completed" | "failed" | "manual" | "blocked";
  discovered: number;
  nextCursor: number;
  error?: string | null;
};

/** The cursor and source receipt commit together after page item writes succeed. */
export async function persistDiscoverySourcePage(
  database: D1Database,
  runId: string,
  sourceId: string,
  attemptedAt: string,
  result: DiscoverySourcePageResult
) {
  const sourceUpdate = result.status === "completed"
    ? database.prepare(`UPDATE investor_sources SET last_attempted_at=?,
        last_successful_at=?, last_error=NULL, discovery_cursor=? WHERE id=?`)
      .bind(attemptedAt, attemptedAt, result.nextCursor, sourceId)
    : result.status === "failed"
      ? database.prepare(`UPDATE investor_sources SET last_attempted_at=?,
          last_error=? WHERE id=?`).bind(attemptedAt, result.error || "source_page_incomplete", sourceId)
      : database.prepare(`UPDATE investor_sources SET last_attempted_at=?,
          last_error='awaiting_permission_or_manual_import' WHERE id=?`)
        .bind(attemptedAt, sourceId);
  await database.batch([
    sourceUpdate,
    database.prepare(`INSERT INTO ingestion_source_results (
      run_id, source_kind, source_id, status, attempted_at, completed_at,
      discovered_count, error_code, error_message
    ) VALUES (?, 'investor', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, source_kind, source_id) DO UPDATE SET
      status=excluded.status, completed_at=excluded.completed_at,
      discovered_count=excluded.discovered_count,
      error_code=excluded.error_code, error_message=excluded.error_message`)
      .bind(runId, sourceId, result.status, attemptedAt, attemptedAt,
        result.discovered, result.status === "failed" ? "partial_page_failure" : null,
        result.status === "failed" ? (result.error || "source_page_incomplete") : null),
  ]);
}
