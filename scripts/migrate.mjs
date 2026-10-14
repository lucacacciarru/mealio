import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

const databasePath = resolve(process.env.DATABASE_PATH ?? './data/mealio.sqlite')
mkdirSync(dirname(databasePath), { recursive: true })
const sqlite = new Database(databasePath)
sqlite.pragma('busy_timeout = 10000')

try {
  migrate(drizzle(sqlite), { migrationsFolder: './drizzle' })
  process.stdout.write(`SQLite migrations applied: ${databasePath}\n`)
} finally {
  sqlite.close()
}
