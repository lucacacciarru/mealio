# Development and Operations

## Local development

Requirements: Node.js `>=22.12` and pnpm `11.21`.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

No password configuration is needed: on first open, the app asks you to choose a password (at least 8 characters) and stores only its scrypt hash in the database. It can be changed later from **Dieta → Cambia password**. `BACKUP_ENCRYPTION_KEY` is needed only for backups and must be 32 bytes encoded as Base64; for example, generate it with `openssl rand -base64 32`.

```sh
pnpm db:migrate
pnpm dev
```

The local UI is available at `http://localhost:5009`. `.env`, the SQLite database, and the `data/` directory are excluded from Git.

The app is online only. Navigation has three items, in a bottom bar on mobile and a sidebar on desktop: **Oggi** is the home (`/`, optional `?date=YYYY-MM-DD`; the former `/calendario?date=` redirects there), **Settimana** (`/settimana`, optional `?start=YYYY-MM-DD` for an ISO Monday and `&date=`), **Spesa** (`/spesa`, same week parameter). **Dieta** (`/dieta`) is a secondary link. No offline session admission, local meal cache, change queue or background synchronization is used.

## Import a meal plan PDF

Set `OPENROUTER_API_KEY` in the local `.env` to enable extraction, then create an OpenRouter preset with the slug `mealio-prod` at https://openrouter.ai/settings/presets and choose the model there; it is not set in code or environment variables, so it can change without a deploy. Pick a model that reads PDF files natively and that OpenRouter does not moderate, for example a Google Gemini model: OpenRouter moderates some models (OpenAI ones among them) and rejects a flagged plan with HTTP 403. Keep the key out of source control and Railway config values; configure it as a private Railway variable in production. The import accepts PDF files up to 15 MB.

The authenticated user picks a PDF and chooses **Carica e analizza**. That single action stores the original under `DATA_DIRECTORY/imports/` with private file permissions (if `DATA_DIRECTORY` is unset, imports use the directory containing `DATABASE_PATH`, the Railway volume mounted at `/data` in production) and then sends the complete PDF through OpenRouter for schema-constrained JSON generation via the Vercel AI SDK OpenRouter provider; the form states where the PDF goes. Requests use `@preset/mealio-prod` as the model and set `provider.zdr: true`, so OpenRouter routes inference only to zero-data-retention endpoints (for Gemini models this means Google Vertex, not AI Studio), and select the `file-parser` plugin with the `native` PDF engine. With the account-level plugin policy below, PDFs are not sent to a separate OCR backend; a model without native PDF input fails. Request fields override matching preset fields (a shallow merge), so provider-routing preferences saved in the preset are replaced by `{ zdr: true }`. The PDF is sent as `piano.pdf`, not under its original name. The request constrains the extraction structure with JSON Schema that works with both OpenAI and Gemini: it uses `anyOf` rather than `oneOf`, which OpenAI strict mode rejects, and omits array length limits, which Gemini on Vertex rejects when nested. The server then validates the result with Zod, including seven days, distinct meal slots, and every length limit (at most 100 foods per meal). The request allows up to 64,000 output tokens and 10 minutes, because a meal with several combinations lists every food of every option. AI SDK telemetry is disabled. A rejected request shows its HTTP status with OpenRouter's error message (for example a disabled preset or a provider error, at most 300 characters), never the raw response body or input flagged by moderation. A failed analysis keeps the PDF; **Analizza di nuovo** sends it again. There are no automatic retries because OpenRouter bills every attempt. Daily backups and weekly exports include the source PDFs referenced by imports.

