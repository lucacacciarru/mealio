---
name: mealio-domain-safety
description: Apply Mealio's food-plan, nutrition, check-in, health-data, and privacy invariants when implementing or reviewing domain behavior, imports, fixtures, or user-facing explanations.
---

# Mealio domain safety

Before changing product behavior, read the relevant sections of `docs/product-spec.md`. It is the source of truth for expected behavior, and explicitly distinguishes planned design from implemented features.

## Preserve domain semantics

- The professional's approved plan is authoritative. Mealio follows it; it does not create diets, foods, quantities, substitutions, or medical/nutrition advice.
- Imported plans require explicit human review and an explicit activation date; extraction alone never activates a plan.
- Preserve provenance and ambiguity. Do not infer missing values, units, raw/cooked state, equivalence scope, or nutrition targets. The plan's gram weights refer to raw ingredients unless it explicitly says otherwise.
- Keep versioned-plan and weekly-snapshot behavior intact. Do not retroactively change meals already planned or data already recorded.
- Substitutions must come from the meal's alternatives or an explicitly scoped equivalence. Day swaps move all meals; meal moves swap the same slot rather than duplicating or deleting meals.
- A planned free meal has no invented ingredients or macros, is excluded from grocery calculations, and counts as followed for adherence. A missing check-in is “not recorded,” not “not followed.” Keep adherence and coverage distinct as defined in the spec.
- Nutrition values need a visible source. Do not derive absolute macro targets from percentages until their basis is confirmed. Health statistics describe recorded data and must not imply medical conclusions.
- Keep offline edits and derived grocery calculations consistent with the spec when touching those flows; keep checkmarks, pantry quantities, and manual entries separate from the plan-derived list.

## Protect private data

- Use synthetic plans, meals, nutrition values, PDFs, and body measurements in examples, tests, logs, and screenshots. Never add the user's actual plan, source PDF, measurements, or derived personal data to the repository.
- Do not send personal health data to external tools/services unless the task and approved product flow explicitly require it. Do not inspect or print `.env`, production credentials, password hashes, session tokens, or cookies.
- Validate untrusted input at server boundaries; authorization must be enforced server-side. Do not rely on hidden UI controls to protect data or mutations.
- Do not guess when source data is ambiguous. Preserve the ambiguity and surface it for human review as the specification requires.
