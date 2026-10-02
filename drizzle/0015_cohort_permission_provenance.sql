-- Forward-only audit trail for explicitly reviewed curated-cohort permission.
-- Existing evidence remains unchanged and has NULL provenance.
ALTER TABLE startup_domain_evidence ADD COLUMN permission_provenance_json TEXT;