OpenRouter's [Plugins settings](https://openrouter.ai/settings/plugins) are part of this privacy configuration: leave `file-parser` unenforced or, if **Prevent overrides** is enabled, enforce only the `native` engine. A forced non-native engine can send the PDF to a third-party parser; request-level ZDR applies only to inference endpoints, not plugin backends. See OpenRouter's [Plugins](https://openrouter.ai/docs/guides/features/plugins) and [ZDR](https://openrouter.ai/docs/guides/features/zdr) documentation.

The extraction splits every meal into single foods, each with the quantity and unit printed next to it. When the PDF offers several sets of foods for one meal («OPPURE», «a scelta tra», options valid only on some days, such as training days), each set is a combination labelled from the PDF or as «Opzione 1», «Opzione 2», and so on; foods common to every set have no combination, and «A o B» alternatives inside a set share an alternative group. A meal the PDF gives once for every day, such as a general section on breakfast and snacks, is extracted once and copied by the server into each day that has no meal of its own for that slot; equivalences scoped to it apply to every copy. A slot the PDF never gives becomes an empty meal with a warning, a free meal printed in the plan stays an empty meal with the printed text as its note, and general daily indications that belong to no meal (for example a daily allowance of oil) are listed as warnings because the app does not apply them. Alternatives made of several foods are combinations of the meal they replace, never equivalences: an equivalence item always replaces one food, or the whole meal, on its own.

After analysis, **Dieta** shows one status card for the latest usable PDF (to activate, or active since a date) with a link to the original PDF, then a collapsible read-only list of meals and permitted variants with a day selector, and a collapsible upload for a new PDF. Quantities, units, raw/cooked/unspecified state, notes and warnings remain visible. Equivalences retain their scope; unresolved scopes are shown but never applied. **Usa questa dieta**, with a start date, explicitly activates a version; extraction alone never activates it. Activation requires the original PDF. **Scegli i pasti della settimana** opens the activation week, or the current week for an already-started diet. The upload form states that the PDF is private and sent to an AI model through OpenRouter.

For schema changes, update `src/db/schema.ts`, generate the SQL migration, and apply it:

```sh
pnpm db:generate
pnpm db:migrate
```

Migration SQL and their snapshots in `drizzle/` are version-controlled. In production, `pnpm start:deploy` applies pending migrations before starting the server.

## Plan the week

Open **Settimana**, or follow a link from Oggi or Spesa, to organize an ISO week (Monday–Sunday). Each date takes the plan version valid on that date; a week can mix two versions when a new one starts mid-week. Today, and therefore which days are past, follows `Europe/Rome`.

Meal variants and explicit food alternatives start undecided; the first printed option is never selected automatically, and optional equivalences never replace the original foods. A day is **ready** as soon as none of its meals has an open choice; there is no separate "add to calendar" step. Only ready days appear in Oggi and count for Spesa.

The screen shows, from top to bottom: the meals still to decide (the first four, as shortcuts) with **Ripeti le scelte della settimana scorsa**; the seven days, each marked ready (✓) or with its number of open choices; and the selected day's meals. A meal opens its editor with **Scegli** or **Modifica**; once it is decided, the next open meal of the same day opens. The editor contains the variants and alternatives, **Rendilo il pasto libero** (one per week, with an optional description; setting it on another meal moves it) and **Scambia con un altro giorno**. **Scambia giornata** swaps whole days. Swaps stay within the week, from today on, between dates that use the same plan version, and never move a meal to another slot. Missing quantities, foods and unresolved equivalence scopes are never guessed.

**Ripeti le scelte della settimana scorsa** fills, from today on, each meal that still has an open choice with the choices of the same plan meal (version, plan day and slot) last week, only when they resolve it. Swaps and the free meal are not repeated, so meals are never copied or dropped.

The first valid edit, check-in or grocery purchase atomically stores the weekly snapshot in `weeks` and `week_meals` (until then an untouched week follows the active diet); an invalid action leaves no partial snapshot. The `week_days` table from the former per-day publication is kept but no longer read. If a newer diet starts after a week was saved, the affected days keep their snapshot and **Usa la nuova dieta** replans those dates from today on, dropping their swaps and substitutions; the free meal stays.

## Groceries

**Spesa** shows one weekly list derived from the ready days; every read recalculates it. Days from today on that still have open choices are named with a link to the planner; the free meal contributes nothing.

Foods are identified by the catalog food linked at import, otherwise by a catalog name or alias equal to the printed label, otherwise by the printed label itself (case-insensitive). Quantities add up per food and unit. Only exact metric spellings convert on their own (`g`, `gr`, `hg`, `kg` to grams; `ml`, `cl`, `dl`, `l` to millilitres); a unit linked to the catalog at import uses its symbol, and any other unit, or a bare count, stays as printed. Cooked weights are never turned into a raw amount to buy; non-numeric quantities and an unspecified raw/cooked state are flagged on the row, not guessed.

The list groups foods by aisle; ticked rows sink to the bottom of their aisle. Ticking a row records each internal round's amount online (the Monday/Thursday round identities stay internal); unticking clears them. If meals change after a purchase and more is needed, the row shows the amount to add. The **⋯** button on a row shows the meals that use the food, the aisle field and **Ce l'ho sempre in casa**; foods always at home are listed, collapsed, at the bottom with **Rimetti in lista**. Unit conversions, package sizes and storage days already saved on catalog foods (`catalog_foods`, `catalog_food_conversions`) keep applying but are no longer edited in the UI. Manual items (`grocery_manual_items`) can be added, ticked and removed. Pantry stock recorded by earlier versions (`grocery_pantry`) stays stored but no longer changes the list. No edits are queued offline.

The grocery regression scenario uses an isolated synthetic database:

```sh
pnpm exec tsx --test src/server/weeks.test.ts src/server/groceries.test.ts src/server/diary.test.ts
```

## Oggi and meal check-ins

**Oggi** (`/`) opens today; arrows move one day back or forward and **Torna a oggi** returns. Each meal card shows the foods and quantities of the chosen variant and a one-tap **Seguito**; a progress line counts followed meals. Past dates are read-only; future dates show only ready days, and the API rejects future check-ins. A day with open choices shows an empty state with a link to that exact planner day, never a diet preview or a list of undecided variants. Missing/ambiguous data stays explicit.

A meal without a check-in is "not recorded", not "not followed". Under each meal, **Nota o non seguito** opens the note (saved explicitly, up to 1,000 characters) and **Segna non seguito**; unsaved notes require confirmation before navigation discards them. **Segna tutto come seguito** records the day's meals as followed; already-followed meals keep their note and time. A planned free meal is recorded as followed, without invented ingredients or estimated nutrition. Previously recorded meals keep their immutable snapshots even if later planner edits reopen a choice on that day; unrecorded meals stay hidden until the day is ready again. The server rejects new check-ins on days with open choices, including requests using an older diary snapshot.

The server retains immutable day-plan copies in `diary_plan_snapshots`. Each row in `meal_check_ins` keeps the meal snapshot from its first check-in, even when the note/status is edited or the planner changes. Past unrecorded meals use the day plan captured at its first check-in. Revisions detect concurrent edits and `check_in_operations` preserves idempotency when a response is lost; existing delayed submissions and recorded history remain compatible.

### Online-only operation

All screens load and save against the server. A failed connection reports an error, never a local save or a queued operation. Diary conflicts still require an explicit choice between the displayed draft and server data.

Existing `/diary-sw.js` installations are retired by a no-fetch worker and by the app shell: only `mealio-public-*` anonymous caches are removed. The app registers no worker and emits no offline asset manifest. Old personal IndexedDB data is deliberately untouched; it is not loaded, synchronized or discarded automatically.

The persistence regression scenario uses an isolated synthetic database:

```sh
pnpm exec tsx --test src/server/diary.test.ts
```

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

- `ADMIN_PASSWORD_HASH` (optional): output from `pnpm auth:hash`. It is used only until a password is chosen or changed in the app, which then takes precedence. Without it, the first visitor of a fresh deployment chooses the password, so open a new deployment yourself right away.
- `SESSION_SECRET` (optional): at least 32 random bytes to key login rate limits; otherwise the app generates and stores one.
- `BACKUP_ENCRYPTION_KEY`: 32 random bytes encoded as Base64. Keep a copy outside Railway, such as in a password manager; it is required to decrypt backups.
- `OPENROUTER_API_KEY`: secret OpenRouter API key for PDF extraction; set it as a private Railway variable. The model comes from the OpenRouter preset `mealio-prod`.
- `S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`, `S3_REGION`: respectively the `endpoint`, `accessKeyId`, `secretAccessKey`, `bucketName`, and `region` returned by `railway bucket credentials --bucket mealio-backups --json`.

The bucket is created in `ams`, but Railway assigns an effective S3 name distinct from the resource name; the S3 region may also differ from the creation region. Use the values returned by the credentials command. Sensitive variables remain `preserve()` values in the infrastructure-as-code file.

Sessions last a year and are renewed (at most once a day) while in use, so each device signs in once. The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Login, first-run setup and password changes are limited to five attempts per IP address every 15 minutes; the address is stored only as an HMAC keyed by `SESSION_SECRET` or by a random secret kept in `app_settings`. Changing the password keeps the current session and signs out every other device; **Esci** ends the current one. The password field is hidden by default and has a Show/Hide control.

## Backups and exports

The maintenance process starts with the service and uploads:

- daily SQLite snapshots at 03:00 UTC, including source PDFs referenced by imported plans;
- weekly JSON exports on Sundays at 03:15 UTC, including the same source PDFs.

Objects are compressed and encrypted with AES-256-GCM before upload. The JSON export includes application tables and excludes sessions, login rate limits, `app_settings` (password hash and rate-limit secret), and scheduler state; the SQLite snapshot keeps them, so a restore brings the password back. A backup or export fails if a referenced source PDF is missing instead of silently omitting it. The bucket is in EU West. Do not put PDFs or personal data in the repository.

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
