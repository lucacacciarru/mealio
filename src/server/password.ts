import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const KEY_LENGTH = 64
const SCRYPT_N = 32_768
const SCRYPT_R = 8
const SCRYPT_P = 1
const MAX_MEMORY = 128 * 1024 * 1024

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>()
  scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEMORY,
  }, (error, derived) => {
    if (error) {
      reject(error)
      return
    }
    resolve(derived)
  })
  return promise
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await deriveKey(password, salt)
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$')
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, nValue, rValue, pValue, saltValue, keyValue, extra] = encoded.split('$')
  if (
    algorithm !== 'scrypt' ||
    extra !== undefined ||
    nValue !== String(SCRYPT_N) ||
    rValue !== String(SCRYPT_R) ||
    pValue !== String(SCRYPT_P) ||
    !saltValue ||
    !keyValue
  ) {
    return false
  }

  const salt = Buffer.from(saltValue, 'base64url')
  const expected = Buffer.from(keyValue, 'base64url')
  if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false

  const actual = await deriveKey(password, salt)
  return timingSafeEqual(actual, expected)
}
