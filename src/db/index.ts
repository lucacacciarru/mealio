import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

const databasePath = process.env.DATABASE_PATH ?? './data/mealio.sqlite'
const resolvedDatabasePath = resolve(databasePath)
mkdirSync(dirname(resolvedDatabasePath), { recursive: true })

export const sqlite = new Database(resolvedDatabasePath)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('synchronous = NORMAL')
sqlite.pragma('foreign_keys = ON')
sqlite.pragma('busy_timeout = 5000')
sqlite.pragma('wal_autocheckpoint = 1000')

export const db = drizzle(sqlite, { schema })
