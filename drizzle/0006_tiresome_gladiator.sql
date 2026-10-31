CREATE TABLE `catalog_food_conversions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`food_id` integer NOT NULL,
	`unit` text NOT NULL,
	`factor` real NOT NULL,
	FOREIGN KEY (`food_id`) REFERENCES `catalog_foods`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "catalog_food_conversions_factor_check" CHECK(factor > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_food_conversions_food_unit_unique` ON `catalog_food_conversions` (`food_id`,`unit`);--> statement-breakpoint
CREATE TABLE `grocery_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`week_start` text NOT NULL,
	`round` text NOT NULL,
	`food_key` text NOT NULL,
	`name` text NOT NULL,
	`unit` text NOT NULL,
	`cooked` integer NOT NULL,
	`quantity` real,
	`checked_at` integer NOT NULL,
	CONSTRAINT "grocery_checks_round_check" CHECK(round in ('monday', 'thursday')),
	CONSTRAINT "grocery_checks_quantity_check" CHECK(quantity is null or quantity >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grocery_checks_line_unique` ON `grocery_checks` (`week_start`,`round`,`food_key`,`unit`,`cooked`);--> statement-breakpoint
CREATE TABLE `grocery_manual_items` (
	`id` text PRIMARY KEY NOT NULL,
	`week_start` text NOT NULL,
	`round` text NOT NULL,
	`label` text NOT NULL,
	`quantity_text` text,
	`checked_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "grocery_manual_items_round_check" CHECK(round in ('monday', 'thursday'))
);
--> statement-breakpoint
CREATE INDEX `grocery_manual_items_week_start_idx` ON `grocery_manual_items` (`week_start`);--> statement-breakpoint
CREATE TABLE `grocery_pantry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`week_start` text NOT NULL,
	`food_key` text NOT NULL,
	`name` text NOT NULL,
	`unit` text NOT NULL,
	`quantity` real NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "grocery_pantry_quantity_check" CHECK(quantity > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grocery_pantry_week_food_unit_unique` ON `grocery_pantry` (`week_start`,`food_key`,`unit`);--> statement-breakpoint
ALTER TABLE `catalog_foods` ADD `grocery_unit` text;--> statement-breakpoint
ALTER TABLE `catalog_foods` ADD `package_size` real;--> statement-breakpoint
ALTER TABLE `catalog_foods` ADD `storage_days` integer;--> statement-breakpoint
ALTER TABLE `catalog_foods` ADD `always_at_home` integer DEFAULT false NOT NULL;