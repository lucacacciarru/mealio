# Mealio — Product and Technical Specification

> Reference for requirements, decisions, and completion criteria. This document describes intended behavior, not necessarily features already implemented.
>
> **Privacy:** this version contains no personal PDF, real meals, plan quantities, personal nutrition values, or body measurements. Use synthetic data in examples and tests.

## Goal

Mealio is a private app for consulting and following a meal plan already defined by a nutrition professional, planning the week, preparing groceries, recording adherence, and tracking personal data over time. The app follows the plan; it does not create diets or provide medical or nutritional advice.

The intended use is individual, from an iPhone and a computer. Use the iPhone for Today, check-ins, and groceries; use the computer primarily for importing and planning.

## Product principles and rules

- The professional's approved plan is the source of truth. The app must not invent foods, quantities, or substitutions.
- Plans are versioned; each week retains a snapshot of the plan and the changes used during that period.
- A plan has seven days and five slots: breakfast, morning snack, lunch, afternoon snack, and dinner.
- **Plan weights refer to ingredients weighed raw**, as confirmed by the user. Any exception must be explicit in the plan.
- Substitutions are allowed only among a meal's alternatives or through equivalences explicitly associated with a component and its scope. Global equivalences do not apply.
- Swapping two days moves all meals together. Moving a meal between days swaps it with the meal in the same slot; it must not duplicate or remove meals. Changes must not mix plan versions.
- Past days are not replanned; they are recorded in the diary.
- One free meal per week is allowed, chosen by the user. It may have a description, but no invented ingredients or macros, and it does not contribute to groceries. A planned free meal counts as followed for adherence.
- Missing or ambiguous data remains explicit and requires review; it is not guessed.
- The interface is mobile-first. Groceries and check-ins must work offline and sync when connectivity returns.
- Statistics describe recorded data; they do not make medical conclusions.

## Functional requirements

### 1. Plan import and versioning

Expected flow:

1. Upload and privately retain the original PDF.
2. Send the PDF to Google Gemini for structured extraction, only after the user authorizes it.
3. Normalize foods and units against the catalog.
4. Validate structure, quantities, units, alternatives, and equivalences; flag ambiguity instead of filling gaps by assumption.
5. Show the PDF alongside the extraction, with page-level provenance, for review and manual correction.
6. Activate a new version only while the original PDF is available, after explicit confirmation and selection of a start date. Retain previous versions and show differences.

Import must cover all seven days and five meals, preserving alternatives, notes, quantities, raw/cooked state, and equivalences with their scope and provenance. Automated extraction must never activate a plan directly.

### 2. Food catalog

The catalog maps plan names to normalized foods and retains reusable aliases. In the macro phase, it includes nutrients per 100 g, data source, and food state (raw/cooked). It may include alternative units, typical package sizes, store aisle, and information useful for shopping.

### 3. Weekly planning

A week is derived from a plan version and associated with real dates. The user can:

- swap two full days from the same version;
- move a meal by swapping it with the meal in the same slot on another day;
- choose a substitution allowed by the meal or an applicable equivalence;
- choose the weekly free meal.

An unconfirmed week may start from the original plan, but it must be marked as unconfirmed. Changes to future days recalculate grocery requirements; past meals remain in the diary.

### 4. Groceries and pantry

The list is derived from planned meals, excluding free-meal items. It sums quantities by food, subtracts pantry stock and “always at home” items, accounts for use dates and storage, and groups items by aisle.

Two shopping rounds are planned: Monday and Thursday. After a plan change, the list shows the difference from items already purchased. Checkboxes must work offline. The list is recalculated from the plan; checkmarks, manual items, and pantry quantities are stored separately.

### 5. Today and diary

Each meal has a binary check-in: **followed** or **not followed**, with an optional note. A meal without a check-in is “not recorded,” not “not followed.” The user can record all meals for a day with one action when they were followed.

### 6. Macros and statistics

Actual macros are calculated from plan quantities and the nutrients linked in the catalog, with source/provenance visible. Values reported by the PDF, including its energy percentages, are retained with their original labels; **do not derive gram targets until the basis for applying the percentages is confirmed**. Do not estimate macros for a free meal.

Adherence is `followed meals / recorded meals`; unrecorded meals are excluded. Coverage is `recorded meals / planned meals`. If there is not enough data, the dashboard says so instead of showing a misleading result. Views by period, meal, and day, trends, and comparisons between plan versions are planned.

