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

The local UI is available at `http://localhost:5009`. `.env`, the SQLite database, and the `data/` directory are excluded from Git.

## Import a meal plan PDF

Set `OPENROUTER_API_KEY` in the local `.env` to enable extraction, then create an OpenRouter preset with the slug `mealio-prod` at https://openrouter.ai/settings/presets and choose the model there; it is not set in code or environment variables, so it can change without a deploy. Pick a model that reads PDF files natively and that OpenRouter does not moderate, for example a Google Gemini model: OpenRouter moderates some models (OpenAI ones among them) and rejects a flagged plan with HTTP 403. Keep the key out of source control and Railway config values; configure it as a private Railway variable in production. The import accepts PDF files up to 15 MB.

The authenticated user picks a PDF and chooses **Carica e analizza**. That single action stores the original under `DATA_DIRECTORY/imports/` with private file permissions (if `DATA_DIRECTORY` is unset, imports use the directory containing `DATABASE_PATH`, the Railway volume mounted at `/data` in production) and then sends the complete PDF through OpenRouter for schema-constrained JSON generation via the Vercel AI SDK OpenRouter provider; the form states where the PDF goes. Requests use `@preset/mealio-prod` as the model and set `provider.zdr: true`, so OpenRouter routes inference only to zero-data-retention endpoints (for Gemini models this means Google Vertex, not AI Studio), and select the `file-parser` plugin with the `native` PDF engine. With the account-level plugin policy below, PDFs are not sent to a separate OCR backend; a model without native PDF input fails. Request fields override matching preset fields (a shallow merge), so provider-routing preferences saved in the preset are replaced by `{ zdr: true }`. The PDF is sent as `piano.pdf`, not under its original name. The request constrains the extraction structure with JSON Schema that works with both OpenAI and Gemini: it uses `anyOf` rather than `oneOf`, which OpenAI strict mode rejects, and omits array length limits, which Gemini on Vertex rejects when nested. The server then validates the result with Zod, including seven days, distinct meal slots, and every length limit (at most 100 foods per meal). The request allows up to 64,000 output tokens and 10 minutes, because a meal with several combinations lists every food of every option. AI SDK telemetry is disabled. A rejected request shows its HTTP status with OpenRouter's error message (for example a disabled preset or a provider error, at most 300 characters), never the raw response body or input flagged by moderation. A failed analysis keeps the PDF; **Analizza di nuovo** sends it again. There are no automatic retries because OpenRouter bills every attempt. Daily backups and weekly exports include the source PDFs referenced by imports.

