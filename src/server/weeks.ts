import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { PLAN_SLOTS, planVersions, weekMeals, weeks, type PlanSlot } from '../db/schema'
import { HttpError } from './http'
import {
  DAY_NAMES,
  getPlan,
  planVersionForDate,
  todayInRome,
  type EquivalenceView,
  type PlanComponentView,
  type PlanView,
} from './plans'

// Reading a week previews the valid diet without selecting its alternatives.
// A day is ready, and counts for groceries and the diary, once every required
// choice of its meals is made. Edits preserve past dates and swap only within
// the same plan version.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000
const FREE_MEAL_DESCRIPTION_MAX_LENGTH = 200

export type WeekEquivalence = Omit<EquivalenceView, 'scope'> & {
  scope: { type: 'meal' } | { type: 'component'; componentId: number }
}

// Copy of a plan meal and of the equivalences explicitly scoped to it or to
// one of its foods; unresolved equivalences never apply.
export type WeekMealSnapshot = {
  mealId: number | null
  page: number | null
  notes: string | null
  sourceQuote: string | null
  components: PlanComponentView[]
  equivalences: WeekEquivalence[]
}

// Choices hold option keys of the snapshot. `combination` picks one of the meal's
// alternative sets of foods; `meal` replaces the whole meal with an item of a
// meal-scoped equivalence; `rows` resolves a row (one food, or the foods of an
// alternative group) among the shared foods or those of the chosen combination
// to one of its alternatives or to an item of an equivalence scoped to one of
// its foods. Missing required combinations and alternative groups stay open.
export const WeekMealChoicesSchema = z
  .object({
    // Absent from choices saved before combinations existed.
    combination: z.string().max(100).nullable().default(null),
    meal: z.string().max(40).nullable(),
    rows: z.record(z.string().max(120), z.string().max(40)),
  })
  .strict()

export type WeekMealChoices = z.infer<typeof WeekMealChoicesSchema>

type EquivalenceSource = Pick<WeekEquivalence, 'id' | 'page' | 'note' | 'sourceQuote'>
type EquivalenceItem = WeekEquivalence['items'][number]

export type RowOption =
  | { key: string; type: 'component'; component: PlanComponentView }
  | {
      key: string
      type: 'item'
      item: EquivalenceItem
      replaces: PlanComponentView
      equivalence: EquivalenceSource
    }

export type MealOption = { key: string; item: EquivalenceItem; equivalence: EquivalenceSource }

// `combination` is null for foods planned whatever combination is chosen.
type MealRow = { key: string; combination: string | null; components: PlanComponentView[]; options: RowOption[] }

type MealSubstitutionOptions = {
  rows: MealRow[]
  combinations: string[]
  meal: MealOption[]
}

type VersionRef = { id: number; label: string | null }

export type WeekMealView = {
  slot: PlanSlot
  // Plan day the meal comes from; it differs from the date after a swap.
  sourceDayIndex: number
  sourceDayName: string
  mealId: number | null
  page: number | null
  notes: string | null
  rows: (MealRow & { choice: string | null })[]
  // Alternative sets of foods to choose from; empty when the meal has a single set.
  combinations: string[]
  combinationChoice: string | null
  mealOptions: MealOption[]
  mealChoice: string | null
  free: { description: string | null } | null
}

export type WeekDayView = {
  date: string
  dayIndex: number
  dayName: string
  past: boolean
  // Has meals and no open choices: it counts for groceries and the diary.
  ready: boolean
  unresolvedChoices: number
  // Version whose meals the day shows and version valid on the date now: they
  // differ when a newer version started after the week was confirmed.
  plannedVersion: VersionRef | null
  validVersion: VersionRef | null
  meals: WeekMealView[]
}

export type WeekView = {
  weekStart: string
  weekEnd: string
  previousWeekStart: string
  nextWeekStart: string
  isoYear: number
  isoWeek: number
  today: string
  // Legacy weekly snapshot metadata, not per-day publication status.
  status: 'confirmed' | 'unconfirmed'
  confirmedAt: number | null
  freeMeal: { date: string; slot: PlanSlot; description: string | null } | null
  days: WeekDayView[]
}

