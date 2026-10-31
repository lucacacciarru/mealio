import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  catalogAisles,
  catalogFoodAliases,
  catalogFoodConversions,
  catalogFoods,
  GROCERY_ROUNDS,
  groceryChecks,
  groceryManualItems,
  groceryPantry,
  type GroceryRound,
  type PlanComponentState,
  type PlanSlot,
} from '../db/schema'
import { addFood, getOrCreateAisle, normalizeAlias } from './catalog'
import { HttpError } from './http'
import type { PlanComponentView } from './plans'
import { addDays, assertWeekStart, getWeek, type MealOption, type WeekMealView, type WeekView } from './weeks'

// The grocery list is derived from the week whenever it is read: it sums the
// foods each planned meal actually uses (the chosen combination and
// substitutions, never the free meal) and splits them between the fixed
// Monday and Thursday rounds. Units convert only through exact metric
// equivalences or the rules the user set for a food; anything else stays as
// printed and is flagged. Pantry stock, checkmarks, and manual items are the
// user's separate records and are matched to the recalculated lines.

const THURSDAY = 3

// Exact equivalences valid for every food. Spoons, jars, slices, or a bare
// count convert only through a rule set for that food.
const METRIC_UNITS: Record<string, { unit: string; factor: number }> = Object.fromEntries(
  (
    [
      ['g', 1, ['g', 'gr', 'grammo', 'grammi']],
      ['g', 100, ['hg', 'etto', 'etti']],
      ['g', 1000, ['kg', 'chilogrammo', 'chilogrammi']],
      ['ml', 1, ['ml', 'millilitro', 'millilitri']],
      ['ml', 10, ['cl', 'centilitro', 'centilitri']],
      ['ml', 100, ['dl', 'decilitro', 'decilitri']],
      ['ml', 1000, ['l', 'lt', 'litro', 'litri']],
    ] as const
  ).flatMap(([unit, factor, spellings]) => spellings.map((spelling) => [spelling, { unit, factor }])),
)

// Canonical unit key and the factor to it: metric spellings become g or ml,
// any other printed unit stays as lowercase text ('' = a bare count).
export function canonicalUnit(text: string | null): { unit: string; factor: number } {
  const key = (text ?? '').trim().toLocaleLowerCase('it').replace(/\s+/g, ' ').replace(/\.$/, '')
  return Object.hasOwn(METRIC_UNITS, key) ? METRIC_UNITS[key]! : { unit: key, factor: 1 }
}

export function isCanonicalUnit(unit: string): boolean {
  const canonical = canonicalUnit(unit)
  return canonical.unit === unit && canonical.factor === 1
}

// `food:<catalog id>`, or `label:<normalized label>` for a plan label that is
// not in the catalog.
export function isFoodKey(key: string): boolean {
  if (/^food:[1-9]\d{0,9}$/.test(key)) return true
  const label = key.startsWith('label:') ? key.slice('label:'.length) : ''
  return label !== '' && normalizeAlias(label) === label
}

// Decimal sums are rounded so floating-point noise never reaches the list.
function tidy(value: number): number {
  return Math.round(value * 1000) / 1000
}

// Uses before Thursday are bought on Monday. From Thursday on, a food goes on
// the Monday round only if it keeps, after purchase, until the day it is used.
function roundFor(dayOffset: number, storageDays: number | null): GroceryRound {
  return dayOffset < THURSDAY || (storageDays !== null && dayOffset <= storageDays) ? 'monday' : 'thursday'
}

// ---------------------------------------------------------------------------
// Catalog rules
// ---------------------------------------------------------------------------

type CatalogFood = {
  id: number
  name: string
  aisle: { name: string; position: number } | null
  groceryUnit: string | null
  packageSize: number | null
  storageDays: number | null
  alwaysAtHome: boolean
  conversions: Map<string, number>
}

type Catalog = { foods: Map<number, CatalogFood>; foodIdByText: Map<string, number>; aisles: string[] }

