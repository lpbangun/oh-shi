ALTER TABLE company_sources
ADD COLUMN refresh_cadence TEXT NOT NULL DEFAULT 'frequent'
CHECK (refresh_cadence IN ('frequent', 'daily'));

CREATE INDEX IF NOT EXISTS company_sources_refresh_cadence_idx
ON company_sources(enabled, refresh_cadence, id);
