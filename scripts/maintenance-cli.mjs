import { uploadDailyBackup, uploadWeeklyExport } from './maintenance.mjs'

const operation = process.argv[2]

if (operation === 'backup') {
  process.stdout.write(`Uploaded encrypted SQLite backup: ${await uploadDailyBackup()}\n`)
} else if (operation === 'export') {
  process.stdout.write(`Uploaded encrypted JSON export: ${await uploadWeeklyExport()}\n`)
} else {
  process.stderr.write('Use `pnpm backup:run` or `pnpm export:run`.\n')
  process.exitCode = 2
}
