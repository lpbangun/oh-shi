-- Re-check terminal automatic discovery misses when detector behavior changes.
ALTER TABLE discovery_queue ADD COLUMN discovery_version TEXT;
