-- A promotion records off-board discovery evidence for a separately verified
-- canonical job. Signals and canonical jobs remain separate source tables.
CREATE TABLE IF NOT EXISTS hiring_signal_promotions (
  signal_id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  evidence_url TEXT NOT NULL,
  source_rights_url TEXT NOT NULL,
  discovery_source_kind TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  run_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS hiring_signal_promotions_job_idx
  ON hiring_signal_promotions(job_id);
CREATE INDEX IF NOT EXISTS hiring_signal_promotions_company_idx
  ON hiring_signal_promotions(company_id, verified_at);
