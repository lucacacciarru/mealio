import { sql } from 'drizzle-orm'
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('sessions_expires_at_idx').on(table.expiresAt)],
)

// Single-user settings managed by the app itself: the password hash and the
// secret used to key login rate limits.
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const loginRateLimits = sqliteTable('login_rate_limits', {
  addressHash: text('address_hash').primaryKey(),
  windowStartedAt: integer('window_started_at').notNull(),
  attempts: integer('attempts').notNull(),
})

export const maintenanceRuns = sqliteTable('maintenance_runs', {
  jobName: text('job_name').primaryKey(),
  lastSuccessAt: integer('last_success_at').notNull(),
})

// ---------------------------------------------------------------------------
// Food catalog. Foods are normalized once; plan names map to them through
// aliases. Nutrients and food state belong to the macro phase and are out of
// scope here.
// ---------------------------------------------------------------------------

export const catalogAisles = sqliteTable('catalog_aisles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  position: integer('position').notNull().default(0),
})

export const catalogUnits = sqliteTable('catalog_units', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  symbol: text('symbol').notNull().unique(),
  name: text('name'),
})

// Shopping rules are explicit and optional. `groceryUnit` is the canonical unit
// the grocery list sums the food in ('' = a bare count); null keeps each
// printed unit apart. `packageSize` is in that unit. `storageDays` says how
// long the food keeps after purchase; null buys it on the round of its use.
export const catalogFoods = sqliteTable('catalog_foods', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  canonicalName: text('canonical_name').notNull().unique(),
  defaultUnitId: integer('default_unit_id').references(() => catalogUnits.id),
  aisleId: integer('aisle_id').references(() => catalogAisles.id),
  createdAt: integer('created_at').notNull(),
  groceryUnit: text('grocery_unit'),
  packageSize: real('package_size'),
  storageDays: integer('storage_days'),
  alwaysAtHome: integer('always_at_home', { mode: 'boolean' }).notNull().default(false),
})

export const catalogFoodAliases = sqliteTable(
  'catalog_food_aliases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    foodId: integer('food_id')
      .notNull()
      .references(() => catalogFoods.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
  },
  (table) => [uniqueIndex('catalog_food_aliases_alias_unique').on(table.alias)],
)

// One `unit` of the food equals `factor` of its grocery unit. Units are
// canonical keys (see src/server/groceries.ts); rules are set by the user for
// one food and never inferred.
export const catalogFoodConversions = sqliteTable(
  'catalog_food_conversions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    foodId: integer('food_id')
      .notNull()
      .references(() => catalogFoods.id, { onDelete: 'cascade' }),
    unit: text('unit').notNull(),
    factor: real('factor').notNull(),
  },
  (table) => [
    uniqueIndex('catalog_food_conversions_food_unit_unique').on(table.foodId, table.unit),
    check('catalog_food_conversions_factor_check', sql`factor > 0`),
  ],
)

// ---------------------------------------------------------------------------
// Versioned plans. A plan has seven days and five slots. Weights refer to raw
// ingredients unless a component states otherwise. A draft version has no
// validity date; activation sets `valid_from` explicitly. `valid_from` is
// unique, so at most one version starts on a given date and the active
// version for a date is the latest activated `valid_from` on or before it.
// ---------------------------------------------------------------------------

export const planImports = sqliteTable(
  'plan_imports',
  {
    id: text('id').primaryKey(),
    originalName: text('original_name').notNull(),
    fileKey: text('file_key').notNull(),
    byteSize: integer('byte_size').notNull(),
    status: text('status', { enum: ['uploaded', 'extracted', 'activated'] }).notNull(),
    extractionJson: text('extraction_json'),
    authorizedAt: integer('authorized_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [uniqueIndex('plan_imports_file_key_unique').on(table.fileKey)],
)

export const planVersions = sqliteTable(
  'plan_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    label: text('label'),
    validFrom: text('valid_from'),
    activatedAt: integer('activated_at'),
    createdAt: integer('created_at').notNull(),
    sourceImportId: text('source_import_id').references(() => planImports.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('plan_versions_valid_from_unique').on(table.validFrom),
  ],
)

export const planDays = sqliteTable(
  'plan_days',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    versionId: integer('version_id')
      .notNull()
      .references(() => planVersions.id, { onDelete: 'cascade' }),
    // 0 = Monday … 6 = Sunday
    dayIndex: integer('day_index').notNull(),
  },
  (table) => [uniqueIndex('plan_days_version_day_unique').on(table.versionId, table.dayIndex)],
)

export const PLAN_SLOTS = ['breakfast', 'morning_snack', 'lunch', 'afternoon_snack', 'dinner'] as const
export type PlanSlot = (typeof PLAN_SLOTS)[number]

export const planMeals = sqliteTable(
  'plan_meals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    dayId: integer('day_id')
      .notNull()
      .references(() => planDays.id, { onDelete: 'cascade' }),
    slot: text('slot', { enum: PLAN_SLOTS }).notNull(),
    page: integer('page'),
    notes: text('notes'),
    sourceQuote: text('source_quote'),
  },
  (table) => [
    uniqueIndex('plan_meals_day_slot_unique').on(table.dayId, table.slot),
    index('plan_meals_day_id_idx').on(table.dayId),
  ],
)

