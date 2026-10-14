import { downloadBackupToFile } from './maintenance.mjs'

const [objectKey, outputPath] = process.argv.slice(2)
if (!objectKey || !outputPath) {
  process.stderr.write('Usage: pnpm backup:restore -- <backups/object-key> <local-output-path>\n')
  process.exit(2)
}

process.stdout.write(`Restored and verified SQLite file: ${await downloadBackupToFile(objectKey, outputPath)}\n`)
