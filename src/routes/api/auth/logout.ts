import { createFileRoute } from '@tanstack/react-router'
import { expiredSessionCookie, revokeSession } from '../../../server/auth'

export const Route = createFileRoute('/api/auth/logout')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const origin = request.headers.get('origin')
        if (origin && origin !== new URL(request.url).origin) {
          return Response.json({ error: 'Richiesta non valida.' }, { status: 403 })
        }

        revokeSession(request)
        return Response.json(
          { authenticated: false },
          {
            headers: {
              'cache-control': 'no-store',
              'set-cookie': expiredSessionCookie(process.env.NODE_ENV === 'production'),
              'x-content-type-options': 'nosniff',
            },
          },
        )
      },
    },
  },
})
