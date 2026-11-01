# Mealio — Product and Technical Specification

> Reference for requirements, decisions, and completion criteria. This document describes intended behavior, not necessarily features already implemented.
>
> **Privacy:** this version contains no personal PDF, real meals, plan quantities, personal nutrition values, or body measurements. Use synthetic data in examples and tests.

## Goal

Mealio is a private app with one primary flow: **upload the professional's diet PDF → choose that diet's meals and variants for a week → generate the weekly shopping list**. It follows the plan; it does not create diets or provide medical or nutritional advice.

The app is online-only and usable from an iPhone or a computer. Its three screens are **Oggi** (the home: today's meals and a one-tap check-in), **Settimana** (choosing the week's meals) and **Spesa** (the shopping list). **Dieta** (uploading and activating the PDF) is used rarely and sits outside the main navigation. Check-ins are optional and never a prerequisite for planning or shopping.

## Product principles and rules

- The professional's approved plan is the source of truth. The app must not invent foods, quantities, or substitutions.
- Plans are versioned; each week retains a snapshot of the plan and the changes used during that period.
- A plan has seven days and five slots: breakfast, morning snack, lunch, afternoon snack, and dinner.
- **Plan weights refer to ingredients weighed raw**, as confirmed by the user. Any exception must be explicit in the plan.
- Substitutions are allowed only among a meal's alternatives or through equivalences explicitly associated with a component and its scope. Global equivalences do not apply.
- Swapping two days moves all meals together. Moving a meal between days swaps it with the meal in the same slot; it must not duplicate or remove meals. Changes must not mix plan versions.
- Past days are not replanned; they are recorded in the diary.
- One free meal per week is allowed, chosen by the user. It may have a description, but no invented ingredients or macros, and it does not contribute to groceries. A planned free meal counts as followed for adherence.
- Missing or ambiguous data remains explicit and is flagged as a warning; it is not guessed.
- The interface is mobile-first. Loading and saving require connectivity; there is no offline mode, local health-data cache, outbox or background synchronization.
- Statistics describe recorded data; they do not make medical conclusions.

## Functional requirements

### 1. Plan import and versioning

Expected flow:

1. Upload and privately retain the original PDF.
2. In the same explicit action (**Carica e analizza**, which states that the PDF goes to an AI model through OpenRouter), send the PDF through OpenRouter for structured extraction, routing inference only to zero-data-retention endpoints and selecting the native PDF parser. Require account-level Plugins settings not to enforce a non-native `file-parser` engine, because request-level ZDR does not apply to plugin backends. Retrying is another explicit action.
3. Normalize foods and units against the catalog.
4. Validate structure, quantities, units, alternatives, and equivalences; flag ambiguity instead of filling gaps by assumption.
5. Show a read-only list of meals and permitted variants with a day selector. Preserve printed quantities and units, raw/cooked/unspecified state, notes, equivalences and warnings; the original PDF stays one tap away. There is no per-meal review or manual correction. The latest usable saved import opens on return as a single status card (active since a date, or to activate); uploading another PDF is a secondary action. Older imports remain stored but are not browsed in the UI.
6. **Usa questa dieta** explicitly activates a new version with a start date, only while the original PDF is available. **Pianifica la settimana** opens the applicable week. Equivalences with unclear scopes are shown but not applied; retain previous versions.

Import must cover all seven days and five meals, preserving alternatives, notes, quantities, raw/cooked state, and equivalences with their scope and provenance. Automated extraction must never activate a plan directly.

The OpenRouter service account must not enforce a non-native PDF parser in its Plugins settings. If `Prevent overrides` is enabled for `file-parser`, its configured PDF engine must be `native`; request-level zero-data-retention routing does not apply to plugin backends.

### 2. Food catalog

The catalog maps plan names to normalized foods and retains reusable aliases. In the macro phase, it includes nutrients per 100 g, data source, and food state (raw/cooked). It may include alternative units, typical package sizes, store aisle, and information useful for shopping.

### 3. Weekly planning

A new week starts from the diet valid on each date. Required meal variants and explicit food alternatives remain undecided until the user chooses them; optional equivalences never replace original foods automatically. A day is **ready** as soon as none of its meals has an open choice: there is no separate publication step. Only ready days appear in Oggi and in the shopping list. The planner lists the meals still to decide and, once a meal is decided, opens the next open meal of that day. The user can:

