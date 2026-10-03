ALTER TABLE `gate_runs` ADD `attempt` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `gate_runs` ADD `retry_of` text REFERENCES `gate_runs`(`id`);
--> statement-breakpoint
ALTER TABLE `gate_runs` ADD `lease_bytes` integer;
--> statement-breakpoint
CREATE INDEX `gate_runs_retry_of_idx` ON `gate_runs` (`retry_of`);
