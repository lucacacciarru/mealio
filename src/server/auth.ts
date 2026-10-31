import { createHash, createHmac, randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import { db } from '../db'
import { appSettings, loginRateLimits, sessions } from '../db/schema'
import { hashPassword, verifyPassword } from './password'

export const SESSION_COOKIE = 'mealio_session'
// Sessions last a year and are renewed while in use: one login per device.
export const SESSION_TTL_SECONDS = 365 * 24 * 60 * 60
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000
export const MIN_PASSWORD_LENGTH = 8
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_LOGIN_ATTEMPTS = 5

export type AuthFailure = { status: 400 | 401 | 409 | 429; message: string; retryAfterSeconds?: number }
export type LoginResult = { status: 200; token: string } | AuthFailure

function setting(key: string): string | undefined {
  return db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).get()?.value
}

function saveSetting(key: string, value: string): void {
  const updatedAt = Date.now()
  db.insert(appSettings).values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt } })
    .run()
}

// Keys login rate limits; generated once and kept in the database unless the
// environment provides one.
function rateLimitSecret(): string {
  const configured = process.env.SESSION_SECRET
  if (configured && Buffer.byteLength(configured) >= 32) return configured
  const stored = setting('rate_limit_secret')
  if (stored) return stored
  const generated = randomBytes(32).toString('base64url')
  db.insert(appSettings).values({ key: 'rate_limit_secret', value: generated, updatedAt: Date.now() })
    .onConflictDoNothing().run()
  return setting('rate_limit_secret')!
}

// The password set in the app wins; ADMIN_PASSWORD_HASH keeps existing
// deployments working until a password is set in the app.
function passwordHash(): string | undefined {
  return setting('password_hash') ?? (process.env.ADMIN_PASSWORD_HASH || undefined)
}

export function isPasswordSet(): boolean {
  return passwordHash() !== undefined
}

function newSession(now: number): string {
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run()
  const token = randomBytes(32).toString('base64url')
  db.insert(sessions)
    .values({ tokenHash: tokenHash(token), createdAt: now, expiresAt: now + SESSION_TTL_SECONDS * 1000 })
    .run()
  return token
}

// Rate-limited like a login. Returns null when the attempt may proceed.
function limitAttempt(address: string, now: number): AuthFailure | null {
  db.delete(loginRateLimits)
    .where(lt(loginRateLimits.windowStartedAt, now - LOGIN_WINDOW_MS))
    .run()
  const attempt = consumeLoginAttempt(addressHash(address, rateLimitSecret()), now)
  return attempt.allowed
    ? null
    : { status: 429, message: 'Troppi tentativi. Riprova tra qualche minuto.', retryAfterSeconds: attempt.retryAfterSeconds }
}

function validNewPassword(password: string): AuthFailure | null {
  return password.length < MIN_PASSWORD_LENGTH
    ? { status: 400, message: `La password deve avere almeno ${MIN_PASSWORD_LENGTH} caratteri.` }
    : null
}

// First run only: with no password anywhere, the first visitor chooses it.
export async function setupPassword(password: string, address: string): Promise<LoginResult> {
  const now = Date.now()
  const limited = limitAttempt(address, now)
  if (limited) return limited
  const invalid = validNewPassword(password)
  if (invalid) return invalid
  const hash = await hashPassword(password)
  const created = db.transaction(() => {
    if (isPasswordSet()) return false
    saveSetting('password_hash', hash)
    return true
  })
  if (!created) return { status: 409, message: 'La password è già stata scelta. Accedi.' }
  return { status: 200, token: newSession(now) }
}

// Requires the current password; other devices stay signed in. Null on success.
export async function changePassword(current: string, next: string, address: string): Promise<AuthFailure | null> {
  const now = Date.now()
  const limited = limitAttempt(address, now)
  if (limited) return limited
  const encoded = passwordHash()
  if (!encoded || !(await verifyPassword(current, encoded))) {
    return { status: 401, message: 'La password attuale non è corretta.' }
  }
  const invalid = validNewPassword(next)
  if (invalid) return invalid
  saveSetting('password_hash', await hashPassword(next))
  return null
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function addressHash(address: string, secret: string): string {
  return createHmac('sha256', secret).update(address).digest('hex')
}

export function requestAddress(request: Request): string {
  const direct = request.headers.get('x-real-ip')?.trim()
  if (direct) return direct
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

function consumeLoginAttempt(key: string, now: number): { allowed: boolean; retryAfterSeconds: number } {
  const current = db.select().from(loginRateLimits).where(eq(loginRateLimits.addressHash, key)).get()
  const inWindow = current && now - current.windowStartedAt < LOGIN_WINDOW_MS
  const attempts = inWindow ? current.attempts + 1 : 1
  const windowStartedAt = inWindow ? current.windowStartedAt : now

  db.insert(loginRateLimits)
    .values({ addressHash: key, windowStartedAt, attempts })
    .onConflictDoUpdate({
      target: loginRateLimits.addressHash,
      set: { windowStartedAt, attempts },
    })
    .run()

  const retryAfterSeconds = Math.max(1, Math.ceil((windowStartedAt + LOGIN_WINDOW_MS - now) / 1000))
  return { allowed: attempts <= MAX_LOGIN_ATTEMPTS, retryAfterSeconds }
}

export async function loginWithPassword(password: string, address: string): Promise<LoginResult> {
  const encodedPassword = passwordHash()
  if (!encodedPassword) return { status: 409, message: 'Scegli prima una password.' }
  const now = Date.now()
  const limited = limitAttempt(address, now)
  if (limited) return limited
  if (!(await verifyPassword(password, encodedPassword))) {
    return { status: 401, message: 'Password non corretta.' }
  }
  db.delete(loginRateLimits).where(eq(loginRateLimits.addressHash, addressHash(address, rateLimitSecret()))).run()
  return { status: 200, token: newSession(now) }
}

// Renews a valid session at most once a day, so it never expires while in use.
export function sessionExpiresAt(request: Request): number | null {
  const token = sessionToken(request)
  if (!token) return null

  const row = db
    .select({ expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash(token)))
    .get()
  const now = Date.now()
  if (!row || row.expiresAt <= now) {
    if (row) db.delete(sessions).where(eq(sessions.tokenHash, tokenHash(token))).run()
    return null
  }
  const renewed = now + SESSION_TTL_SECONDS * 1000
  if (renewed - row.expiresAt >= SESSION_RENEW_AFTER_MS) {
    db.update(sessions).set({ expiresAt: renewed }).where(eq(sessions.tokenHash, tokenHash(token))).run()
    return renewed
  }
  return row.expiresAt
}

export function sessionToken(request: Request): string | null {
  const token = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1)
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
}

export function hasValidSession(request: Request): boolean {
  return sessionExpiresAt(request) !== null
}

export function revokeSession(request: Request): void {
  const token = sessionToken(request)
  if (token) db.delete(sessions).where(eq(sessions.tokenHash, tokenHash(token))).run()
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

export function expiredSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}
