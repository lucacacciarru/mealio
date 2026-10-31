import { Fragment, useEffect, useId, useState } from 'react'
import type { ReactNode, SyntheticEvent } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import type { PlanSlot } from '../db/schema'
import type { WeekDayView, WeekMealChoices, WeekMealView, WeekView } from '../server/weeks'
import { apiRequest } from './api'
import { FoodText, printedAmount, SLOT_LABELS, type FoodFields } from './plan-text'

const FREE_MEAL_DESCRIPTION_MAX_LENGTH = 200

type WeekAction =
  | { action: 'confirmDay'; date: string }
  | { action: 'refresh' }
  | { action: 'swapDays'; dates: [string, string] }
  | { action: 'moveMeal'; slot: PlanSlot; dates: [string, string] }
  | { action: 'setChoices'; date: string; slot: PlanSlot; choices: WeekMealChoices }
  | { action: 'setFreeMeal'; date: string; slot: PlanSlot; description: string | null }
  | { action: 'clearFreeMeal' }
type RunAction = (action: WeekAction, success: string) => Promise<boolean>

function formatDay(date: string, options: Intl.DateTimeFormatOptions = {}): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('it-IT', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    ...options,
  })
}

function versionName(version: { id: number; label: string | null }): string {
  return version.label ?? `Versione ${version.id}`
}

// Decorative icons: the buttons they sit in carry the text.
const CHECK_ICON = (
  <svg className="choice-chip-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m3.5 8.5 3 3 6-7" />
  </svg>
)
const SWAP_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="16" rx="3" />
    <path d="M3 10h18M8 3v4m8-4v4m-7 8h6m0 0-2-2m2 2-2 2" />
  </svg>
)

