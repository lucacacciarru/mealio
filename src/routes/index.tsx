import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { WeekPlanner } from '../components/week-planner'

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { start?: string; date?: string } => {
    const start = z.iso.date().safeParse(search.start)
    const date = z.iso.date().safeParse(search.date)
    return { start: start.success ? start.data : undefined, date: date.success ? date.data : undefined }
  },
  head: () => ({ meta: [{ title: 'Settimana · Mealio' }] }),
  component: WeekPage,
})

function WeekPage() {
  const { start, date } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <section className="screen-content" aria-labelledby="week-page-title">
      <header className="screen-heading">
        <div>
          <h1 id="week-page-title">La tua settimana</h1>
        </div>
      </header>
      <WeekPlanner
        weekStart={start ?? null}
        selectedDate={date ?? null}
        onDayChange={(selected) => void navigate({ search: { start, date: selected } })}
        onWeekChange={(selected) => void navigate({ search: { start: selected ?? undefined } })}
      />
    </section>
  )
}
