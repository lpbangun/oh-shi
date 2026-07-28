-- Forward-only migration: no table or existing column is dropped.
ALTER TABLE jobs ADD COLUMN provider TEXT NOT NULL DEFAULT 'ashby';
ALTER TABLE jobs ADD COLUMN source_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE jobs ADD COLUMN published_at TEXT;

CREATE INDEX IF NOT EXISTS jobs_source_status_idx
  ON jobs(provider, source_id, status);

CREATE TABLE IF NOT EXISTS investor_sources (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  portfolio_url TEXT NOT NULL, jobs_url TEXT, access_mode TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, mandatory INTEGER NOT NULL DEFAULT 0,
  review_notes TEXT NOT NULL DEFAULT '', last_attempted_at TEXT,
  last_successful_at TEXT, last_error TEXT,
  discovery_cursor INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS company_sources (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, provider TEXT NOT NULL,
  board_id TEXT NOT NULL, careers_url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  discovery_status TEXT NOT NULL DEFAULT 'active', first_discovered_at TEXT NOT NULL,
  last_attempted_at TEXT, last_successful_at TEXT, last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0, review_notes TEXT NOT NULL DEFAULT '',
  UNIQUE(provider, board_id)
);
CREATE INDEX IF NOT EXISTS company_sources_company_idx ON company_sources(company_id, enabled);

CREATE TABLE IF NOT EXISTS company_investors (
  company_id TEXT NOT NULL, investor_source_id TEXT NOT NULL,
  first_discovered_at TEXT NOT NULL, evidence_url TEXT NOT NULL,
  PRIMARY KEY(company_id, investor_source_id)
);

CREATE TABLE IF NOT EXISTS discovery_queue (
  id TEXT PRIMARY KEY, normalized_domain TEXT NOT NULL UNIQUE,
  company_name TEXT NOT NULL, website_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'discovered','resolving','canonical_source_found','active',
    'needs_review','unsupported','rejected'
  )),
  first_discovered_at TEXT NOT NULL, last_attempted_at TEXT,
  last_error TEXT, review_notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS discovery_queue_investors (
  candidate_id TEXT NOT NULL, investor_source_id TEXT NOT NULL,
  evidence_url TEXT NOT NULL, first_discovered_at TEXT NOT NULL,
  PRIMARY KEY(candidate_id, investor_source_id)
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT,
  status TEXT NOT NULL, metrics_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS ingestion_source_results (
  run_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
  status TEXT NOT NULL, attempted_at TEXT NOT NULL, completed_at TEXT,
  discovered_count INTEGER NOT NULL DEFAULT 0, verified_count INTEGER NOT NULL DEFAULT 0,
  opened_count INTEGER NOT NULL DEFAULT 0, closed_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT, error_message TEXT,
  PRIMARY KEY(run_id, source_kind, source_id)
);

-- jobs_provider_identity_idx is created by the idempotent runtime initializer
-- after company_sources are bootstrapped and legacy rows are source-backfilled.
