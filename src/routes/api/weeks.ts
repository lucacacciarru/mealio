import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { PLAN_SLOTS } from '../../db/schema'
import { hasValidSession } from '../../server/auth'
import { HttpError, readBodyUpTo, requestHasSameOrigin } from '../../server/http'
import {
  clearWeekFreeMeal,
  confirmWeek,
  getWeek,
  refreshWeek,
  setWeekFreeMeal,
  setWeekMealChoices,
  swapWeekMeals,
  WeekMealChoicesSchema,
} from '../../server/weeks'

const responseHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

// Dates are validated against the week by the planner module.
const date = z.string().max(10)
const weekStart = date
const slot = z.enum(PLAN_SLOTS)
const WeekActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), weekStart }).strict(),
  z.object({ action: z.literal('refresh'), weekStart }).strict(),
  z.object({ action: z.literal('swapDays'), weekStart, dates: z.tuple([date, date]) }).strict(),
  z.object({ action: z.literal('moveMeal'), weekStart, slot, dates: z.tuple([date, date]) }).strict(),
  z.object({ action: z.literal('setChoices'), weekStart, date, slot, choices: WeekMealChoicesSchema }).strict(),
  z
    .object({ action: z.literal('setFreeMeal'), weekStart, date, slot, description: z.string().max(1000).nullable() })
    .strict(),
  z.object({ action: z.literal('clearFreeMeal'), weekStart }).strict(),
])

function applyWeekAction(action: z.infer<typeof WeekActionSchema>) {
  switch (action.action) {
    case 'confirm':
      return confirmWeek(action.weekStart)
    case 'refresh':
      return refreshWeek(action.weekStart)
    case 'swapDays':
      return swapWeekMeals(action.weekStart, action.dates, PLAN_SLOTS)
    case 'moveMeal':
      return swapWeekMeals(action.weekStart, action.dates, [action.slot])
    case 'setChoices':
      return setWeekMealChoices(action.weekStart, action.date, action.slot, action.choices)
    case 'setFreeMeal':
      return setWeekFreeMeal(action.weekStart, action.date, action.slot, action.description)
    case 'clearFreeMeal':
      return clearWeekFreeMeal(action.weekStart)
  }
}

export const Route = createFileRoute('/api/weeks')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!hasValidSession(request)) {
          return Response.json({ error: 'Accesso richiesto.' }, { status: 401, headers: responseHeaders })
        }
        try {
          const start = new URL(request.url).searchParams.get('start')
          return Response.json(getWeek(start ?? undefined), { headers: responseHeaders })
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          const message = error instanceof HttpError ? error.message : 'Impossibile leggere la settimana.'
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
          const action = WeekActionSchema.safeParse(payload)
          if (!action.success) {
            return Response.json({ error: 'Modifica della settimana non valida.' }, { status: 400, headers: responseHeaders })
          }
          return Response.json(applyWeekAction(action.data), { headers: responseHeaders })
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          const message = error instanceof HttpError ? error.message : 'Modifica della settimana non riuscita.'
          return Response.json({ error: message }, { status, headers: responseHeaders })
        }
      },
    },
  },
})