function loadCatalog(): Catalog {
  const aisles = db.select().from(catalogAisles).orderBy(asc(catalogAisles.position), asc(catalogAisles.name)).all()
  const aisleById = new Map(aisles.map((aisle) => [aisle.id, aisle]))
  const conversions = new Map<number, Map<string, number>>()
  for (const row of db.select().from(catalogFoodConversions).all()) {
    const units = conversions.get(row.foodId) ?? new Map<string, number>()
    units.set(row.unit, row.factor)
    conversions.set(row.foodId, units)
  }
  const foods = new Map<number, CatalogFood>()
  const foodIdByText = new Map<string, number>()
  for (const food of db.select().from(catalogFoods).all()) {
    const aisle = food.aisleId === null ? undefined : aisleById.get(food.aisleId)
    foods.set(food.id, {
      id: food.id,
      name: food.canonicalName,
      aisle: aisle ? { name: aisle.name, position: aisle.position } : null,
      groceryUnit: food.groceryUnit,
      packageSize: food.packageSize,
      storageDays: food.storageDays,
      alwaysAtHome: food.alwaysAtHome,
      conversions: conversions.get(food.id) ?? new Map(),
    })
    foodIdByText.set(normalizeAlias(food.canonicalName), food.id)
  }
  // As in findFoodByText, an alias wins over a canonical name.
  for (const alias of db.select().from(catalogFoodAliases).all()) foodIdByText.set(alias.alias, alias.foodId)
  return { foods, foodIdByText, aisles: aisles.map((aisle) => aisle.name) }
}

// The catalog food linked during import, else the one whose name or alias is
// the printed label; otherwise the label itself identifies the food.
function resolveFood(label: string, foodId: number | null, catalog: Catalog) {
  const id = foodId !== null && catalog.foods.has(foodId) ? foodId : catalog.foodIdByText.get(normalizeAlias(label))
  const food = id === undefined ? undefined : catalog.foods.get(id)
  return food
    ? { key: `food:${food.id}`, food, name: food.name }
    : { key: `label:${normalizeAlias(label)}`, food: null, name: label.trim() }
}

function foodForKey(key: string, catalog: Catalog): CatalogFood | null {
  const match = /^food:(\d+)$/.exec(key)
  return match ? catalog.foods.get(Number(match[1])) ?? null : null
}

// Converts a quantity in a canonical unit to the food's grocery unit when the
// food has an explicit rule for it; otherwise the unit is kept.
function inGroceryUnit(food: CatalogFood | null, unit: string, quantity: number | null) {
  if (!food || food.groceryUnit === null || unit === food.groceryUnit) return { unit, quantity }
  const factor = food.conversions.get(unit)
  if (factor === undefined) return { unit, quantity }
  return { unit: food.groceryUnit, quantity: quantity === null ? null : quantity * factor }
}

// Identity of a list line; pantry stock and checkmarks match lines through it.
function lineId(foodKey: string, unit: string, cooked: boolean): string {
  return JSON.stringify([foodKey, unit, cooked])
}

// ---------------------------------------------------------------------------
// Planned foods
// ---------------------------------------------------------------------------

export type GroceryUse = {
  date: string
  dayName: string
  slot: PlanSlot
  label: string
  quantityText: string | null
  unitText: string | null
  // Equivalence items carry no raw/cooked state; plan weights are raw unless stated.
  state: PlanComponentState | null
  substitution: 'alternative' | 'equivalence' | null
}

// `unitSymbol` is the catalog unit matched at import; it normalizes the unit,
// while the use keeps the unit as printed.
type PlannedFood = Omit<GroceryUse, 'date' | 'dayName' | 'slot'> & {
  foodId: number | null
  quantity: number | null
  unitSymbol: string | null
}

type OpenChoice = { kind: 'combination' | 'alternative'; options: string[] }

