-- Off-board leads are deliberately isolated from canonical verified openings.
CREATE TABLE hiring_signals (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  company_name TEXT NOT NULL,
  company_domain TEXT NOT NULL,
  role_function TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN (
    'company_blog','rss','github','hacker_news','authorized_api','submission'
  )),
  source_url TEXT NOT NULL,
  evidence_url TEXT NOT NULL,
  source_rights_url TEXT NOT NULL,
  application_url TEXT,
  permission_status TEXT NOT NULL CHECK(permission_status IN (
    'permitted','authorized','manual_reviewed'
  )),
  confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (
    'active','expired','unverifiable','promoted'
  )),
  observed_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at > observed_at),
  promoted_job_id TEXT,
  CHECK(
    (status='promoted' AND promoted_job_id IS NOT NULL) OR
    (status<>'promoted' AND promoted_job_id IS NULL)
  )
);

CREATE INDEX hiring_signals_active_idx ON hiring_signals(status, expires_at);
CREATE INDEX hiring_signals_company_idx ON hiring_signals(company_domain, status);
