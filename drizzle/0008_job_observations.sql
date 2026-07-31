-- Preserve every source observation while jobs remains the canonical opening table.
CREATE TABLE IF NOT EXISTS job_observations (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  normalized_canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  employment_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  published_at TEXT,
  status TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  closed_at TEXT,
  raw_url TEXT NOT NULL,
  evidence_url TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  snapshot_run_id TEXT NOT NULL,
  match_method TEXT NOT NULL CHECK(match_method IN (
    'new','stable_id','canonical_url','high_confidence','backfill'
  )),
  match_score_bps INTEGER NOT NULL CHECK(match_score_bps BETWEEN 0 AND 10000),
  UNIQUE(provider, source_id, external_id)
);

CREATE INDEX IF NOT EXISTS job_observations_job_status_idx
  ON job_observations(job_id, status);
CREATE INDEX IF NOT EXISTS job_observations_company_url_idx
  ON job_observations(company_id, normalized_canonical_url);
CREATE INDEX IF NOT EXISTS job_observations_source_status_idx
  ON job_observations(provider, source_id, status);

INSERT OR IGNORE INTO job_observations (
  id, job_id, company_id, provider, source_id, external_id, canonical_url,
  normalized_canonical_url, title, location, employment_type, summary,
  published_at, status, first_seen_at, last_seen_at, last_verified_at,
  closed_at, raw_url, evidence_url, parser_version, snapshot_run_id,
  match_method, match_score_bps
)
SELECT
  'observation_' || id, id, company_id, provider, source_id, external_id,
  canonical_url, canonical_url, title, location, employment_type, summary,
  published_at, status, first_seen_at, last_seen_at, last_verified_at,
  closed_at, raw_url, evidence_url, parser_version, snapshot_run_id,
  'backfill', 10000
FROM jobs;