export const PLAN_COMPONENT_STATES = ['raw', 'cooked', 'unspecified'] as const
export type PlanComponentState = (typeof PLAN_COMPONENT_STATES)[number]

export const planComponents = sqliteTable(
  'plan_components',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mealId: integer('meal_id')
      .notNull()
      .references(() => planMeals.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    // Text exactly as extracted; never guessed. `foodId` is null while the
    // food is unrecognized and pending review.
    label: text('label').notNull(),
    foodId: integer('food_id').references(() => catalogFoods.id),
    // Effective, review-confirmed values.
    quantity: real('quantity'),
    unitId: integer('unit_id').references(() => catalogUnits.id),
    quantityText: text('quantity_text'),
    unitText: text('unit_text'),
    // Values printed in the PDF, retained when a reviewer corrects the plan.
    printedQuantity: real('printed_quantity'),
    printedUnitId: integer('printed_unit_id').references(() => catalogUnits.id),
    printedQuantityText: text('printed_quantity_text'),
    printedUnitText: text('printed_unit_text'),
    state: text('state', { enum: PLAN_COMPONENT_STATES }).notNull().default('raw'),
    // Components sharing a group within a meal are mutually exclusive
    // alternatives ("scelte"); null = not an alternative.
    alternativeGroup: text('alternative_group'),
    // Components sharing a combination are eaten together as one of the meal's
    // alternative sets of foods ("OPPURE", "a scelta tra"); null = part of
    // every set, or the meal offers a single one.
    combination: text('combination'),
    page: integer('page'),
    sourceQuote: text('source_quote'),
    notes: text('notes'),
    confirmedAt: integer('confirmed_at'),
  },
  (table) => [
    index('plan_components_meal_id_idx').on(table.mealId),
    index('plan_components_food_id_idx').on(table.foodId),
    check('plan_components_state_check', sql`state in ('raw', 'cooked', 'unspecified')`),
  ],
)

// Equivalences carry page and scope; they are never global substitutions.
// Scope is the component or meal they apply to; both null means the scope is
// unresolved and requires review.
export const planEquivalences = sqliteTable(
  'plan_equivalences',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    versionId: integer('version_id')
      .notNull()
      .references(() => planVersions.id, { onDelete: 'cascade' }),
    scopeComponentId: integer('scope_component_id').references(() => planComponents.id, {
      onDelete: 'cascade',
    }),
    scopeMealId: integer('scope_meal_id').references(() => planMeals.id, { onDelete: 'cascade' }),
    page: integer('page'),
    note: text('note'),
    sourceQuote: text('source_quote'),
  },
  (table) => [
    index('plan_equivalences_version_id_idx').on(table.versionId),
    index('plan_equivalences_scope_component_id_idx').on(table.scopeComponentId),
    index('plan_equivalences_scope_meal_id_idx').on(table.scopeMealId),
  ],
)

export const planEquivalenceItems = sqliteTable(
  'plan_equivalence_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    equivalenceId: integer('equivalence_id')
      .notNull()
      .references(() => planEquivalences.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    label: text('label').notNull(),
    foodId: integer('food_id').references(() => catalogFoods.id),
    quantity: real('quantity'),
    quantityText: text('quantity_text'),
    unitText: text('unit_text'),
    sourceQuote: text('source_quote'),
    unitId: integer('unit_id').references(() => catalogUnits.id),
  },
  (table) => [index('plan_equivalence_items_equivalence_id_idx').on(table.equivalenceId)],
)

// ---------------------------------------------------------------------------
// Weekly snapshots and saved draft choices are independent of publication.
// Only an explicit per-day confirmation in week_days publishes its meals.
// Each week meal keeps its source plan snapshot; swaps move snapshots,
// choices, and the free meal between dates of the same plan version.
// ---------------------------------------------------------------------------

export const weeks = sqliteTable(
  'weeks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Monday of the ISO week, YYYY-MM-DD.
    weekStart: text('week_start').notNull(),
    confirmedAt: integer('confirmed_at').notNull(),
    // At most one free meal per week: it replaces the planned meal at this
    // date and slot and carries no ingredients.
    freeMealDate: text('free_meal_date'),
    freeMealSlot: text('free_meal_slot', { enum: PLAN_SLOTS }),
    freeMealDescription: text('free_meal_description'),
  },
  (table) => [
    uniqueIndex('weeks_week_start_unique').on(table.weekStart),
    check(
      'weeks_free_meal_check',
      sql`(free_meal_date is null) = (free_meal_slot is null) and (free_meal_description is null or free_meal_date is not null)`,
    ),
  ],
)