export function WeekPlanner({ weekStart, selectedDate, onDayChange, onWeekChange }: {
  weekStart: string | null
  selectedDate: string | null
  onDayChange: (date: string) => void
  onWeekChange: (start: string | null) => void
}) {
  const [week, setWeek] = useState<WeekView | null>(null)
  const [pending, setPending] = useState<'load' | 'action' | null>('load')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loadRevision, setLoadRevision] = useState(0)

  const router = useRouter()
  useEffect(() => {
    let cancelled = false
    setPending('load')
    setWeek(null)
    setError('')
    setNotice('')
    void apiRequest<WeekView>(weekStart ? `/api/weeks?start=${encodeURIComponent(weekStart)}` : '/api/weeks')
      .then((current) => {
        if (!cancelled) setWeek(current)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Impossibile caricare la settimana.')
      })
      .finally(() => {
        if (!cancelled) setPending(null)
      })
    return () => {
      cancelled = true
    }
  }, [weekStart, loadRevision])

  // Changes happen inside the meal cards, so notices float over the page and
  // leave on their own instead of shifting it.
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  async function runAction(action: WeekAction, success: string): Promise<boolean> {
    if (!week || pending !== null) return false
    setPending('action')
    setError('')
    setNotice('')
    try {
      setWeek(
        await apiRequest<WeekView>('/api/weeks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...action, weekStart: week.weekStart }),
        }),
      )
      setNotice(success)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Modifica non riuscita.')
      return false
    } finally {
      setPending(null)
    }
  }

  async function openGroceries() {
    if (!week || pending !== null) return
    await router.navigate({ to: '/spesa', search: { start: week.weekStart } })
  }

  const busy = pending !== null
  const selectedDay = week?.days.find((day) => day.date === selectedDate)
    ?? week?.days.find((day) => !day.past)
    ?? week?.days[0]
  const plannedDays = week?.days.filter((day) => day.plannedAt !== null).length ?? 0

  return (
    <section className="week-planner" id="settimana" aria-labelledby="week-planner-title" aria-busy={busy}>
      <div className="workspace-heading">
        <div>
          <h2 id="week-planner-title">
            {week
              ? `${formatDay(week.weekStart)} – ${formatDay(week.weekEnd, { year: 'numeric' })}`
              : 'Caricamento della settimana…'}
          </h2>
        </div>
        {week && (
          <nav className="week-nav" aria-label="Cambia settimana">
            <button className="secondary-button" type="button" aria-label="Settimana precedente" onClick={() => onWeekChange(week.previousWeekStart)} disabled={busy}>
              ←
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onWeekChange(null)}
              disabled={busy || (week.today >= week.weekStart && week.today <= week.weekEnd)}
            >
              Questa settimana
            </button>
            <button className="secondary-button" type="button" aria-label="Settimana successiva" onClick={() => onWeekChange(week.nextWeekStart)} disabled={busy}>
              →
            </button>
          </nav>
        )}
      </div>

      {error && !week && (
        <div role="alert">
          <p className="message error-message">{error}</p>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => setLoadRevision((revision) => revision + 1)}>Riprova caricamento</button>
        </div>
      )}
      {pending === 'load' && <p className="loading-inline" role="status">Caricamento della settimana…</p>}
      <div className="planner-feedback" aria-live="polite">
        {error && week && (
          <div className="planner-toast planner-toast-error" role="alert">
            <p>{error}</p>
            <button className="text-button" type="button" disabled={busy} onClick={() => setLoadRevision((revision) => revision + 1)}>Ricarica la settimana</button>
          </div>
        )}
        {notice && <p className="planner-toast">{notice}</p>}
      </div>

      {week && (
        <div className="week-body">
          <WeekStatus week={week} busy={busy} runAction={runAction} />
          {week.days.some((day) => day.meals.length > 0) && (
            <div className="planner-toolbar">
              <p>
                <strong>{plannedDays} di {week.days.filter((day) => day.meals.length > 0).length} giorni nel calendario.</strong>
                {' '}Scegli i pasti, poi aggiungi ogni giornata quando è pronta.
              </p>
              <button className="secondary-button" type="button" onClick={() => void openGroceries()} disabled={busy}>
                Vai alla spesa →
              </button>
            </div>
          )}
          {week.days.some((day) => day.meals.length > 0) && (
            <>
          <div className="planner-day-tabs" role="group" aria-label="Giorni da pianificare">
            {week.days.map((day) => (
              <button
                key={day.date}
                className="planner-day-tab"
                type="button"
                aria-label={`${day.dayName} ${formatDay(day.date)}, ${day.plannedAt !== null ? 'nel calendario' : 'da pianificare'}${day.past ? ', passato' : ''}`}
                aria-pressed={selectedDay?.date === day.date}
                data-planned={day.plannedAt !== null}
                onClick={() => onDayChange(day.date)}
                disabled={busy}
              >
                <span>{day.dayName.slice(0, 3)}</span>
                <strong>{Number(day.date.slice(8))}</strong>
                <small>{day.plannedAt !== null ? '✓' : day.date === week.today ? 'Oggi' : '—'}</small>
              </button>
            ))}
          </div>
          {selectedDay && <DayCard key={selectedDay.date} week={week} day={selectedDay} busy={busy} runAction={runAction} />}
            </>
          )}
          {week.days.some((day) => day.meals.length > 0) && week.weekEnd >= week.today && (
            <details className="week-optional">
              <summary>{week.freeMeal ? 'Il tuo pasto libero' : 'Aggiungi un pasto libero (facoltativo)'}</summary>
              <FreeMealPanel
                key={`${week.weekStart}:${JSON.stringify(week.freeMeal)}`}
                week={week}
                busy={busy}
                runAction={runAction}
              />
            </details>
          )}
        </div>
      )}
    </section>
  )
}

function WeekStatus({ week, busy, runAction }: { week: WeekView; busy: boolean; runAction: RunAction }) {
  if (!week.days.some((day) => day.meals.length > 0)) {
    return (
      <section className="week-status" role="status">
        <h3>Parti dalla tua dieta</h3>
        <p>Carica il PDF e usa i pasti letti dalla dieta per organizzare questa settimana.</p>
        <Link className="text-button" to="/dieta">Carica la dieta →</Link>
      </section>
    )
  }
  const needsRefresh = week.days.some(
    (day) => !day.past && day.validVersion !== null && day.validVersion.id !== day.plannedVersion?.id,
  )
  if (!needsRefresh) return null
  return (
    <section className="week-status">
      <h3>Hai una dieta più recente</h3>
      <p>I pasti salvati non sono cambiati. Aggiornando i giorni futuri, perderai le loro varianti e i loro scambi; il pasto libero resta.</p>
      <button
        className="secondary-button"
        type="button"
        onClick={() => void runAction({ action: 'refresh' }, 'Pasti aggiornati alla nuova dieta.')}
        disabled={busy}
      >
        Usa la nuova dieta
      </button>
    </section>
  )
}

