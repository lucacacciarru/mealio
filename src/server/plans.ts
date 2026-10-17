import { and, asc, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm'
import { db } from '../db'
import {
  catalogFoods,
  catalogUnits,
  planComponents,
  planDays,
  planEquivalenceItems,
  planEquivalences,
  planMeals,
  planVersions,
  type PlanComponentState,
  type PlanSlot,
} from '../db/schema'
import { addAlias, findFoodByText } from './catalog'

export const DAY_NAMES = [
  'Lunedì',
  'Martedì',
  'Mercoledì',
  'Giovedì',
  'Venerdì',
  'Sabato',
  'Domenica',
] as const

const SLOT_ORDER: Record<PlanSlot, number> = {
  breakfast: 0,
  morning_snack: 1,
  lunch: 2,
  afternoon_snack: 3,
  dinner: 4,
}

const VALID_FROM_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function assertValidFrom(validFrom: string): void {
  if (!VALID_FROM_PATTERN.test(validFrom)) {
    throw new Error(`Data di validità non valida: "${validFrom}". Usa il formato AAAA-MM-GG.`)
  }
  const date = new Date(`${validFrom}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== validFrom) {
    throw new Error(`Data di validità non valida: "${validFrom}". Usa il formato AAAA-MM-GG.`)
  }
}

function assertVersionIsDraft(versionId: number): void {
  const version = db
    .select({ activatedAt: planVersions.activatedAt })
    .from(planVersions)
    .where(eq(planVersions.id, versionId))
    .get()
  if (!version) throw new Error('Versione del piano non trovata.')
  if (version.activatedAt !== null) {
    throw new Error('Non è possibile modificare una versione già attiva.')
  }
}

function assertMealVersionIsDraft(mealId: number): void {
  const meal = db
    .select({ versionId: planDays.versionId })
    .from(planMeals)
    .innerJoin(planDays, eq(planMeals.dayId, planDays.id))
    .where(eq(planMeals.id, mealId))
    .get()
  if (!meal) throw new Error('Pasto non trovato.')
  assertVersionIsDraft(meal.versionId)
}

function assertComponentVersionIsDraft(componentId: number): void {
  const component = db
    .select({ versionId: planDays.versionId })
    .from(planComponents)
    .innerJoin(planMeals, eq(planComponents.mealId, planMeals.id))
    .innerJoin(planDays, eq(planMeals.dayId, planDays.id))
    .where(eq(planComponents.id, componentId))
    .get()
  if (!component) throw new Error('Componente non trovato.')
  assertVersionIsDraft(component.versionId)
}

export function todayInRome(): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date())
}

function catalogContext() {
  const unitSymbolById = new Map(
    db.select().from(catalogUnits).all().map((unit) => [unit.id, unit.symbol]),
  )
  const foodNameById = new Map(
    db.select().from(catalogFoods).all().map((food) => [food.id, food.canonicalName]),
  )
  return { unitSymbolById, foodNameById }
}

// ---------------------------------------------------------------------------
// Version lifecycle
// ---------------------------------------------------------------------------

export function createPlanVersion(label?: string): number {
  return db.transaction(() => {
    const version = db
      .insert(planVersions)
      .values({ label: label?.trim() || null, createdAt: Date.now() })
      .returning()
      .get()
    for (let dayIndex = 0; dayIndex < DAY_NAMES.length; dayIndex += 1) {
      db.insert(planDays).values({ versionId: version.id, dayIndex }).run()
    }
    return version.id
  })
}

export function activatePlanVersion(versionId: number, validFrom: string): void {
  assertValidFrom(validFrom)
  db.transaction(() => {
    const version = db
      .select()
      .from(planVersions)
      .where(eq(planVersions.id, versionId))
      .get()
    if (!version) throw new Error('Versione del piano non trovata.')
    if (version.activatedAt !== null) throw new Error('La versione è già attiva.')
    const latestActive = db
      .select()
      .from(planVersions)
      .where(and(isNotNull(planVersions.validFrom), isNotNull(planVersions.activatedAt)))
      .orderBy(desc(planVersions.validFrom))
      .limit(1)
      .get()
    if (latestActive && validFrom <= (latestActive.validFrom ?? '')) {
      throw new Error(
        `La data di attivazione deve essere successiva a ${latestActive.validFrom}, ` +
          'inizio della versione attiva.',
      )
    }
    db.update(planVersions)
      .set({ validFrom, activatedAt: Date.now() })
      .where(eq(planVersions.id, versionId))
      .run()
  })
}

// The active version for a date is the latest activated version whose
// validity starts on or before that date; `valid_from` is unique, so at most
// one version matches.
export function planVersionForDate(date: string): { id: number } | null {
  assertValidFrom(date)
  return (
    db
      .select({ id: planVersions.id })
      .from(planVersions)
      .where(
        and(
          isNotNull(planVersions.validFrom),
          isNotNull(planVersions.activatedAt),
          lte(planVersions.validFrom, date),
        ),
      )
      .orderBy(desc(planVersions.validFrom))
      .limit(1)
      .get() ?? null
  )
}

export type PlanVersionHistoryEntry = {
  id: number
  label: string | null
  validFrom: string | null
  validUntil: string | null
  activatedAt: number | null
  createdAt: number
  status: 'draft' | 'upcoming' | 'active' | 'superseded'
}

export function listPlanVersions(): PlanVersionHistoryEntry[] {
  const versions = db
    .select()
    .from(planVersions)
    .orderBy(asc(planVersions.createdAt))
    .all()
  const activated = versions
    .filter((version) => version.validFrom !== null && version.activatedAt !== null)
    .sort((a, b) => (a.validFrom ?? '').localeCompare(b.validFrom ?? ''))
  const today = todayInRome()
  return versions.map((version) => {
    const activatedIndex = activated.findIndex((entry) => entry.id === version.id)
    const validUntil =
      activatedIndex === -1 ? null : activated[activatedIndex + 1]?.validFrom ?? null
    let status: PlanVersionHistoryEntry['status'] = 'draft'
    if (version.activatedAt !== null && version.validFrom !== null) {
      if (version.validFrom > today) status = 'upcoming'
      else if (validUntil === null || validUntil > today) status = 'active'
      else status = 'superseded'
    }
    return {
      id: version.id,
      label: version.label,
      validFrom: version.validFrom,
      validUntil,
      activatedAt: version.activatedAt,
      createdAt: version.createdAt,
      status,
    }
  })
}

// ---------------------------------------------------------------------------
// Draft-only write helpers.

export function ensureMeal(
  versionId: number,
  dayIndex: number,
  slot: PlanSlot,
  options: { page?: number | null; notes?: string | null } = {},
): number {
  if (SLOT_ORDER[slot] === undefined) throw new Error(`Pasto non valido: "${slot}".`)
  return db.transaction(() => {
    const day = db
      .select()
      .from(planDays)
      .where(and(eq(planDays.versionId, versionId), eq(planDays.dayIndex, dayIndex)))
      .get()
    if (!day) throw new Error(`Giorno ${dayIndex + 1} non trovato nella versione ${versionId}.`)
    assertVersionIsDraft(day.versionId)
    const existing = db
      .select()
      .from(planMeals)
      .where(and(eq(planMeals.dayId, day.id), eq(planMeals.slot, slot)))
      .get()
    if (existing) {
      db.update(planMeals)
        .set({ page: options.page ?? existing.page, notes: options.notes ?? existing.notes })
        .where(eq(planMeals.id, existing.id))
        .run()
      return existing.id
    }
    return db
      .insert(planMeals)
      .values({ dayId: day.id, slot, page: options.page, notes: options.notes })
      .returning()
      .get().id
  })
}

export type AddComponentInput = {
  label: string
  foodId?: number | null
  quantity?: number | null
  unitId?: number | null
  printedQuantity?: number | null
  printedUnitId?: number | null
  state?: PlanComponentState
  alternativeGroup?: string | null
  page?: number | null
  notes?: string | null
}

export function addComponent(mealId: number, input: AddComponentInput): number {
  const label = input.label.trim()
  if (!label) throw new Error('Etichetta alimento mancante.')
  return db.transaction(() => {
    assertMealVersionIsDraft(mealId)
    const last = db
      .select({ position: planComponents.position })
      .from(planComponents)
      .where(eq(planComponents.mealId, mealId))
      .orderBy(desc(planComponents.position))
      .limit(1)
      .get()
    const component = db
      .insert(planComponents)
      .values({
        mealId,
        position: (last?.position ?? -1) + 1,
        label,
        foodId: input.foodId ?? null,
        quantity: input.quantity ?? null,
        unitId: input.unitId ?? null,
        printedQuantity: input.printedQuantity ?? null,
        printedUnitId: input.printedUnitId ?? null,
        state: input.state ?? 'raw',
        alternativeGroup: input.alternativeGroup ?? null,
        page: input.page ?? null,
        notes: input.notes ?? null,
      })
      .returning()
      .get()
    return component.id
  })
}

// Links an unrecognized extracted component to a catalog food during review;
// optionally registers the extracted label as a reusable alias.
export function linkComponentToFood(componentId: number, foodId: number, alias?: string): void {
  db.transaction(() => {
    assertComponentVersionIsDraft(componentId)
    const food = db.select().from(catalogFoods).where(eq(catalogFoods.id, foodId)).get()
    if (!food) throw new Error('Alimento del catalogo non trovato.')
    db.update(planComponents)
      .set({ foodId })
      .where(eq(planComponents.id, componentId))
      .run()
    if (alias?.trim()) {
      const existing = findFoodByText(alias)
      if (existing && existing.id !== foodId) {
        throw new Error(`L'alias "${alias.trim()}" è già associato a "${existing.canonicalName}".`)
      }
      if (!existing) addAlias(foodId, alias)
    }
  })
}

