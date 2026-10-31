import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { DiaryMutation } from '../diary'
import { HttpError } from './http'

test('diary preserves recorded plans, retries once, and synchronizes past offline check-ins atomically', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mealio-diary-test-'))
  const previousPath = process.env.DATABASE_PATH
  process.env.DATABASE_PATH = join(directory, 'diary.sqlite')
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-17T10:00:00Z') })
  // The database singleton must load only after the disposable path is set.
  const { db, sqlite } = await import('../db')
  try {
    migrate(db, { migrationsFolder: './drizzle' })
    const { diaryPlanSnapshots, mealCheckIns, PLAN_SLOTS } = await import('../db/schema')
    const { createPlanVersion, ensureMeal, addComponent, activatePlanVersion } = await import('./plans')
    const { confirmDay, getWeek, setWeekFreeMeal } = await import('./weeks')
    const { DiaryConflictError, getDiaryDay, saveDiaryCheckIns } = await import('./diary')
    const version = createPlanVersion('Piano sintetico')
    for (let day = 0; day < 7; day += 1) {
      for (const slot of PLAN_SLOTS) {
        addComponent(ensureMeal(version, day, slot), { label: `Alimento sintetico ${slot}`, quantity: 80, state: 'raw' })
      }
    }
    activatePlanVersion(version, '2026-10-01')
    const draft = getDiaryDay('2026-10-19')
    assert.deepEqual(draft.meals, [])
    assert.deepEqual(getDiaryDay().meals, [])
    confirmDay('2026-10-19', '2026-10-19')
    const preview = getDiaryDay('2026-10-19')
    assert.equal(preview.today, '2026-10-17')
    assert.equal(preview.date, '2026-10-19')
    assert.deepEqual(preview.meals.map((meal) => meal.plan.slot), [...PLAN_SLOTS])
    assert.equal(preview.meals.find((meal) => meal.plan.slot === 'lunch')!.plan.rows[0]!.components[0]!.label, 'Alimento sintetico lunch')
    assert.throws(() => saveDiaryCheckIns({
      id: randomUUID(), date: preview.date, snapshotId: preview.snapshotId,
      entries: [{ slot: 'lunch', followed: true, note: null, recordedAt: Date.parse('2026-10-19T10:00:00Z'), baseRevision: 0 }],
    }), (cause) => cause instanceof HttpError && cause.status === 400)
    assert.equal(getDiaryDay(preview.date).meals.find((meal) => meal.plan.slot === 'lunch')!.checkIn, null)

    const historyDate = '2026-10-16'
    const historyDay = getDiaryDay(historyDate)
    const historicalMeals = getWeek(historyDay.weekStart).days.find((day) => day.date === historyDate)!.meals
    function snapshotWithLabel(label: string) {
      return {
        date: historyDay.date,
        weekStart: historyDay.weekStart,
        weekStatus: historyDay.weekStatus,
        plannedVersion: historyDay.plannedVersion,
        validVersion: historyDay.validVersion,
        meals: historicalMeals.map((plan) => ({
          ...plan,
          rows: plan.rows.map((row, rowIndex) => rowIndex === 0
            ? {
                ...row,
                components: row.components.map((component, componentIndex) => componentIndex === 0
                  ? { ...component, label: `${label} ${plan.slot}` }
                  : component),
              }
            : row),
        })),
      }
    }
    const firstPlan = snapshotWithLabel('Piano del primo check-in')
    const secondPlan = snapshotWithLabel('Piano del secondo check-in')
    const firstSnapshotId = createHash('sha256').update(JSON.stringify(firstPlan)).digest('hex')
    const secondSnapshotId = createHash('sha256').update(JSON.stringify(secondPlan)).digest('hex')
    db.insert(diaryPlanSnapshots).values([
      { id: firstSnapshotId, date: historyDate, snapshotJson: JSON.stringify(firstPlan) },
      { id: secondSnapshotId, date: historyDate, snapshotJson: JSON.stringify(secondPlan) },
    ]).run()
    const createdAt = Date.now()
    for (const [slot, snapshotId] of [['lunch', firstSnapshotId], ['dinner', secondSnapshotId]] as const) {
      db.insert(mealCheckIns).values({
        date: historyDate,
        slot,
        snapshotId,
        followed: true,
        note: null,
        recordedAt: Date.parse('2026-10-16T10:00:00Z'),
        createdAt,
        revision: 1,
      }).run()
    }
    const tiedHistory = getDiaryDay(historyDate)
    assert.deepEqual(tiedHistory.meals.map((meal) => meal.plan.slot), ['lunch', 'dinner'])
    assert.equal(tiedHistory.meals[0]!.plan.rows[0]!.components[0]!.label, 'Piano del primo check-in lunch')
    assert.equal(tiedHistory.meals[1]!.plan.rows[0]!.components[0]!.label, 'Piano del secondo check-in dinner')
    const historicalEdit = saveDiaryCheckIns({
      id: randomUUID(), date: historyDate, snapshotId: secondSnapshotId,
      entries: [{ slot: 'lunch', followed: false, note: 'Correzione storica', recordedAt: Date.parse('2026-10-16T10:00:00Z'), baseRevision: 1 }],
    })
    assert.equal(historicalEdit.meals[0]!.checkIn!.revision, 2)
    assert.equal(historicalEdit.meals[0]!.plan.rows[0]!.components[0]!.label, 'Piano del primo check-in lunch')
    assert.throws(() => saveDiaryCheckIns({
      id: randomUUID(), date: historyDate, snapshotId: firstSnapshotId,
      entries: [{ slot: 'breakfast', followed: true, note: null, recordedAt: Date.parse('2026-10-16T10:00:00Z'), baseRevision: 0 }],
    }), (cause) => cause instanceof HttpError && cause.status === 409)

    confirmDay(historyDay.weekStart, '2026-10-17')
    const original = getDiaryDay()
    const breakfast = original.meals.find((meal) => meal.plan.slot === 'breakfast')!
    assert.equal(breakfast.checkIn, null)
    const first: DiaryMutation = {
      id: randomUUID(), date: original.date, snapshotId: original.snapshotId,
      entries: [{ slot: 'breakfast', followed: true, note: null, recordedAt: Date.now(), baseRevision: 0 }],
    }
    saveDiaryCheckIns(first)
    const correction: DiaryMutation = {
      ...first, id: randomUUID(),
      entries: [{ ...first.entries[0]!, followed: false, note: 'Eccezione sintetica', baseRevision: 1 }],
    }
    saveDiaryCheckIns(correction)
    // A lost-response retry cannot overwrite a newer correction.
    const retried = saveDiaryCheckIns(first).meals.find((meal) => meal.plan.slot === 'breakfast')!
    assert.deepEqual(retried.checkIn, { followed: false, note: 'Eccezione sintetica', recordedAt: Date.now(), revision: 2 })
    assert.throws(() => saveDiaryCheckIns({ ...first, entries: correction.entries }), (cause) => cause instanceof HttpError && cause.status === 409)

    // Publishing was explicit; a subsequent edit makes unrecorded slots drafts again.
    setWeekFreeMeal(original.weekStart, original.date, 'breakfast', 'Descrizione sintetica')
    const changed = getDiaryDay()
    // Planner changes cannot turn the recorded breakfast into a free meal.
    assert.deepEqual(changed.meals.find((meal) => meal.plan.slot === 'breakfast')!.plan, breakfast.plan)
    assert.deepEqual(changed.meals.map((meal) => meal.plan.slot), ['breakfast'])
    assert.throws(() => saveDiaryCheckIns({
      ...first, id: randomUUID(), entries: [
        { slot: 'lunch', followed: true, note: null, recordedAt: Date.now(), baseRevision: 0 },
      ],
    }), (cause) => cause instanceof HttpError && cause.status === 409 && cause.message.includes('non è pianificato'))
    // Recorded slots remain editable without republishing or changing their snapshot.
    const recordedEdit = saveDiaryCheckIns({
      ...first, id: randomUUID(), entries: [{ ...correction.entries[0]!, baseRevision: 2 }],
    })
    assert.equal(recordedEdit.meals[0]!.checkIn!.revision, 3)
    assert.deepEqual(recordedEdit.meals[0]!.plan, breakfast.plan)
    confirmDay(original.weekStart, original.date)
    assert.throws(() => saveDiaryCheckIns({
      ...first, id: randomUUID(), entries: [
        { slot: 'lunch', followed: true, note: null, recordedAt: Date.now(), baseRevision: 0 },
        { ...first.entries[0]!, baseRevision: 0 },
      ],
    }), DiaryConflictError)
    assert.equal(getDiaryDay().meals.find((meal) => meal.plan.slot === 'lunch')!.checkIn, null)

    const queued: DiaryMutation = {
      ...first, id: randomUUID(), entries: [{ slot: 'lunch', followed: true, note: 'Registrato offline', recordedAt: Date.now(), baseRevision: 0 }],
    }
    t.mock.timers.setTime(new Date('2026-10-18T10:00:00Z').getTime())
    const history = saveDiaryCheckIns(queued)
    assert.equal(history.date, '2026-10-17')
    assert.equal(history.today, '2026-10-18')
    assert.equal(history.meals.find((meal) => meal.plan.slot === 'lunch')!.checkIn!.note, 'Registrato offline')
    assert.deepEqual(history.meals.map((meal) => meal.plan), original.meals.map((meal) => meal.plan))
    assert.throws(() => saveDiaryCheckIns({ ...queued, id: randomUUID(), entries: [{ ...queued.entries[0]!, recordedAt: Date.now(), baseRevision: 1 }] }), (cause) => cause instanceof HttpError && cause.status === 400)
    assert.throws(() => getDiaryDay('2026-02-30'), (cause) => cause instanceof HttpError && cause.status === 400)
  } finally {
    sqlite.close()
    t.mock.timers.reset()
    if (previousPath === undefined) delete process.env.DATABASE_PATH
    else process.env.DATABASE_PATH = previousPath
    rmSync(directory, { recursive: true, force: true })
  }
})
