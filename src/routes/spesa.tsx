import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { GroceryList } from '../components/grocery-list'

export const Route = createFileRoute('/spesa')({
  validateSearch: (search: Record<string, unknown>): { start?: string } => {
    const start = z.iso.date().safeParse(search.start)
    return { start: start.success ? start.data : undefined }
  },
  head: () => ({ meta: [{ title: 'La spesa della settimana · Mealio' }] }),
  component: GroceriesPage,
})

function GroceriesPage() {
  const { start } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <section className="screen-content" aria-labelledby="groceries-page-title">
      <header className="screen-heading">
        <div>
          <span className="eyebrow">Dai pasti scelti alla lista</span>
          <h1 id="groceries-page-title">La spesa della settimana</h1>
          <p>Gli alimenti dei pasti scelti, sommati per la settimana. Spunta quello che compri: ogni modifica si salva online.</p>
        </div>
      </header>
      <GroceryList weekStart={start ?? null} onWeekChange={(selected) => void navigate({ search: { start: selected ?? undefined } })} />
    </section>
  )
}
