CREATE TABLE IF NOT EXISTS discovery_review_batches (
  id TEXT PRIMARY KEY,
  requested_count INTEGER NOT NULL,
  assigned_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  ready_count INTEGER NOT NULL DEFAULT 0,
  needs_review_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued','processing','ready','completed','failed'
  )),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS discovery_candidate_reviews (
  batch_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued','processing','ready','needs_review','failed','approved','rejected','activated'
  )),
  company_name TEXT NOT NULL,
  normalized_domain TEXT NOT NULL,
  website_url TEXT NOT NULL,
  provider TEXT,
  board_id TEXT,
  careers_url TEXT,
  job_count INTEGER NOT NULL DEFAULT 0,
  jobs_json TEXT NOT NULL DEFAULT '[]',
  fingerprint TEXT,
  observed_at TEXT,
  last_attempted_at TEXT,
  last_error TEXT,
  reviewed_at TEXT,
  review_reason TEXT,
  PRIMARY KEY(batch_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS discovery_candidate_reviews_batch_status_idx
  ON discovery_candidate_reviews(batch_id, status);
CREATE INDEX IF NOT EXISTS discovery_candidate_reviews_candidate_status_idx
  ON discovery_candidate_reviews(candidate_id, status);
PRAGMA optimize;
