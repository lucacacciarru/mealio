import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs'
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

const RECOVERY_IMPORT_TABLE = '__mealio_recovery_import_files'

function importsDirectoryFor(databaseFilePath) {
  const dataDirectory = process.env.DATA_DIRECTORY ?? dirname(resolve(databaseFilePath))
  return join(resolve(dataDirectory), 'imports')
}

function readImportFiles(source, databaseFilePath) {
  const records = source.prepare('SELECT file_key FROM plan_imports ORDER BY file_key').all()
  return records.map(({ file_key }) => {
    if (typeof file_key !== 'string' || basename(file_key) !== file_key || !file_key.endsWith('.pdf')) {
      throw new Error('An imported PDF reference has an unsafe file key.')
    }
    try {
      return { fileKey: file_key, content: readFileSync(join(importsDirectoryFor(databaseFilePath), file_key)) }
    } catch {
      throw new Error(`Cannot include referenced imported PDF in recovery artifact: ${file_key}`)
    }
  })
}

function embedImportFiles(snapshotPath, sourceDatabasePath) {
  const snapshot = new Database(resolve(snapshotPath))
  try {
    const files = readImportFiles(snapshot, sourceDatabasePath)
    snapshot.exec(`CREATE TABLE "${RECOVERY_IMPORT_TABLE}" (file_key TEXT PRIMARY KEY NOT NULL, content BLOB NOT NULL)`)
    const insert = snapshot.prepare(`INSERT INTO "${RECOVERY_IMPORT_TABLE}" (file_key, content) VALUES (?, ?)`)
    snapshot.transaction(() => {
      for (const file of files) insert.run(file.fileKey, file.content)
    })()
  } finally {
    snapshot.close()
  }
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
  embedImportFiles(targetPath, sourcePath)
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
    const sourceFiles = readImportFiles(source, sourcePath).map(({ fileKey, content }) => ({
      fileKey,
      contentBase64: content.toString('base64'),
    }))
    return Buffer.from(JSON.stringify({ formatVersion: 2, exportedAt: new Date().toISOString(), tables, sourceFiles }, null, 2))
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
    await uploadObject(client, key, encrypted, 'sqlite-backup-v2')
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
    await uploadObject(client, key, encrypted, 'json-export-v2')
    return key
  } finally {
    client.destroy()
  }
}
function restoreImportFiles(restored, importDirectory) {
  const recoveryTable = restored
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(RECOVERY_IMPORT_TABLE)
  if (!recoveryTable) return

  const directory = resolve(importDirectory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const files = restored
    .prepare(`SELECT file_key, content FROM "${RECOVERY_IMPORT_TABLE}" ORDER BY file_key`)
    .all()
  for (const { file_key, content } of files) {
    if (
      typeof file_key !== 'string' ||
      basename(file_key) !== file_key ||
      file_key.includes('/') ||
      file_key.includes('\\') ||
      !file_key.endsWith('.pdf') ||
      !Buffer.isBuffer(content)
    ) {
      throw new Error('Backup contains an invalid imported PDF entry.')
    }
    const target = join(directory, file_key)
    const temporary = join(directory, `.${file_key}.${randomBytes(8).toString('hex')}.tmp`)
    try {
      writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
      renameSync(temporary, target)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
  restored.exec(`DROP TABLE "${RECOVERY_IMPORT_TABLE}"`)
}
export function restoreEncryptedBackup(
  encrypted,
  key,
  outputPath,
  importDirectory = join(dirname(resolve(outputPath)), 'imports'),
) {
  const plaintext = decryptBackupContent(encrypted, key)
  const destination = resolve(outputPath)
  mkdirSync(dirname(destination), { recursive: true })
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomBytes(8).toString('hex')}.tmp`)
  writeFileSync(temporary, plaintext, { flag: 'wx', mode: 0o600 })

  try {
    const restored = new Database(temporary, { fileMustExist: true })
    try {
      let result = restored.prepare('PRAGMA integrity_check').get()
      if (result.integrity_check !== 'ok') throw new Error('Restored SQLite database failed integrity_check.')
      restoreImportFiles(restored, importDirectory)
      result = restored.prepare('PRAGMA integrity_check').get()
      if (result.integrity_check !== 'ok') throw new Error('Restored SQLite database failed integrity_check.')
    } finally {
      restored.close()
    }
    renameSync(temporary, destination)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return destination
}

export async function downloadBackupToFile(
  key,
  outputPath,
  importDirectory = join(dirname(resolve(outputPath)), 'imports'),
) {
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

  return restoreEncryptedBackup(encrypted, encryptionKey(), outputPath, importDirectory)
}
