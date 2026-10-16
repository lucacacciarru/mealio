import { dirname, join, resolve } from 'node:path'
import { downloadBackupToFile } from './maintenance.mjs'

const [objectKey, outputPath, importDirectory = join(dirname(resolve(outputPath ?? '.')), 'imports')] = process.argv.slice(2)
if (!objectKey || !outputPath) {
  process.stderr.write('Usage: pnpm backup:restore -- <backups/object-key> <local-output-path> [local-imports-directory]\n')
  process.exit(2)
}

process.stdout.write(`Restored and verified SQLite file: ${await downloadBackupToFile(objectKey, outputPath, importDirectory)}\n`)
process.stdout.write(`Imported PDF source directory: ${resolve(importDirectory)}\n`)
