import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'

// The former diary now lives on the home screen.
export const Route = createFileRoute('/calendario')({
  beforeLoad: ({ search }) => {
    const date = z.iso.date().safeParse((search as Record<string, unknown>).date)
    throw redirect({ to: '/', search: { date: date.success ? date.data : undefined }, replace: true })
  },
})