function FreeMealPanel({ week, busy, runAction }: { week: WeekView; busy: boolean; runAction: RunAction }) {
  const free = week.freeMeal
  const freeDay = free && week.days.find((day) => day.date === free.date)
  if (free && freeDay && free.date < week.today) {
    return (
      <section className="week-free-panel">
        <h3>Pasto libero</h3>
        <p>
          Previsto per {freeDay.dayName.toLowerCase()} {formatDay(free.date)} · {SLOT_LABELS[free.slot]}
          {free.description ? ` — ${free.description}` : ''}
        </p>
      </section>
    )
  }
  const positions = week.days
    .filter((day) => !day.past)
    .flatMap((day) =>
      day.meals.map((meal) => ({
        value: `${day.date}|${meal.slot}`,
        label: `${day.dayName} ${formatDay(day.date)} · ${SLOT_LABELS[meal.slot]}`,
      })),
    )
  if (positions.length === 0) return null

  function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const [date, slot] = String(form.get('position') ?? '').split('|')
    if (!date || !slot) return
    const description = String(form.get('description') ?? '').trim()
    void runAction(
      { action: 'setFreeMeal', date, slot: slot as PlanSlot, description: description || null },
      'Pasto libero salvato.',
    )
  }

  return (
    <section className="week-free-panel" aria-labelledby="free-meal-title">
      <h3 id="free-meal-title">Pasto libero</h3>
      <p>Uno a settimana, al posto di un pasto del piano: nessun alimento da pianificare.</p>
      <form className="week-form" onSubmit={save}>
        <label htmlFor="free-meal-position">Quando</label>
        <select
          id="free-meal-position"
          name="position"
          required
          defaultValue={free ? `${free.date}|${free.slot}` : ''}
          disabled={busy}
        >
          <option value="" disabled>
            Scegli un pasto
          </option>
          {positions.map((position) => (
            <option key={position.value} value={position.value}>
              {position.label}
            </option>
          ))}
        </select>
        <label htmlFor="free-meal-description">Descrizione (facoltativa)</label>
        <input
          id="free-meal-description"
          name="description"
          type="text"
          maxLength={FREE_MEAL_DESCRIPTION_MAX_LENGTH}
          defaultValue={free?.description ?? ''}
          disabled={busy}
        />
        <div className="week-form-actions">
          <button className="primary-button" type="submit" disabled={busy}>
            {free ? 'Aggiorna il pasto libero' : 'Salva il pasto libero'}
          </button>
          {free && (
            <button
              className="secondary-button"
              type="button"
              onClick={() => void runAction({ action: 'clearFreeMeal' }, 'Pasto libero tolto.')}
              disabled={busy}
            >
              Togli il pasto libero
            </button>
          )}
        </div>
      </form>
    </section>
  )
}

