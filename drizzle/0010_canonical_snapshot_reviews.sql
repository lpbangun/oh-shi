ALTER TABLE company_sources ADD COLUMN quarantine_snapshot_id TEXT;
ALTER TABLE company_sources ADD COLUMN quarantine_application_id TEXT;

ALTER TABLE canonical_source_snapshots ADD COLUMN board_id TEXT;

CREATE TABLE IF NOT EXISTS canonical_snapshot_members (
  snapshot_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('observed','missing','existing')),
  PRIMARY KEY(snapshot_id, external_id, kind)
);
CREATE INDEX IF NOT EXISTS canonical_snapshot_members_snapshot_idx
  ON canonical_snapshot_members(snapshot_id, kind);

CREATE TABLE IF NOT EXISTS canonical_snapshot_applications (
  idempotency_key TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  board_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'running','applied','rejected','failed','uncertain'
  )),
  reason TEXT NOT NULL,
  original_fingerprint TEXT NOT NULL,
  fresh_fingerprint TEXT,
  original_existing_count INTEGER NOT NULL,
  fresh_existing_count INTEGER,
  original_observed_count INTEGER NOT NULL,
  fresh_observed_count INTEGER,
  original_missing_count INTEGER NOT NULL,
  fresh_missing_count INTEGER,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  opened_count INTEGER NOT NULL DEFAULT 0,
  closed_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS canonical_snapshot_applications_source_idx
  ON canonical_snapshot_applications(source_id, requested_at);
