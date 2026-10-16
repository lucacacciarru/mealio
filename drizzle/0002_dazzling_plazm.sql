CREATE TABLE `plan_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`original_name` text NOT NULL,
	`file_key` text NOT NULL,
	`byte_size` integer NOT NULL,
	`status` text NOT NULL,
	`extraction_json` text,
	`authorized_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_imports_file_key_unique` ON `plan_imports` (`file_key`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_plan_components` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meal_id` integer NOT NULL,
	`position` integer NOT NULL,
	`label` text NOT NULL,
	`food_id` integer,
	`quantity` real,
	`unit_id` integer,
	`quantity_text` text,
	`unit_text` text,
	`printed_quantity` real,
	`printed_unit_id` integer,
	`printed_quantity_text` text,
	`printed_unit_text` text,
	`state` text DEFAULT 'raw' NOT NULL,
	`alternative_group` text,
	`page` integer,
	`source_quote` text,
	`notes` text,
	`confirmed_at` integer,
	FOREIGN KEY (`meal_id`) REFERENCES `plan_meals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`food_id`) REFERENCES `catalog_foods`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `catalog_units`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`printed_unit_id`) REFERENCES `catalog_units`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "plan_components_state_check" CHECK(state in ('raw', 'cooked', 'unspecified'))
);
--> statement-breakpoint
INSERT INTO `__new_plan_components`("id", "meal_id", "position", "label", "food_id", "quantity", "unit_id", "quantity_text", "unit_text", "printed_quantity", "printed_unit_id", "printed_quantity_text", "printed_unit_text", "state", "alternative_group", "page", "source_quote", "notes", "confirmed_at") SELECT "id", "meal_id", "position", "label", "food_id", "quantity", "unit_id", NULL, NULL, "printed_quantity", "printed_unit_id", NULL, NULL, "state", "alternative_group", "page", NULL, "notes", "confirmed_at" FROM `plan_components`;--> statement-breakpoint
DROP TABLE `plan_components`;--> statement-breakpoint
ALTER TABLE `__new_plan_components` RENAME TO `plan_components`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `plan_components_meal_id_idx` ON `plan_components` (`meal_id`);--> statement-breakpoint
CREATE INDEX `plan_components_food_id_idx` ON `plan_components` (`food_id`);--> statement-breakpoint
ALTER TABLE `plan_equivalence_items` ADD `quantity_text` text;--> statement-breakpoint
ALTER TABLE `plan_equivalence_items` ADD `unit_text` text;--> statement-breakpoint
ALTER TABLE `plan_equivalence_items` ADD `source_quote` text;--> statement-breakpoint
ALTER TABLE `plan_equivalences` ADD `source_quote` text;--> statement-breakpoint
ALTER TABLE `plan_meals` ADD `source_quote` text;--> statement-breakpoint
ALTER TABLE `plan_versions` ADD `source_import_id` text REFERENCES plan_imports(id) ON DELETE set null;