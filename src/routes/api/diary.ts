import { createFileRoute } from '@tanstack/react-router'
import { hasValidSession } from '../../server/auth'
import { DiaryConflictError, DiaryMutationSchema, getDiaryDay, saveDiaryCheckIns } from '../../server/diary'
import { HttpError, readBodyUpTo, requestHasSameOrigin } from '../../server/http'

const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

function failure(error: unknown) {
  if (error instanceof DiaryConflictError) {
    return Response.json({ error: error.message, day: getDiaryDay(error.date) }, { status: 409, headers })
  }
  return Response.json(
    { error: error instanceof HttpError ? error.message : 'Impossibile completare il check-in.' },
    { status: error instanceof HttpError ? error.status : 500, headers },
  )
}

export const Route = createFileRoute('/api/diary')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!hasValidSession(request)) return Response.json({ error: 'Accesso richiesto.' }, { status: 401, headers })
        try {
          return Response.json(getDiaryDay(new URL(request.url).searchParams.get('date') ?? undefined), { headers })
        } catch (error) {
          return failure(error)
        }
      },
      POST: async ({ request }) => {
        if (!hasValidSession(request)) return Response.json({ error: 'Accesso richiesto.' }, { status: 401, headers })
        if (!requestHasSameOrigin(request)) return Response.json({ error: 'Richiesta non valida.' }, { status: 403, headers })
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return Response.json({ error: 'Richiesta non valida.' }, { status: 415, headers })
        }
        try {
          const body = await readBodyUpTo(request, 16_384)
          let payload: unknown
          try {
            payload = JSON.parse(body.toString('utf8'))
          } catch {
            throw new HttpError('Richiesta non valida.', 400)
          }
          const parsed = DiaryMutationSchema.safeParse(payload)
          if (!parsed.success) throw new HttpError('Check-in non valido.', 400)
          return Response.json(saveDiaryCheckIns(parsed.data), { headers })
        } catch (error) {
          return failure(error)
        }
      },
    },
  },
})