The body diary records weight every Monday, waist and hip measurements once a month, and workouts by type and duration. The interface shows series and changes without medical interpretation.

### 7. PWA and notifications

The PWA must be installable on the iPhone Home Screen. Web Push is planned only for the iPhone; the computer remains usable without notifications. Tapping a notification opens the relevant screen; notifications do not require interactive actions. The app icon badge represents meals still to be recorded.

Initial notification catalog, in `Europe/Rome`:

| Notification | Planned time | Condition/destination |
|---|---|---|
| Weekly planning | Sunday 18:00, reminder 21:00 | Next week is unconfirmed; opens the planner |
| Groceries ready | Shopping day, 09:00 | The round contains items; opens the list |
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
- **Groceries:** derived list, two shopping rounds, pantry, checkmarks, and manual items.
- **Diary:** check-ins, body measurements, and workouts.
- **System:** imports, notifications, push subscriptions, and idempotent send records.

Key invariants:

1. A date uses the plan version valid for that date.
2. Plan changes do not retroactively alter already planned meals or recorded data.
3. Swaps and moves preserve meals; a move is always a swap within the same slot.
4. Groceries are derived from the week's current plan; checkmarks, pantry, and manual items are separate state.
5. Automated extraction never replaces human review.

## Planned architecture

These are design choices to validate during implementation, not services that are necessarily active:

- **Web:** TanStack Start with React in SPA mode; server functions for application operations and server routes for uploads, push, and scheduler ticks.
- **Runtime/deployment:** Node via Nitro on Railway, EU West region.
- **Persistence:** SQLite with Drizzle on the web service's persistent volume.
- **Import:** Vercel AI SDK with its Google provider for structured output; Zod validates extracted data on the server and in forms/application code.
- **PWA/offline:** manifest and dedicated service worker; cache persisted in IndexedDB and an offline change queue for grocery checkmarks and check-ins.
- **Scheduler:** a Railway Function runs periodically and calls a protected endpoint on the web service. The web service decides sends using `Europe/Rome` and records a unique key to prevent duplicates.
- **Push:** Web Push with VAPID keys; the private key remains only in service environment variables.

Prototype items to verify: SQLite driver compatibility with the chosen Node runtime, production PWA/service-worker build, actual volume persistence, and job behavior across daylight-saving changes.

## Security and data handling

- Single-user password access with a long-lived session; cookies use `HttpOnly`, `Secure`, and `SameSite`; rate-limit login attempts.
- Store only the password hash and keep secrets in environment variables, never in the repository.
- Protect the scheduler endpoint with a shared secret; require a valid session to manage push subscriptions.
- Store PDFs and personal data only in the application's private storage. Do not commit PDFs, real meals, personal nutrition values, body measurements, screenshots, or fixtures derived from real data.
- Use synthetic examples in tests. Import regression tests must not include the personal PDF or its extraction in the repository.
- Provide data export and verify backup restoration.

## Roadmap and dependencies

The board's development order is based on prerequisites and dependencies, not issue number:

1. **Phase 1 — Foundations, plan, and import:** #3 repository/app setup; #1 catalog and versioned model; #11 PDF import with review.
2. **Phase 2 — Weekly use:** #9 planner; #12 Today and check-ins; #10 PWA/offline; #7 groceries and pantry.
3. **Phase 3 — Data and statistics:** #5 BDA catalog and macros; #13 body measurements and workouts; #8 dashboard.
4. **Phase 4 — Reminders:** #6 Web Push subscriptions and badge; #4 scheduler and first notification group; #2 remaining notifications.
5. **Extras:** to be defined based on actual use, outside the initial phases.

### Phase completion criteria

- **Phase 1:** import, review, and activate a plan without direct database changes; previous versions remain accessible.
- **Phase 2:** plan a week, record meals, and complete both shopping rounds in the app, including offline grocery checkmarks.
- **Phase 3:** macros and statistics are traceable to their sources; the body diary is available over time; the dashboard reports insufficient coverage.
- **Phase 4:** push and scheduler run for two weeks without duplicate or missed sends and respect local time across daylight-saving changes.

## Open decisions

- Confirm the basis for the plan's energy percentages before deriving absolute gram targets. Until then, show the original percentages and calculate only actual macros from foods.
- Verify the technical compatibility items listed in the architecture section during the prototype.
- Define extra features only after using the main phases.
