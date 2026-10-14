import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { encryptBackupContent, decryptBackupContent } from './maintenance-crypto.mjs'

const databasePath = resolve(process.env.DATABASE_PATH ?? './data/mealio.sqlite')
const excludedTables = new Set([
  '__drizzle_migrations',
  'sessions',
  'login_rate_limits',
  'maintenance_runs',
])

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required Railway variable: ${name}`)
  return value
}

function encryptionKey() {
  const value = Buffer.from(required('BACKUP_ENCRYPTION_KEY'), 'base64')
  if (value.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must be base64 for 32 random bytes.')
  return value
}

function createStorageClient() {
  return new S3Client({
    endpoint: required('S3_ENDPOINT_URL'),
    region: required('S3_REGION'),
    forcePathStyle: true,
    credentials: {
      accessKeyId: required('S3_ACCESS_KEY_ID'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    },
  })
}

function objectKey(kind, extension) {
  const date = new Date().toISOString()
  const [year, month, day] = date.slice(0, 10).split('-')
  const stamp = date.replaceAll(':', '-').replaceAll('.', '-')
  return `${kind}/${year}/${month}/${day}/mealio-${stamp}.${extension}.gz.enc`
}

function uploadObject(client, key, content, format) {
  return client.send(new PutObjectCommand({
    Bucket: required('S3_BUCKET_NAME'),
    Key: key,
    Body: content,
    ContentType: 'application/octet-stream',
    Metadata: { format, encryption: 'aes-256-gcm+gzip' },
  }))
}

export function createDatabaseSnapshot(sourcePath, targetPath) {
  const source = new Database(resolve(sourcePath))
  try {
    source.pragma('busy_timeout = 10000')
    source.pragma('wal_checkpoint(FULL)')
    const quotedPath = targetPath.replaceAll("'", "''")
    source.exec(`VACUUM INTO '${quotedPath}'`)
  } finally {
    source.close()
  }
}

export function createJsonExport(sourcePath = databasePath) {
  const source = new Database(resolve(sourcePath), { readonly: true, fileMustExist: true })
  try {
    const names = source
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name)
      .filter((name) => !excludedTables.has(name))
    const tables = {}
    for (const name of names) {
      const identifier = `"${name.replaceAll('"', '""')}"`
      tables[name] = source.prepare(`SELECT * FROM ${identifier}`).all()
    }
    return Buffer.from(JSON.stringify({ formatVersion: 1, exportedAt: new Date().toISOString(), tables }, null, 2))
  } finally {
    source.close()
  }
}

export async function uploadDailyBackup() {
  const client = createStorageClient()
  let directory
  try {
    directory = mkdtempSync(join(tmpdir(), 'mealio-backup-'))
    const snapshotPath = join(directory, 'mealio.sqlite')
    createDatabaseSnapshot(databasePath, snapshotPath)
    const encrypted = encryptBackupContent(readFileSync(snapshotPath), encryptionKey())
    const key = objectKey('backups', 'sqlite')
    await uploadObject(client, key, encrypted, 'sqlite-backup-v1')
    return key
  } finally {
    client.destroy()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
}

export async function uploadWeeklyExport() {
  const client = createStorageClient()
  try {
    const encrypted = encryptBackupContent(createJsonExport(databasePath), encryptionKey())
    const key = objectKey('exports', 'json')
    await uploadObject(client, key, encrypted, 'json-export-v1')
    return key
  } finally {
    client.destroy()
  }
}
export function restoreEncryptedBackup(encrypted, key, outputPath) {
  const plaintext = decryptBackupContent(encrypted, key)
  const destination = resolve(outputPath)
  mkdirSync(dirname(destination), { recursive: true })
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomBytes(8).toString('hex')}.tmp`)
  writeFileSync(temporary, plaintext, { flag: 'wx', mode: 0o600 })

  try {
    const restored = new Database(temporary, { readonly: true, fileMustExist: true })
    let result
    try {
      result = restored.prepare('PRAGMA integrity_check').get()
    } finally {
      restored.close()
    }
    if (result.integrity_check !== 'ok') throw new Error('Restored SQLite database failed integrity_check.')
    renameSync(temporary, destination)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return destination
}

export async function downloadBackupToFile(key, outputPath) {
  if (!key.startsWith('backups/') || key.includes('..')) {
    throw new Error('Restore accepts only backup objects under the backups/ prefix.')
  }
  const client = createStorageClient()
  let encrypted
  try {
    const response = await client.send(new GetObjectCommand({
      Bucket: required('S3_BUCKET_NAME'),
      Key: key,
    }))
    if (!response.Body) throw new Error('Backup object is empty.')
    encrypted = Buffer.from(await response.Body.transformToByteArray())
  } finally {
    client.destroy()
  }

  return restoreEncryptedBackup(encrypted, encryptionKey(), outputPath)
}