function DayCard({ week, day, busy, runAction }: { week: WeekView; day: WeekDayView; busy: boolean; runAction: RunAction }) {
  const [swapping, setSwapping] = useState(false)
  const [editingSlot, setEditingSlot] = useState<PlanSlot | null>(null)
  const id = useId()
  // Past days stay unchanged; swaps stay within the same plan version.
  const changeable = !day.past && day.plannedVersion !== null
  const targets = changeable
    ? week.days.filter(
        (other) => other.date !== day.date && !other.past && other.plannedVersion?.id === day.plannedVersion?.id,
      )
    : []
  const staleNote =
    week.status === 'confirmed' &&
    !day.past &&
    day.plannedVersion &&
    day.validVersion &&
    day.plannedVersion.id !== day.validVersion.id
      ? `Pianificato con «${versionName(day.plannedVersion)}»: per questa data ora vale «${versionName(day.validVersion)}».`
      : null
  return (
    <section className="week-day" aria-labelledby={`${id}-title`}>
      <header className="week-day-heading">
        <div className="week-day-title">
          <h3 id={`${id}-title`}>
            {day.dayName} {formatDay(day.date)}
          </h3>
          {day.date === week.today && <span className="week-tag week-tag-today">Oggi</span>}
          {day.past && <span className="week-tag">Passato</span>}
          <span className={day.plannedAt !== null ? 'week-tag week-tag-planned' : 'week-tag'}>
            {day.plannedAt !== null ? 'Nel calendario' : 'Bozza'}
          </span>
        </div>
        {/* Plan weights are raw unless the plan states otherwise; foods flag the exceptions. */}
        {day.meals.length > 0 && <p className="week-day-note">Pesi a crudo, salvo dove indicato.</p>}
        {targets.length > 0 && (
          <button
            className="meal-card-action week-day-swap"
            type="button"
            aria-expanded={swapping}
            aria-controls={`${id}-swap`}
            onClick={() => setSwapping(!swapping)}
          >
            {SWAP_ICON}
            Scambia la giornata
          </button>
        )}
      </header>
      {swapping && targets.length > 0 && (
        <SwapChoices
          id={`${id}-swap`}
          label="Scambia tutti i pasti con"
          targets={targets}
          busy={busy}
          onSwap={async (target) => {
            if (await runAction({ action: 'swapDays', dates: [day.date, target] }, 'Giorni scambiati.')) setSwapping(false)
          }}
        />
      )}
      {staleNote && <p className="week-warning">{staleNote}</p>}
      {day.meals.length === 0 ? (
        <p className="summary-missing">Nessun piano valido in questa data.</p>
      ) : (
        <ol className="week-meals">
          {day.meals.map((meal) => (
            <MealCard
              key={meal.slot}
              day={day}
              meal={meal}
              changeable={changeable}
              targets={targets}
              busy={busy}
              runAction={runAction}
              editing={editingSlot === meal.slot}
              onEdit={() => setEditingSlot(editingSlot === meal.slot ? null : meal.slot)}
            />
          ))}
        </ol>
      )}
      {changeable && day.meals.length > 0 && (
        <div className="day-planning-action">
          <div>
            <h4>{day.plannedAt !== null ? 'Giornata aggiunta' : day.unresolvedChoices > 0 ? 'Completa le scelte' : 'La giornata è pronta'}</h4>
            <p>
              {day.plannedAt !== null
                ? 'Questi pasti sono nel calendario e nella spesa. Una modifica riapre la bozza.'
                : day.unresolvedChoices > 0
                  ? `${day.unresolvedChoices} ${day.unresolvedChoices === 1 ? 'scelta da completare' : 'scelte da completare'}. La bozza non compare nel calendario né nella spesa.`
                  : 'Controlla i pasti e aggiungili al calendario. La spesa userà solo le giornate aggiunte.'}
            </p>
          </div>
          {day.plannedAt === null ? (
            <button
              className="primary-button"
              type="button"
              disabled={busy || day.unresolvedChoices > 0}
              onClick={() => void runAction({ action: 'confirmDay', date: day.date }, 'Giornata aggiunta al calendario e alla spesa.')}
            >
              Aggiungi al calendario
            </button>
          ) : (
            <Link className="text-button" to="/calendario" search={{ date: day.date }}>Vedi nel calendario →</Link>
          )}
        </div>
      )}
    </section>
  )
}

