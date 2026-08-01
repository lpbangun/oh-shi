-- Forward-only job provenance required for source-level verification audits.
ALTER TABLE jobs ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN source_updated_at TEXT;
ALTER TABLE jobs ADD COLUMN raw_url TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN discovery_channel TEXT NOT NULL DEFAULT 'public_ats';
ALTER TABLE jobs ADD COLUMN evidence_url TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN parser_version TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE jobs ADD COLUMN snapshot_run_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE jobs ADD COLUMN linkedin_evidence_url TEXT;
ALTER TABLE jobs ADD COLUMN linkedin_checked_at TEXT;
ALTER TABLE jobs ADD COLUMN linkedin_presence_state TEXT NOT NULL DEFAULT 'unknown'
  CHECK(linkedin_presence_state IN ('confirmed','not_observed','unknown') AND
    (linkedin_presence_state='unknown' OR
      (linkedin_evidence_url IS NOT NULL AND linkedin_checked_at IS NOT NULL)));

UPDATE jobs SET
  last_seen_at = last_verified_at,
  raw_url = canonical_url,
  evidence_url = canonical_url
WHERE last_seen_at = '' OR raw_url = '' OR evidence_url = '';
