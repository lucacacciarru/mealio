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

The main flow is **Dieta → Settimana → Spesa**, online only. **Settimana** is the home (`/`, also `/settimana`, optional `?start=YYYY-MM-DD` for an ISO Monday); **Spesa** (`/spesa`) accepts the same week parameter; **Dieta** is `/dieta`. Navigation has three items, in a bottom bar on mobile and a sidebar on desktop. The existing diary/history remains at `/calendario?date=YYYY-MM-DD`, reached through a secondary **Diario dei pasti** link. No offline session admission, local meal cache, change queue or background synchronization is used.

## Import a meal plan PDF

Set `OPENROUTER_API_KEY` in the local `.env` to enable extraction, then create an OpenRouter preset with the slug `mealio-prod` at https://openrouter.ai/settings/presets and choose the model there; it is not set in code or environment variables, so it can change without a deploy. Pick a model that reads PDF files natively and that OpenRouter does not moderate, for example a Google Gemini model: OpenRouter moderates some models (OpenAI ones among them) and rejects a flagged plan with HTTP 403. Keep the key out of source control and Railway config values; configure it as a private Railway variable in production. The import accepts PDF files up to 15 MB.

The authenticated user picks a PDF and chooses **Carica e analizza**. That single action stores the original under `DATA_DIRECTORY/imports/` with private file permissions (if `DATA_DIRECTORY` is unset, imports use the directory containing `DATABASE_PATH`, the Railway volume mounted at `/data` in production) and then sends the complete PDF through OpenRouter for schema-constrained JSON generation via the Vercel AI SDK OpenRouter provider; the form states where the PDF goes. Requests use `@preset/mealio-prod` as the model and set `provider.zdr: true`, so OpenRouter routes inference only to zero-data-retention endpoints (for Gemini models this means Google Vertex, not AI Studio), and select the `file-parser` plugin with the `native` PDF engine. With the account-level plugin policy below, PDFs are not sent to a separate OCR backend; a model without native PDF input fails. Request fields override matching preset fields (a shallow merge), so provider-routing preferences saved in the preset are replaced by `{ zdr: true }`. The PDF is sent as `piano.pdf`, not under its original name. The request constrains the extraction structure with JSON Schema that works with both OpenAI and Gemini: it uses `anyOf` rather than `oneOf`, which OpenAI strict mode rejects, and omits array length limits, which Gemini on Vertex rejects when nested. The server then validates the result with Zod, including seven days, distinct meal slots, and every length limit (at most 100 foods per meal). The request allows up to 64,000 output tokens and 10 minutes, because a meal with several combinations lists every food of every option. AI SDK telemetry is disabled. A rejected request shows its HTTP status with OpenRouter's error message (for example a disabled preset or a provider error, at most 300 characters), never the raw response body or input flagged by moderation. A failed analysis keeps the PDF; **Analizza di nuovo** sends it again. There are no automatic retries because OpenRouter bills every attempt. Daily backups and weekly exports include the source PDFs referenced by imports.

