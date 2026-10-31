import { createHash } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { checkInOperations, diaryPlanSnapshots, mealCheckIns, PLAN_SLOTS } from '../db/schema'
import { CHECK_IN_NOTE_MAX_LENGTH } from '../diary'
import type { DiaryDay, DiaryMutation } from '../diary'
import { HttpError } from './http'
import { todayInRome } from './plans'
import { getWeek } from './weeks'
import type { WeekMealView } from './weeks'

const dateSchema = z.iso.date()

export const DiaryMutationSchema = z.object({
  id: z.uuid(),
  date: dateSchema,
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  entries: z.array(z.object({
    slot: z.enum(PLAN_SLOTS),
    followed: z.boolean(),
    note: z.string().trim().max(CHECK_IN_NOTE_MAX_LENGTH).nullable(),
    recordedAt: z.number().int().nonnegative(),
    baseRevision: z.number().int().nonnegative(),
  }).strict()).min(1).max(PLAN_SLOTS.length),
}).strict().refine((mutation) => new Set(mutation.entries.map((entry) => entry.slot)).size === mutation.entries.length)

type DaySnapshot = Pick<DiaryDay, 'date' | 'weekStart' | 'weekStatus' | 'plannedVersion' | 'validVersion'> & {
  meals: WeekMealView[]
}
export class DiaryConflictError extends HttpError {
  constructor(readonly date: string) {
    super('Questi pasti sono stati modificati da un altro dispositivo. Scegli quali check-in mantenere.', 409)
  }
}


function readSnapshot(id: string): DaySnapshot {
  const row = db.select().from(diaryPlanSnapshots).where(eq(diaryPlanSnapshots.id, id)).get()
  if (!row) throw new HttpError('Pianificazione non disponibile. Ricarica il giorno prima di registrarlo.', 409)
  return JSON.parse(row.snapshotJson) as DaySnapshot
}

function originalSnapshot(date: string): DaySnapshot {
  const instant = new Date(`${date}T00:00:00Z`)
  instant.setUTCDate(instant.getUTCDate() - (instant.getUTCDay() + 6) % 7)
  const week = getWeek(instant.toISOString().slice(0, 10))
  const day = week.days.find((candidate) => candidate.date === date)!
  return {
    date,
    weekStart: week.weekStart,
    weekStatus: week.status,
    plannedVersion: day.plannedVersion,
    validVersion: day.validVersion,
    meals: day.ready ? day.meals : [],
  }
}

export function getDiaryDay(date = todayInRome()): DiaryDay {
  if (!dateSchema.safeParse(date).success) throw new HttpError('Data non valida.', 400)
  const today = todayInRome()
  const checkIns = db.select().from(mealCheckIns)
    .where(eq(mealCheckIns.date, date))
    .orderBy(asc(mealCheckIns.createdAt), asc(sql`rowid`))
    .all()
  const snapshots = new Map<string, DaySnapshot>()
  function snapshot(id: string) {
    const saved = snapshots.get(id) ?? readSnapshot(id)
    snapshots.set(id, saved)
    return saved
  }
  // Recorded slots always use their immutable snapshot. Unrecorded slots
  // remain hidden while the day has open choices, including historical snapshots.
  // A ready past day retains the plan seen at its first check-in.
  const first = checkIns[0]
  const current = originalSnapshot(date)
  const base = date < today && first
    ? { ...snapshot(first.snapshotId), meals: current.meals.length > 0 ? snapshot(first.snapshotId).meals : [] }
    : current
  const meals = PLAN_SLOTS.flatMap((slot) => {
    const checkIn = checkIns.find((row) => row.slot === slot)
    const plan = (checkIn ? snapshot(checkIn.snapshotId) : base).meals.find((meal) => meal.slot === slot)
    return plan ? [{
      plan,
      checkIn: checkIn ? {
        followed: checkIn.followed,
        note: checkIn.note,
        recordedAt: checkIn.recordedAt,
        revision: checkIn.revision,
      } : null,
    }] : []
  })
  const saved: DaySnapshot = { ...base, meals: meals.map((meal) => meal.plan) }
  const snapshotJson = JSON.stringify(saved)
  const snapshotId = createHash('sha256').update(snapshotJson).digest('hex')
  db.insert(diaryPlanSnapshots).values({ id: snapshotId, date, snapshotJson }).onConflictDoNothing().run()
  return {
    date,
    today,
    weekStart: saved.weekStart,
    weekStatus: saved.weekStatus,
    plannedVersion: saved.plannedVersion,
    validVersion: saved.validVersion,
    snapshotId,
    meals,
  }
}

export function saveDiaryCheckIns(input: DiaryMutation): DiaryDay {
  const parsed = DiaryMutationSchema.safeParse(input)
  if (!parsed.success) throw new HttpError('Check-in non valido.', 400)
  const mutation = parsed.data
  if (!dateSchema.safeParse(mutation.date).success) throw new HttpError('Data non valida.', 400)
  if (mutation.date > todayInRome()) throw new HttpError('I check-in non si registrano per i giorni futuri.', 400)
  const requestHash = createHash('sha256').update(JSON.stringify(mutation)).digest('hex')
  db.transaction(() => {
    const receipt = db.select().from(checkInOperations).where(eq(checkInOperations.id, mutation.id)).get()
    if (receipt) {
      if (receipt.requestHash !== requestHash) throw new HttpError('Identificativo del check-in già utilizzato.', 409)
      return
    }
    const plan = readSnapshot(mutation.snapshotId)
    if (plan.date !== mutation.date) throw new HttpError('La pianificazione non appartiene a questo giorno.', 400)
    const now = Date.now()
    const existing = db.select().from(mealCheckIns).where(eq(mealCheckIns.date, mutation.date)).all()
    const current = originalSnapshot(mutation.date)
    for (const entry of mutation.entries) {
      const row = existing.find((candidate) => candidate.slot === entry.slot)
      if ((row?.revision ?? 0) !== entry.baseRevision) throw new DiaryConflictError(mutation.date)
      if (!row && !current.meals.some((meal) => meal.slot === entry.slot)) {
        throw new HttpError('Il giorno ha ancora scelte da fare nella settimana: completale prima di registrare nuovi pasti.', 409)
      }
      const meal = (row ? readSnapshot(row.snapshotId) : plan).meals.find((candidate) => candidate.slot === entry.slot)
      if (!meal) throw new HttpError('Nessun pasto pianificato in questo giorno e orario.', 400)
      if (meal.free && !entry.followed) {
        throw new HttpError('Il pasto libero pianificato conta come seguito.', 400)
      }
      if (entry.recordedAt > now + 120_000 || new Date(entry.recordedAt).toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' }) !== mutation.date) {
        throw new HttpError('L’orario del check-in deve appartenere al giorno registrato e non essere futuro.', 400)
      }
    }
    for (const entry of mutation.entries) {
      const row = existing.find((candidate) => candidate.slot === entry.slot)
      const values = {
        followed: entry.followed,
        note: entry.note || null,
        recordedAt: entry.recordedAt,
        revision: entry.baseRevision + 1,
      }
      db.insert(mealCheckIns).values({
        date: mutation.date,
        slot: entry.slot,
        snapshotId: row?.snapshotId ?? mutation.snapshotId,
        createdAt: row?.createdAt ?? now,
        ...values,
      }).onConflictDoUpdate({
        target: [mealCheckIns.date, mealCheckIns.slot],
        set: values,
      }).run()
    }
    db.insert(checkInOperations).values({ id: mutation.id, requestHash }).run()
  })
  return getDiaryDay(mutation.date)
}
