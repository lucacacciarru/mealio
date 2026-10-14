---
name: react-ui
description: Use when creating, refactoring, or reviewing Mealio React UI, interactions, component state, or rendering behavior.
---

# React UI in Mealio

This app uses React 19 with TanStack Start in SPA mode. Follow nearby `src/routes/` code and TanStack Router conventions. Do not apply Next.js App Router, Server Components, `next/*`, or server-action guidance: those APIs are not part of this project.

- Prefer simple local components and explicit state. Introduce reusable components or compound APIs only when real reuse or complexity warrants them; avoid boolean-prop proliferation without building abstractions in advance.
- Derive render state from current props/state instead of synchronizing derived values through effects. Use effects for external systems; put interaction-specific work in event handlers.
- Keep state as close as possible to its consumers. Memoize only when there is measured or clearly non-trivial work; avoid `useMemo`/`useCallback` for simple values and expressions.
- Start independent asynchronous work together where ordering is not required. Preserve loading, error, and success states for user-visible requests.
- Use semantic HTML, associated labels, keyboard-operable controls, and clear focus/error states. Keep layouts mobile-first, consistent with `docs/product-spec.md`.
- Keep authentication, validation, and data integrity on the server even when the UI already constrains input.

These are focused React principles adapted from Foodlista's React guidance. Framework-specific Next.js, SWR, and server-rendering rules do not apply here; verify any library-specific technique against the dependencies in `package.json`.
