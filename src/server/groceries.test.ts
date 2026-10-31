import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { planComponents, type PlanComponentState, type PlanSlot } from '../db/schema'
import type { GroceryView } from './groceries'
import { HttpError } from './http'

type SyntheticFood = {
  label: string
  quantity: number | null
  quantityText?: string
  unitText: string | null
  unitId?: number
  state?: PlanComponentState
  alternativeGroup?: string
}

function line(view: GroceryView, round: 'monday' | 'thursday', name: string) {
  return view.rounds
    .find((candidate) => candidate.round === round)!
    .aisles.flatMap((aisle) => aisle.lines)
    .find((candidate) => candidate.name === name)
}

test('groceries follow the planned week, explicit food rules, pantry, and purchases', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mealio-groceries-test-'))
  const previousPath = process.env.DATABASE_PATH
  process.env.DATABASE_PATH = join(directory, 'groceries.sqlite')
  // Sunday in Europe/Rome: the whole next week can still be planned.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-18T10:00:00Z') })
  // The database singleton opens DATABASE_PATH when first imported: it and the
  // modules using it load only after the disposable path is set.
  const { db, sqlite } = await import('../db')
  try {
    migrate(db, { migrationsFolder: './drizzle' })
    const { getOrCreateUnit } = await import('./catalog')
    const { activatePlanVersion, createPlanVersion, ensureMeal } = await import('./plans')
    const { clearWeekFreeMeal, confirmDay, getWeek, setWeekFreeMeal, setWeekMealChoices, swapWeekMeals } = await import('./weeks')
    const groceries = await import('./groceries')

    const version = createPlanVersion('Piano sintetico')
    function plan(dayIndex: number, slot: PlanSlot, foods: SyntheticFood[]) {
      const mealId = ensureMeal(version, dayIndex, slot)
      foods.forEach((food, position) => {
        db.insert(planComponents)
          .values({
            mealId,
            position,
            label: food.label,
            quantity: food.quantity,
            quantityText: food.quantityText ?? (food.quantity === null ? null : String(food.quantity)),
            unitText: food.unitText,
            unitId: food.unitId ?? null,
            state: food.state ?? 'raw',
            alternativeGroup: food.alternativeGroup ?? null,
          })
          .run()
      })
    }
    // As at import, a printed unit matching a catalog unit's name links to it.
    const vasetto = getOrCreateUnit('vasetto', 'vasetti')
    for (let day = 0; day < 7; day += 1) {
      plan(day, 'breakfast', [
        day === 0
          ? { label: 'Yogurt bianco', quantity: 2, unitText: 'vasetti', unitId: vasetto }
          : { label: 'Yogurt bianco', quantity: 1, unitText: 'vasetto' },
      ])
      plan(day, 'lunch', [
        { label: 'Pasta integrale', quantity: 80, unitText: 'g' },
        { label: "Olio extravergine d'oliva", quantity: 1, unitText: 'cucchiaio' },
      ])
    }
    plan(0, 'dinner', [{ label: 'Petto di pollo', quantity: 150, unitText: 'g' }])
    plan(1, 'dinner', [{ label: 'Uova', quantity: 2, unitText: null }])
    plan(2, 'dinner', [
      { label: 'Merluzzo', quantity: 200, unitText: 'g', alternativeGroup: 'secondo' },
      { label: 'Salmone', quantity: 150, unitText: 'g', alternativeGroup: 'secondo' },
    ])
    plan(3, 'dinner', [{ label: 'Riso basmati', quantity: 150, unitText: 'g', state: 'cooked' }])
    plan(4, 'dinner', [{ label: 'Petto di pollo', quantity: 150, unitText: 'gr' }])
    plan(5, 'dinner', [{ label: 'Pane integrale', quantity: null, quantityText: 'q.b.', unitText: null }])
    plan(6, 'dinner', [{ label: 'Petto di pollo', quantity: 0.2, quantityText: '0,2', unitText: 'kg' }])
    activatePlanVersion(version, '2026-10-01')
    const weekStart = '2026-10-19'

    // Diet availability keeps manual actions reachable, but drafts contribute no foods.
    const original = groceries.getGroceries(weekStart)
    assert.equal(original.weekStatus, 'unconfirmed')
    assert.equal(original.planned, true)
    assert.equal(original.unplannedDays.length, 7)
    assert.deepEqual(original.openChoices, [])
    assert.equal(line(original, 'monday', 'Merluzzo'), undefined)
    assert.deepEqual(original.foods, [])
    // Manual items are separate from the derived list; retrying an addition adds nothing.
    const item = { weekStart, round: 'thursday' as const, id: randomUUID(), label: 'Detersivo', quantityText: null }
    groceries.addGroceryManualItem(item)
    assert.equal(groceries.addGroceryManualItem(item).rounds[1]!.manual.length, 1)
    const ticked = groceries.setGroceryManualItemChecked({ weekStart, id: item.id, checked: true })
    assert.notEqual(ticked.rounds[1]!.manual[0]!.checkedAt, null)
    assert.deepEqual(groceries.deleteGroceryManualItem({ weekStart, id: item.id }).rounds[1]!.manual, [])

    setWeekFreeMeal(weekStart, '2026-10-24', 'lunch', null)
    const fish = getWeek(weekStart).days[2]!.meals.find((meal) => meal.slot === 'dinner')!.rows[0]!
    const salmon = fish.options.find((option) => option.type === 'component' && option.component.label === 'Salmone')!
    setWeekMealChoices(weekStart, '2026-10-21', 'dinner', { combination: null, meal: null, rows: { [fish.key]: salmon.key } })
    assert.equal(line(groceries.getGroceries(weekStart), 'monday', 'Salmone'), undefined)
    for (const day of getWeek(weekStart).days) confirmDay(weekStart, day.date)

    const planned = groceries.getGroceries(weekStart)
    assert.deepEqual(planned.openChoices, [])
    assert.deepEqual(planned.freeMeal, { date: '2026-10-24', dayName: 'Sabato', slot: 'lunch' })
    // Before Thursday everything goes on Monday; without storage rules, later uses go on Thursday.
    assert.equal(line(planned, 'monday', 'Pasta integrale')?.needed, 240)
    // The free meal on Saturday removes that lunch from Thursday's round.
    assert.equal(line(planned, 'thursday', 'Pasta integrale')?.needed, 240)
    assert.equal(line(planned, 'monday', 'Salmone')?.uses[0]?.substitution, 'alternative')
    // Metric spellings are exact: 150 gr and 0.2 kg add up in grams.
    assert.deepEqual(
      [line(planned, 'thursday', 'Petto di pollo')?.unit, line(planned, 'thursday', 'Petto di pollo')?.toBuy],
      ['g', 350],
    )
    const rice = line(planned, 'thursday', 'Riso basmati')!
    assert.deepEqual([rice.cooked, rice.needed, rice.toBuy], [true, 150, null])
    const bread = line(planned, 'thursday', 'Pane integrale')!
    assert.deepEqual([bread.unquantifiedUses, bread.needed, bread.toBuy], [1, null, null])
    // A jar is not converted without a rule for that food; the catalog unit
    // sums «2 vasetti» with «1 vasetto», and the use keeps the printed unit.
    const jars = line(planned, 'monday', 'Yogurt bianco')!
    assert.deepEqual([jars.unit, jars.needed, jars.uses[0]!.unitText], ['vasetto', 4, 'vasetti'])

    // Pantry and checkmarks recorded under a plan label follow it into the catalog.
    groceries.setGroceryPantry({ weekStart, foodKey: 'label:pasta integrale', unit: 'g', name: 'Pasta integrale', quantity: 100 })
    groceries.setGroceryCheck({ weekStart, round: 'monday', foodKey: 'label:uova', unit: '', cooked: false, name: 'Uova', quantity: 2 })
    groceries.setGroceryCheck({
      weekStart,
      round: 'thursday',
      foodKey: 'label:petto di pollo',
      unit: 'g',
      cooked: false,
      name: 'Petto di pollo',
      quantity: 350,
    })
    const rules = { weekStart, aisle: null, unit: null, packageSize: null, storageDays: null, alwaysAtHome: false, conversions: [] }
    groceries.setGroceryFoodRules({ ...rules, foodKey: 'label:pasta integrale', aisle: 'Dispensa', unit: 'g', packageSize: 500, storageDays: 365 })
    groceries.setGroceryFoodRules({
      ...rules,
      foodKey: 'label:yogurt bianco',
      aisle: 'Frigo',
      unit: 'g',
      packageSize: 500,
      storageDays: 7,
      conversions: [{ unit: 'vasetto', factor: 125 }],
    })
    const ruled = groceries.setGroceryFoodRules({ ...rules, foodKey: "label:olio extravergine d'oliva", alwaysAtHome: true })
    const pasta = line(ruled, 'monday', 'Pasta integrale')!
    // Kept for a year, all six lunches are bought on Monday: 480 g minus 100 g at home, in 500 g packages.
    assert.deepEqual(
      [pasta.needed, pasta.pantry, pasta.packages, pasta.toBuy, pasta.surplus],
      [480, 100, 1, 500, 120],
    )
    assert.equal(line(ruled, 'thursday', 'Pasta integrale'), undefined)
    const yogurt = line(ruled, 'monday', 'Yogurt bianco')!
    // 8 jars of 125 g fill exactly two 500 g packages: no extra package, no surplus.
    assert.deepEqual([yogurt.unit, yogurt.needed, yogurt.packages, yogurt.surplus], ['g', 1000, 2, 0])
    assert.equal(line(ruled, 'monday', "Olio extravergine d'oliva"), undefined)
    assert.deepEqual(
      ruled.alwaysAtHome.map((key) => ruled.foods.find((food) => food.key === key)?.name),
      ["Olio extravergine d'oliva"],
    )
    assert.deepEqual(
      ruled.rounds[0]!.aisles.map((aisle) => aisle.name),
      ['Dispensa', 'Frigo', null],
    )
    assert.throws(
      () => groceries.setGroceryFoodRules({ ...rules, foodKey: 'label:uova', unit: 'kg' }),
      (cause) => cause instanceof HttpError && cause.status === 400,
    )
    assert.throws(
      () => groceries.setGroceryFoodRules({ ...rules, foodKey: 'label:uova', packageSize: 6 }),
      (cause) => cause instanceof HttpError && cause.status === 400,
    )

    // After a week change, purchases show what to add and what is no longer needed.
    groceries.setGroceryCheck({ weekStart, round: 'monday', foodKey: pasta.foodKey, unit: 'g', cooked: false, name: pasta.name, quantity: 500 })
    const swapped = swapWeekMeals(weekStart, ['2026-10-20', '2026-10-23'], ['breakfast', 'morning_snack', 'lunch', 'afternoon_snack', 'dinner'])
    assert.equal(swapped.days[1]!.meals.find((meal) => meal.slot === 'dinner')!.rows[0]!.components[0]!.label, 'Petto di pollo')
    const draft = groceries.getGroceries(weekStart)
    assert.deepEqual(draft.unplannedDays.map((day) => day.date), ['2026-10-20', '2026-10-23'])
    assert.equal(line(draft, 'thursday', 'Uova'), undefined)
    assert.equal(line(draft, 'monday', 'Petto di pollo')?.needed, 150)
    confirmDay(weekStart, '2026-10-20')
    confirmDay(weekStart, '2026-10-23')
    const changed = groceries.getGroceries(weekStart)
    assert.equal(line(changed, 'monday', 'Petto di pollo')?.toBuy, 300)
    const chicken = line(changed, 'thursday', 'Petto di pollo')!
    assert.deepEqual([chicken.toBuy, chicken.check?.quantity, chicken.delta], [200, 350, -150])
    assert.deepEqual(changed.rounds[0]!.noLongerNeeded, [
      { foodKey: 'label:uova', name: 'Uova', unit: '', cooked: false, quantity: 2 },
    ])
    assert.equal(line(changed, 'thursday', 'Uova')?.needed, 2)
    assert.equal(line(changed, 'monday', 'Pasta integrale')?.delta, 0)

    groceries.setGroceryPantry({ weekStart, foodKey: pasta.foodKey, unit: 'g', name: pasta.name, quantity: null })
    clearWeekFreeMeal(weekStart)
    assert.equal(groceries.getGroceries(weekStart).unplannedDays.some((day) => day.date === '2026-10-24'), true)
    confirmDay(weekStart, '2026-10-24')
    const more = line(groceries.getGroceries(weekStart), 'monday', 'Pasta integrale')!
    assert.deepEqual([more.needed, more.packages, more.toBuy, more.delta], [560, 2, 1000, 500])
    const cleared = groceries.clearGroceryCheck({ weekStart, round: 'monday', foodKey: 'label:uova', unit: '', cooked: false })
    assert.deepEqual(cleared.rounds[0]!.noLongerNeeded, [])

  } finally {
    sqlite.close()
    t.mock.timers.reset()
    if (previousPath === undefined) delete process.env.DATABASE_PATH
    else process.env.DATABASE_PATH = previousPath
    rmSync(directory, { recursive: true, force: true })
  }
})
