import { createFileRoute } from '@tanstack/react-router'
import { expiredSessionCookie, revokeSession } from '../../../server/auth'
import { requestHasSameOrigin } from '../../../server/http'

export const Route = createFileRoute('/api/auth/logout')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!requestHasSameOrigin(request)) {
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