function MealCard({
  day,
  meal,
  changeable,
  targets,
  busy,
  runAction,
  editing,
  onEdit,
}: {
  day: WeekDayView
  meal: WeekMealView
  changeable: boolean
  targets: WeekDayView[]
  busy: boolean
  runAction: RunAction
  editing: boolean
  onEdit: () => void
}) {
  const id = useId()
  const wholeMeal = meal.mealOptions.some((option) => option.key === meal.mealChoice)
  const needsChoice = !meal.free && !wholeMeal && (
    (meal.combinations.length > 0 && meal.combinationChoice === null) ||
    meal.rows.some((row) =>
      (row.combination === null || row.combination === meal.combinationChoice) &&
      row.components.length > 1 && row.choice === null,
    )
  )
  const canChoose =
    changeable &&
    !meal.free &&
    (meal.combinations.length > 0 || meal.mealOptions.length > 0 || meal.rows.some((row) => row.options.length > 0))
  const canSwap = targets.length > 0
  return (
    <li className={meal.free ? 'meal-card meal-card-free' : 'meal-card'} aria-labelledby={`${id}-title`}>
      <div className="meal-card-content">
        <header className="meal-card-heading">
          <h4 id={`${id}-title`}>{SLOT_LABELS[meal.slot]}</h4>
          {meal.free && <span className="week-tag week-tag-free">Pasto libero</span>}
          {!meal.free && wholeMeal && <span className="week-tag week-tag-variant">Pasto sostituito</span>}
          {!meal.free && !wholeMeal && meal.combinationChoice !== null && (
            <span className="week-tag week-tag-variant">{meal.combinationChoice}</span>
          )}
          {meal.sourceDayIndex !== day.dayIndex && (
            <span className="week-tag">Da {meal.sourceDayName.toLowerCase()}</span>
          )}
        </header>
        {meal.free ? (
          <p className="meal-card-free-text">{meal.free.description ?? 'Pasto libero, escluso dalla spesa.'}</p>
        ) : needsChoice ? (
          <p className="meal-choice-needed">
            {meal.combinations.length > 0 && meal.combinationChoice === null
              ? 'Scegli una variante della dieta.'
              : 'Scegli tra gli alimenti alternativi.'}
          </p>
        ) : (
          <MealFoods meal={meal} />
        )}
        {meal.notes && (
          <details className="meal-diet-note">
            <summary>Note della dieta</summary>
            <p className="meal-card-note">{meal.notes}</p>
          </details>
        )}
      </div>
      {(canChoose || canSwap) && (
        <button
          className={needsChoice ? 'secondary-button meal-card-edit' : 'meal-card-action meal-card-edit'}
          type="button"
          aria-label={`${editing ? 'Chiudi' : needsChoice ? 'Scegli' : 'Modifica'} ${SLOT_LABELS[meal.slot].toLowerCase()}`}
          aria-expanded={editing}
          aria-controls={`${id}-editor`}
          onClick={onEdit}
          disabled={busy}
        >
          {editing ? 'Chiudi' : needsChoice ? 'Scegli' : 'Modifica'}
        </button>
      )}
      {editing && (
        <div className="meal-card-editor" id={`${id}-editor`}>
          {canChoose && <MealChoices id={`${id}-choices`} day={day} meal={meal} busy={busy} runAction={runAction} />}
          {canSwap && (
            <details className="meal-swap">
              <summary>Scambia con un altro giorno</summary>
              <SwapChoices
                id={`${id}-swap`}
                label="Scambia con lo stesso pasto di"
                targets={targets}
                busy={busy}
                onSwap={async (target) => {
                  if (await runAction({ action: 'moveMeal', slot: meal.slot, dates: [day.date, target] }, 'Pasti scambiati. Le giornate sono in bozza.')) {
                    onEdit()
                  }
                }}
              />
            </details>
          )}
        </div>
      )}
    </li>
  )
}

type ShownFood = { key: string; food: FoodFields; prefix?: string; note?: string }

// What a planned row puts on the plate: the saved choice, else every food of
// the row as printed ("oppure").
function rowFoods(row: WeekMealView['rows'][number]): ShownFood[] {
  const chosen = row.options.find((option) => option.key === row.choice)
  if (chosen?.type === 'item') {
    return [{ key: row.key, food: chosen.item, note: `Equivalenza al posto di ${chosen.replaces.label}` }]
  }
  if (chosen?.type === 'component') {
    return [{ key: row.key, food: chosen.component }]
  }
  return row.components.map((component, index) => ({
    key: `${row.key}:${component.id}`,
    food: component,
    prefix: index > 0 ? 'oppure' : undefined,
  }))
}

function MealFoods({ meal }: { meal: WeekMealView }) {
  const wholeMeal = meal.mealOptions.find((option) => option.key === meal.mealChoice)
  const planned: ShownFood[] = wholeMeal
    ? [{ key: wholeMeal.key, food: wholeMeal.item, note: 'Equivalenza al posto del pasto della dieta' }]
    : meal.rows
        .filter((row) => row.combination === null || row.combination === meal.combinationChoice)
        .flatMap(rowFoods)
  return planned.length > 0
    ? <FoodList foods={planned} />
    : <p className="summary-missing">Nessun alimento nella dieta.</p>
}