OpenRouter's [Plugins settings](https://openrouter.ai/settings/plugins) are part of this privacy configuration: leave `file-parser` unenforced or, if **Prevent overrides** is enabled, enforce only the `native` engine. A forced non-native engine can send the PDF to a third-party parser; request-level ZDR applies only to inference endpoints, not plugin backends. See OpenRouter's [Plugins](https://openrouter.ai/docs/guides/features/plugins) and [ZDR](https://openrouter.ai/docs/guides/features/zdr) documentation.

The extraction splits every meal into single foods, each with the quantity and unit printed next to it. When the PDF offers several sets of foods for one meal («OPPURE», «a scelta tra», options valid only on some days, such as training days), each set is a combination labelled from the PDF or as «Opzione 1», «Opzione 2», and so on; foods common to every set have no combination, and «A o B» alternatives inside a set share an alternative group. A meal the PDF gives once for every day, such as a general section on breakfast and snacks, is extracted once and copied by the server into each day that has no meal of its own for that slot; equivalences scoped to it apply to every copy. A slot the PDF never gives becomes an empty meal with a warning, a free meal printed in the plan stays an empty meal with the printed text as its note, and general daily indications that belong to no meal (for example a daily allowance of oil) are listed as warnings because the app does not apply them. Alternatives made of several foods are combinations of the meal they replace, never equivalences: an equivalence item always replaces one food, or the whole meal, on its own.

After analysis, **Dieta** shows a read-only list of meals and permitted variants, with a day selector. The latest usable PDF opens automatically on return; uploads and older PDFs are secondary disclosures. Quantities, units, raw/cooked/unspecified state, notes, warnings and PDF references remain visible or directly expandable. Equivalences retain their scope; unresolved scopes are shown but never applied. **Usa questa dieta**, with a start date, explicitly activates a version; extraction alone never activates it. Activation requires the original PDF. **Pianifica la settimana** opens the activation week, or the current week for an already-started diet. Technical AI/privacy details are expandable; the upload form still states that the PDF is private and sent to OpenRouter.

For schema changes, update `src/db/schema.ts`, generate the SQL migration, and apply it:

```sh
pnpm db:generate
pnpm db:migrate
```

Migration SQL and their snapshots in `drizzle/` are version-controlled. In production, `pnpm start:deploy` applies pending migrations before starting the server.

## Plan the week

Open **Settimana**, or follow **Pianifica la giornata** from a calendar date, to organize its ISO week (Monday–Sunday). The seven-day selector opens one day's meals at a time. Both planner routes accept `?start=YYYY-MM-DD&date=YYYY-MM-DD`, so calendar links open the exact day and browser history retains the selection. Previous/next week controls update the route. Each date takes the plan version valid on that date; a week can mix two versions when a new one starts mid-week. Today, and therefore which days are past, follows `Europe/Rome`.

A new week is a draft of the valid diet. Meal variants and explicit food alternatives start undecided; the first printed option is never selected automatically. Original foods remain the default instead of their optional equivalences. Missing quantities, foods and unresolved equivalence scopes are never guessed. Saved snapshots and choices are retained, including older unresolved alternatives, but a weekly save alone does not add dates to the calendar.

Each meal is a compact row. **Scegli** opens its required alternatives; **Modifica** opens saved choices and optional changes. Only one meal editor opens at a time; variant buttons show their foods and printed quantities. The day states once that weights are raw unless a food says otherwise; cooked weights, missing quantities and an unspecified raw/cooked state stay marked. Choosing an option saves a draft immediately. **Aggiungi al calendario** publishes only the selected day after every required variant and food alternative has been chosen. Optional equivalences and missing source foods/quantities do not block publication. A short notice confirms saves; a failed change keeps the previous choice and offers to reload the week.

The first valid edit or day publication atomically stores the weekly snapshot in `weeks` and `week_meals`; an invalid action leaves no partial snapshot. Explicit day publication is stored separately in `week_days`. There is no backfill of publication for older snapshots: their choices stay available in Settimana, and recorded diary meals remain preserved. **Vai alla spesa** only opens that week's list; it never chooses alternatives or publishes days. Editing a choice, moving meals, changing the free meal or refreshing a diet returns only affected dates to draft until they are added again. Dates from today on can change in these ways:

- swap two whole days, or move a meal by swapping it with the same slot on another day, within the week and between dates that use the same plan version. Meals are never copied, dropped, or moved to another slot (for example lunch with dinner);
- choose a meal variant from the PDF, a food alternative within its shared or selected foods, or an equivalence explicitly scoped to that food or whole meal. Required choices remain open until explicitly selected; changing a variant never adds foods from the other variants;
- choose one free meal per week, with an optional description of up to 200 characters. It replaces the planned meal at that date and slot, has no ingredients, and follows the meal when it is swapped.

If a newer diet starts after a week was saved, the affected days retain their snapshot and are flagged. **Usa la nuova dieta** replans those dates from today on and drops their swaps and substitutions; the free meal stays.

## Groceries

Open **Spesa**, or **Vai alla spesa** in the planner, for one weekly list derived only from days explicitly added to the calendar. Every read recalculates quantities; draft days and the free meal contribute nothing. The screen lists dates still in draft with a planner link, rather than counting undecided alternatives. A complete draft remains excluded until its day is added. Returning a day to draft does not erase pantry, manual items or recorded purchases; purchase differences remain visible.

Foods are identified by the catalog food linked at import, otherwise by a catalog name or alias equal to the printed label, otherwise by the printed label itself (case-insensitive). Quantities add up per food and unit. Only exact metric spellings convert on their own (`g`, `gr`, `hg`, `kg` to grams; `ml`, `cl`, `dl`, `l` to millilitres); a unit linked to the catalog at import uses its symbol, and any other unit, or a bare count, stays as printed. A food printed in several units shows one flagged line per unit until its rules set a list unit and a factor for each other unit. Cooked weights form their own line and are never turned into a raw amount to buy; non-numeric quantities (for example «q.b.») and an unspecified raw/cooked state are flagged, not guessed. Each use keeps its quantity and unit as printed in the line's details.

The screen sums the same food/unit/state into one weekly row. Existing Monday/Thursday round identities stay internal to preserve purchases, pantry and storage rules: Monday covers the early week and later uses explicitly covered by shelf life; otherwise Thursday covers the later week. No round setup or selector is required. Foods are grouped by aisle, with uncatalogued aisles last.

**Pasti e dettagli** under a line shows its uses and optional pantry quantities; **Opzioni alimento** contains optional catalog rules:

- the pantry: what is at home before that week's Monday round, in the line's unit, recorded for that week only. It covers the Monday round first, then the Thursday one;
- the food's rules, saved on the catalog food (`catalog_foods`, `catalog_food_conversions`): aisle, list unit, conversion factors, package size in the list unit, days the food keeps after purchase, and **Sempre in casa**. Foods always at home never enter the list and are listed apart. With a package size, the amount to buy rounds up to whole packages and the surplus is shown. A printed label not yet in the catalog becomes a catalog food named as printed, with the label as alias; its pantry stock and ticks follow it.

Ticking a weekly row records each contributing round's amount online; unticking clears those purchases. Partial failures are reported with the number saved and the list is reloaded, so a partly purchased row stays visibly partial. Changes after purchase show **Da aggiungere** / **Non più necessario** against the actual recorded amounts. Manual items can be added, ticked and removed in the same list; new items use the existing Monday identity internally. Pantry (`grocery_pantry`), purchases (`grocery_checks`) and manual items (`grocery_manual_items`) stay separate from the plan. No edits are queued offline.

The grocery regression scenario uses an isolated synthetic database:

```sh
pnpm exec tsx --test src/server/weeks.test.ts src/server/groceries.test.ts src/server/diary.test.ts
```

## Calendar and meal check-ins

The secondary **Diario dei pasti** (`/calendario`) opens today. Its day strip, week arrows and compact date picker select another date without entering planning mode. Past dates show read-only history; future dates show only explicitly added meals, and the API rejects future check-ins. Dates still in draft show an empty state with a link to that exact planner day, not a diet preview or a list of undecided variants. The calendar preserves printed quantities and explicit missing/ambiguous data in added meals. Previously recorded meals keep their immutable snapshots even if later planner edits return the date to draft; unrecorded meals remain hidden until publication. The server rejects new check-ins on unpublished days, including requests using an older diary snapshot.

Meal cards expose foods, quantities, an explicit **Non registrato** / **Seguito** / **Non seguito** state, and a one-tap **Seguito** action. Notes, recording time and **Non seguito** are under each meal's disclosure rather than five always-open forms. Notes are saved explicitly (up to 1,000 characters), and unsaved drafts require confirmation before route/date navigation discards them. A save or conflict resolution keeps the meal disclosure open and refreshes the note from the selected authoritative record. Time is displayed in `Europe/Rome`. A planned free meal is recorded as followed, without invented ingredients or estimated nutrition.

**Tutto seguito** records the day's meals as followed; already-followed meals keep their note and time. Correct exceptions on the individual meal. Version/provenance information is available below the meals, while a changed valid diet is flagged visibly. PDF summaries, source files, new imports and activation remain on **Dieta**; activating a plan and returning to the calendar/planner reloads the applicable data rather than relying on the previous single-page refresh callbacks.

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
