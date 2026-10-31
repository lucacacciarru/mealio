import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { GROCERY_ROUNDS } from '../../db/schema'
import { hasValidSession } from '../../server/auth'
import {
  addGroceryManualItem,
  clearGroceryCheck,
  deleteGroceryManualItem,
  getGroceries,
  isCanonicalUnit,
  isFoodKey,
  setGroceryCheck,
  setGroceryFoodRules,
  setGroceryManualItemChecked,
} from '../../server/groceries'
import { HttpError, readBodyUpTo, requestHasSameOrigin } from '../../server/http'

const responseHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

// The week start is validated by the grocery module.
const weekStart = z.string().max(10)
const round = z.enum(GROCERY_ROUNDS)
const foodKey = z.string().max(320).refine(isFoodKey)
const unit = z.string().max(80).refine(isCanonicalUnit)
const name = z.string().trim().min(1).max(300)
const amount = z.number().nonnegative().max(1_000_000)
const line = { weekStart, round, foodKey, unit, cooked: z.boolean() }
const GroceryActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('check'), ...line, name, quantity: amount.nullable() }).strict(),
  z.object({ action: z.literal('uncheck'), ...line }).strict(),
  z
    .object({
      action: z.literal('addManual'),
      weekStart,
      round,
      id: z.uuid(),
      label: z.string().trim().min(1).max(120),
      quantityText: z.string().trim().max(60).nullable(),
    })
    .strict(),
  z.object({ action: z.literal('setManualChecked'), weekStart, id: z.uuid(), checked: z.boolean() }).strict(),
  z.object({ action: z.literal('deleteManual'), weekStart, id: z.uuid() }).strict(),
  z
    .object({
      action: z.literal('setFoodRules'),
      weekStart,
      foodKey,
      aisle: z.string().trim().max(60).nullable(),
      unit: unit.nullable(),
      packageSize: amount.positive().nullable(),
      storageDays: z.number().int().min(0).max(365).nullable(),
      alwaysAtHome: z.boolean(),
      conversions: z.array(z.object({ unit, factor: amount.positive() }).strict()).max(20),
    })
    .strict(),
])

function applyGroceryAction(action: z.infer<typeof GroceryActionSchema>) {
  switch (action.action) {
    case 'check':
      return setGroceryCheck(action)
    case 'uncheck':
      return clearGroceryCheck(action)
    case 'addManual':
      return addGroceryManualItem(action)
    case 'setManualChecked':
      return setGroceryManualItemChecked(action)
    case 'deleteManual':
      return deleteGroceryManualItem(action)
    case 'setFoodRules':
      return setGroceryFoodRules(action)
  }
}

export const Route = createFileRoute('/api/groceries')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!hasValidSession(request)) {
          return Response.json({ error: 'Accesso richiesto.' }, { status: 401, headers: responseHeaders })
        }
        try {
          const start = new URL(request.url).searchParams.get('start')
          return Response.json(getGroceries(start ?? undefined), { headers: responseHeaders })
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          const message = error instanceof HttpError ? error.message : 'Impossibile leggere la spesa.'
          return Response.json({ error: message }, { status, headers: responseHeaders })
        }
      },
      POST: async ({ request }) => {
        if (!hasValidSession(request)) {
          return Response.json({ error: 'Accesso richiesto.' }, { status: 401, headers: responseHeaders })
        }
        if (!requestHasSameOrigin(request)) {
          return Response.json({ error: 'Richiesta non valida.' }, { status: 403, headers: responseHeaders })
        }
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return Response.json({ error: 'Richiesta non valida.' }, { status: 415, headers: responseHeaders })
        }
        try {
          const body = await readBodyUpTo(request, 16_384)
          let payload: unknown
          try {
            payload = JSON.parse(body.toString('utf8'))
          } catch {
            throw new HttpError('Richiesta non valida.', 400)
          }
          const action = GroceryActionSchema.safeParse(payload)
          if (!action.success) {
            return Response.json({ error: 'Modifica della spesa non valida.' }, { status: 400, headers: responseHeaders })
          }
          return Response.json(applyGroceryAction(action.data), { headers: responseHeaders })
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          const message = error instanceof HttpError ? error.message : 'Modifica della spesa non riuscita.'
          return Response.json({ error: message }, { status, headers: responseHeaders })
        }
      },
    },
  },
})
