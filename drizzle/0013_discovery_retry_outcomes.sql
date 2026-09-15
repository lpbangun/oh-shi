-- Persist measurable discovery outcomes and prevent transient failures from hot-looping.
ALTER TABLE discovery_queue ADD COLUMN last_outcome TEXT;
ALTER TABLE discovery_queue ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discovery_queue ADD COLUMN next_attempt_at TEXT;
CREATE INDEX IF NOT EXISTS discovery_queue_retry_idx
  ON discovery_queue(status, next_attempt_at, first_discovered_at);
