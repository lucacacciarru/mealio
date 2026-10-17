import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { TodayDiary } from '../components/today-diary'

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { date?: string } => {
    const date = z.iso.date().safeParse(search.date)
    return { date: date.success ? date.data : undefined }
  },
  head: () => ({ meta: [{ title: 'Calendario · Mealio' }] }),
  component: CalendarPage,
})

function CalendarPage() {
  const { date } = Route.useSearch()
  const navigate = Route.useNavigate()
  return <TodayDiary date={date ?? null} onDateChange={(selected) => void navigate({ search: { date: selected ?? undefined } })} />
}
