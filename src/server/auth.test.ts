import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

test('the password is chosen in the app, can be changed, and sessions renew while in use', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mealio-auth-test-'))
  const previous = { path: process.env.DATABASE_PATH, hash: process.env.ADMIN_PASSWORD_HASH, secret: process.env.SESSION_SECRET }
  process.env.DATABASE_PATH = join(directory, 'auth.sqlite')
  delete process.env.ADMIN_PASSWORD_HASH
  delete process.env.SESSION_SECRET
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-18T10:00:00Z') })
  // The database singleton must load only after the disposable path is set.
  const { db, sqlite } = await import('../db')
  try {
    migrate(db, { migrationsFolder: './drizzle' })
    const auth = await import('./auth')
    const request = (token?: string) => new Request('http://localhost/api', token ? { headers: { cookie: `${auth.SESSION_COOKIE}=${token}` } } : {})

    // No password anywhere: login is refused and the first run chooses one.
    assert.equal(auth.isPasswordSet(), false)
    assert.equal((await auth.loginWithPassword('qualsiasi', 'a')).status, 409)
    assert.equal((await auth.setupPassword('corta', 'a')).status, 400)
    const setup = await auth.setupPassword('password-sintetica', 'a')
    assert.equal(setup.status, 200)
    assert.equal(auth.isPasswordSet(), true)
    // A second setup cannot replace it.
    assert.equal((await auth.setupPassword('altra-password', 'b')).status, 409)

    assert.equal((await auth.loginWithPassword('sbagliata', 'c')).status, 401)
    const login = await auth.loginWithPassword('password-sintetica', 'c')
    assert.equal(login.status, 200)
    const token = login.status === 200 ? login.token : ''
    const firstExpiry = auth.sessionExpiresAt(request(token))!
    assert.ok(firstExpiry > Date.now() + 364 * 24 * 60 * 60 * 1000)

    // Use after a few days renews the session.
    t.mock.timers.setTime(new Date('2026-10-25T10:00:00Z').getTime())
    assert.ok(auth.sessionExpiresAt(request(token))! > firstExpiry)

    // Changing requires the current password, keeps the caller signed in and
    // signs out every other device.
    const other = await auth.loginWithPassword('password-sintetica', 'c')
    assert.equal(other.status, 200)
    const otherToken = (other as { token: string }).token
    assert.equal((await auth.changePassword('sbagliata', 'nuova-password', 'd', token))?.status, 401)
    assert.equal((await auth.changePassword('password-sintetica', 'corta', 'd', token))?.status, 400)
    assert.notEqual(auth.sessionExpiresAt(request(otherToken)), null)
    assert.equal(await auth.changePassword('password-sintetica', 'nuova-password', 'd', token), null)
    assert.notEqual(auth.sessionExpiresAt(request(token)), null)
    assert.equal(auth.sessionExpiresAt(request(otherToken)), null)
    assert.equal((await auth.loginWithPassword('password-sintetica', 'e')).status, 401)
    assert.equal((await auth.loginWithPassword('nuova-password', 'e')).status, 200)

    // Attempts are rate limited per address.
    for (let attempt = 0; attempt < 5; attempt += 1) await auth.loginWithPassword('sbagliata', 'f')
    assert.equal((await auth.loginWithPassword('nuova-password', 'f')).status, 429)

    auth.revokeSession(request(token))
    assert.equal(auth.sessionExpiresAt(request(token)), null)
  } finally {
    sqlite.close()
    t.mock.timers.reset()
    for (const [key, value] of [['DATABASE_PATH', previous.path], ['ADMIN_PASSWORD_HASH', previous.hash], ['SESSION_SECRET', previous.secret]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(directory, { recursive: true, force: true })
  }
})
