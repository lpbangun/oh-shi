CREATE TABLE `fragile_job_misses` (
  `job_id` text NOT NULL,
  `source_id` text NOT NULL,
  `first_miss_at` text NOT NULL,
  `last_miss_at` text NOT NULL,
  `clean_miss_count` integer NOT NULL,
  `last_run_id` text NOT NULL,
  PRIMARY KEY(`job_id`, `source_id`),
  CONSTRAINT "fragile_job_misses_count_check" CHECK("fragile_job_misses"."clean_miss_count" >= 1)
);
--> statement-breakpoint
CREATE INDEX `fragile_job_misses_source_idx`
  ON `fragile_job_misses` (`source_id`,`first_miss_at`);
