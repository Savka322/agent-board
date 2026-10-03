ALTER TABLE `board_events` ADD `epic` text;
--> statement-breakpoint
CREATE TABLE `epic_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`epic` text NOT NULL,
	`ts` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`note` text,
	FOREIGN KEY (`epic`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`app_id` text NOT NULL,
	`delivered` integer NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `notifications_cause_idx` ON `notifications` (`kind`,`ref`);
