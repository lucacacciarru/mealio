---
name: verify-ui
description: Run an observed local browser smoke check when a change can affect Mealio rendering, interaction, navigation, or user-visible data.
---

# Verify Mealio UI changes

Use for changes that can alter what a user sees or does, including route/API changes that affect a visible flow. A build or type check is not visual or behavioral proof.

## Local run

1. Follow local setup in `docs/development.md`; use `.env.example` as the variable-name template. Do not read or print `.env` values or use production credentials/data.
2. Start the app with `pnpm dev` and use `http://localhost:3000` (see `vite.config.ts`).
3. Use a browser to exercise the changed path through the real app. Check the relevant success, loading, and failure state; check keyboard operation and a narrow/mobile viewport for affected controls.
4. If the change requires authentication or private data, use a locally configured disposable account/database with synthetic data. If that prerequisite is unavailable, verify the reachable unauthenticated path and report exactly what could not be exercised; do not claim an unobserved flow passed.
5. Keep any screenshots local and synthetic. Never upload private Mealio data or screenshots to public hosting.

Report what path and state you observed and any limitation. Do not infer that an unchanged screenshot proves the changed behavior works; exercise the interaction itself.