// The foods a planned meal uses with the week's choices. A choice still open
// in the plan (a combination, or "A oppure B") is reported, never guessed.
function plannedFoods(meal: WeekMealView): { foods: PlannedFood[]; open: OpenChoice[] } {
  const sources: { food: PlanComponentView | MealOption['item']; substitution: GroceryUse['substitution'] }[] = []
  const open: OpenChoice[] = []
  const wholeMeal = meal.mealOptions.find((option) => option.key === meal.mealChoice)
  if (wholeMeal) {
    sources.push({ food: wholeMeal.item, substitution: 'equivalence' })
  } else {
    if (meal.combinations.length > 0 && meal.combinationChoice === null) {
      open.push({ kind: 'combination', options: meal.combinations })
    }
    for (const row of meal.rows) {
      if (row.combination !== null && row.combination !== meal.combinationChoice) continue
      const chosen = row.options.find((option) => option.key === row.choice)
      if (chosen?.type === 'component') sources.push({ food: chosen.component, substitution: 'alternative' })
      else if (chosen?.type === 'item') sources.push({ food: chosen.item, substitution: 'equivalence' })
      else if (row.components.length === 1) sources.push({ food: row.components[0]!, substitution: null })
      else open.push({ kind: 'alternative', options: row.components.map((component) => component.label) })
    }
  }
  return {
    foods: sources.map(({ food, substitution }) => ({
      label: food.label,
      foodId: food.foodId,
      quantity: food.quantity,
      quantityText: food.quantityText,
      unitText: food.unitText,
      unitSymbol: food.unitSymbol,
      state: 'state' in food ? food.state : null,
      substitution,
    })),
    open,
  }
}

// ---------------------------------------------------------------------------
// Consultation
// ---------------------------------------------------------------------------

export type GroceryLine = {
  foodKey: string
  name: string
  unit: string
  // Cooked weights are not converted to the raw weight to buy.
  cooked: boolean
  // Sum of the uses with a quantity in this round, in `unit`.
  needed: number | null
  unquantifiedUses: number
  unspecifiedStateUses: number
  // Pantry stock covering this round; the Monday round uses it first.
  pantry: number
  packageSize: number | null
  packages: number | null
  toBuy: number | null
  surplus: number | null
  // The food's grocery unit differs and no rule converts this unit.
  unconvertedUnit: boolean
  // No grocery unit is set and the food appears in several units this week.
  mixedUnits: boolean
  uses: GroceryUse[]
  check: { quantity: number | null; checkedAt: number } | null
  // What to buy now minus what was bought: positive = to add, negative = no longer needed.
  delta: number | null
}

export type GroceryRoundView = {
  round: GroceryRound
  date: string
  aisles: { name: string | null; lines: GroceryLine[] }[]
  // Checked lines the recalculated round no longer contains.
  noLongerNeeded: { foodKey: string; name: string; unit: string; cooked: boolean; quantity: number | null }[]
  manual: { id: string; label: string; quantityText: string | null; checkedAt: number | null }[]
}

export type GroceryFood = {
  key: string
  foodId: number | null
  name: string
  aisle: string | null
  rules: {
    unit: string | null
    packageSize: number | null
    storageDays: number | null
    alwaysAtHome: boolean
    conversions: { unit: string; factor: number }[]
  } | null
  // Canonical units the food is printed in this week or its rules mention.
  units: string[]
}

export type GroceryView = {
  weekStart: string
  weekEnd: string
  previousWeekStart: string
  nextWeekStart: string
  isoYear: number
  isoWeek: number
  today: string
  weekStatus: WeekView['status']
  planned: boolean
  unplannedDays: { date: string; dayName: string }[]
  rounds: GroceryRoundView[]
  openChoices: (OpenChoice & { date: string; dayName: string; slot: PlanSlot })[]
  freeMeal: { date: string; dayName: string; slot: PlanSlot } | null
  // Keys of foods used this week that are always at home and never listed.
  alwaysAtHome: string[]
  pantry: { foodKey: string; name: string; unit: string; quantity: number; used: boolean }[]
  foods: GroceryFood[]
  aisles: string[]
}

type LineDraft = {
  foodKey: string
  name: string
  food: CatalogFood | null
  unit: string
  cooked: boolean
  needs: { round: GroceryRound; quantity: number | null; use: GroceryUse }[]
}

type RecordedCheck = GroceryRoundView['noLongerNeeded'][number] & { round: GroceryRound; checkedAt: number }

