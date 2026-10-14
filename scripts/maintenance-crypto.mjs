import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

const MAGIC = Buffer.from('MEALIO1\0')
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

export function encryptBackupContent(content, key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error('BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes.')
  }
  const compressed = gzipSync(content, { level: 9 })
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()])
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext])
}

export function decryptBackupContent(envelope, key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error('BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes.')
  }
  const headerLength = MAGIC.length + IV_BYTES + TAG_BYTES
  if (!Buffer.isBuffer(envelope) || envelope.length <= headerLength || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Backup file has an unknown or damaged format.')
  }
  const ivStart = MAGIC.length
  const tagStart = ivStart + IV_BYTES
  const contentStart = tagStart + TAG_BYTES
  const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(ivStart, tagStart))
  decipher.setAuthTag(envelope.subarray(tagStart, contentStart))
  return gunzipSync(Buffer.concat([
    decipher.update(envelope.subarray(contentStart)),
    decipher.final(),
  ]))
}
