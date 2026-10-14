import { createFileRoute } from '@tanstack/react-router'
import { sqlite } from '../../db'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        sqlite.prepare('SELECT 1').get()
        return Response.json(
          { status: 'ok' },
          { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } },
        )
      },
    },
  },
})
