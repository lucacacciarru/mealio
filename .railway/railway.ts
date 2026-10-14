import {
  bucket,
  defineRailway,
  github,
  preserve,
  project,
  service,
  volume,
} from 'railway/iac'

export default defineRailway(() => {
  const backups = bucket('mealio-backups', { region: 'ams' })
  const app = service('mealio', {
    source: github('lucacacciarru/mealio', { branch: 'main' }),
    build: 'pnpm build',
    start: 'pnpm start:deploy',
    env: {
      NODE_ENV: 'production',
      TZ: 'UTC',
      DATABASE_PATH: '/data/mealio.sqlite',
      S3_BUCKET_NAME: preserve(),
      S3_REGION: preserve(),
      S3_ENDPOINT_URL: preserve(),
      S3_ACCESS_KEY_ID: preserve(),
      S3_SECRET_ACCESS_KEY: preserve(),
      BACKUP_ENCRYPTION_KEY: preserve(),
      SESSION_SECRET: preserve(),
      ADMIN_PASSWORD_HASH: preserve(),
    },
    replicas: { 'europe-west4': 1 },
    volumeMounts: {
      '/data': volume('mealio-data', { sizeMB: 1024 }),
    },
  })

  return project('mealio', { resources: [backups, app] })
})
