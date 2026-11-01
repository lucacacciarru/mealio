import { useEffect, useId, useState } from 'react'
import type { ReactNode, SyntheticEvent } from 'react'
import { Link } from '@tanstack/react-router'
import type { PlanSlot } from '../db/schema'
import type { WeekDayView, WeekMealChoices, WeekMealView, WeekView } from '../server/weeks'
import { apiRequest } from './api'
import { printedAmount, SLOT_LABELS, type FoodFields } from './plan-text'
import './week-planner.css'

const FREE_MEAL_DESCRIPTION_MAX_LENGTH = 200

type WeekAction =
  | { action: 'refresh' }
  | { action: 'repeatPreviousWeek' }
  | { action: 'swapDays'; dates: [string, string] }
  | { action: 'moveMeal'; slot: PlanSlot; dates: [string, string] }
  | { action: 'setChoices'; date: string; slot: PlanSlot; choices: WeekMealChoices }
  | { action: 'setFreeMeal'; date: string; slot: PlanSlot; description: string | null }
  | { action: 'clearFreeMeal' }
type RunAction = (action: WeekAction, success: string) => Promise<boolean>
type MealRef = { date: string; slot: PlanSlot }

function formatDay(date: string, options: Intl.DateTimeFormatOptions = {}): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('it-IT', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    ...options,
  })
}

function shortDay(day: Pick<WeekDayView, 'dayName' | 'date'>): string {
  return `${day.dayName.slice(0, 3)} ${Number(day.date.slice(8))}`
}

// Required choices still open in a meal: its variant, then each "A oppure B"
// row of the shared foods or of the chosen variant. Mirrors the server count.
function openChoices(meal: WeekMealView): number {
  if (meal.free || meal.mealOptions.some((option) => option.key === meal.mealChoice)) return 0
  let open = Number(meal.combinations.length > 0 && meal.combinationChoice === null)
  for (const row of meal.rows) {
    if (
      row.components.length > 1 &&
      (row.combination === null || row.combination === meal.combinationChoice) &&
      row.choice === null
    ) open += 1
  }
  return open
}

// Meals from today on that still need a choice, in week order.
function openMeals(week: WeekView): (MealRef & { day: WeekDayView })[] {
  return week.days
    .filter((day) => !day.past)
    .flatMap((day) => day.meals.filter((meal) => openChoices(meal) > 0).map((meal) => ({ date: day.date, slot: meal.slot, day })))
}