- swap two full days from the same version;
- move a meal by swapping it with the meal in the same slot on another day;
- choose a substitution allowed by the meal or an applicable equivalence;
- choose the weekly free meal from the meal itself;
- explicitly repeat last week's choices: each meal still open from today on takes the choices of the same plan meal (version, plan day and slot) last week, only when they resolve it. Swaps and the free meal are not repeated, so no meal is copied or dropped.

The first valid edit, check-in or grocery purchase atomically saves a snapshot of the week's meals and choices; until then an untouched week follows the active diet. An invalid action creates no saved week, and opening groceries never saves one. Reopening a choice makes that day not ready again until it is decided. Groceries recalculate from ready days; past choices, saved snapshots and recorded diary meals are not silently reinterpreted. Day publication records written by earlier versions (`week_days`) are kept but no longer read.

### 4. Groceries

The list is derived only from ready days, excluding free-meal items. It sums quantities by food, leaves out “always at home” items, accounts for use dates and storage, and groups items by aisle. Days from today on that still have open choices are named with a planner link, never counted as foods to buy.

Show one weekly shopping list, summing the same food/unit/state across the internal Monday/Thursday accounting rounds. The user does not choose or configure rounds to shop. Checking a weekly row records its contributing purchases online; taken rows sink to the bottom of their aisle; partial failures remain explicit. When meal changes need more of a food already bought, the row shows the amount to add. Per food, the user can only set the aisle and mark it “always at home”; existing unit, package and storage rules keep applying. Checkmarks and manual items remain separate from the derived list. Pantry stock recorded by earlier versions stays stored but no longer changes the list.

### 5. Oggi and check-ins

Each meal has a binary check-in: **followed** or **not followed**, with an optional note. A meal without a check-in is “not recorded,” not “not followed.” The user can record all meals for a day with one action when they were followed.

**Oggi** (`/`, `/calendario` redirects there) shows only meals of ready days and previously recorded meals, with printed quantities and explicit missing data. A day with open choices has an empty state linked to that exact planner date, never an automatic diet preview or unresolved variant list. Previous/next day arrows open past history or future planned meals; only today's meals offer online check-ins. Notes and “not followed” open on demand. Server validation rejects new check-ins for days with open choices even when an older snapshot exists; recorded meal snapshots remain immutable.

Primary navigation contains only **Oggi**, **Settimana** and **Spesa**; **Dieta** is a secondary link. Importing the professional's diet is separate from organizing a week, and neither check-ins nor grocery settings are required to complete the core flow.

### 6. Macros and statistics

Actual macros are calculated from plan quantities and the nutrients linked in the catalog, with source/provenance visible. Values reported by the PDF, including its energy percentages, are retained with their original labels; **do not derive gram targets until the basis for applying the percentages is confirmed**. Do not estimate macros for a free meal.

Adherence is `followed meals / recorded meals`; unrecorded meals are excluded. Coverage is `recorded meals / planned meals`. If there is not enough data, the dashboard says so instead of showing a misleading result. Views by period, meal, and day, trends, and comparisons between plan versions are planned.

The body diary records weight every Monday, waist and hip measurements once a month, and workouts by type and duration. The interface shows series and changes without medical interpretation.

### 7. Optional future notifications

Notifications are outside the simplified core flow and are not required for import, planning or shopping. Any future iPhone Home Screen / Web Push work must not reintroduce offline health-data storage or synchronization. The historical notification catalog below remains a future reference, not implemented behavior.

Initial notification catalog, in `Europe/Rome`:

| Notification | Planned time | Condition/destination |
|---|---|---|
| Weekly planning | Sunday 18:00, reminder 21:00 | Next week has no saved snapshot; opens the planner |
| Groceries ready | Shopping day, 09:00 | The weekly list contains items; opens the list |
| Evening check-in | Every day, 21:30 | Meals remain unrecorded; opens check-in |
| Preparations for tomorrow | 21:00 | Preparations are needed; opens the preparation list |
| Weigh-in | Monday, 07:30 | Opens weight entry and, when scheduled, measurements |
| Weekly report | Monday, 08:00 | Opens the completed week's report |
| Monthly report | First day of the month, 09:00 | Opens the monthly report |

Notifications must be idempotent, respect the `Europe/Rome` time zone, and not duplicate on daylight-saving changes or restarts. Push subscription and its status must be visible; a test notification must be available.

## Conceptual model and invariants

