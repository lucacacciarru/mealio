import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { GroceryList } from '../components/grocery-list'

export const Route = createFileRoute('/spesa')({
  validateSearch: (search: Record<string, unknown>): { start?: string } => {
    const start = z.iso.date().safeParse(search.start)
    return { start: start.success ? start.data : undefined }
  },
  head: () => ({ meta: [{ title: 'Spesa · Mealio' }] }),
  component: GroceriesPage,
})

function GroceriesPage() {
  const { start } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <section className="screen-content" aria-labelledby="groceries-page-title">
      <h1 className="visually-hidden" id="groceries-page-title">Spesa</h1>
      <GroceryList weekStart={start ?? null} onWeekChange={(selected) => void navigate({ search: { start: selected ?? undefined } })} />
    </section>
  )
}