// Records the user-confirmed values for a component, keeping the printed
// values separate so the discrepancy stays traceable (e.g. cod printed 200 g,
// confirmed 250 g).
export function recordComponentConfirmation(
  componentId: number,
  input: {
    quantity: number | null
    unitId: number | null
    printedQuantity: number | null
    printedUnitId: number | null
  },
): void {
  db.transaction(() => {
    assertComponentVersionIsDraft(componentId)
    db.update(planComponents)
      .set({
        quantity: input.quantity,
        unitId: input.unitId,
        printedQuantity: input.printedQuantity,
        printedUnitId: input.printedUnitId,
        confirmedAt: Date.now(),
      })
      .where(eq(planComponents.id, componentId))
      .run()
  })
}

// ---------------------------------------------------------------------------
// Equivalences
// ---------------------------------------------------------------------------

export type AddEquivalenceInput = {
  scopeComponentId?: number | null
  scopeMealId?: number | null
  page?: number | null
  note?: string | null
  items: { label: string; foodId?: number | null; quantity?: number | null; unitId?: number | null }[]
}

export function addEquivalence(versionId: number, input: AddEquivalenceInput): number {
  if (
    input.scopeComponentId !== null &&
    input.scopeComponentId !== undefined &&
    input.scopeMealId !== null &&
    input.scopeMealId !== undefined
  ) {
    throw new Error('Un’equivalenza non può avere ambiti pasto e componente contemporaneamente.')
  }
  if (!input.items.length) throw new Error('Un’equivalenza richiede almeno un elemento.')
  return db.transaction(() => {
    assertVersionIsDraft(versionId)
    if (input.scopeComponentId !== null && input.scopeComponentId !== undefined) {
      const scopeComponent = db
        .select({ versionId: planDays.versionId })
        .from(planComponents)
        .innerJoin(planMeals, eq(planComponents.mealId, planMeals.id))
        .innerJoin(planDays, eq(planMeals.dayId, planDays.id))
        .where(eq(planComponents.id, input.scopeComponentId))
        .get()
      if (!scopeComponent || scopeComponent.versionId !== versionId) {
        throw new Error('Il componente di ambito non appartiene a questa versione.')
      }
    }
    if (input.scopeMealId !== null && input.scopeMealId !== undefined) {
      const scopeMeal = db
        .select({ versionId: planDays.versionId })
        .from(planMeals)
        .innerJoin(planDays, eq(planMeals.dayId, planDays.id))
        .where(eq(planMeals.id, input.scopeMealId))
        .get()
      if (!scopeMeal || scopeMeal.versionId !== versionId) {
        throw new Error('Il pasto di ambito non appartiene a questa versione.')
      }
    }
    const equivalence = db
      .insert(planEquivalences)
      .values({
        versionId,
        scopeComponentId: input.scopeComponentId ?? null,
        scopeMealId: input.scopeMealId ?? null,
        page: input.page ?? null,
        note: input.note ?? null,
      })
      .returning()
      .get()
    input.items.forEach((item, index) => {
      db.insert(planEquivalenceItems)
        .values({
          equivalenceId: equivalence.id,
          position: index,
          label: item.label.trim(),
          foodId: item.foodId ?? null,
          quantity: item.quantity ?? null,
          unitId: item.unitId ?? null,
        })
        .run()
    })
    return equivalence.id
  })
}

