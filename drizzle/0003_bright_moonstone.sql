CREATE TABLE `week_meals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`week_id` integer NOT NULL,
	`date` text NOT NULL,
	`slot` text NOT NULL,
	`source_version_id` integer NOT NULL,
	`source_day_index` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`choices_json` text NOT NULL,
	FOREIGN KEY (`week_id`) REFERENCES `weeks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_version_id`) REFERENCES `plan_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `week_meals_week_date_slot_unique` ON `week_meals` (`week_id`,`date`,`slot`);--> statement-breakpoint
CREATE TABLE `weeks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`week_start` text NOT NULL,
	`confirmed_at` integer NOT NULL,
	`free_meal_date` text,
	`free_meal_slot` text,
	`free_meal_description` text,
	CONSTRAINT "weeks_free_meal_check" CHECK((free_meal_date is null) = (free_meal_slot is null) and (free_meal_description is null or free_meal_date is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weeks_week_start_unique` ON `weeks` (`week_start`);