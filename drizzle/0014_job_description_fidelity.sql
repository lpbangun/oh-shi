-- Preserve normalized canonical posting bodies for agent consumers.
ALTER TABLE jobs ADD COLUMN description TEXT;
ALTER TABLE job_observations ADD COLUMN description TEXT;
