import { createFileRoute, Link } from '@tanstack/react-router'
import { z } from 'zod'
import { WeekPlanner } from '../components/week-planner'

export const Route = createFileRoute('/settimana')({
  validateSearch: (search: Record<string, unknown>): { start?: string } => {
    const start = z.iso.date().safeParse(search.start)
    return { start: start.success ? start.data : undefined }
  },
  head: () => ({ meta: [{ title: 'Pianifica la settimana · Mealio' }] }),
  component: WeekPage,
})

function WeekPage() {
  const { start } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <section className="screen-content" aria-labelledby="week-page-title">
      <header className="screen-heading">
        <div>
          <span className="eyebrow">Organizza il tuo piano</span>
          <h1 id="week-page-title">La tua settimana</h1>
          <p>Scegli le combinazioni, organizza i pasti e conferma la settimana. Nel calendario ritrovi le tue scelte.</p>
        </div>
        <Link className="screen-back-link" to="/" search={{ date: undefined }}>Torna al calendario</Link>
      </header>
      <WeekPlanner weekStart={start ?? null} onWeekChange={(selected) => void navigate({ search: { start: selected ?? undefined } })} />
    </section>
  )
}
