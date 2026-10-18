import type { PlanSlot } from './db/schema'
import type { WeekDayView, WeekMealView } from './server/weeks'

export type DiaryCheckIn = {
  followed: boolean
  note: string | null
  recordedAt: number
  revision: number
}

export type DiaryDay = {
  date: string
  today: string
  weekStart: string
  weekStatus: 'confirmed' | 'unconfirmed'
  plannedVersion: WeekDayView['plannedVersion']
  validVersion: WeekDayView['validVersion']
  // Reference to an immutable, server-owned copy of the meals shown.
  snapshotId: string
  meals: { plan: WeekMealView; checkIn: DiaryCheckIn | null }[]
}

export type DiaryMutation = {
  id: string
  date: string
  snapshotId: string
  entries: {
    slot: PlanSlot
    followed: boolean
    note: string | null
    recordedAt: number
    baseRevision: number
  }[]
}

export const CHECK_IN_NOTE_MAX_LENGTH = 1000