export const weekDays = sqliteTable(
  'week_days',
  {
    weekId: integer('week_id')
      .notNull()
      .references(() => weeks.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    plannedAt: integer('planned_at').notNull(),
  },
  (table) => [uniqueIndex('week_days_week_date_unique').on(table.weekId, table.date)],
)

export const weekMeals = sqliteTable(
  'week_meals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    weekId: integer('week_id')
      .notNull()
      .references(() => weeks.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    slot: text('slot', { enum: PLAN_SLOTS }).notNull(),
    // Plan version and plan day the meal comes from; after a swap the plan
    // day differs from the weekday of `date`.
    sourceVersionId: integer('source_version_id')
      .notNull()
      .references(() => planVersions.id),
    sourceDayIndex: integer('source_day_index').notNull(),
    snapshotJson: text('snapshot_json').notNull(),
    // Substitutions chosen among the snapshot's alternatives and equivalences.
    choicesJson: text('choices_json').notNull(),
  },
  (table) => [uniqueIndex('week_meals_week_date_slot_unique').on(table.weekId, table.date, table.slot)],
)

// Diary snapshots are independent of mutable planner rows. A check-in keeps
// the first snapshot it referenced, including substitutions and the free meal.
export const diaryPlanSnapshots = sqliteTable(
  'diary_plan_snapshots',
  {
    id: text('id').primaryKey(),
    date: text('date').notNull(),
    snapshotJson: text('snapshot_json').notNull(),
  },
  (table) => [index('diary_plan_snapshots_date_idx').on(table.date)],
)

export const mealCheckIns = sqliteTable(
  'meal_check_ins',
  {
    date: text('date').notNull(),
    slot: text('slot', { enum: PLAN_SLOTS }).notNull(),
    snapshotId: text('snapshot_id')
      .notNull()
      .references(() => diaryPlanSnapshots.id),
    followed: integer('followed', { mode: 'boolean' }).notNull(),
    note: text('note'),
    recordedAt: integer('recorded_at').notNull(),
    createdAt: integer('created_at').notNull(),
    revision: integer('revision').notNull(),
  },
  (table) => [
    uniqueIndex('meal_check_ins_date_slot_unique').on(table.date, table.slot),
    check('meal_check_ins_followed_check', sql`followed in (0, 1)`),
    check('meal_check_ins_revision_check', sql`revision > 0`),
  ],
)

// Receipts survive later edits: retrying a request whose response was lost
// must never replay it over a newer check-in.
export const checkInOperations = sqliteTable('check_in_operations', {
  id: text('id').primaryKey(),
  requestHash: text('request_hash').notNull(),
})

// ---------------------------------------------------------------------------
// Groceries. The list itself is never stored: it is recalculated from the
// week. Pantry stock, checkmarks, and manual items are the user's separate
// records. Foods are keyed `food:<catalog id>` or, for a plan label missing
// from the catalog, `label:<normalized label>`; units are canonical keys.
// ---------------------------------------------------------------------------

export const GROCERY_ROUNDS = ['monday', 'thursday'] as const
export type GroceryRound = (typeof GROCERY_ROUNDS)[number]

// Stock at home before the Monday round of an ISO week.
export const groceryPantry = sqliteTable(
  'grocery_pantry',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    weekStart: text('week_start').notNull(),
    foodKey: text('food_key').notNull(),
    name: text('name').notNull(),
    unit: text('unit').notNull(),
    quantity: real('quantity').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('grocery_pantry_week_food_unit_unique').on(table.weekStart, table.foodKey, table.unit),
    check('grocery_pantry_quantity_check', sql`quantity > 0`),
  ],
)

// What was bought for a list line, as shown when it was checked; null when the
// line had no computable amount. The recalculated list is compared with it to
// show what to add or what is no longer needed.
export const groceryChecks = sqliteTable(
  'grocery_checks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    weekStart: text('week_start').notNull(),
    round: text('round', { enum: GROCERY_ROUNDS }).notNull(),
    foodKey: text('food_key').notNull(),
    name: text('name').notNull(),
    unit: text('unit').notNull(),
    cooked: integer('cooked', { mode: 'boolean' }).notNull(),
    quantity: real('quantity'),
    checkedAt: integer('checked_at').notNull(),
  },
  (table) => [
    uniqueIndex('grocery_checks_line_unique').on(table.weekStart, table.round, table.foodKey, table.unit, table.cooked),
    check('grocery_checks_round_check', sql`round in ('monday', 'thursday')`),
    check('grocery_checks_quantity_check', sql`quantity is null or quantity >= 0`),
  ],
)

export const groceryManualItems = sqliteTable(
  'grocery_manual_items',
  {
    // Generated by the client, so a retried request cannot add the item twice.
    id: text('id').primaryKey(),
    weekStart: text('week_start').notNull(),
    round: text('round', { enum: GROCERY_ROUNDS }).notNull(),
    label: text('label').notNull(),
    quantityText: text('quantity_text'),
    checkedAt: integer('checked_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('grocery_manual_items_week_start_idx').on(table.weekStart),
    check('grocery_manual_items_round_check', sql`round in ('monday', 'thursday')`),
  ],
)
