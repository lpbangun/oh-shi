-- Forward-only canonical snapshot audit and mass-deletion quarantine.
CREATE TABLE IF NOT EXISTS canonical_source_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('accepted','quarantined')),
  existing_open_count INTEGER NOT NULL,
  observed_open_count INTEGER NOT NULL,
  missing_count INTEGER NOT NULL,
  missing_ratio_bps INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  quarantine_reason TEXT,
  UNIQUE(run_id, source_id)
);

CREATE INDEX IF NOT EXISTS canonical_source_snapshots_source_idx
  ON canonical_source_snapshots(source_id, captured_at);
