import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { uploadDailyBackup, uploadWeeklyExport } from './maintenance.mjs'

const databasePath = resolve(process.env.DATABASE_PATH ?? './data/mealio.sqlite')
const database = new Database(databasePath)
database.pragma('busy_timeout = 10000')
const successfulRun = database.prepare('SELECT last_success_at FROM maintenance_runs WHERE job_name = ?')
const recordSuccess = database.prepare(`
  INSERT INTO maintenance_runs (job_name, last_success_at) VALUES (?, ?)
  ON CONFLICT(job_name) DO UPDATE SET last_success_at = excluded.last_success_at
`)
const attempted = new Map()
const active = new Set()

function latestDailyDue(now) {
  const due = new Date(now)
  due.setUTCHours(3, 0, 0, 0)
  if (due.getTime() > now) due.setUTCDate(due.getUTCDate() - 1)
  return due.getTime()
}

function latestWeeklyDue(now) {
  const due = new Date(now)
  due.setUTCHours(3, 15, 0, 0)
  due.setUTCDate(due.getUTCDate() - due.getUTCDay())
  if (due.getTime() > now) due.setUTCDate(due.getUTCDate() - 7)
  return due.getTime()
}

async function runIfDue(name, dueAt, operation) {
  if (active.has(name) || attempted.get(name) === dueAt) return
  const previous = successfulRun.get(name)
  if (previous && previous.last_success_at >= dueAt) return

  attempted.set(name, dueAt)
  active.add(name)
  try {
    const key = await operation()
    recordSuccess.run(name, Date.now())
    process.stdout.write(`[maintenance] ${name} uploaded ${key}\n`)
  } catch (error) {
    process.stderr.write(`[maintenance] ${name} failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
  } finally {
    active.delete(name)
  }
}

async function tick() {
  const now = Date.now()
  await runIfDue('daily-backup', latestDailyDue(now), uploadDailyBackup)
  await runIfDue('weekly-json-export', latestWeeklyDue(now), uploadWeeklyExport)
}

void tick()
const timer = setInterval(() => void tick(), 60_000)

function shutdown() {
  clearInterval(timer)
  database.close()
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