export function getGroceries(weekStart?: string): GroceryView {
  const week = getWeek(weekStart)
  const catalog = loadCatalog()
  const drafts = new Map<string, LineDraft>()
  const foods = new Map<string, { food: CatalogFood | null; name: string; units: Set<string> }>()
  const alwaysAtHome = new Set<string>()
  const openChoices: GroceryView['openChoices'] = []

  week.days.forEach((day, dayOffset) => {
    if (day.plannedAt === null) return
    for (const meal of day.meals) {
      if (meal.free) continue
      const { foods: planned, open } = plannedFoods(meal)
      for (const choice of open) openChoices.push({ ...choice, date: day.date, dayName: day.dayName, slot: meal.slot })
      for (const { foodId, quantity, unitSymbol, ...printed } of planned) {
        const resolved = resolveFood(printed.label, foodId, catalog)
        const unit = canonicalUnit(unitSymbol ?? printed.unitText)
        const seen = foods.get(resolved.key) ?? { food: resolved.food, name: resolved.name, units: new Set<string>() }
        seen.units.add(unit.unit)
        foods.set(resolved.key, seen)
        if (resolved.food?.alwaysAtHome) {
          alwaysAtHome.add(resolved.key)
          continue
        }
        const amount = inGroceryUnit(resolved.food, unit.unit, quantity === null ? null : quantity * unit.factor)
        const cooked = printed.state === 'cooked'
        const id = lineId(resolved.key, amount.unit, cooked)
        const draft = drafts.get(id) ?? {
          foodKey: resolved.key,
          name: resolved.name,
          food: resolved.food,
          unit: amount.unit,
          cooked,
          needs: [],
        }
        draft.needs.push({
          round: roundFor(dayOffset, resolved.food?.storageDays ?? null),
          quantity: amount.quantity,
          use: { ...printed, date: day.date, dayName: day.dayName, slot: meal.slot },
        })
        drafts.set(id, draft)
      }
    }
  })

  const pantry = new Map<string, GroceryView['pantry'][number]>()
  for (const row of db.select().from(groceryPantry).where(eq(groceryPantry.weekStart, week.weekStart)).all()) {
    const amount = inGroceryUnit(foodForKey(row.foodKey, catalog), row.unit, row.quantity)
    const id = lineId(row.foodKey, amount.unit, false)
    const entry = pantry.get(id) ?? { foodKey: row.foodKey, name: row.name, unit: amount.unit, quantity: 0, used: drafts.has(id) }
    entry.quantity = tidy(entry.quantity + (amount.quantity ?? 0))
    pantry.set(id, entry)
  }

  const checks = new Map<string, RecordedCheck>()
  for (const row of db.select().from(groceryChecks).where(eq(groceryChecks.weekStart, week.weekStart)).all()) {
    const amount = inGroceryUnit(foodForKey(row.foodKey, catalog), row.unit, row.quantity)
    const id = `${row.round}:${lineId(row.foodKey, amount.unit, row.cooked)}`
    const previous = checks.get(id)
    checks.set(id, {
      round: row.round,
      foodKey: row.foodKey,
      name: row.name,
      unit: amount.unit,
      cooked: row.cooked,
      // Rows a new conversion rule merges add up; an unknown amount stays unknown.
      quantity:
        amount.quantity === null || previous?.quantity === null
          ? null
          : tidy((previous?.quantity ?? 0) + amount.quantity),
      checkedAt: Math.max(previous?.checkedAt ?? 0, row.checkedAt),
    })
  }

  const unitsByFood = new Map<string, Set<string>>()
  for (const draft of drafts.values()) {
    if (draft.cooked) continue
    const units = unitsByFood.get(draft.foodKey) ?? new Set<string>()
    units.add(draft.unit)
    unitsByFood.set(draft.foodKey, units)
  }

  const linesByRound: Record<GroceryRound, { aisle: CatalogFood['aisle']; line: GroceryLine }[]> = {
    monday: [],
    thursday: [],
  }
  for (const [id, draft] of drafts) {
    const groceryUnit = draft.food?.groceryUnit ?? null
    const packageSize = !draft.cooked && groceryUnit === draft.unit ? draft.food?.packageSize ?? null : null
    let pantryLeft = draft.cooked ? 0 : pantry.get(id)?.quantity ?? 0
    for (const round of GROCERY_ROUNDS) {
      const needs = draft.needs.filter((need) => need.round === round)
      if (needs.length === 0) continue
      const quantities = needs.flatMap((need) => (need.quantity === null ? [] : [need.quantity]))
      const needed = quantities.length === 0 ? null : tidy(quantities.reduce((total, value) => total + value, 0))
      const fromPantry = needed === null ? 0 : Math.min(pantryLeft, needed)
      pantryLeft = tidy(pantryLeft - fromPantry)
      const net = needed === null ? null : tidy(needed - fromPantry)
      let packages: number | null = null
      let toBuy: number | null = null
      let surplus: number | null = null
      if (net !== null && !draft.cooked) {
        if (packageSize !== null) {
          // The tolerance keeps an exact multiple from rounding up one package.
          packages = Math.max(0, Math.ceil(net / packageSize - 1e-9))
          toBuy = tidy(packages * packageSize)
          surplus = tidy(toBuy - net)
        } else {
          toBuy = net
        }
      }
      const recorded = checks.get(`${round}:${id}`)
      checks.delete(`${round}:${id}`)
      linesByRound[round].push({
        aisle: draft.food?.aisle ?? null,
        line: {
          foodKey: draft.foodKey,
          name: draft.name,
          unit: draft.unit,
          cooked: draft.cooked,
          needed,
          unquantifiedUses: needs.length - quantities.length,
          unspecifiedStateUses: needs.filter((need) => need.use.state === 'unspecified').length,
          pantry: fromPantry,
          packageSize,
          packages,
          toBuy,
          surplus,
          unconvertedUnit: groceryUnit !== null && draft.unit !== groceryUnit,
          mixedUnits: groceryUnit === null && (unitsByFood.get(draft.foodKey)?.size ?? 0) > 1,
          uses: needs.map((need) => need.use),
          check: recorded ? { quantity: recorded.quantity, checkedAt: recorded.checkedAt } : null,
          delta: recorded?.quantity != null && toBuy !== null ? tidy(toBuy - recorded.quantity) : null,
        },
      })
    }
  }

  const manualRows = db
    .select()
    .from(groceryManualItems)
    .where(eq(groceryManualItems.weekStart, week.weekStart))
    .orderBy(asc(groceryManualItems.createdAt), asc(groceryManualItems.id))
    .all()

  return {
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
    previousWeekStart: week.previousWeekStart,
    nextWeekStart: week.nextWeekStart,
    isoYear: week.isoYear,
    isoWeek: week.isoWeek,
    today: week.today,
    weekStatus: week.status,
    planned: week.days.some((day) => day.meals.length > 0),
    unplannedDays: week.days
      .filter((day) => day.meals.length > 0 && day.plannedAt === null)
      .map(({ date, dayName }) => ({ date, dayName })),
    rounds: GROCERY_ROUNDS.map((round) => ({
      round,
      date: addDays(week.weekStart, round === 'monday' ? 0 : THURSDAY),
      aisles: groupByAisle(linesByRound[round]),
      noLongerNeeded: [...checks.values()]
        .filter((recorded) => recorded.round === round)
        .map(({ foodKey, name, unit, cooked, quantity }) => ({ foodKey, name, unit, cooked, quantity }))
        .sort((left, right) => left.name.localeCompare(right.name, 'it')),
      manual: manualRows
        .filter((row) => row.round === round)
        .map((row) => ({ id: row.id, label: row.label, quantityText: row.quantityText, checkedAt: row.checkedAt })),
    })),
    openChoices,
    freeMeal: week.freeMeal && week.days.some((day) => day.date === week.freeMeal?.date && day.plannedAt !== null)
      ? {
          date: week.freeMeal.date,
          dayName: week.days.find((day) => day.date === week.freeMeal?.date)?.dayName ?? '',
          slot: week.freeMeal.slot,
        }
      : null,
    alwaysAtHome: [...alwaysAtHome],
    pantry: [...pantry.values()].sort((left, right) => left.name.localeCompare(right.name, 'it')),
    foods: [...foods.entries()].map(([key, { food, name, units }]) => {
      const rules = food && {
        unit: food.groceryUnit,
        packageSize: food.packageSize,
        storageDays: food.storageDays,
        alwaysAtHome: food.alwaysAtHome,
        conversions: [...food.conversions].map(([unit, factor]) => ({ unit, factor })),
      }
      for (const conversion of rules?.conversions ?? []) units.add(conversion.unit)
      if (rules?.unit != null) units.add(rules.unit)
      return { key, foodId: food?.id ?? null, name, aisle: food?.aisle?.name ?? null, rules, units: [...units] }
    }),
    aisles: catalog.aisles,
  }
}