OpenRouter's [Plugins settings](https://openrouter.ai/settings/plugins) are part of this privacy configuration: leave `file-parser` unenforced or, if **Prevent overrides** is enabled, enforce only the `native` engine. A forced non-native engine can send the PDF to a third-party parser; request-level ZDR applies only to inference endpoints, not plugin backends. See OpenRouter's [Plugins](https://openrouter.ai/docs/guides/features/plugins) and [ZDR](https://openrouter.ai/docs/guides/features/zdr) documentation.

The extraction splits every meal into single foods, each with the quantity and unit printed next to it. When the PDF offers several sets of foods for one meal («OPPURE», «a scelta tra», options valid only on some days, such as training days), each set is a combination labelled from the PDF or as «Opzione 1», «Opzione 2», and so on; foods common to every set have no combination, and «A o B» alternatives inside a set share an alternative group. A meal the PDF gives once for every day, such as a general section on breakfast and snacks, is extracted once and copied by the server into each day that has no meal of its own for that slot; equivalences scoped to it apply to every copy. A slot the PDF never gives becomes an empty meal with a warning, a free meal printed in the plan stays an empty meal with the printed text as its note, and general daily indications that belong to no meal (for example a daily allowance of oil) are listed as warnings because the app does not apply them. Alternatives made of several foods are combinations of the meal they replace, never equivalences: an equivalence item always replaces one food, or the whole meal, on its own.

After analysis the app shows a read-only summary: for each day and meal, the foods with quantities and units as printed, raw/cooked/unspecified state, alternatives, combinations, notes, and any warnings; an unspecified cooking state is explicitly shown and warned about. Equivalences are listed with their scope; ambiguous scopes are shown but not applied, while meal-wide equivalences are applied only when the source explicitly assigns them to the whole meal. There is no per-meal review or editing. **Attiva il piano** with a start date creates and activates a new plan version from the saved extraction. Extraction alone never writes or activates plan data. If the original PDF is missing, the saved summary remains viewable but activation is blocked until the PDF is restored.

For schema changes, update `src/db/schema.ts`, generate the SQL migration, and apply it:

```sh
pnpm db:generate
pnpm db:migrate
```

Migration SQL and their snapshots in `drizzle/` are version-controlled. In production, `pnpm start:deploy` applies pending migrations before starting the server.

## Plan the week

The signed-in page shows the planner above the PDF import. It covers one ISO week (Monday–Sunday) and takes each date from the plan version valid on that date, so a week can mix two versions when a new one starts mid-week. Today, and therefore which days are past, follows `Europe/Rome`.

An unconfirmed week shows the original plan, labelled **Settimana non confermata**: until the week is confirmed, the original plan is the one that applies. **Conferma la settimana** stores a snapshot of every planned meal, with the equivalences scoped to it, in `weeks` and `week_meals`; later plan versions and changes to other days never rewrite it. A week that has already ended cannot be confirmed.

In a confirmed week only dates from today on can change, and only in these ways:

- swap two whole days, or move a meal by swapping it with the same slot on another day, within the week and between dates that use the same plan version. Meals are never copied, dropped, or moved to another slot (for example lunch with dinner);
- when a meal offers several combinations, choose the one to eat on that date; then choose a substitution among the alternatives of the shared foods or of the chosen combination, or the items of an equivalence scoped to one of those foods. Alternatively, replace the whole meal with an item of an equivalence explicitly scoped to it. Equivalences with an unresolved scope never apply. Until a combination is chosen, the planner lists them all;
- choose one free meal per week, with an optional description of up to 200 characters. It replaces the planned meal at that date and slot, has no ingredients, and follows the meal when it is swapped.

If a newer plan version starts after a week was confirmed, the affected days keep their snapshot and are flagged. **Aggiorna al piano valido** replans those days, from today on, from the valid version and drops their swaps and substitutions; the free meal stays.

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
- `OPENROUTER_API_KEY`: secret OpenRouter API key for PDF extraction; set it as a private Railway variable. The model comes from the OpenRouter preset `mealio-prod`.
- `S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`, `S3_REGION`: respectively the `endpoint`, `accessKeyId`, `secretAccessKey`, `bucketName`, and `region` returned by `railway bucket credentials --bucket mealio-backups --json`.

The bucket is created in `ams`, but Railway assigns an effective S3 name distinct from the resource name; the S3 region may also differ from the creation region. Use the values returned by the credentials command. Sensitive variables remain `preserve()` values in the infrastructure-as-code file.

Sessions last 30 days. The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Login is limited to five attempts per IP address every 15 minutes; the address is stored only as an HMAC using `SESSION_SECRET`. The password field is hidden by default and has a Show/Hide control.

## Backups and exports

The maintenance process starts with the service and uploads:

- daily SQLite snapshots at 03:00 UTC, including source PDFs referenced by imported plans;
- weekly JSON exports on Sundays at 03:15 UTC, including the same source PDFs.

Objects are compressed and encrypted with AES-256-GCM before upload. The JSON export includes application tables and excludes sessions, login rate limits, and scheduler state. A backup or export fails if a referenced source PDF is missing instead of silently omitting it. The bucket is in EU West. Do not put PDFs or personal data in the repository.

Run a backup or export manually when Railway variables are available locally:

```sh
railway run --project <PROJECT_ID> --environment production --service mealio -- pnpm backup:run
railway run --project <PROJECT_ID> --environment production --service mealio -- pnpm export:run
```

## Restore from backup

Restoring replaces the current database. Perform a restore during a maintenance window and retain the `BACKUP_ENCRYPTION_KEY` used for the backup.

1. Download and verify the encrypted snapshot locally. The command runs `PRAGMA integrity_check` and extracts bundled source PDFs to the specified local directory:

   ```sh
   railway run --project <PROJECT_ID> --environment production --service mealio -- \
     pnpm backup:restore -- backups/<YYYY>/<MM>/<DD>/<object>.sqlite.gz.enc /tmp/mealio-restore.sqlite /tmp/mealio-imports
   ```

2. Stop the service, remove any stale SQLite sidecars from the volume, upload the restored database and source PDFs, then start one replica:
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
   if [ -d /tmp/mealio-imports ]; then
     railway volume files upload /tmp/mealio-imports /imports \
       --project <PROJECT_ID> --environment production --service mealio --overwrite --json
   fi
   railway scale --project <PROJECT_ID> --environment production --service mealio europe-west4=1 --json
   ```

   Remove sidecars only while the service is stopped: the restored backup replaces the previous state completely. For older backups created before PDF recovery was added, no source directory is produced and imported records will show that their original PDF is unavailable.

3. Verify `GET /api/health`, then log in. The start command applies any pending migrations automatically.

`pnpm backup:restore` accepts objects only under the `backups/` prefix and does not overwrite the volume by itself. Keep a local copy of the downloaded database and PDF directory until the restore is complete.

## Railway spend limits

Set a hard limit on the **My Projects workspace** target; the **agent** target does not limit service compute costs. A hard limit can suspend the service when the threshold is reached. Check the current status before setting a limit:

```sh
railway usage limit status --workspace "My Projects" --target workspace --json
railway usage limit set --workspace "My Projects" --target workspace --hard <USD> --json
railway usage limit status --workspace "My Projects" --target workspace --json
```
