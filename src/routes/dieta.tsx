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
          <p>Consulta i PDF e i riepiloghi salvati, oppure importa una nuova dieta e scegli da quando seguirla.</p>
        </div>
        <Link className="screen-back-link" to="/" search={{ date: undefined }}>Torna al calendario</Link>
      </header>
      <PlanImportWorkspace />
    </section>
  )
}
