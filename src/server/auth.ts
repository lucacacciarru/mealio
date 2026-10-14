import { createHash, createHmac, randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import { db } from '../db'
import { loginRateLimits, sessions } from '../db/schema'
import { verifyPassword } from './password'

export const SESSION_COOKIE = 'mealio_session'
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_LOGIN_ATTEMPTS = 5

export type LoginResult =
  | { status: 200; token: string }
  | { status: 401 | 429 | 503; message: string; retryAfterSeconds?: number }

function getSessionSecret(): string | undefined {
  const secret = process.env.SESSION_SECRET
  return secret && Buffer.byteLength(secret) >= 32 ? secret : undefined
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
  const encodedPassword = process.env.ADMIN_PASSWORD_HASH
  const secret = getSessionSecret()
  if (!encodedPassword || !secret) {
    return { status: 503, message: 'Accesso non configurato.' }
  }

  const now = Date.now()
  db.delete(loginRateLimits)
    .where(lt(loginRateLimits.windowStartedAt, now - LOGIN_WINDOW_MS))
    .run()
  const key = addressHash(address, secret)
  const attempt = consumeLoginAttempt(key, now)
  if (!attempt.allowed) {
    return {
      status: 429,
      message: 'Troppi tentativi. Riprova tra qualche minuto.',
      retryAfterSeconds: attempt.retryAfterSeconds,
    }
  }

  if (!(await verifyPassword(password, encodedPassword))) {
    return { status: 401, message: 'Password non corretta.' }
  }

  db.delete(loginRateLimits).where(eq(loginRateLimits.addressHash, key)).run()
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run()

  const token = randomBytes(32).toString('base64url')
  db.insert(sessions)
    .values({
      tokenHash: tokenHash(token),
      createdAt: now,
      expiresAt: now + SESSION_TTL_SECONDS * 1000,
    })
    .run()

  return { status: 200, token }
}

export function hasValidSession(request: Request): boolean {
  const secret = getSessionSecret()
  if (!secret) return false

  const cookieHeader = request.headers.get('cookie') ?? ''
  const token = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1)
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false

  const row = db
    .select({ expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash(token)))
    .get()
  if (!row || row.expiresAt <= Date.now()) {
    if (row) db.delete(sessions).where(eq(sessions.tokenHash, tokenHash(token))).run()
    return false
  }
  return true
}

export function revokeSession(request: Request): void {
  const cookieHeader = request.headers.get('cookie') ?? ''
  const token = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1)
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    db.delete(sessions).where(eq(sessions.tokenHash, tokenHash(token))).run()
  }
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

export function expiredSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}