// Aisles in catalog order, lines without one last; foods alphabetically.
function groupByAisle(lines: { aisle: CatalogFood['aisle']; line: GroceryLine }[]): GroceryRoundView['aisles'] {
  const sorted = [...lines].sort(
    (left, right) =>
      Number(left.aisle === null) - Number(right.aisle === null) ||
      (left.aisle?.position ?? 0) - (right.aisle?.position ?? 0) ||
      (left.aisle?.name ?? '').localeCompare(right.aisle?.name ?? '', 'it') ||
      left.line.name.localeCompare(right.line.name, 'it') ||
      left.line.unit.localeCompare(right.line.unit, 'it') ||
      Number(left.line.cooked) - Number(right.line.cooked),
  )
  const groups: GroceryRoundView['aisles'] = []
  for (const { aisle, line } of sorted) {
    const name = aisle?.name ?? null
    const group = groups.at(-1)
    if (group && group.name === name) group.lines.push(line)
    else groups.push({ name, lines: [line] })
  }
  return groups
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

type LineRef = { weekStart: string; round: GroceryRound; foodKey: string; unit: string; cooked: boolean }

// Removes what was recorded as bought for a line, including rows recorded in
// another unit that the food's rules now convert to the line's unit.
function deleteLineChecks(line: LineRef): void {
  const food = foodForKey(line.foodKey, loadCatalog())
  const ids = db
    .select()
    .from(groceryChecks)
    .where(
      and(
        eq(groceryChecks.weekStart, line.weekStart),
        eq(groceryChecks.round, line.round),
        eq(groceryChecks.foodKey, line.foodKey),
        eq(groceryChecks.cooked, line.cooked),
      ),
    )
    .all()
    .filter((row) => inGroceryUnit(food, row.unit, row.quantity).unit === line.unit)
    .map((row) => row.id)
  if (ids.length > 0) db.delete(groceryChecks).where(inArray(groceryChecks.id, ids)).run()
}

// Records what was bought for a line: the amount the list showed, or null when
// it had none. Checking again replaces the previous record.
export function setGroceryCheck(input: LineRef & { name: string; quantity: number | null }): GroceryView {
  assertWeekStart(input.weekStart)
  db.transaction(() => {
    deleteLineChecks(input)
    db.insert(groceryChecks)
      .values({
        weekStart: input.weekStart,
        round: input.round,
        foodKey: input.foodKey,
        name: input.name,
        unit: input.unit,
        cooked: input.cooked,
        quantity: input.quantity,
        checkedAt: Date.now(),
      })
      .run()
  })
  return getGroceries(input.weekStart)
}

export function clearGroceryCheck(input: LineRef): GroceryView {
  assertWeekStart(input.weekStart)
  db.transaction(() => deleteLineChecks(input))
  return getGroceries(input.weekStart)
}

// Stock at home before the week's Monday round, in the line's unit; null
// removes it.
export function setGroceryPantry(input: {
  weekStart: string
  foodKey: string
  unit: string
  name: string
  quantity: number | null
}): GroceryView {
  assertWeekStart(input.weekStart)
  db.transaction(() => {
    const food = foodForKey(input.foodKey, loadCatalog())
    const ids = db
      .select()
      .from(groceryPantry)
      .where(and(eq(groceryPantry.weekStart, input.weekStart), eq(groceryPantry.foodKey, input.foodKey)))
      .all()
      .filter((row) => inGroceryUnit(food, row.unit, row.quantity).unit === input.unit)
      .map((row) => row.id)
    if (ids.length > 0) db.delete(groceryPantry).where(inArray(groceryPantry.id, ids)).run()
    if (input.quantity !== null && input.quantity > 0) {
      db.insert(groceryPantry)
        .values({
          weekStart: input.weekStart,
          foodKey: input.foodKey,
          name: input.name,
          unit: input.unit,
          quantity: input.quantity,
          updatedAt: Date.now(),
        })
        .run()
    }
  })
  return getGroceries(input.weekStart)
}

// The client generates the id: retrying the same request adds nothing.
export function addGroceryManualItem(input: {
  weekStart: string
  round: GroceryRound
  id: string
  label: string
  quantityText: string | null
}): GroceryView {
  assertWeekStart(input.weekStart)
  db.insert(groceryManualItems)
    .values({
      id: input.id,
      weekStart: input.weekStart,
      round: input.round,
      label: input.label,
      quantityText: input.quantityText || null,
      checkedAt: null,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run()
  return getGroceries(input.weekStart)
}

export function setGroceryManualItemChecked(input: { weekStart: string; id: string; checked: boolean }): GroceryView {
  assertWeekStart(input.weekStart)
  const result = db
    .update(groceryManualItems)
    .set({ checkedAt: input.checked ? Date.now() : null })
    .where(and(eq(groceryManualItems.id, input.id), eq(groceryManualItems.weekStart, input.weekStart)))
    .run()
  if (result.changes === 0) throw new HttpError('Voce non trovata in questa settimana.', 404)
  return getGroceries(input.weekStart)
}

export function deleteGroceryManualItem(input: { weekStart: string; id: string }): GroceryView {
  assertWeekStart(input.weekStart)
  db.delete(groceryManualItems)
    .where(and(eq(groceryManualItems.id, input.id), eq(groceryManualItems.weekStart, input.weekStart)))
    .run()
  return getGroceries(input.weekStart)
}

export type GroceryFoodRulesInput = {
  weekStart: string
  foodKey: string
  aisle: string | null
  unit: string | null
  packageSize: number | null
  storageDays: number | null
  alwaysAtHome: boolean
  conversions: { unit: string; factor: number }[]
}

export function setGroceryFoodRules(input: GroceryFoodRulesInput): GroceryView {
  assertWeekStart(input.weekStart)
  if (input.unit !== null && !isCanonicalUnit(input.unit)) throw new HttpError('Unità della lista non valida.', 400)
  if (input.unit === null && (input.packageSize !== null || input.conversions.length > 0)) {
    throw new HttpError('Scegli l’unità della lista prima di indicare confezione o conversioni.', 400)
  }
  if (
    new Set(input.conversions.map((conversion) => conversion.unit)).size !== input.conversions.length ||
    input.conversions.some((conversion) => conversion.unit === input.unit || !isCanonicalUnit(conversion.unit))
  ) {
    throw new HttpError('Indica ogni conversione una sola volta, da un’unità diversa da quella della lista.', 400)
  }
  db.transaction(() => {
    const foodId = catalogFoodId(input.weekStart, input.foodKey)
    db.update(catalogFoods)
      .set({
        aisleId: input.aisle ? getOrCreateAisle(input.aisle) : null,
        groceryUnit: input.unit,
        packageSize: input.packageSize,
        storageDays: input.storageDays,
        alwaysAtHome: input.alwaysAtHome,
      })
      .where(eq(catalogFoods.id, foodId))
      .run()
    db.delete(catalogFoodConversions).where(eq(catalogFoodConversions.foodId, foodId)).run()
    if (input.conversions.length > 0) {
      db.insert(catalogFoodConversions)
        .values(input.conversions.map((conversion) => ({ foodId, ...conversion })))
        .run()
    }
  })
  return getGroceries(input.weekStart)
}

// Rules belong to catalog foods. A plan label of this week's list that is not
// in the catalog becomes a food named as printed, with the label as alias;
// pantry stock and checkmarks recorded under the label follow it.
function catalogFoodId(weekStart: string, foodKey: string): number {
  const food = foodForKey(foodKey, loadCatalog())
  if (food) return food.id
  const listed = foodKey.startsWith('label:')
    ? getGroceries(weekStart).foods.find((candidate) => candidate.key === foodKey)
    : undefined
  if (!listed) throw new HttpError('Alimento non presente nella spesa di questa settimana.', 404)
  const foodId = addFood({ canonicalName: listed.name, aliases: [listed.name] })
  const key = `food:${foodId}`
  db.run(sql`update or ignore grocery_pantry set food_key = ${key} where food_key = ${foodKey}`)
  db.run(sql`update or ignore grocery_checks set food_key = ${key} where food_key = ${foodKey}`)
  return foodId
}
