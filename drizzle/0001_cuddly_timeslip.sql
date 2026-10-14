CREATE TABLE `catalog_aisles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_aisles_name_unique` ON `catalog_aisles` (`name`);--> statement-breakpoint
CREATE TABLE `catalog_food_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`food_id` integer NOT NULL,
	`alias` text NOT NULL,
	FOREIGN KEY (`food_id`) REFERENCES `catalog_foods`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_food_aliases_alias_unique` ON `catalog_food_aliases` (`alias`);--> statement-breakpoint
CREATE TABLE `catalog_foods` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canonical_name` text NOT NULL,
	`default_unit_id` integer,
	`aisle_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`default_unit_id`) REFERENCES `catalog_units`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`aisle_id`) REFERENCES `catalog_aisles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_foods_canonical_name_unique` ON `catalog_foods` (`canonical_name`);--> statement-breakpoint
CREATE TABLE `catalog_units` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`name` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_units_symbol_unique` ON `catalog_units` (`symbol`);--> statement-breakpoint
CREATE TABLE `plan_components` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meal_id` integer NOT NULL,
	`position` integer NOT NULL,
	`label` text NOT NULL,
	`food_id` integer,
	`quantity` real,
	`unit_id` integer,
	`printed_quantity` real,
	`printed_unit_id` integer,
	`state` text DEFAULT 'raw' NOT NULL,
	`alternative_group` text,
	`page` integer,
	`notes` text,
	`confirmed_at` integer,
	FOREIGN KEY (`meal_id`) REFERENCES `plan_meals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`food_id`) REFERENCES `catalog_foods`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `catalog_units`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`printed_unit_id`) REFERENCES `catalog_units`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "plan_components_state_check" CHECK(state in ('raw', 'cooked'))
);
--> statement-breakpoint
CREATE INDEX `plan_components_meal_id_idx` ON `plan_components` (`meal_id`);--> statement-breakpoint
CREATE INDEX `plan_components_food_id_idx` ON `plan_components` (`food_id`);--> statement-breakpoint
CREATE TABLE `plan_days` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_id` integer NOT NULL,
	`day_index` integer NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `plan_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_days_version_day_unique` ON `plan_days` (`version_id`,`day_index`);--> statement-breakpoint
CREATE TABLE `plan_equivalence_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`equivalence_id` integer NOT NULL,
	`position` integer NOT NULL,
	`label` text NOT NULL,
	`food_id` integer,
	`quantity` real,
	`unit_id` integer,
	FOREIGN KEY (`equivalence_id`) REFERENCES `plan_equivalences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`food_id`) REFERENCES `catalog_foods`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `catalog_units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `plan_equivalence_items_equivalence_id_idx` ON `plan_equivalence_items` (`equivalence_id`);--> statement-breakpoint
CREATE TABLE `plan_equivalences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_id` integer NOT NULL,
	`scope_component_id` integer,
	`scope_meal_id` integer,
	`page` integer,
	`note` text,
	FOREIGN KEY (`version_id`) REFERENCES `plan_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scope_component_id`) REFERENCES `plan_components`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scope_meal_id`) REFERENCES `plan_meals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plan_equivalences_version_id_idx` ON `plan_equivalences` (`version_id`);--> statement-breakpoint
CREATE INDEX `plan_equivalences_scope_component_id_idx` ON `plan_equivalences` (`scope_component_id`);--> statement-breakpoint
CREATE INDEX `plan_equivalences_scope_meal_id_idx` ON `plan_equivalences` (`scope_meal_id`);--> statement-breakpoint
CREATE TABLE `plan_meals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day_id` integer NOT NULL,
	`slot` text NOT NULL,
	`page` integer,
	`notes` text,
	FOREIGN KEY (`day_id`) REFERENCES `plan_days`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_meals_day_slot_unique` ON `plan_meals` (`day_id`,`slot`);--> statement-breakpoint
CREATE INDEX `plan_meals_day_id_idx` ON `plan_meals` (`day_id`);--> statement-breakpoint
CREATE TABLE `plan_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text,
	`valid_from` text,
	`activated_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_versions_valid_from_unique` ON `plan_versions` (`valid_from`);