// Decorative icons: the buttons they sit in carry the text.
const CHECK_ICON = (
  <svg className="choice-chip-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m3.5 8.5 3 3 6-7" />
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
  const [editing, setEditing] = useState<MealRef | null>(null)

  useEffect(() => {
    let cancelled = false
    setPending('load')
    setWeek(null)
    setError('')
    setNotice('')
    setEditing(null)
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

  // Notices float over the page and leave on their own instead of shifting it.
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

  async function runAction(action: WeekAction, success: string): Promise<boolean> {
    if (!week || pending !== null) return false
    setPending('action')
    setError('')
    setNotice('')
    try {
      const next = await apiRequest<WeekView>('/api/weeks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...action, weekStart: week.weekStart }),
      })
      setWeek(next)
      setNotice(success)
      // Once a meal is decided, move on to the next open meal of the same day.
      if (action.action === 'setChoices') {
        const day = next.days.find((candidate) => candidate.date === action.date)
        const meal = day?.meals.find((candidate) => candidate.slot === action.slot)
        if (day && meal && openChoices(meal) === 0) {
          const following = day.meals.find((candidate) => openChoices(candidate) > 0)
          setEditing(following ? { date: day.date, slot: following.slot } : null)
        }
      }
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Modifica non riuscita.')
      return false
    } finally {
      setPending(null)
    }
  }

  function openMeal(ref: MealRef) {
    if (ref.date !== selectedDay?.date) onDayChange(ref.date)
    setEditing(ref)
  }

  const busy = pending !== null
  const selectedDay = week?.days.find((day) => day.date === selectedDate)
    ?? week?.days.find((day) => !day.past)
    ?? week?.days[0]
  const hasMeals = week?.days.some((day) => day.meals.length > 0) ?? false
  const isCurrentWeek = week ? week.today >= week.weekStart && week.today <= week.weekEnd : true

  return (
    <section className="week-planner" aria-labelledby="week-planner-title" aria-busy={busy}>
      <header className="week-header">
        <button className="week-arrow" type="button" aria-label="Settimana precedente" onClick={() => week && onWeekChange(week.previousWeekStart)} disabled={busy || !week}>←</button>
        <div className="week-header-title">
          <span className="eyebrow">{isCurrentWeek ? 'Questa settimana' : 'Settimana'}</span>
          <h2 id="week-planner-title">
            {week ? `${formatDay(week.weekStart)} – ${formatDay(week.weekEnd)}` : 'Caricamento…'}
          </h2>
        </div>
        <button className="week-arrow" type="button" aria-label="Settimana successiva" onClick={() => week && onWeekChange(week.nextWeekStart)} disabled={busy || !week}>→</button>
      </header>
      {!isCurrentWeek && (
        <button className="text-button week-back" type="button" onClick={() => onWeekChange(null)} disabled={busy}>Torna a questa settimana</button>
      )}

      {error && !week && (
        <div className="week-error" role="alert">
          <p>{error}</p>
          <button className="text-button" type="button" disabled={busy} onClick={() => setLoadRevision((revision) => revision + 1)}>Riprova</button>
        </div>
      )}
      <div className="planner-feedback" aria-live="polite">
        {error && week && (
          <div className="planner-toast planner-toast-error" role="alert">
            <p>{error}</p>
            <button className="text-button" type="button" disabled={busy} onClick={() => setLoadRevision((revision) => revision + 1)}>Ricarica</button>
          </div>
        )}
        {notice && <p className="planner-toast">{notice}</p>}
      </div>

      {week && !hasMeals && (
        <div className="week-empty">
          <p>Non c’è una dieta attiva per questa settimana.</p>
          <Link className="primary-button" to="/dieta">Carica la dieta</Link>
        </div>
      )}

      {week && hasMeals && (
        <>
          <NewerDietNotice week={week} busy={busy} runAction={runAction} />
          <WeekSummary week={week} busy={busy} runAction={runAction} onOpen={openMeal} />
          <div className="planner-day-tabs" role="group" aria-label="Giorni">
            {week.days.map((day) => {
              const status = day.meals.length === 0 ? 'nessun pasto' : day.ready ? 'pronto' : day.past ? 'passato' : `${day.unresolvedChoices} da scegliere`
              return (
                <button
                  key={day.date}
                  className="planner-day-tab"
                  type="button"
                  aria-label={`${day.dayName} ${formatDay(day.date)}, ${status}${day.date === week.today ? ', oggi' : ''}`}
                  aria-pressed={selectedDay?.date === day.date}
                  data-ready={day.ready}
                  data-past={day.past}
                  onClick={() => {
                    onDayChange(day.date)
                    setEditing(null)
                  }}
                  disabled={busy}
                >
                  <span>{day.date === week.today ? 'Oggi' : day.dayName.slice(0, 3)}</span>
                  <strong>{Number(day.date.slice(8))}</strong>
                  <small aria-hidden="true">{day.meals.length === 0 ? '' : day.ready ? '✓' : day.past ? '·' : day.unresolvedChoices}</small>
                </button>
              )
            })}
          </div>
          {selectedDay && (
            <DayCard
              key={selectedDay.date}
              week={week}
              day={selectedDay}
              busy={busy}
              runAction={runAction}
              editingSlot={editing?.date === selectedDay.date ? editing.slot : null}
              onEdit={(slot) => setEditing(slot === null ? null : { date: selectedDay.date, slot })}
            />
          )}
        </>
      )}
    </section>
  )
}

// What is left to decide this week, with a shortcut to repeat last week.
function WeekSummary({ week, busy, runAction, onOpen }: {
  week: WeekView
  busy: boolean
  runAction: RunAction
  onOpen: (meal: MealRef) => void
}) {
  const open = openMeals(week)
  if (open.length === 0) {
    const anyFuture = week.days.some((day) => !day.past && day.meals.length > 0)
    return anyFuture ? (
      <div className="week-summary week-summary-done">
        <p><strong>Settimana pronta.</strong> La spesa è aggiornata.</p>
        <Link className="text-button" to="/spesa" search={{ start: week.weekStart }}>Vai alla spesa →</Link>
      </div>
    ) : null
  }
  return (
    <div className="week-summary">
      <div className="week-summary-head">
        <p><strong>{open.length === 1 ? '1 pasto da scegliere' : `${open.length} pasti da scegliere`}</strong></p>
        <button
          className="text-button"
          type="button"
          disabled={busy}
          onClick={() => void runAction({ action: 'repeatPreviousWeek' }, 'Scelte della settimana scorsa ripetute.')}
        >
          Ripeti le scelte della settimana scorsa
        </button>
      </div>
      <ul className="week-open-list">
        {open.slice(0, 4).map((meal) => (
          <li key={`${meal.date}:${meal.slot}`}>
            <button className="week-open-chip" type="button" disabled={busy} onClick={() => onOpen(meal)}>
              {meal.date === week.today ? 'Oggi' : shortDay(meal.day)} · {SLOT_LABELS[meal.slot]}
            </button>
          </li>
        ))}
        {open.length > 4 && <li className="week-open-more">e altri {open.length - 4}</li>}
      </ul>
    </div>
  )
}

function NewerDietNotice({ week, busy, runAction }: { week: WeekView; busy: boolean; runAction: RunAction }) {
  const needsRefresh = week.days.some(
    (day) => !day.past && day.validVersion !== null && day.validVersion.id !== day.plannedVersion?.id,
  )
  if (!needsRefresh) return null
  return (
    <div className="week-notice">
      <p>Hai attivato una dieta più recente. Aggiorna i prossimi giorni per usarla: le scelte di quei giorni ripartono da zero.</p>
      <button
        className="text-button"
        type="button"
        onClick={() => void runAction({ action: 'refresh' }, 'Prossimi giorni aggiornati alla nuova dieta.')}
        disabled={busy}
      >
        Usa la nuova dieta
      </button>
    </div>
  )
}

function DayCard({ week, day, busy, runAction, editingSlot, onEdit }: {
  week: WeekView
  day: WeekDayView
  busy: boolean
  runAction: RunAction
  editingSlot: PlanSlot | null
  onEdit: (slot: PlanSlot | null) => void
}) {
  const id = useId()
  // Past days stay unchanged; swaps stay within the same plan version.
  const changeable = !day.past && day.plannedVersion !== null
  const targets = changeable
    ? week.days.filter(
        (other) => other.date !== day.date && !other.past && other.plannedVersion?.id === day.plannedVersion?.id,
      )
    : []
  return (
    <section className="week-day" aria-labelledby={`${id}-title`}>
      <header className="week-day-heading">
        <h3 id={`${id}-title`}>
          {day.dayName} {formatDay(day.date)}
        </h3>
        {day.past && <span className="week-tag">Passato</span>}
        {targets.length > 0 && (
          <details className="week-day-menu">
            <summary>Scambia giornata</summary>
            <SwapChoices
              id={`${id}-swap`}
              label="Scambia tutti i pasti con"
              targets={targets}
              busy={busy}
              onSwap={async (target) => {
                if (await runAction({ action: 'swapDays', dates: [day.date, target] }, 'Giornate scambiate.')) onEdit(null)
              }}
            />
          </details>
        )}
      </header>
      {day.meals.length === 0 ? (
        <p className="summary-missing">Nessun pasto della dieta in questa data.</p>
      ) : (
        <>
          <ol className="week-meals">
            {day.meals.map((meal) => (
              <MealCard
                key={meal.slot}
                week={week}
                day={day}
                meal={meal}
                changeable={changeable}
                targets={targets}
                busy={busy}
                runAction={runAction}
                editing={editingSlot === meal.slot}
                onEdit={() => onEdit(editingSlot === meal.slot ? null : meal.slot)}
              />
            ))}
          </ol>
          {/* Plan weights are raw unless the plan states otherwise; foods flag the exceptions. */}
          <p className="week-day-note">Pesi a crudo, salvo dove indicato.</p>
        </>
      )}
    </section>
  )
}

function MealCard({
  week,
  day,
  meal,
  changeable,
  targets,
  busy,
  runAction,
  editing,
  onEdit,
}: {
  week: WeekView
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
  const open = openChoices(meal)
  const wholeMeal = meal.mealOptions.some((option) => option.key === meal.mealChoice)
  const canChoose =
    !meal.free &&
    (meal.combinations.length > 0 || meal.mealOptions.length > 0 || meal.rows.some((row) => row.options.length > 0))
  // The free meal can be set here unless this week's one is already past.
  const canFree = changeable && !(week.freeMeal !== null && week.freeMeal.date < week.today)
  const editable = changeable && (canChoose || canFree || targets.length > 0)
  const heading = (
    <span className="meal-card-heading">
      <span className="meal-card-title" id={`${id}-title`}>{SLOT_LABELS[meal.slot]}</span>
      {meal.free && <span className="week-tag week-tag-free">Pasto libero</span>}
      {!meal.free && !wholeMeal && meal.combinationChoice !== null && (
        <span className="week-tag week-tag-variant">{meal.combinationChoice}</span>
      )}
      {meal.sourceDayIndex !== day.dayIndex && (
        <span className="week-tag">Da {meal.sourceDayName.toLowerCase()}</span>
      )}
    </span>
  )
  return (
    <li className={meal.free ? 'meal-card meal-card-free' : open > 0 ? 'meal-card meal-card-open' : 'meal-card'} aria-labelledby={`${id}-title`}>
      {editable ? (
        <button
          className="meal-card-toggle"
          type="button"
          aria-expanded={editing}
          aria-controls={`${id}-editor`}
          onClick={onEdit}
          disabled={busy}
        >
          {heading}
          <span className={open > 0 ? 'meal-card-cta meal-card-cta-open' : 'meal-card-cta'} aria-hidden="true">
            {editing ? 'Chiudi' : open > 0 ? 'Scegli' : 'Modifica'}
          </span>
        </button>
      ) : (
        <div className="meal-card-toggle">{heading}</div>
      )}
      {meal.free ? (
        <p className="meal-card-free-text">{meal.free.description ?? 'Niente da pianificare né da comprare.'}</p>
      ) : open > 0 ? (
        <p className="meal-choice-needed">
          {meal.combinations.length > 0 && meal.combinationChoice === null
            ? `Da scegliere tra ${meal.combinations.length} varianti.`
            : open === 1 ? 'Manca una scelta.' : `Mancano ${open} scelte.`}
        </p>
      ) : (
        <MealFoods meal={meal} />
      )}
      {meal.notes && !editing && <p className="meal-card-note">{meal.notes}</p>}
      {editing && (
        <div className="meal-card-editor" id={`${id}-editor`}>
          {canChoose && <MealChoices id={`${id}-choices`} day={day} meal={meal} busy={busy} runAction={runAction} />}
          {meal.notes && <p className="meal-card-note">{meal.notes}</p>}
          {canFree && <FreeMealEditor week={week} day={day} meal={meal} busy={busy} runAction={runAction} />}
          {targets.length > 0 && (
            <details className="meal-swap">
              <summary>Scambia con un altro giorno</summary>
              <SwapChoices
                id={`${id}-swap`}
                label={`Scambia ${SLOT_LABELS[meal.slot].toLowerCase()} con quello di`}
                targets={targets}
                busy={busy}
                onSwap={async (target) => {
                  if (await runAction({ action: 'moveMeal', slot: meal.slot, dates: [day.date, target] }, 'Pasti scambiati.')) {
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

// One free meal per week, at the meal's date and slot; setting it elsewhere moves it.
function FreeMealEditor({ week, day, meal, busy, runAction }: {
  week: WeekView
  day: WeekDayView
  meal: WeekMealView
  busy: boolean
  runAction: RunAction
}) {
  const id = useId()
  const elsewhere = week.freeMeal && !meal.free
    ? week.days.find((candidate) => candidate.date === week.freeMeal?.date)
    : undefined

  function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    const description = String(new FormData(event.currentTarget).get('description') ?? '').trim()
    void runAction(
      { action: 'setFreeMeal', date: day.date, slot: meal.slot, description: description || null },
      meal.free ? 'Pasto libero aggiornato.' : 'Pasto libero impostato.',
    )
  }

  return (
    <details className="meal-swap" open={Boolean(meal.free)}>
      <summary>{meal.free ? 'Pasto libero' : 'Rendilo il pasto libero'}</summary>
      <form className="week-form" onSubmit={save}>
        {elsewhere && week.freeMeal && (
          <p className="week-form-hint">Ora è {shortDay(elsewhere)} · {SLOT_LABELS[week.freeMeal.slot].toLowerCase()}: lo sposterai qui.</p>
        )}
        <label htmlFor={`${id}-description`}>Cosa pensi di mangiare (facoltativo)</label>
        <input
          id={`${id}-description`}
          name="description"
          type="text"
          maxLength={FREE_MEAL_DESCRIPTION_MAX_LENGTH}
          defaultValue={meal.free?.description ?? ''}
          disabled={busy}
        />
        <div className="week-form-actions">
          <button className="secondary-button" type="submit" disabled={busy}>
            {meal.free ? 'Salva' : elsewhere ? 'Sposta qui il pasto libero' : 'Imposta pasto libero'}
          </button>
          {meal.free && (
            <button
              className="text-button"
              type="button"
              onClick={() => void runAction({ action: 'clearFreeMeal' }, 'Torna il pasto della dieta.')}
              disabled={busy}
            >
              Torna al pasto della dieta
            </button>
          )}
        </div>
      </form>
    </details>
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

export function MealFoods({ meal }: { meal: WeekMealView }) {
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

// Each press saves the choice; the day is ready once nothing is left to choose.
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
    void runAction({ action: 'setChoices', date: day.date, slot: meal.slot, choices }, 'Scelta salvata.')
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

