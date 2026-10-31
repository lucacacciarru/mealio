import { createFileRoute } from '@tanstack/react-router'
import { ChangePassword } from '../components/change-password'
import { PlanImportWorkspace } from '../components/plan-import-workspace'

export const Route = createFileRoute('/dieta')({
  head: () => ({ meta: [{ title: 'La tua dieta · Mealio' }] }),
  component: DietPage,
})

function DietPage() {
  return (
    <section className="screen-content" aria-labelledby="diet-page-title">
      <header className="screen-heading">
        <h1 id="diet-page-title">La tua dieta</h1>
      </header>
      <PlanImportWorkspace />
      <div className="plan-import-workspace diet-settings">
        <ChangePassword />
      </div>
    </section>
  )
}
