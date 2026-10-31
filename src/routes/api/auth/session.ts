import { createFileRoute } from '@tanstack/react-router'
import { isPasswordSet, sessionCookie, sessionExpiresAt, sessionToken } from '../../../server/auth'

export const Route = createFileRoute('/api/auth/session')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        const expiresAt = sessionExpiresAt(request)
        const token = sessionToken(request)
        if (expiresAt === null || !token) {
          return Response.json({ authenticated: false, needsSetup: !isPasswordSet() }, { status: 401, headers })
        }
        // The session was renewed on the server: renew the cookie too.
        headers.set('set-cookie', sessionCookie(token, process.env.NODE_ENV === 'production'))
        return Response.json({ authenticated: true, expiresAt }, { headers })
      },
    },
  },
})
