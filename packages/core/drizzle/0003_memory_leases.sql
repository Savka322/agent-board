CREATE TABLE `memory_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL CHECK (`kind` IN ('gate', 'executor')),
	`ref` text NOT NULL,
	`bytes` integer NOT NULL CHECK (`bytes` > 0),
	`pid` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memory_leases_pid_idx` ON `memory_leases` (`pid`);
--> statement-breakpoint
ALTER TABLE `gate_runs` ADD `exit_code` integer;
