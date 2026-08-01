-- Forward-only canonical startup-domain registry.
-- Candidate rows never create companies or verified openings by themselves.
ALTER TABLE investor_sources ADD COLUMN terms_url TEXT;

CREATE TABLE IF NOT EXISTS startup_domains (
  canonical_domain TEXT PRIMARY KEY,
  company_id TEXT UNIQUE,
  company_name TEXT NOT NULL,
  website_url TEXT NOT NULL,
  activity_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK(activity_state IN ('unknown','active','inactive')),
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(review_status IN ('pending','verified','rejected')),
  pilot_cohort TEXT,
  careers_url TEXT,
  ats_provider TEXT,
  ats_board_id TEXT,
  career_fingerprint TEXT,
  last_discovery_attempt_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS startup_domains_pilot_idx
  ON startup_domains(pilot_cohort, review_status);

CREATE TABLE IF NOT EXISTS startup_domain_aliases (
  alias_domain TEXT PRIMARY KEY,
  canonical_domain TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'alias' CHECK(relation = 'alias'),
  evidence_url TEXT NOT NULL,
  permission_status TEXT NOT NULL,
  source_terms_url TEXT,
  observed_at TEXT NOT NULL,
  CHECK(alias_domain <> canonical_domain)
);

CREATE INDEX IF NOT EXISTS startup_domain_aliases_canonical_idx
  ON startup_domain_aliases(canonical_domain);

CREATE TABLE IF NOT EXISTS startup_domain_acquisitions (
  canonical_domain TEXT NOT NULL,
  related_domain TEXT NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('acquired_from','acquired_by')),
  evidence_url TEXT NOT NULL,
  permission_status TEXT NOT NULL,
  source_terms_url TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(canonical_domain, related_domain, relation, evidence_url),
  CHECK(canonical_domain <> related_domain)
);

CREATE INDEX IF NOT EXISTS startup_domain_acquisitions_related_idx
  ON startup_domain_acquisitions(related_domain);

CREATE TABLE IF NOT EXISTS startup_domain_evidence (
  canonical_domain TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_classification TEXT NOT NULL,
  evidence_url TEXT NOT NULL,
  permission_status TEXT NOT NULL,
  source_terms_url TEXT,
  observed_at TEXT NOT NULL,
  observed_website_urls_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(canonical_domain, source_kind, source_id, evidence_url)
);

CREATE INDEX IF NOT EXISTS startup_domain_evidence_source_idx
  ON startup_domain_evidence(source_kind, source_id);

CREATE TABLE IF NOT EXISTS startup_domain_imports (
  cohort TEXT PRIMARY KEY,
  expected_domains INTEGER NOT NULL,
  persisted_domains INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS startup_domain_cohorts (
  canonical_domain TEXT NOT NULL,
  cohort TEXT NOT NULL,
  included_at TEXT NOT NULL,
  PRIMARY KEY(canonical_domain, cohort)
);

CREATE INDEX IF NOT EXISTS startup_domain_cohorts_cohort_idx
  ON startup_domain_cohorts(cohort);