// ---------------------------------------------------------------------------
// Consultation
// ---------------------------------------------------------------------------

export type PlanComponentView = {
  id: number
  position: number
  label: string
  foodId: number | null
  foodCanonicalName: string | null
  quantity: number | null
  quantityText: string | null
  unitSymbol: string | null
  unitText: string | null
  printedQuantity: number | null
  printedQuantityText: string | null
  printedUnitSymbol: string | null
  printedUnitText: string | null
  state: PlanComponentState
  alternativeGroup: string | null
  combination: string | null
  page: number | null
  sourceQuote: string | null
  notes: string | null
  confirmedAt: number | null
}

export type PlanMealView = {
  id: number
  slot: PlanSlot
  page: number | null
  sourceQuote: string | null
  notes: string | null
  components: PlanComponentView[]
}

export type EquivalenceView = {
  id: number
  page: number | null
  sourceQuote: string | null
  note: string | null
  scope:
    | { type: 'component'; componentId: number; dayIndex: number; dayName: string; slot: PlanSlot; label: string }
    | { type: 'meal'; mealId: number; dayIndex: number; dayName: string; slot: PlanSlot }
    | { type: 'unresolved' }
  items: {
    id: number
    position: number
    label: string
    foodId: number | null
    foodCanonicalName: string | null
    quantity: number | null
    quantityText: string | null
    unitSymbol: string | null
    unitText: string | null
    sourceQuote: string | null
  }[]
}

