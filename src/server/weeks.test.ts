import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { planComponents, planEquivalences, planEquivalenceItems, weekMeals, weeks } from '../db/schema'
import { HttpError } from './http'

test('days are ready once their choices are made, and last week\'s choices can be repeated', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mealio-weeks-test-'))
  const previousPath = process.env.DATABASE_PATH
  process.env.DATABASE_PATH = join(directory, 'weeks.sqlite')
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-18T10:00:00Z') })
  // The database and its consumers must load after setting the disposable path:
  // the singleton opens DATABASE_PATH at module initialization.
  const { db, sqlite } = await import('../db')
  const { activatePlanVersion, createPlanVersion, ensureMeal } = await import('./plans')
  const { clearWeekFreeMeal, ensureWeekSnapshot, getWeek, refreshWeek, repeatPreviousWeekChoices, setWeekFreeMeal, setWeekMealChoices, swapWeekMeals } = await import('./weeks')
  const { getGroceries } = await import('./groceries')
  try {
    migrate(db, { migrationsFolder: './drizzle' })
    const version = createPlanVersion('Dieta sintetica')
    for (let day = 0; day < 7; day += 1) {
      const breakfast = ensureMeal(version, day, 'breakfast')
      const lunch = ensureMeal(version, day, 'lunch')
      const dinner = ensureMeal(version, day, 'dinner')
      db.insert(planComponents).values([
        { mealId: breakfast, position: 0, label: 'Yogurt', quantity: 125, quantityText: '125', unitText: 'g', alternativeGroup: 'base', state: 'raw' },
        { mealId: breakfast, position: 1, label: 'Latte', quantity: 150, quantityText: '150', unitText: 'ml', alternativeGroup: 'base', state: 'raw' },
        { mealId: lunch, position: 0, label: 'Olio', quantity: 10, quantityText: '10', unitText: 'g', alternativeGroup: day === 6 ? 'condimento' : null, state: 'raw' },
        { mealId: lunch, position: 1, label: 'Pasta', quantity: 80, quantityText: '80', unitText: 'g', combination: 'Pasta e ceci', state: 'raw' },
        { mealId: lunch, position: 2, label: 'Ceci', quantity: 120, quantityText: '120', unitText: 'g', combination: 'Pasta e ceci', state: 'raw' },
        { mealId: lunch, position: 3, label: 'Riso', quantity: 70, quantityText: '70', unitText: 'g', combination: 'Riso e lenticchie', alternativeGroup: day === 6 ? 'cereali' : null, state: 'raw' },
        { mealId: lunch, position: 4, label: 'Lenticchie', quantity: 130, quantityText: '130', unitText: 'g', combination: 'Riso e lenticchie', state: 'raw' },
        { mealId: dinner, position: 0, label: `Cena ${day + 1}`, quantity: day + 1, quantityText: String(day + 1), state: 'raw' },
      ]).run()
      if (day === 6) {
        db.insert(planComponents).values([
          { mealId: lunch, position: 5, label: 'Burro', quantity: 10, alternativeGroup: 'condimento', state: 'raw' },
          { mealId: lunch, position: 6, label: 'Farro', quantity: 70, combination: 'Riso e lenticchie', alternativeGroup: 'cereali', state: 'raw' },
        ]).run()
      }
    }
    activatePlanVersion(version, '2026-10-01')
    const start = '2026-10-19'
    const preview = getWeek(start)
    const breakfast = preview.days[0]!.meals.find((meal) => meal.slot === 'breakfast')!
    assert.equal(breakfast.rows[0]!.choice, null)
    assert.equal(preview.days[0]!.meals.find((meal) => meal.slot === 'lunch')!.combinationChoice, null)
    assert.equal(preview.days[0]!.unresolvedChoices, 2)
    assert.ok(preview.days.every((day) => !day.ready))
    assert.deepEqual(db.select().from(weeks).all(), [])
    const grocery = getGroceries(start)
    assert.equal(grocery.planned, true)
    assert.equal(grocery.unplannedDays.length, 7)
    assert.equal(grocery.unplannedDays[0]!.unresolvedChoices, 2)
    assert.deepEqual(grocery.rounds.flatMap((round) => round.aisles), [])

    // A failed first edit leaves no snapshot.
    assert.throws(() => setWeekMealChoices(start, start, 'lunch', {
      combination: 'Non prevista dalla dieta', meal: null, rows: {},
    }), (cause) => cause instanceof HttpError && cause.status === 400)
    assert.deepEqual(db.select().from(weeks).all(), [])

    // A day becomes ready, and enters groceries, as soon as its last choice is made.
    const selected = setWeekMealChoices(start, start, 'lunch', { combination: 'Riso e lenticchie', meal: null, rows: {} })
    assert.ok(selected.days.every((day) => !day.ready))
    assert.equal(selected.days[1]!.meals.find((meal) => meal.slot === 'lunch')!.combinationChoice, null)
    assert.deepEqual(getGroceries(start).rounds.flatMap((round) => round.aisles), [])
    const yogurt = breakfast.rows[0]!.options.find((option) => option.type === 'component' && option.component.label === 'Yogurt')!
    const ready = setWeekMealChoices(start, start, 'breakfast', { combination: null, meal: null, rows: { [breakfast.rows[0]!.key]: yogurt.key } })
    assert.equal(ready.days[0]!.unresolvedChoices, 0)
    assert.equal(ready.days[0]!.ready, true)
    assert.ok(ready.days.slice(1).every((day) => !day.ready))
    const readyFoods = getGroceries(start).rounds.flatMap((round) => round.aisles.flatMap((aisle) => aisle.lines))
    assert.equal(readyFoods.find((food) => food.name === 'Riso')!.needed, 70)
    assert.equal(readyFoods.some((food) => food.name === 'Pasta' || food.name === 'Latte'), false)
    assert.equal(getGroceries(start).unplannedDays.length, 6)

    function completeDay(date: string) {
      const meal = getWeek(start).days.find((day) => day.date === date)!.meals.find((candidate) => candidate.slot === 'breakfast')!
      const row = meal.rows[0]!
      const choice = row.options.find((option) => option.type === 'component' && option.component.label === 'Yogurt')!
      setWeekMealChoices(start, date, 'breakfast', { combination: null, meal: null, rows: { [row.key]: choice.key } })
      return setWeekMealChoices(start, date, 'lunch', { combination: 'Pasta e ceci', meal: null, rows: {} })
    }
    completeDay('2026-10-20')
    completeDay('2026-10-21')
    assert.deepEqual(getWeek(start).days.slice(0, 4).map((day) => day.ready), [true, true, true, false])

    // Reopening a choice makes only that day not ready; nothing is filled from the plan.
    const cleared = setWeekMealChoices(start, start, 'lunch', { combination: null, meal: null, rows: {} })
    assert.equal(cleared.days[0]!.ready, false)
    assert.equal(cleared.days[0]!.unresolvedChoices, 1)
    assert.equal(cleared.days[1]!.ready, true)
    setWeekMealChoices(start, start, 'lunch', { combination: 'Riso e lenticchie', meal: null, rows: {} })

    // Moving a meal swaps it with the same slot: nothing is copied or dropped.
    const moved = swapWeekMeals(start, [start, '2026-10-20'], ['lunch'])
    assert.equal(moved.days[0]!.meals.find((meal) => meal.slot === 'lunch')!.combinationChoice, 'Pasta e ceci')
    assert.equal(moved.days[1]!.meals.find((meal) => meal.slot === 'lunch')!.combinationChoice, 'Riso e lenticchie')
    assert.equal(moved.days[0]!.meals.find((meal) => meal.slot === 'dinner')!.rows[0]!.components[0]!.label, 'Cena 1')
    assert.deepEqual(moved.days.slice(0, 2).map((day) => day.ready), [true, true])
    assert.equal(db.select().from(weekMeals).all().length, 35)

    // A free meal resolves its slot and follows nothing else.
    setWeekFreeMeal(start, '2026-10-22', 'lunch', 'Pasto sintetico')
    assert.equal(getWeek(start).days[3]!.unresolvedChoices, 1)
    clearWeekFreeMeal(start)
    assert.equal(getWeek(start).days[3]!.unresolvedChoices, 2)

    // Count shared and selected-set alternatives, not rows in unselected sets.
    const sunday = '2026-10-25'
    assert.equal(getWeek(start).days[6]!.unresolvedChoices, 3)
    setWeekMealChoices(start, sunday, 'lunch', { combination: 'Riso e lenticchie', meal: null, rows: {} })
    setWeekFreeMeal(start, sunday, 'breakfast', null)
    assert.equal(getWeek(start).days[6]!.unresolvedChoices, 2)
    const sundayLunch = getWeek(start).days[6]!.meals.find((meal) => meal.slot === 'lunch')!
    const oil = sundayLunch.rows.find((row) => row.components.some((food) => food.label === 'Olio'))!
    const rice = sundayLunch.rows.find((row) => row.components.some((food) => food.label === 'Riso'))!
    const decided = setWeekMealChoices(start, sunday, 'lunch', {
      combination: 'Riso e lenticchie', meal: null, rows: {
        [oil.key]: `component:${oil.components.find((food) => food.label === 'Olio')!.id}`,
        [rice.key]: `component:${rice.components.find((food) => food.label === 'Riso')!.id}`,
      },
    })
    assert.equal(decided.days[6]!.unresolvedChoices, 0)
    assert.equal(decided.days[6]!.ready, true)
    clearWeekFreeMeal(start)
    assert.equal(getWeek(start).days[6]!.unresolvedChoices, 1)
    assert.equal(getWeek(start).days[6]!.ready, false)

    // Repeating last week copies the choices of the same plan meals, only where
    // they are still open, and never swaps.
    const next = '2026-10-26'
    // A choice already made this week is never replaced: next Sunday's lunch
    // picked another combination, so last week's choices do not apply to it.
    setWeekMealChoices(next, '2026-11-01', 'lunch', { combination: 'Pasta e ceci', meal: null, rows: {} })
    const repeated = repeatPreviousWeekChoices(next)
    assert.equal(repeated.days[6]!.meals.find((meal) => meal.slot === 'lunch')!.combinationChoice, 'Pasta e ceci')
    // Last week's Monday/Tuesday lunches were swapped: each plan meal keeps its own choice.
    assert.equal(repeated.days[0]!.meals.find((meal) => meal.slot === 'lunch')!.combinationChoice, 'Riso e lenticchie')
    assert.equal(repeated.days[1]!.meals.find((meal) => meal.slot === 'lunch')!.combinationChoice, 'Pasta e ceci')
    assert.equal(repeated.days[0]!.meals.find((meal) => meal.slot === 'lunch')!.sourceDayIndex, 0)
    assert.deepEqual(repeated.days.map((day) => day.ready), [true, true, true, false, false, false, false])
    // Sunday: the open breakfast, plus the lunch left open on its own variant.
    assert.equal(repeated.days[6]!.unresolvedChoices, 2)
    assert.throws(() => repeatPreviousWeekChoices(next), (cause) => cause instanceof HttpError && cause.status === 409)
    assert.throws(() => repeatPreviousWeekChoices('2026-11-09'), (cause) => cause instanceof HttpError && cause.status === 409)

    // Refresh replans only dates whose source plan actually changes.
    const updatedVersion = createPlanVersion('Nuova dieta sintetica')
    for (let day = 0; day < 7; day += 1) {
      db.insert(planComponents).values({
        mealId: ensureMeal(updatedVersion, day, 'lunch'), position: 0, label: 'Nuovo pranzo', quantity: null, state: 'raw',
      }).run()
    }
    // Optional scoped equivalences never become required choices.
    const dinner = ensureMeal(updatedVersion, 0, 'dinner')
    const equivalence = db.insert(planEquivalences).values({ versionId: updatedVersion, scopeMealId: dinner }).returning().get()
    db.insert(planEquivalenceItems).values({ equivalenceId: equivalence.id, position: 0, label: 'Equivalenza facoltativa', quantity: null }).run()
    activatePlanVersion(updatedVersion, '2026-10-22')
    const refreshed = refreshWeek(start)
    assert.equal(refreshed.days[0]!.ready, true)
    assert.equal(refreshed.days[2]!.ready, true)
    assert.equal(refreshed.days[3]!.plannedVersion!.id, updatedVersion)
    assert.equal(refreshed.days[3]!.meals.find((meal) => meal.slot === 'lunch')!.combinationChoice, null)
    // A day without required choices is ready without any action.
    const future = getWeek('2026-11-02')
    assert.equal(future.days[0]!.ready, true)
    assert.equal(future.days[0]!.meals.find((meal) => meal.slot === 'dinner')!.mealChoice, null)

    // Missing slots and quantities remain explicit; they are never invented.
    const incompleteVersion = createPlanVersion('Dieta sintetica parziale')
    db.insert(planComponents).values({
      mealId: ensureMeal(incompleteVersion, 0, 'lunch'), position: 0, label: 'Solo pranzo', quantity: null, state: 'raw',
    }).run()
    activatePlanVersion(incompleteVersion, '2026-11-04')
    const partial = getWeek('2026-11-09')
    assert.equal(partial.days[0]!.ready, true)
    assert.deepEqual(partial.days[0]!.meals.find((meal) => meal.slot === 'breakfast')!.rows, [])
    assert.equal(partial.days[0]!.meals.find((meal) => meal.slot === 'lunch')!.rows[0]!.components[0]!.quantity, null)
    assert.throws(() => swapWeekMeals('2026-11-02', ['2026-11-02', '2026-11-05'], ['lunch']),
      (cause) => cause instanceof HttpError && cause.status === 409)

    // An untouched week follows the active diet until its first real use
    // (a check-in or a purchase) freezes it: a later diet then no longer
    // replaces its meals silently, it is offered instead.
    const used = '2026-11-16'
    assert.equal(getWeek(used).status, 'unconfirmed')
    ensureWeekSnapshot('2026-11-17')
    assert.equal(getWeek(used).status, 'confirmed')
    const laterVersion = createPlanVersion('Dieta sintetica successiva')
    db.insert(planComponents).values({
      mealId: ensureMeal(laterVersion, 2, 'lunch'), position: 0, label: 'Pranzo successivo', quantity: null, state: 'raw',
    }).run()
    activatePlanVersion(laterVersion, '2026-11-18')
    const frozen = getWeek(used)
    assert.equal(frozen.days[2]!.plannedVersion!.id, incompleteVersion)
    assert.equal(frozen.days[2]!.validVersion!.id, laterVersion)
    // Past weeks are never frozen after the fact.
    const before = db.select().from(weeks).all().length
    ensureWeekSnapshot('2026-10-05')
    assert.equal(db.select().from(weeks).all().length, before)

    // Days before the first diet have no meals and are never ready.
    t.mock.timers.setTime(new Date('2026-09-27T10:00:00Z').getTime())
    assert.equal(getWeek('2026-09-28').days[0]!.ready, false)
    assert.equal(getWeek('2026-09-28').status, 'unconfirmed')

    t.mock.timers.setTime(new Date('2026-10-27T10:00:00Z').getTime())
    assert.throws(() => setWeekMealChoices(start, start, 'lunch', { combination: null, meal: null, rows: {} }),
      (cause) => cause instanceof HttpError && cause.status === 409)
    assert.equal(getWeek(start).days[1]!.meals.find((meal) => meal.slot === 'lunch')!.combinationChoice, 'Riso e lenticchie')
  } finally {
    sqlite.close()
    t.mock.timers.reset()
    if (previousPath === undefined) delete process.env.DATABASE_PATH
    else process.env.DATABASE_PATH = previousPath
    rmSync(directory, { recursive: true, force: true })
  }
})