// Raw is the plan's default, stated once per day; cooked weights, missing
// quantities and an unspecified raw/cooked state stay visible on each food.
function FoodList({ foods }: { foods: ShownFood[] }) {
  return (
    <ul className="meal-foods">
      {foods.map(({ key, food, prefix, note }) => {
        const amount = printedAmount(food)
        return (
          <li className="meal-food" key={key}>
            <span className="meal-food-name">
              {prefix && <span className="meal-food-muted">{prefix} </span>}
              {food.label}
              {food.state === 'cooked' && <span className="meal-food-muted"> · a cotto</span>}
              {food.state === 'unspecified' && <span className="meal-food-warning">Stato crudo/cotto non specificato</span>}
              {food.notes && <span className="meal-food-note">{food.notes}</span>}
              {note && <span className="meal-food-note">{note}</span>}
            </span>
            {amount ? (
              <span className="meal-food-amount">{amount}</span>
            ) : (
              <span className="meal-food-missing">quantità non indicata</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// Each press saves the draft. Only the day's explicit action publishes it.
function MealChoices({
  id,
  day,
  meal,
  busy,
  runAction,
}: {
  id: string
  day: WeekDayView
  meal: WeekMealView
  busy: boolean
  runAction: RunAction
}) {
  const wholeMeal = meal.mealOptions.some((option) => option.key === meal.mealChoice)
  const plannedRows = wholeMeal
    ? []
    : meal.rows.filter((row) => row.combination === null || row.combination === meal.combinationChoice)
  const rowChoices = Object.fromEntries(
    plannedRows.flatMap((row) => (row.choice === null ? [] : [[row.key, row.choice]])),
  )
  function save(choices: WeekMealChoices) {
    void runAction({ action: 'setChoices', date: day.date, slot: meal.slot, choices }, 'Scelta salvata in bozza.')
  }
  return (
    <div className="meal-panel" id={id}>
      {!wholeMeal && meal.combinations.length > 0 && (
        <ChoiceGroup label="Variante">
          {meal.combinations.map((combination) => (
            <Chip
              key={combination}
              selected={combination === meal.combinationChoice}
              busy={busy}
              onSelect={() =>
                save({
                  combination,
                  meal: null,
                  rows: Object.fromEntries(
                    plannedRows.flatMap((row) =>
                      row.combination === null && row.choice !== null ? [[row.key, row.choice]] : [],
                    ),
                  ),
                })
              }
            >
              <span className="choice-variant">
                <strong>{combination}</strong>
                {meal.rows
                  .filter((row) => row.combination === combination)
                  .flatMap((row) => row.components.map((food, index) => (
                    <span className="choice-variant-food" key={food.id}>
                      {index > 0 && <span className="choice-chip-detail">oppure </span>}
                      <ChipFood food={food} />
                    </span>
                  )))}
              </span>
            </Chip>
          ))}
        </ChoiceGroup>
      )}
      {plannedRows
        .filter((row) => row.options.length > 0)
        .map((row) => (
          <ChoiceGroup
            key={row.key}
            // A single food's only options are equivalences scoped to it.
            label={
              row.components.length === 1
                ? `${row.components[0]!.label} o un equivalente`
                : row.components.map((component) => component.label).join(' o ')
            }
          >
            {row.components.length === 1 && (
              <Chip
                selected={row.choice === null}
                busy={busy}
                onSelect={() =>
                  save({
                    combination: meal.combinationChoice,
                    meal: null,
                    rows: Object.fromEntries(Object.entries(rowChoices).filter(([key]) => key !== row.key)),
                  })
                }
              >
                <ChipFood food={row.components[0]!} />
              </Chip>
            )}
            {row.options.map((option) => (
              <Chip
                key={option.key}
                selected={option.key === row.choice}
                busy={busy}
                onSelect={() =>
                  save({ combination: meal.combinationChoice, meal: null, rows: { ...rowChoices, [row.key]: option.key } })
                }
              >
                <ChipFood food={option.type === 'component' ? option.component : option.item} />
              </Chip>
            ))}
          </ChoiceGroup>
        ))}
      {meal.mealOptions.length > 0 && (
        <ChoiceGroup label="Pasto intero">
          <Chip selected={!wholeMeal} busy={busy} onSelect={() => save({ combination: null, meal: null, rows: {} })}>
            Come nella dieta
          </Chip>
          {meal.mealOptions.map((option) => (
            <Chip
              key={option.key}
              selected={option.key === meal.mealChoice}
              busy={busy}
              onSelect={() => save({ combination: null, meal: option.key, rows: {} })}
            >
              <ChipFood food={option.item} />
            </Chip>
          ))}
        </ChoiceGroup>
      )}
    </div>
  )
}

function SwapChoices({
  id,
  label,
  targets,
  busy,
  onSwap,
}: {
  id: string
  label: string
  targets: WeekDayView[]
  busy: boolean
  onSwap: (date: string) => Promise<void>
}) {
  return (
    <div className="meal-panel" id={id}>
      <ChoiceGroup label={label}>
        {targets.map((target) => (
          <button
            key={target.date}
            className="choice-chip"
            type="button"
            aria-label={`${target.dayName} ${formatDay(target.date)}`}
            aria-disabled={busy}
            onClick={() => {
              if (!busy) void onSwap(target.date)
            }}
          >
            {target.dayName.slice(0, 3)} {Number(target.date.slice(8))}
          </button>
        ))}
      </ChoiceGroup>
    </div>
  )
}

function ChoiceGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId()
  return (
    <div className="choice-group" role="group" aria-labelledby={id}>
      <p id={id}>{label}</p>
      <div className="choice-chips">{children}</div>
    </div>
  )
}

// A pressed chip is the saved choice. While a change saves, chips keep focus
// but ignore presses; runAction rejects concurrent changes too.
function Chip({
  selected,
  busy,
  onSelect,
  children,
}: {
  selected: boolean
  busy: boolean
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <button
      className="choice-chip"
      type="button"
      aria-pressed={selected}
      aria-disabled={busy}
      onClick={() => {
        if (!selected && !busy) onSelect()
      }}
    >
      {selected && CHECK_ICON}
      {children}
    </button>
  )
}

function ChipFood({ food }: { food: FoodFields }) {
  const amount = printedAmount(food)
  return (
    <span>
      {food.label}
      <span className="choice-chip-detail"> {amount || '· quantità non indicata'}</span>
      {food.state === 'cooked' && <span className="choice-chip-detail"> a cotto</span>}
      {food.state === 'unspecified' && <span className="choice-chip-detail"> · stato crudo/cotto non specificato</span>}
      {food.notes && <span className="choice-chip-detail"> · {food.notes}</span>}
    </span>
  )
}

export function PlannedMealContent({ meal }: { meal: WeekMealView }) {
  const wholeMeal = meal.mealOptions.find((option) => option.key === meal.mealChoice)
  // Foods planned whatever the combination, plus those of the chosen one.
  const plannedRows = meal.rows.filter(
    (row) => row.combination === null || row.combination === meal.combinationChoice,
  )
  const openCombinations = meal.combinationChoice === null ? meal.combinations : []
  return (
    <>
      {wholeMeal ? (
        <ul className="summary-foods">
          <li>
            <FoodText food={wholeMeal.item} />
            <span className="summary-note"> · equivalenza al posto del pasto previsto</span>
          </li>
        </ul>
      ) : meal.rows.length === 0 ? (
        <p className="summary-missing">Nessun alimento nel piano.</p>
      ) : (
        <>
          {meal.combinationChoice !== null && (
            <p className="week-combination-choice">Variante: {meal.combinationChoice}</p>
          )}
          {plannedRows.length > 0 && openCombinations.length > 0 && (
            <p className="summary-note">In tutte le varianti:</p>
          )}
          {plannedRows.length > 0 && <PlannedRows rows={plannedRows} />}
          {openCombinations.length > 0 && (
            <details className="week-combinations">
              <summary>{openCombinations.length} varianti dalla dieta</summary>
              <ol>
                {openCombinations.map((combination) => (
                  <li key={combination}>
                    <strong>{combination}</strong>
                    <PlannedRows rows={meal.rows.filter((row) => row.combination === combination)} />
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
      {meal.notes && <p className="summary-note">{meal.notes}</p>}
    </>
  )
}

function PlannedRows({ rows }: { rows: WeekMealView['rows'] }) {
  return (
    <ul className="summary-foods">
      {rows.map((row) => {
        const chosen = row.options.find((option) => option.key === row.choice)
        return (
          <li key={row.key}>
            {chosen?.type === 'component' ? (
              <>
                <FoodText food={chosen.component} />
                <span className="summary-note"> · scelta tra le alternative</span>
              </>
            ) : chosen?.type === 'item' ? (
              <>
                <FoodText food={chosen.item} />
                <span className="summary-note"> · equivalenza al posto di {chosen.replaces.label}</span>
              </>
            ) : (
              row.components.map((component, index) => (
                <Fragment key={component.id}>
                  {index > 0 && <span className="summary-or"> oppure </span>}
                  <FoodText food={component} />
                </Fragment>
              ))
            )}
          </li>
        )
      })}
    </ul>
  )
}