type WeekMealRow = Omit<typeof weekMeals.$inferInsert, 'id' | 'weekId'>

// Rejects rollovers such as 2026-02-30.
function isCalendarDate(value: string): boolean {
  return (
    DATE_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  )
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

// 0 = Monday … 6 = Sunday, as plan day indexes.
function weekdayIndex(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7
}

function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, offset) => addDays(weekStart, offset))
}

export function assertWeekStart(weekStart: string): void {
  if (!isCalendarDate(weekStart) || weekdayIndex(weekStart) !== 0) {
    throw new HttpError('Settimana non valida: indica il lunedì in formato AAAA-MM-GG.', 400)
  }
}

// Changes touch only dates of the week from today on: past meals are recorded,
// not replanned.
function assertChangeableDate(weekStart: string, date: string, today: string): void {
  if (!isCalendarDate(date) || date < weekStart || date > addDays(weekStart, 6)) {
    throw new HttpError('La data non appartiene a questa settimana.', 400)
  }
  if (date < today) throw new HttpError('I giorni passati non si ripianificano.', 409)
}

function savedWeek(weekStart: string) {
  const existing = db.select().from(weeks).where(eq(weeks.weekStart, weekStart)).get()
  if (existing) return existing
  if (addDays(weekStart, 6) < todayInRome()) {
    throw new HttpError('La settimana è già passata: per quei giorni resta il piano originale.', 409)
  }
  const plans = new Map<number, PlanView>()
  const rows = weekDates(weekStart).flatMap((date) => {
    const version = planVersionForDate(date)
    return version ? plannedMealRows(date, version.id, plans) : []
  })
  if (rows.length === 0) throw new HttpError('Nessun piano è valido nelle date di questa settimana.', 409)
  const week = db.insert(weeks).values({ weekStart, confirmedAt: Date.now() }).returning().get()
  db.insert(weekMeals).values(rows.map((row) => ({ ...row, weekId: week.id }))).run()
  return week
}

// The meals the version sets for the weekday of `date`, as unmodified rows.
function plannedMealRows(date: string, versionId: number, plans: Map<number, PlanView>): WeekMealRow[] {
  const plan = plans.get(versionId) ?? getPlan(versionId)
  if (!plan) throw new Error(`Versione ${versionId} non trovata.`)
  plans.set(versionId, plan)
  const dayIndex = weekdayIndex(date)
  const meals = plan.days.find((day) => day.dayIndex === dayIndex)?.meals ?? []
  return PLAN_SLOTS.map((slot) => {
    const meal = meals.find((candidate) => candidate.slot === slot)
    const componentIds = new Set(meal?.components.map((component) => component.id))
    const snapshot: WeekMealSnapshot = {
      mealId: meal?.id ?? null,
      page: meal?.page ?? null,
      notes: meal?.notes ?? null,
      sourceQuote: meal?.sourceQuote ?? null,
      components: meal?.components ?? [],
      equivalences: plan.equivalences.flatMap(({ scope, ...equivalence }): WeekEquivalence[] => {
        if (!meal || equivalence.items.length === 0) return []
        if (scope.type === 'meal' && scope.mealId === meal.id) return [{ ...equivalence, scope: { type: 'meal' } }]
        if (scope.type === 'component' && componentIds.has(scope.componentId)) {
          return [{ ...equivalence, scope: { type: 'component', componentId: scope.componentId } }]
        }
        return []
      }),
    }
    const choices: WeekMealChoices = { combination: null, meal: null, rows: {} }
    return {
      date,
      slot,
      sourceVersionId: versionId,
      sourceDayIndex: dayIndex,
      snapshotJson: JSON.stringify(snapshot),
      choicesJson: JSON.stringify(choices),
    }
  })
}

