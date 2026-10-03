CREATE TABLE `board_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`kind` text NOT NULL,
	`task` text,
	`question` text,
	`run` text,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `board_events_kind_seq_idx` ON `board_events` (`kind`,`seq`);--> statement-breakpoint
CREATE INDEX `board_events_run_idx` ON `board_events` (`run`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
