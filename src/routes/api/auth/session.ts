import { createFileRoute } from '@tanstack/react-router'
import { sessionExpiresAt } from '../../../server/auth'

export const Route = createFileRoute('/api/auth/session')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const expiresAt = sessionExpiresAt(request)
        const authenticated = expiresAt !== null
        return Response.json(
          authenticated ? { authenticated: true, expiresAt } : { authenticated: false },
          {
            status: authenticated ? 200 : 401,
            headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
          },
        )
      },
    },
  },
})