export type PlanView = {
  version: {
    id: number
    label: string | null
    validFrom: string | null
    activatedAt: number | null
    createdAt: number
    sourceImportId: string | null
  }
  days: { dayIndex: number; dayName: string; meals: PlanMealView[] }[]
  equivalences: EquivalenceView[]
}

export function getPlan(versionId: number): PlanView | null {
  const version = db
    .select()
    .from(planVersions)
    .where(eq(planVersions.id, versionId))
    .get()
  if (!version) return null
  const { unitSymbolById, foodNameById } = catalogContext()

  const days = db
    .select()
    .from(planDays)
    .where(eq(planDays.versionId, versionId))
    .orderBy(asc(planDays.dayIndex))
    .all()
  const mealsByDayId = new Map<number, PlanMealView[]>()
  for (const meal of db
    .select()
    .from(planMeals)
    .where(inArray(planMeals.dayId, days.map((day) => day.id)))
    .all()) {
    const components = db
      .select()
      .from(planComponents)
      .where(eq(planComponents.mealId, meal.id))
      .orderBy(asc(planComponents.position))
      .all()
      .map((component) => ({
        id: component.id,
        position: component.position,
        label: component.label,
        foodId: component.foodId,
        foodCanonicalName: component.foodId ? foodNameById.get(component.foodId) ?? null : null,
        quantity: component.quantity,
        quantityText: component.quantityText,
        unitSymbol: component.unitId ? unitSymbolById.get(component.unitId) ?? null : null,
        unitText: component.unitText,
        printedQuantity: component.printedQuantity,
        printedQuantityText: component.printedQuantityText,
        printedUnitSymbol: component.printedUnitId
          ? unitSymbolById.get(component.printedUnitId) ?? null
          : null,
        printedUnitText: component.printedUnitText,
        state: component.state,
        alternativeGroup: component.alternativeGroup,
        combination: component.combination,
        page: component.page,
        sourceQuote: component.sourceQuote,
        notes: component.notes,
        confirmedAt: component.confirmedAt,
      }))
    const view: PlanMealView = {
      id: meal.id,
      slot: meal.slot,
      page: meal.page,
      sourceQuote: meal.sourceQuote,
      notes: meal.notes,
      components,
    }
    const list = mealsByDayId.get(meal.dayId) ?? []
    list.push(view)
    mealsByDayId.set(meal.dayId, list)
  }

  return {
    version: {
      id: version.id,
      label: version.label,
      validFrom: version.validFrom,
      activatedAt: version.activatedAt,
      createdAt: version.createdAt,
      sourceImportId: version.sourceImportId,
    },
    days: days.map((day) => {
      const meals = mealsByDayId.get(day.id) ?? []
      meals.sort((a, b) => SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot])
      return { dayIndex: day.dayIndex, dayName: DAY_NAMES[day.dayIndex], meals }
    }),
    equivalences: listEquivalences(versionId),
  }
}

