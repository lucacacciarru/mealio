# Mealio Agent Guide

Mealio is a private, single-user meal-planning application. The product specification describes intended behavior; it is not proof that a feature already exists. Read the relevant source before treating a requirement as implemented.

## Start here

- `docs/development.md` — local setup, commands, deployment, and data operations.
- `docs/product-spec.md` — product rules, privacy boundaries, and planned architecture.
- `.agents/skills/` — load the skill that matches the task before changing domain behavior, React UI, or user-visible flows.

## Project shape and commands

- Node.js `>=22.12`; pnpm `11.21.0`.
- TanStack Start in SPA mode, React 19, Vite, Nitro's Node server, SQLite, and Drizzle.
- `src/routes/` contains file-based UI and API routes; `src/server/` contains server-side auth; `src/db/` contains the SQLite connection and Drizzle schema; `drizzle/` contains migrations; `scripts/` contains runtime and maintenance commands.
- `pnpm dev` starts the local app at `http://localhost:3000`; follow `docs/development.md` for local environment setup.
- `pnpm build` runs the Vite production build and `tsc --noEmit`.
- Schema changes: update `src/db/schema.ts`, run `pnpm db:generate`, review the generated SQL and snapshot, then apply with `pnpm db:migrate` to a disposable/local database. Never test migrations against production or a database containing irreplaceable data.
- `package.json` currently defines no test or lint script. Do not invent `pnpm test`/`pnpm lint` checks or claim the build proves runtime behavior. For behavior changes, run the relevant app flow or a focused disposable smoke scenario; state any environment-dependent limitation precisely.

## Change rules

- Read adjacent code and follow its existing patterns. Keep the solution small; avoid adding frameworks, dependencies, abstractions, or speculative features.
- Treat `docs/product-spec.md` as the authority for product semantics. In particular, do not invent foods, quantities, substitutions, nutrition values, medical advice, or interpretations of health measurements. Preserve unresolved/ambiguous data as unresolved.
- Use only synthetic meal plans, PDFs, nutrition data, and body measurements in fixtures, examples, logs, and screenshots. Do not commit personal data or expose `.env`, passwords, password hashes, session cookies, tokens, or production credentials.
- Enforce authentication, input validation, and authorization on the server/API boundary; UI visibility is not a security control. Avoid logging secrets or personal health data.
- Preserve SQLite data compatibility. Review migration SQL and snapshots, and use a disposable database for migration checks. Do not silently reset, replace, or delete user data.
- Keep user-facing UI mobile-first and accessible. For user-visible behavior, follow `.agents/skills/verify-ui` and observe the changed flow in the running app rather than relying on a build alone.
- Add path-specific `AGENTS.md` files only when a subtree has distinct rules that are not clear here.

## Local skills

- `.agents/skills/mealio-domain-safety` — plan, food, grocery, check-in, nutrition, or body-measurement semantics and privacy.
- `.agents/skills/react-ui` — React 19 UI work; scoped to this TanStack Start SPA, not Next.js.
- `.agents/skills/verify-ui` — local browser smoke checks for user-visible changes; no Foodlista credentials, infrastructure, or screenshot hosting.
