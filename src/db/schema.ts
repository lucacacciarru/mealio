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

export const catalogFoods = sqliteTable('catalog_foods', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  canonicalName: text('canonical_name').notNull().unique(),
  defaultUnitId: integer('default_unit_id').references(() => catalogUnits.id),
  aisleId: integer('aisle_id').references(() => catalogAisles.id),
  createdAt: integer('created_at').notNull(),
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

// ---------------------------------------------------------------------------
// Versioned plans. A plan has seven days and five slots. Weights refer to raw
// ingredients unless a component states otherwise. A draft version has no
// validity date; activation sets `valid_from` explicitly. `valid_from` is
// unique, so at most one version starts on a given date and the active
// version for a date is the latest activated `valid_from` on or before it.
// ---------------------------------------------------------------------------

export const planVersions = sqliteTable(
  'plan_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    label: text('label'),
    validFrom: text('valid_from'),
    activatedAt: integer('activated_at'),
    createdAt: integer('created_at').notNull(),
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
  },
  (table) => [
    uniqueIndex('plan_meals_day_slot_unique').on(table.dayId, table.slot),
    index('plan_meals_day_id_idx').on(table.dayId),
  ],
)

export const PLAN_COMPONENT_STATES = ['raw', 'cooked'] as const
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
    // Values printed in the PDF, kept separate so confirmed corrections stay
    // traceable (e.g. cod printed 200 g, confirmed 250 g).
    printedQuantity: real('printed_quantity'),
    printedUnitId: integer('printed_unit_id').references(() => catalogUnits.id),
    // Plan weights are raw unless the plan states otherwise.
    state: text('state', { enum: PLAN_COMPONENT_STATES }).notNull().default('raw'),
    // Components sharing a group within a meal are mutually exclusive
    // alternatives ("scelte"); null = not an alternative.
    alternativeGroup: text('alternative_group'),
    page: integer('page'),
    notes: text('notes'),
    confirmedAt: integer('confirmed_at'),
  },
  (table) => [
    index('plan_components_meal_id_idx').on(table.mealId),
    index('plan_components_food_id_idx').on(table.foodId),
    check('plan_components_state_check', sql`state in ('raw', 'cooked')`),
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
    unitId: integer('unit_id').references(() => catalogUnits.id),
  },
  (table) => [index('plan_equivalence_items_equivalence_id_idx').on(table.equivalenceId)],
)
