# Development and Operations

## Local development

Requirements: Node.js `>=22.12` and pnpm `11.21`.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm auth:hash
```

`pnpm auth:hash` reads the password without echoing it and prints only the scrypt hash. Copy the hash to `ADMIN_PASSWORD_HASH` in the local `.env`. Set `SESSION_SECRET` and `BACKUP_ENCRYPTION_KEY` to distinct random values. The latter must be 32 bytes encoded as Base64; for example, generate it with `openssl rand -base64 32`.

```sh
pnpm db:migrate
pnpm dev
```

The local UI is available at `http://localhost:3000`. `.env`, the SQLite database, and the `data/` directory are excluded from Git.

## Import a meal plan PDF

Set `GEMINI_API_KEY` in the local `.env` to enable extraction. `GEMINI_MODEL` defaults to `gemini-3.8-flash`. Keep the key out of source control and Railway config values; configure it as a private Railway variable in production. The import accepts PDF files up to 15 MB.

The uploaded original is stored under `DATA_DIRECTORY/imports/` with private file permissions. If `DATA_DIRECTORY` is unset, imports use the directory containing `DATABASE_PATH` (the Railway volume mounted at `/data` in production). The PDF is not sent to Google when it is uploaded. The authenticated user must check the authorization box and choose **Autorizza e avvia estrazione**; that sends the complete PDF to Google Gemini for structured JSON Schema extraction through the Vercel AI SDK Google provider. AI SDK telemetry is disabled for this request.

The review displays the PDF and extracted seven-day, five-meal plan together. Check each meal, correct its food, exact quantity/unit text, state, alternatives, notes, page, and source citation; resolve or remove uncertain equivalences. Missing or ambiguous values stay explicit and produce warnings. The server validates the reviewed structure with Zod and requires page-level citations plus a per-meal review confirmation. A separate final confirmation and activation date create a new plan version; extraction alone never writes or activates plan data.

For schema changes, update `src/db/schema.ts`, generate the SQL migration, and apply it:

```sh
pnpm db:generate
pnpm db:migrate
```

Migration SQL and their snapshots in `drizzle/` are version-controlled. In production, `pnpm start:deploy` applies pending migrations before starting the server.

## Railway deployment

Create the project in the personal **My Projects** workspace, not **VLK Studio**. After enabling a Railway plan:

```sh
railway init --name mealio --workspace "My Projects" --json
```

Connect the project to the repository and move the code to the `main` branch. Review the infrastructure-as-code plan before applying it:

```sh
railway config plan
railway config apply
```

`.railway/railway.ts` defines one `mealio` service, one replica in `europe-west4` (EU West), a 1 GB volume mounted at `/data`, and the `mealio-backups` bucket in `ams` (Amsterdam). The database path is `/data/mealio.sqlite`. The single-replica limit avoids concurrent SQLite writes from multiple instances.

Set these values as Railway variables on the `mealio` service in `production`; do not put them in the repository:

- `SESSION_SECRET`: at least 32 random bytes.
- `ADMIN_PASSWORD_HASH`: output from `pnpm auth:hash`.
- `BACKUP_ENCRYPTION_KEY`: 32 random bytes encoded as Base64. Keep a copy outside Railway, such as in a password manager; it is required to decrypt backups.
- `GEMINI_API_KEY`: secret Gemini API key for explicitly authorized PDF extraction; set it as a private Railway variable. `GEMINI_MODEL` is optional and defaults to `gemini-3.8-flash`.
- `S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`, `S3_REGION`: respectively the `endpoint`, `accessKeyId`, `secretAccessKey`, `bucketName`, and `region` returned by `railway bucket credentials --bucket mealio-backups --json`.

The bucket is created in `ams`, but Railway assigns an effective S3 name distinct from the resource name; the S3 region may also differ from the creation region. Use the values returned by the credentials command. Sensitive variables remain `preserve()` values in the infrastructure-as-code file.

Sessions last 30 days. The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Login is limited to five attempts per IP address every 15 minutes; the address is stored only as an HMAC using `SESSION_SECRET`. The password field is hidden by default and has a Show/Hide control.

## Backups and exports

The maintenance process starts with the service and uploads:

- daily SQLite snapshots at 03:00 UTC;
- weekly JSON exports on Sundays at 03:15 UTC.

Objects are compressed and encrypted with AES-256-GCM before upload. The JSON export includes application tables and excludes sessions, login rate limits, and scheduler state. The bucket is in EU West. Do not put PDFs or personal data in the repository.

Run a backup or export manually when Railway variables are available locally:

```sh
railway run --project <PROJECT_ID> --environment production --service mealio -- pnpm backup:run
railway run --project <PROJECT_ID> --environment production --service mealio -- pnpm export:run
```

## Restore from backup

Restoring replaces the current database. Perform a restore during a maintenance window and retain the `BACKUP_ENCRYPTION_KEY` used for the backup.

1. Download and verify the encrypted snapshot locally. The command runs `PRAGMA integrity_check` before writing the destination file:

   ```sh
   railway run --project <PROJECT_ID> --environment production --service mealio -- \
     pnpm backup:restore -- backups/<YYYY>/<MM>/<DD>/<object>.sqlite.gz.enc /tmp/mealio-restore.sqlite
   ```

2. Stop the service, remove any stale SQLite sidecars from the volume, upload the restored file, then start one replica:

   ```sh
   railway scale --project <PROJECT_ID> --environment production --service mealio europe-west4=0 --json
   railway volume files list / --project <PROJECT_ID> --environment production --service mealio --json
   # If present, delete /mealio.sqlite-wal and /mealio.sqlite-shm.
   railway volume files delete /mealio.sqlite-wal \
     --project <PROJECT_ID> --environment production --service mealio --yes --json
   railway volume files delete /mealio.sqlite-shm \
     --project <PROJECT_ID> --environment production --service mealio --yes --json
   railway volume files upload /tmp/mealio-restore.sqlite /mealio.sqlite \
     --project <PROJECT_ID> --environment production --service mealio --overwrite --json
   railway scale --project <PROJECT_ID> --environment production --service mealio europe-west4=1 --json
   ```

   Remove sidecars only while the service is stopped: the restored backup replaces the previous state completely.

3. Verify `GET /api/health`, then log in. The start command applies any pending migrations automatically.

`pnpm backup:restore` accepts objects only under the `backups/` prefix and does not overwrite the volume by itself. Keep a local copy of the downloaded file before restoring it to Railway.

## Railway spend limits

Set a hard limit on the **My Projects workspace** target; the **agent** target does not limit service compute costs. A hard limit can suspend the service when the threshold is reached. Check the current status before setting a limit:

```sh
railway usage limit status --workspace "My Projects" --target workspace --json
railway usage limit set --workspace "My Projects" --target workspace --hard <USD> --json
railway usage limit status --workspace "My Projects" --target workspace --json
```
