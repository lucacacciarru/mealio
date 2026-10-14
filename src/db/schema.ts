import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('sessions_expires_at_idx').on(table.expiresAt)],
)

export const loginRateLimits = sqliteTable('login_rate_limits', {
  addressHash: text('address_hash').primaryKey(),
  windowStartedAt: integer('window_started_at').notNull(),
  attempts: integer('attempts').notNull(),
})

export const maintenanceRuns = sqliteTable('maintenance_runs', {
  jobName: text('job_name').primaryKey(),
  lastSuccessAt: integer('last_success_at').notNull(),
})