// Substitutions the plan allows for a meal. Foods sharing a combination form one
// of the meal's alternative sets of foods; foods without one belong to every
// set. Within a set, foods sharing an alternative group form one "A oppure B"
// row, as in the plan summary.
function substitutionOptions(snapshot: WeekMealSnapshot): MealSubstitutionOptions {
  // Components of snapshots taken before combinations existed have no `combination`.
  const labels = [
    ...new Set(
      snapshot.components
        .map((component) => component.combination)
        .filter((combination): combination is string => typeof combination === 'string'),
    ),
  ]
  // A single set needs no choice: its foods are always planned.
  const combinations = labels.length > 1 ? labels : []
  const rows: MealRow[] = []
  const rowByGroup = new Map<string, MealRow>()
  for (const component of snapshot.components) {
    const combination = combinations.length > 0 ? component.combination ?? null : null
    const group = component.alternativeGroup?.trim()
    // Group names are unique only within a combination.
    const groupKey = group ? JSON.stringify([combination, group]) : undefined
    const grouped = groupKey ? rowByGroup.get(groupKey) : undefined
    if (grouped) {
      grouped.components.push(component)
      continue
    }
    const row: MealRow = {
      key: group ? `group:${component.id}` : `component:${component.id}`,
      combination,
      components: [component],
      options: [],
    }
    rows.push(row)
    if (groupKey) rowByGroup.set(groupKey, row)
  }
  for (const row of rows) {
    if (row.components.length > 1) {
      for (const component of row.components) {
        row.options.push({ key: `component:${component.id}`, type: 'component', component })
      }
    }
    for (const component of row.components) {
      for (const { scope, items, ...equivalence } of snapshot.equivalences) {
        if (scope.type !== 'component' || scope.componentId !== component.id) continue
        for (const item of items) {
          row.options.push({ key: `item:${item.id}`, type: 'item', item, replaces: component, equivalence })
        }
      }
    }
  }
  const meal = snapshot.equivalences.flatMap(({ scope, items, ...equivalence }) =>
    scope.type === 'meal' ? items.map((item) => ({ key: `item:${item.id}`, item, equivalence })) : [],
  )
  return { rows, combinations, meal }
}

function unresolvedMealChoices(
  options: MealSubstitutionOptions,
  choices: WeekMealChoices,
): number {
  if (choices.meal !== null) return 0
  let unresolved = Number(options.combinations.length > 0 && choices.combination === null)
  for (const row of options.rows) {
    if (
      row.components.length > 1 &&
      (row.combination === null || row.combination === choices.combination) &&
      choices.rows[row.key] === undefined
    ) unresolved += 1
  }
  return unresolved
}

function assertChoicesAllowed(snapshot: WeekMealSnapshot, choices: WeekMealChoices): void {
  const options = substitutionOptions(snapshot)
  const rowChoices = Object.entries(choices.rows)
  if (choices.meal !== null && (choices.combination !== null || rowChoices.length > 0)) {
    throw new HttpError('Sostituisci il pasto intero oppure scegli combinazione e alimenti, non entrambi.', 400)
  }
  const allowed =
    (choices.combination === null || options.combinations.includes(choices.combination)) &&
    (choices.meal === null || options.meal.some((option) => option.key === choices.meal)) &&
    rowChoices.every(([rowKey, optionKey]) =>
      options.rows.some(
        (row) =>
          row.key === rowKey &&
          (row.combination === null || row.combination === choices.combination) &&
          row.options.some((option) => option.key === optionKey),
      ),
    )
  if (!allowed) throw new HttpError('Sostituzione non prevista dal piano per questo pasto.', 400)
}

// ---------------------------------------------------------------------------
// Consultation
// ---------------------------------------------------------------------------