- **Catalog:** foods, aliases, units, nutrient sources, and raw/cooked state.
- **Versioned plan:** private source document, validity period, days, meals, components, alternatives, equivalences, and provenance.
- **Week:** real dates, plan version, meal snapshots, substitutions, swaps, and free meal.
- **Groceries:** one weekly list, internal purchase-round identities, checkmarks, and manual items.
- **Diary:** check-ins, body measurements, and workouts.
- **System:** imports, notifications, push subscriptions, and idempotent send records.

Key invariants:

1. A date uses the plan version valid for that date.
2. Plan changes do not retroactively alter already planned meals or recorded data.
3. Swaps and moves preserve meals; a move is always a swap within the same slot.
4. Groceries are derived from the week's ready days; checkmarks and manual items are separate state.
5. Automated extraction never activates a plan by itself; the user activates it explicitly after seeing the summary.

## Planned architecture

These are design choices to validate during implementation, not services that are necessarily active:

- **Web:** TanStack Start with React in SPA mode; server functions for application operations and server routes for uploads, push, and scheduler ticks.
- **Runtime/deployment:** Node via Nitro on Railway, EU West region.
- **Persistence:** SQLite with Drizzle on the web service's persistent volume.
- **Import:** Vercel AI SDK with the OpenRouter provider for JSON generation; the model is chosen in an OpenRouter preset, and requests enforce zero-data-retention routing and native PDF input. The OpenRouter account must not enforce a non-native PDF parser, because ZDR does not cover plugin backends. Zod validates extracted data on the server.
- **Client data:** online requests and in-memory view state only. No offline worker, persisted health-data cache or local mutation queue. Previously installed workers are retired without deleting personal IndexedDB records.
- **Scheduler:** a Railway Function runs periodically and calls a protected endpoint on the web service. The web service decides sends using `Europe/Rome` and records a unique key to prevent duplicates.
- **Push:** Web Push with VAPID keys; the private key remains only in service environment variables.

Prototype items to verify: SQLite driver compatibility with the Node runtime, actual volume persistence, and any future scheduler behavior across daylight-saving changes or restarts.

## Security and data handling

- Single-user password access, chosen in the app on first run and changeable from the app, with a session renewed while in use; cookies use `HttpOnly`, `Secure`, and `SameSite`; rate-limit login attempts.
- Store only the password hash (in the database) and keep other secrets in environment variables, never in the repository.
- Protect the scheduler endpoint with a shared secret; require a valid session to manage push subscriptions.
- Store PDFs and personal data only in the application's private storage. Do not commit PDFs, real meals, personal nutrition values, body measurements, screenshots, or fixtures derived from real data.
- Use synthetic examples in tests. Import regression tests must not include the personal PDF or its extraction in the repository.
- Provide data export and verify backup restoration.

## Roadmap and dependencies

The board's development order is based on prerequisites and dependencies, not issue number:

1. **Phase 1 — Foundations, plan, and import:** #3 repository/app setup; #1 catalog and versioned model; #11 PDF import with summary.
2. **Phase 2 — Weekly use:** #9 planner; #7 groceries and optional pantry; #12 existing online diary remains secondary. The former #10 offline scope is retired.
3. **Phase 3 — Data and statistics:** #5 BDA catalog and macros; #13 body measurements and workouts; #8 dashboard.
4. **Phase 4 — Reminders:** #6 Web Push subscriptions and badge; #4 scheduler and first notification group; #2 remaining notifications.
5. **Extras:** to be defined based on actual use, outside the initial phases.

### Phase completion criteria

- **Phase 1:** import a plan, see its summary, and activate it without direct database changes; previous versions remain accessible.
- **Phase 2:** import a PDF, explicitly use its meals, choose variants and day swaps, generate one shopping list from the ready days, and check purchases online. No variant is selected automatically except when the user explicitly repeats last week's choices. Existing choices and recorded history remain intact; offline operation is not an acceptance criterion.
- **Phase 3:** macros and statistics are traceable to their sources; the body diary is available over time; the dashboard reports insufficient coverage.
- **Phase 4:** push and scheduler run for two weeks without duplicate or missed sends and respect local time across daylight-saving changes.

## Open decisions

- Confirm the basis for the plan's energy percentages before deriving absolute gram targets. Until then, show the original percentages and calculate only actual macros from foods.
- Verify the technical compatibility items listed in the architecture section during the prototype.
- Define extra features only after using the main phases.
