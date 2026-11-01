import { createFileRoute } from '@tanstack/react-router'
import { requestAddress, sessionCookie, setupPassword } from '../../../server/auth'
import { requestHasSameOrigin } from '../../../server/http'

const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

// First run: choose the password when none exists yet, and sign in.
export const Route = createFileRoute('/api/auth/setup')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!requestHasSameOrigin(request)) return Response.json({ error: 'Richiesta non valida.' }, { status: 403, headers })
        if (Number(request.headers.get('content-length') ?? 0) > 2048) {
          return Response.json({ error: 'Richiesta troppo grande.' }, { status: 413, headers })
        }
        let payload: unknown
        try {
          payload = await request.json()
        } catch {
          return Response.json({ error: 'Richiesta non valida.' }, { status: 400, headers })
        }
        const password = payload && typeof payload === 'object' && 'password' in payload ? payload.password : undefined
        if (typeof password !== 'string' || password.length > 1024) {
          return Response.json({ error: 'Password non valida.' }, { status: 400, headers })
        }
        const result = await setupPassword(password, requestAddress(request))
        if (result.status !== 200) {
          return Response.json({ error: result.message }, {
            status: result.status,
            headers: result.retryAfterSeconds ? { ...headers, 'retry-after': String(result.retryAfterSeconds) } : headers,
          })
        }
        return Response.json({ authenticated: true }, {
          headers: { ...headers, 'set-cookie': sessionCookie(result.token, process.env.NODE_ENV === 'production') },
        })
      },
    },
  },
})