export function listEquivalences(versionId: number): EquivalenceView[] {
  const { unitSymbolById, foodNameById } = catalogContext()
  const equivalences = db
    .select()
    .from(planEquivalences)
    .where(eq(planEquivalences.versionId, versionId))
    .orderBy(asc(planEquivalences.id))
    .all()

  const componentScopeById = new Map<
    number,
    { dayIndex: number; slot: PlanSlot; label: string }
  >()
  for (const equivalence of equivalences) {
    if (equivalence.scopeComponentId === null) continue
    const scope = db
      .select({
        dayIndex: planDays.dayIndex,
        slot: planMeals.slot,
        label: planComponents.label,
      })
      .from(planComponents)
      .innerJoin(planMeals, eq(planComponents.mealId, planMeals.id))
      .innerJoin(planDays, eq(planMeals.dayId, planDays.id))
      .where(eq(planComponents.id, equivalence.scopeComponentId))
      .get()
    if (scope) componentScopeById.set(equivalence.scopeComponentId, scope)
  }
  const mealScopeById = new Map<number, { dayIndex: number; slot: PlanSlot }>()
  for (const equivalence of equivalences) {
    if (equivalence.scopeMealId === null) continue
    const scope = db
      .select({ dayIndex: planDays.dayIndex, slot: planMeals.slot })
      .from(planMeals)
      .innerJoin(planDays, eq(planMeals.dayId, planDays.id))
      .where(eq(planMeals.id, equivalence.scopeMealId))
      .get()
    if (scope) mealScopeById.set(equivalence.scopeMealId, scope)
  }

  return equivalences.map((equivalence) => {
    let scope: EquivalenceView['scope'] = { type: 'unresolved' }
    if (equivalence.scopeComponentId !== null) {
      const resolved = componentScopeById.get(equivalence.scopeComponentId)
      if (resolved) {
        scope = {
          type: 'component',
          componentId: equivalence.scopeComponentId,
          dayIndex: resolved.dayIndex,
          dayName: DAY_NAMES[resolved.dayIndex],
          slot: resolved.slot,
          label: resolved.label,
        }
      }
    } else if (equivalence.scopeMealId !== null) {
      const resolved = mealScopeById.get(equivalence.scopeMealId)
      if (resolved) {
        scope = {
          type: 'meal',
          mealId: equivalence.scopeMealId,
          dayIndex: resolved.dayIndex,
          dayName: DAY_NAMES[resolved.dayIndex],
          slot: resolved.slot,
        }
      }
    }
    const items = db
      .select()
      .from(planEquivalenceItems)
      .where(eq(planEquivalenceItems.equivalenceId, equivalence.id))
      .orderBy(asc(planEquivalenceItems.position))
      .all()
      .map((item) => ({
        id: item.id,
        position: item.position,
        label: item.label,
        foodId: item.foodId,
        foodCanonicalName: item.foodId ? foodNameById.get(item.foodId) ?? null : null,
        quantity: item.quantity,
        quantityText: item.quantityText,
        unitSymbol: item.unitId ? unitSymbolById.get(item.unitId) ?? null : null,
        unitText: item.unitText,
        sourceQuote: item.sourceQuote,
      }))
    return {
      id: equivalence.id,
      page: equivalence.page,
      sourceQuote: equivalence.sourceQuote,
      note: equivalence.note,
      scope,
      items,
    }
  })
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type ComponentSnapshot = {
  quantity: number | null
  quantityText: string | null
  unitSymbol: string | null
  unitText: string | null
  printedQuantity: number | null
  printedQuantityText: string | null
  printedUnitSymbol: string | null
  printedUnitText: string | null
  state: PlanComponentState
  foodCanonicalName: string | null
  alternativeGroup: string | null
  combination: string | null
  page: number | null
  sourceQuote: string | null
  notes: string | null
}

export type EquivalenceItemSnapshot = {
  label: string
  foodId: number | null
  foodCanonicalName: string | null
  quantity: number | null
  quantityText: string | null
  unitSymbol: string | null
  unitText: string | null
  sourceQuote: string | null
}

export type EquivalenceSnapshot = {
  page: number | null
  sourceQuote: string | null
  note: string | null
  items: EquivalenceItemSnapshot[]
}

export type ComponentDiffEntry = {
  dayIndex: number
  dayName: string
  slot: PlanSlot
  label: string
  kind: 'added' | 'removed' | 'changed'
  before: ComponentSnapshot | null
  after: ComponentSnapshot | null
}

export type MealDiffEntry = {
  dayIndex: number
  dayName: string
  slot: PlanSlot
  kind: 'added' | 'removed' | 'changed'
}

export type EquivalenceDiffEntry = {
  kind: 'added' | 'removed' | 'changed'
  scopeLabel: string
  before: EquivalenceSnapshot | null
  after: EquivalenceSnapshot | null
}

export type PlanDiff = {
  fromVersionId: number
  toVersionId: number
  meals: MealDiffEntry[]
  components: ComponentDiffEntry[]
  equivalences: EquivalenceDiffEntry[]
}

function snapshotOf(component: PlanComponentView): ComponentSnapshot {
  return {
    quantity: component.quantity,
    quantityText: component.quantityText,
    unitSymbol: component.unitSymbol,
    unitText: component.unitText,
    printedQuantity: component.printedQuantity,
    printedQuantityText: component.printedQuantityText,
    printedUnitSymbol: component.printedUnitSymbol,
    printedUnitText: component.printedUnitText,
    state: component.state,
    foodCanonicalName: component.foodCanonicalName,
    alternativeGroup: component.alternativeGroup,
    combination: component.combination,
    page: component.page,
    sourceQuote: component.sourceQuote,
    notes: component.notes,
  }
}

function equivalenceScopeLabel(equivalence: EquivalenceView): string {
  if (equivalence.scope.type === 'unresolved') return 'ambito non risolto'
  if (equivalence.scope.type === 'component') {
    return `${equivalence.scope.dayName} · ${equivalence.scope.slot} · ${equivalence.scope.label}`
  }
  return `${equivalence.scope.dayName} · ${equivalence.scope.slot}`
}

function equivalenceSnapshot(equivalence: EquivalenceView): EquivalenceSnapshot {
  const items = equivalence.items.map((item) => ({
    label: item.label,
    foodId: item.foodId,
    foodCanonicalName: item.foodCanonicalName,
    quantity: item.quantity,
    quantityText: item.quantityText,
    unitSymbol: item.unitSymbol,
    unitText: item.unitText,
    sourceQuote: item.sourceQuote,
  }))
  return {
    page: equivalence.page,
    sourceQuote: equivalence.sourceQuote,
    note: equivalence.note,
    items,
  }
}

export function diffPlanVersions(fromVersionId: number, toVersionId: number): PlanDiff {
  const from = getPlan(fromVersionId)
  const to = getPlan(toVersionId)
  if (!from) throw new Error(`Versione ${fromVersionId} non trovata.`)
  if (!to) throw new Error(`Versione ${toVersionId} non trovata.`)

  const meals: MealDiffEntry[] = []
  const components: ComponentDiffEntry[] = []
  const mealKeys = new Set<string>()
  const fromMeals = new Map<string, PlanMealView>()
  const toMeals = new Map<string, PlanMealView>()
  for (const day of from.days) {
    for (const meal of day.meals) {
      const key = `${day.dayIndex}:${meal.slot}`
      fromMeals.set(key, meal)
      mealKeys.add(key)
    }
  }
  for (const day of to.days) {
    for (const meal of day.meals) {
      const key = `${day.dayIndex}:${meal.slot}`
      toMeals.set(key, meal)
      mealKeys.add(key)
    }
  }

  for (const key of [...mealKeys].sort()) {
    const [dayIndexText, slot] = key.split(':') as [string, PlanSlot]
    const dayIndex = Number(dayIndexText)
    const dayName = DAY_NAMES[dayIndex]
    const before = fromMeals.get(key)
    const after = toMeals.get(key)
    if (!before && after) meals.push({ dayIndex, dayName, slot, kind: 'added' })
    else if (before && !after) meals.push({ dayIndex, dayName, slot, kind: 'removed' })
    else if (before && after && (before.page !== after.page || before.notes !== after.notes)) {
      meals.push({ dayIndex, dayName, slot, kind: 'changed' })
    }

    const beforeComponents = before?.components ?? []
    const afterComponents = after?.components ?? []
    const beforeByLabel = new Map<string, PlanComponentView[]>()
    const afterByLabel = new Map<string, PlanComponentView[]>()
    for (const component of beforeComponents) {
      const list = beforeByLabel.get(component.label) ?? []
      list.push(component)
      beforeByLabel.set(component.label, list)
    }
    for (const component of afterComponents) {
      const list = afterByLabel.get(component.label) ?? []
      list.push(component)
      afterByLabel.set(component.label, list)
    }
    for (const label of new Set([...beforeByLabel.keys(), ...afterByLabel.keys()])) {
      const beforeList = beforeByLabel.get(label) ?? []
      const afterList = afterByLabel.get(label) ?? []
      const compared = Math.min(beforeList.length, afterList.length)
      for (let index = 0; index < compared; index += 1) {
        const beforeSnapshot = snapshotOf(beforeList[index])
        const afterSnapshot = snapshotOf(afterList[index])
        if (JSON.stringify(beforeSnapshot) !== JSON.stringify(afterSnapshot)) {
          components.push({
            dayIndex,
            dayName,
            slot,
            label,
            kind: 'changed',
            before: beforeSnapshot,
            after: afterSnapshot,
          })
        }
      }
      for (const removed of beforeList.slice(compared)) {
        components.push({
          dayIndex,
          dayName,
          slot,
          label,
          kind: 'removed',
          before: snapshotOf(removed),
          after: null,
        })
      }
      for (const added of afterList.slice(compared)) {
        components.push({
          dayIndex,
          dayName,
          slot,
          label,
          kind: 'added',
          before: null,
          after: snapshotOf(added),
        })
      }
    }
  }

  const equivalences: EquivalenceDiffEntry[] = []
  const groupKey = (equivalence: EquivalenceView): string => {
    if (equivalence.scope.type === 'component') {
      return `component:${equivalence.scope.dayIndex}:${equivalence.scope.slot}:${equivalence.scope.label}`
    }
    if (equivalence.scope.type === 'meal') {
      return `meal:${equivalence.scope.dayIndex}:${equivalence.scope.slot}`
    }
    return `unresolved:${equivalence.id}`
  }
  const signature = (equivalence: EquivalenceView): string =>
    JSON.stringify(equivalenceSnapshot(equivalence))
  const fromGroups = new Map<string, EquivalenceView[]>()
  const toGroups = new Map<string, EquivalenceView[]>()
  for (const equivalence of from.equivalences) {
    const key = groupKey(equivalence)
    const list = fromGroups.get(key) ?? []
    list.push(equivalence)
    fromGroups.set(key, list)
  }
  for (const equivalence of to.equivalences) {
    const key = groupKey(equivalence)
    const list = toGroups.get(key) ?? []
    list.push(equivalence)
    toGroups.set(key, list)
  }
  for (const key of new Set([...fromGroups.keys(), ...toGroups.keys()])) {
    const beforeList = (fromGroups.get(key) ?? []).sort((a, b) =>
      signature(a).localeCompare(signature(b)),
    )
    const afterList = (toGroups.get(key) ?? []).sort((a, b) =>
      signature(a).localeCompare(signature(b)),
    )
    const label = equivalenceScopeLabel(beforeList[0] ?? afterList[0])
    const compared = Math.min(beforeList.length, afterList.length)
    for (let index = 0; index < compared; index += 1) {
      const before = equivalenceSnapshot(beforeList[index])
      const after = equivalenceSnapshot(afterList[index])
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        equivalences.push({ kind: 'changed', scopeLabel: label, before, after })
      }
    }
    for (const removed of beforeList.slice(compared)) {
      equivalences.push({
        kind: 'removed',
        scopeLabel: label,
        before: equivalenceSnapshot(removed),
        after: null,
      })
    }
    for (const added of afterList.slice(compared)) {
      equivalences.push({
        kind: 'added',
        scopeLabel: label,
        before: null,
        after: equivalenceSnapshot(added),
      })
    }
  }

  return { fromVersionId, toVersionId, meals, components, equivalences }
}
