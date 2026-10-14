import { createFileRoute } from '@tanstack/react-router'
import { hasValidSession } from '../../../server/auth'

export const Route = createFileRoute('/api/auth/session')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authenticated = hasValidSession(request)
        return Response.json(
          authenticated ? { authenticated: true } : { authenticated: false },
          {
            status: authenticated ? 200 : 401,
            headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
          },
        )
      },
    },
  },
})
