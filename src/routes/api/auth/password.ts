import { createFileRoute } from '@tanstack/react-router'
import { changePassword, hasValidSession, requestAddress } from '../../../server/auth'
import { requestHasSameOrigin } from '../../../server/http'

const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

// Changes the password from the app; the current one is required.
export const Route = createFileRoute('/api/auth/password')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!hasValidSession(request)) return Response.json({ error: 'Accesso richiesto.' }, { status: 401, headers })
        if (!requestHasSameOrigin(request)) return Response.json({ error: 'Richiesta non valida.' }, { status: 403, headers })
        if (Number(request.headers.get('content-length') ?? 0) > 4096) {
          return Response.json({ error: 'Richiesta troppo grande.' }, { status: 413, headers })
        }
        let payload: unknown
        try {
          payload = await request.json()
        } catch {
          return Response.json({ error: 'Richiesta non valida.' }, { status: 400, headers })
        }
        const fields = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
        const { current, next } = fields
        if (typeof current !== 'string' || typeof next !== 'string' || current.length > 1024 || next.length > 1024) {
          return Response.json({ error: 'Password non valida.' }, { status: 400, headers })
        }
        const failure = await changePassword(current, next, requestAddress(request))
        if (failure) {
          return Response.json({ error: failure.message }, {
            status: failure.status,
            headers: failure.retryAfterSeconds ? { ...headers, 'retry-after': String(failure.retryAfterSeconds) } : headers,
          })
        }
        return Response.json({ changed: true }, { headers })
      },
    },
  },
})
