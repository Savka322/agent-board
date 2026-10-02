CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`epic` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`epic`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`project` text NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`answer` text,
	`answered_at` text,
	PRIMARY KEY(`project`, `key`),
	FOREIGN KEY (`project`) REFERENCES `projects`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `epics` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`title` text NOT NULL,
	`branch` text NOT NULL,
	`status` text NOT NULL,
	`merge_approved_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project`) REFERENCES `projects`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`raw_line` integer NOT NULL,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `gate_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task` text NOT NULL,
	`cmd` text NOT NULL,
	`status` text NOT NULL,
	`ram_est_bytes` integer NOT NULL,
	`peak_commit_bytes` integer,
	`started_at` text,
	`ended_at` text,
	FOREIGN KEY (`task`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `gate_stats` (
	`project` text NOT NULL,
	`cmd_hash` text NOT NULL,
	`peak_commit_max_bytes` integer NOT NULL,
	`runs` integer NOT NULL,
	PRIMARY KEY(`project`, `cmd_hash`),
	FOREIGN KEY (`project`) REFERENCES `projects`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`name` text PRIMARY KEY NOT NULL,
	`profile_path` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`task` text NOT NULL,
	`decision_key` text,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`text` text NOT NULL,
	`options` text NOT NULL,
	`recommendation` text NOT NULL,
	`status` text NOT NULL,
	`answer` text,
	`answered_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task` text NOT NULL,
	`round` integer NOT NULL,
	`executor` text NOT NULL,
	`session_id` text,
	`pid` integer,
	`started_at` text NOT NULL,
	`ended_at` text,
	`exit_code` integer,
	`outcome` text,
	`report_path` text,
	`raw_path` text,
	`usage` text,
	FOREIGN KEY (`task`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_decisions` (
	`task` text NOT NULL,
	`decision_key` text NOT NULL,
	PRIMARY KEY(`task`, `decision_key`),
	FOREIGN KEY (`task`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_deps` (
	`task` text NOT NULL,
	`depends_on` text NOT NULL,
	PRIMARY KEY(`task`, `depends_on`),
	FOREIGN KEY (`task`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`epic` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`prio` integer NOT NULL,
	`card_path` text NOT NULL,
	`allowed_files` text NOT NULL,
	`gates` text NOT NULL,
	`light_tests` text NOT NULL,
	`round` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`epic`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE no action
);
