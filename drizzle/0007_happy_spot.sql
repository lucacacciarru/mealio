CREATE TABLE `week_days` (
	`week_id` integer NOT NULL,
	`date` text NOT NULL,
	`planned_at` integer NOT NULL,
	FOREIGN KEY (`week_id`) REFERENCES `weeks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `week_days_week_date_unique` ON `week_days` (`week_id`,`date`);