export function getWeek(weekStart?: string): WeekView {
  const today = todayInRome()
  const start = weekStart ?? addDays(today, -weekdayIndex(today))
  assertWeekStart(start)
  const dates = weekDates(start)
  const week = db.select().from(weeks).where(eq(weeks.weekStart, start)).get()
  const validVersionIds = dates.map((date) => planVersionForDate(date)?.id ?? null)
  const plans = new Map<number, PlanView>()
  const rows: WeekMealRow[] = week
    ? db.select().from(weekMeals).where(eq(weekMeals.weekId, week.id)).all()
    : dates.flatMap((date, index) => {
        const versionId = validVersionIds[index]
        return versionId === null ? [] : plannedMealRows(date, versionId, plans)
      })
  const versionIds = [
    ...new Set([
      ...validVersionIds.filter((id) => id !== null),
      ...rows.map((row) => row.sourceVersionId),
    ]),
  ]
  const versions = new Map(
    (versionIds.length === 0
      ? []
      : db
          .select({ id: planVersions.id, label: planVersions.label })
          .from(planVersions)
          .where(inArray(planVersions.id, versionIds))
          .all()
    ).map((version) => [version.id, version]),
  )
  const freeMeal =
    week?.freeMealDate && week.freeMealSlot
      ? { date: week.freeMealDate, slot: week.freeMealSlot, description: week.freeMealDescription }
      : null
  // The ISO week belongs to the year of its Thursday; week 1 holds the
  // year's first Thursday.
  const thursday = dates[3]
  const isoYear = Number(thursday.slice(0, 4))
  const isoWeek = Math.floor((Date.parse(`${thursday}T00:00:00Z`) - Date.UTC(isoYear, 0, 1)) / DAY_MS / 7) + 1

  return {
    weekStart: start,
    weekEnd: dates[6],
    previousWeekStart: addDays(start, -7),
    nextWeekStart: addDays(start, 7),
    isoYear,
    isoWeek,
    today,
    status: week ? 'confirmed' : 'unconfirmed',
    confirmedAt: week?.confirmedAt ?? null,
    freeMeal,
    days: dates.map((date, dayIndex) => {
      const dayRows = rows
        .filter((row) => row.date === date)
        .sort((left, right) => PLAN_SLOTS.indexOf(left.slot) - PLAN_SLOTS.indexOf(right.slot))
      const validVersionId = validVersionIds[dayIndex]
      let unresolvedChoices = 0
      const meals: WeekMealView[] = dayRows.map((row) => {
        const snapshot = JSON.parse(row.snapshotJson) as WeekMealSnapshot
        const choices = WeekMealChoicesSchema.parse(JSON.parse(row.choicesJson))
        const options = substitutionOptions(snapshot)
        const free = freeMeal?.date === date && freeMeal.slot === row.slot
          ? { description: freeMeal.description }
          : null
        if (!free) unresolvedChoices += unresolvedMealChoices(options, choices)
        return {
          slot: row.slot,
          sourceDayIndex: row.sourceDayIndex,
          sourceDayName: DAY_NAMES[row.sourceDayIndex],
          mealId: snapshot.mealId,
          page: snapshot.page,
          notes: snapshot.notes,
          rows: options.rows.map((option) => ({ ...option, choice: choices.rows[option.key] ?? null })),
          combinations: options.combinations,
          combinationChoice: choices.combination,
          mealOptions: options.meal,
          mealChoice: choices.meal,
          free,
        }
      })
      return {
        date,
        dayIndex,
        dayName: DAY_NAMES[dayIndex],
        past: date < today,
        ready: meals.length > 0 && unresolvedChoices === 0,
        unresolvedChoices,
        plannedVersion: dayRows[0] ? versions.get(dayRows[0].sourceVersionId) ?? null : null,
        validVersion: validVersionId === null ? null : versions.get(validVersionId) ?? null,
        meals,
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

// Exchanges whole planned meals (snapshot, choices, and the free meal) between
// the same slots of two dates. A day swap passes every slot; moving a meal
// passes one, so a meal never changes slot and nothing is copied or dropped.
export function swapWeekMeals(
  weekStart: string,
  [first, second]: [string, string],
  slots: readonly PlanSlot[],
): WeekView {
  assertWeekStart(weekStart)
  const today = todayInRome()
  assertChangeableDate(weekStart, first, today)
  assertChangeableDate(weekStart, second, today)
  if (first === second) throw new HttpError('Scegli due giorni diversi.', 400)
  db.transaction(() => {
    const week = savedWeek(weekStart)
    const rows = db
      .select()
      .from(weekMeals)
      .where(and(eq(weekMeals.weekId, week.id), inArray(weekMeals.date, [first, second]), inArray(weekMeals.slot, slots)))
      .all()
    if (rows.length !== slots.length * 2) {
      throw new HttpError('Uno dei due giorni non ha pasti pianificati da scambiare.', 409)
    }
    if (new Set(rows.map((row) => row.sourceVersionId)).size !== 1) {
      throw new HttpError('Puoi scambiare solo pasti della stessa versione del piano.', 409)
    }
    for (const slot of slots) {
      const firstRow = rows.find((row) => row.date === first && row.slot === slot)
      const secondRow = rows.find((row) => row.date === second && row.slot === slot)
      if (!firstRow || !secondRow) throw new HttpError('Uno dei due giorni non ha pasti pianificati da scambiare.', 409)
      for (const [target, source] of [
        [firstRow, secondRow],
        [secondRow, firstRow],
      ]) {
        db.update(weekMeals)
          .set({
            sourceVersionId: source.sourceVersionId,
            sourceDayIndex: source.sourceDayIndex,
            snapshotJson: source.snapshotJson,
            choicesJson: source.choicesJson,
          })
          .where(eq(weekMeals.id, target.id))
          .run()
      }
    }
    if (
      week.freeMealSlot !== null &&
      slots.includes(week.freeMealSlot) &&
      (week.freeMealDate === first || week.freeMealDate === second)
    ) {
      db.update(weeks)
        .set({ freeMealDate: week.freeMealDate === first ? second : first })
        .where(eq(weeks.id, week.id))
        .run()
    }
  })
  return getWeek(weekStart)
}

export function setWeekMealChoices(
  weekStart: string,
  date: string,
  slot: PlanSlot,
  choices: WeekMealChoices,
): WeekView {
  assertWeekStart(weekStart)
  assertChangeableDate(weekStart, date, todayInRome())
  db.transaction(() => {
    const week = savedWeek(weekStart)
    if (week.freeMealDate === date && week.freeMealSlot === slot) {
      throw new HttpError('Il pasto libero non ha alimenti da sostituire.', 409)
    }
    const row = db
      .select()
      .from(weekMeals)
      .where(and(eq(weekMeals.weekId, week.id), eq(weekMeals.date, date), eq(weekMeals.slot, slot)))
      .get()
    if (!row) throw new HttpError('Nessun pasto pianificato in questa data.', 409)
    const snapshot = JSON.parse(row.snapshotJson) as WeekMealSnapshot
    assertChoicesAllowed(snapshot, choices)
    db.update(weekMeals)
      .set({ choicesJson: JSON.stringify(choices) })
      .where(eq(weekMeals.id, row.id))
      .run()
  })
  return getWeek(weekStart)
}

// The free meal replaces the planned meal at a date and slot; it has no
// ingredients. Choosing another date or slot moves it, unless it is past.
export function setWeekFreeMeal(
  weekStart: string,
  date: string,
  slot: PlanSlot,
  description: string | null,
): WeekView {
  assertWeekStart(weekStart)
  const today = todayInRome()
  assertChangeableDate(weekStart, date, today)
  const text = description?.trim() || null
  if (text !== null && text.length > FREE_MEAL_DESCRIPTION_MAX_LENGTH) {
    throw new HttpError(`La descrizione può avere al massimo ${FREE_MEAL_DESCRIPTION_MAX_LENGTH} caratteri.`, 400)
  }
  db.transaction(() => {
    const week = savedWeek(weekStart)
    if (week.freeMealDate !== null && week.freeMealDate < today) {
      throw new HttpError('Il pasto libero di questa settimana è già passato.', 409)
    }
    const planned = db
      .select({ id: weekMeals.id })
      .from(weekMeals)
      .where(and(eq(weekMeals.weekId, week.id), eq(weekMeals.date, date), eq(weekMeals.slot, slot)))
      .get()
    if (!planned) throw new HttpError('Nessun pasto pianificato da sostituire in questa data.', 409)
    db.update(weeks)
      .set({ freeMealDate: date, freeMealSlot: slot, freeMealDescription: text })
      .where(eq(weeks.id, week.id))
      .run()
  })
  return getWeek(weekStart)
}

export function clearWeekFreeMeal(weekStart: string): WeekView {
  assertWeekStart(weekStart)
  const today = todayInRome()
  db.transaction(() => {
    const week = savedWeek(weekStart)
    if (week.freeMealDate === null) throw new HttpError('Non c’è un pasto libero da togliere.', 409)
    if (week.freeMealDate < today) throw new HttpError('Il pasto libero di questa settimana è già passato.', 409)
    db.update(weeks)
      .set({ freeMealDate: null, freeMealSlot: null, freeMealDescription: null })
      .where(eq(weeks.id, week.id))
      .run()
  })
  return getWeek(weekStart)
}

// Replans, from the version now valid, the dates from today on whose meals
// come from another version (a newer one started after confirmation). Their
// swaps and substitutions are dropped; other dates and the free meal stay.
export function refreshWeek(weekStart: string): WeekView {
  assertWeekStart(weekStart)
  const today = todayInRome()
  db.transaction(() => {
    const week = savedWeek(weekStart)
    const stored = db.select().from(weekMeals).where(eq(weekMeals.weekId, week.id)).all()
    const plans = new Map<number, PlanView>()
    let replanned = 0
    for (const date of weekDates(weekStart)) {
      if (date < today) continue
      const validVersionId = planVersionForDate(date)?.id ?? null
      const plannedVersionId = stored.find((row) => row.date === date)?.sourceVersionId ?? null
      if (validVersionId === null || validVersionId === plannedVersionId) continue
      db.delete(weekMeals)
        .where(and(eq(weekMeals.weekId, week.id), eq(weekMeals.date, date)))
        .run()
      db.insert(weekMeals)
        .values(plannedMealRows(date, validVersionId, plans).map((row) => ({ ...row, weekId: week.id })))
        .run()
      replanned += 1
    }
    if (replanned === 0) throw new HttpError('I giorni da oggi in poi seguono già il piano valido.', 409)
  })
  return getWeek(weekStart)
}

// Repeats last week's choices on the meals of this week, from today on, that
// still have open choices. A meal takes the choices of the same plan meal
// (version, plan day, and slot) last week, wherever it was moved, and only
// when they resolve it; swaps and the free meal are not repeated, so no meal
// is copied or dropped.
export function repeatPreviousWeekChoices(weekStart: string): WeekView {
  assertWeekStart(weekStart)
  const today = todayInRome()
  const previous = db.select().from(weeks).where(eq(weeks.weekStart, addDays(weekStart, -7))).get()
  if (!previous) throw new HttpError('La settimana scorsa non ha scelte salvate da ripetere.', 409)
  db.transaction(() => {
    const week = savedWeek(weekStart)
    const sources = db.select().from(weekMeals).where(eq(weekMeals.weekId, previous.id)).all()
    const rows = db.select().from(weekMeals).where(eq(weekMeals.weekId, week.id)).all()
    let repeated = 0
    for (const row of rows) {
      if (row.date < today) continue
      if (week.freeMealDate === row.date && week.freeMealSlot === row.slot) continue
      const snapshot = JSON.parse(row.snapshotJson) as WeekMealSnapshot
      const options = substitutionOptions(snapshot)
      if (unresolvedMealChoices(options, WeekMealChoicesSchema.parse(JSON.parse(row.choicesJson))) === 0) continue
      const source = sources.find(
        (candidate) =>
          candidate.slot === row.slot &&
          candidate.sourceVersionId === row.sourceVersionId &&
          candidate.sourceDayIndex === row.sourceDayIndex &&
          candidate.snapshotJson === row.snapshotJson,
      )
      if (!source) continue
      const choices = WeekMealChoicesSchema.parse(JSON.parse(source.choicesJson))
      if (unresolvedMealChoices(options, choices) > 0) continue
      assertChoicesAllowed(snapshot, choices)
      db.update(weekMeals).set({ choicesJson: JSON.stringify(choices) }).where(eq(weekMeals.id, row.id)).run()
      repeated += 1
    }
    if (repeated === 0) throw new HttpError('Nessuna scelta della settimana scorsa si applica ai pasti ancora da scegliere.', 409)
  })
  return getWeek(weekStart)
}
