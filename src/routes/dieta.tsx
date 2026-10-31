import { createFileRoute, Link } from '@tanstack/react-router'
import { PlanImportWorkspace } from '../components/plan-import-workspace'

export const Route = createFileRoute('/dieta')({
  head: () => ({ meta: [{ title: 'La tua dieta · Mealio' }] }),
  component: DietPage,
})

function DietPage() {
  return (
    <section className="screen-content" aria-labelledby="diet-page-title">
      <header className="screen-heading">
        <div>
          <span className="eyebrow">Il piano del professionista</span>
          <h1 id="diet-page-title">La tua dieta</h1>
          <p>Carica il PDF, consulta i pasti e le varianti, poi usa la dieta per organizzare la settimana.</p>
        </div>
        <Link className="screen-back-link" to="/" search={{ start: undefined }}>Vai alla settimana</Link>
      </header>
      <PlanImportWorkspace />
    </section>
  )
}
