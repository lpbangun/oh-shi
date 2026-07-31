-- Stable refresh run keys prevent a retry from applying the same mutation twice.
CREATE TABLE IF NOT EXISTS refresh_runs (
  run_key TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  response_json TEXT
);
