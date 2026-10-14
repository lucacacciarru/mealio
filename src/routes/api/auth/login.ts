import { createFileRoute } from '@tanstack/react-router'
import { loginWithPassword, requestAddress, sessionCookie } from '../../../server/auth'

export const Route = createFileRoute('/api/auth/login')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const origin = request.headers.get('origin')
        if (origin && origin !== new URL(request.url).origin) {
          return Response.json({ error: 'Richiesta non valida.' }, { status: 403 })
        }

        const contentLength = Number(request.headers.get('content-length') ?? 0)
        if (contentLength > 2048) {
          return Response.json({ error: 'Richiesta troppo grande.' }, { status: 413 })
        }

        let payload: unknown
        try {
          payload = await request.json()
        } catch {
          return Response.json({ error: 'Richiesta non valida.' }, { status: 400 })
        }
        if (
          !payload ||
          typeof payload !== 'object' ||
          !('password' in payload) ||
          typeof payload.password !== 'string' ||
          payload.password.length === 0 ||
          payload.password.length > 1024
        ) {
          return Response.json({ error: 'Password non valida.' }, { status: 400 })
        }

        const result = await loginWithPassword(payload.password, requestAddress(request))
        if (result.status !== 200) {
          const headers = new Headers({
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          })
          if (result.retryAfterSeconds) headers.set('retry-after', String(result.retryAfterSeconds))
          return Response.json({ error: result.message }, { status: result.status, headers })
        }

        return Response.json(
          { authenticated: true },
          {
            headers: {
              'cache-control': 'no-store',
              'set-cookie': sessionCookie(result.token, process.env.NODE_ENV === 'production'),
              'x-content-type-options': 'nosniff',
            },
          },
        )
      },
    },
  },
})
