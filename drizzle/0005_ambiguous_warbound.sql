CREATE TABLE `check_in_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `diary_plan_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`snapshot_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `diary_plan_snapshots_date_idx` ON `diary_plan_snapshots` (`date`);--> statement-breakpoint
CREATE TABLE `meal_check_ins` (
	`date` text NOT NULL,
	`slot` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`followed` integer NOT NULL,
	`note` text,
	`recorded_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revision` integer NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `diary_plan_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "meal_check_ins_followed_check" CHECK(followed in (0, 1)),
	CONSTRAINT "meal_check_ins_revision_check" CHECK(revision > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meal_check_ins_date_slot_unique` ON `meal_check_ins` (`date`,`slot`);