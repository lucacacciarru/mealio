import { Fragment, useEffect, useState } from 'react'
import type { SyntheticEvent } from 'react'
import type { PlanComponentState, PlanSlot } from '../db/schema'
import type { WeekDayView, WeekMealChoices, WeekMealView, WeekView } from '../server/weeks'
import { apiRequest } from './api'
import { FoodText, SLOT_LABELS } from './plan-text'

const FREE_MEAL_DESCRIPTION_MAX_LENGTH = 200

type WeekAction =
  | { action: 'confirm' }
  | { action: 'refresh' }
  | { action: 'swapDays'; dates: [string, string] }
  | { action: 'moveMeal'; slot: PlanSlot; dates: [string, string] }
  | { action: 'setChoices'; date: string; slot: PlanSlot; choices: WeekMealChoices }
  | { action: 'setFreeMeal'; date: string; slot: PlanSlot; description: string | null }
  | { action: 'clearFreeMeal' }
type RunAction = (action: WeekAction, success: string) => Promise<void>

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

// Plain-text food for <option> labels, mirroring FoodText.
function foodLine(food: {
  label: string
  quantityText: string | null
  unitText: string | null
  state?: PlanComponentState
}): string {
  const text = [food.label, food.quantityText?.trim(), food.unitText?.trim()].filter(Boolean).join(' ')
  if (food.state === 'raw') return `${text} a crudo`
  if (food.state === 'cooked') return `${text} a cotto`
  return text
}

export function WeekPlanner({ weekStart, onWeekChange }: { weekStart: string | null; onWeekChange: (start: string | null) => void }) {
  const [week, setWeek] = useState<WeekView | null>(null)
  const [pending, setPending] = useState<'load' | 'action' | null>('load')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [loadRevision, setLoadRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    setPending('load')
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


  async function runAction(action: WeekAction, success: string) {
    if (!week || pending !== null) return
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Modifica non riuscita.')
    } finally {
      setPending(null)
    }
  }

  const busy = pending !== null
  const selectedDay = week?.days.find((day) => day.date === selectedDate)
    ?? week?.days.find((day) => day.date === week.today)
    ?? week?.days[0]

  return (
    <section className="week-planner" id="settimana" aria-labelledby="week-planner-title">
      <div className="workspace-heading">
        <div>
          <span className="eyebrow">Settimana</span>
          <h2 id="week-planner-title">{week ? `Settimana ${week.isoWeek} del ${week.isoYear}` : 'La tua settimana'}</h2>
          {week && (
            <p>
              {formatDay(week.weekStart, week.weekStart.slice(0, 4) === week.weekEnd.slice(0, 4) ? {} : { year: 'numeric' })}
              {' – '}
              {formatDay(week.weekEnd, { year: 'numeric' })}
            </p>
          )}
        </div>
        {week && (
          <nav className="week-nav" aria-label="Cambia settimana">
            <button className="secondary-button" type="button" onClick={() => onWeekChange(week.previousWeekStart)} disabled={busy}>
              ← Precedente
            </button>
            <button className="secondary-button" type="button" onClick={() => onWeekChange(week.nextWeekStart)} disabled={busy}>
              Successiva →
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onWeekChange(null)}
              disabled={busy || (week.today >= week.weekStart && week.today <= week.weekEnd)}
            >
              Settimana in corso
            </button>
          </nav>
        )}
      </div>

      {error && (
        <div role="alert">
          <p className="message error-message">{error}</p>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => setLoadRevision((revision) => revision + 1)}>Riprova caricamento</button>
        </div>
      )}
      {notice && <p className="message success-message" role="status">{notice}</p>}
      {pending === 'load' && <p className="loading-inline" role="status">Caricamento della settimana…</p>}

      {week && (
        <div className="week-body">
          <WeekStatus week={week} busy={busy} runAction={runAction} />
          {week.status === 'confirmed' && (
            <FreeMealPanel
              key={`${week.weekStart}:${JSON.stringify(week.freeMeal)}`}
              week={week}
              busy={busy}
              runAction={runAction}
            />
          )}
          <div className="planner-day-tabs" role="group" aria-label="Giorni da pianificare">
            {week.days.map((day) => (
              <button
                key={day.date}
                className="planner-day-tab"
                type="button"
                aria-label={`${day.dayName} ${formatDay(day.date)}${day.past ? ', passato' : ''}`}
                aria-pressed={selectedDay?.date === day.date}
                onClick={() => setSelectedDate(day.date)}
                disabled={busy}
              >
                <span>{day.dayName.slice(0, 3)}</span>
                <strong>{Number(day.date.slice(8))}</strong>
                {day.date === week.today && <small>Oggi</small>}
                {day.past && <small>Passato</small>}
              </button>
            ))}
          </div>
          <p className="planner-summary">Apri un giorno e modifica solo i pasti che vuoi organizzare diversamente.</p>
          <ol className="week-days">
            {selectedDay && <DayCard key={selectedDay.date} week={week} day={selectedDay} busy={busy} runAction={runAction} />}
          </ol>
        </div>
      )}
    </section>
  )
}

function WeekStatus({ week, busy, runAction }: { week: WeekView; busy: boolean; runAction: RunAction }) {
  const weekOver = week.weekEnd < week.today
  if (week.status === 'unconfirmed') {
    if (!week.days.some((day) => day.meals.length > 0)) {
      return (
        <section className="week-status" role="status">
          <h3>Nessun piano per queste date</h3>
          <p>Nessuna versione del piano è valida in questa settimana. Attiva un piano dal PDF per pianificarla.</p>
        </section>
      )
    }
    return (
      <section className="week-status week-status-pending">
        <h3>Settimana non confermata</h3>
        {weekOver ? (
          <p>Per questa settimana è valso il piano originale.</p>
        ) : (
          <>
            <p>
              Finché non la confermi vale il piano originale. Dopo la conferma puoi scambiare giorni e pasti, scegliere
              le sostituzioni previste dal piano e il pasto libero.
            </p>
            <button
              className="primary-button"
              type="button"
              onClick={() => void runAction({ action: 'confirm' }, 'Settimana confermata.')}
              disabled={busy}
            >
              Conferma la settimana
            </button>
          </>
        )}
      </section>
    )
  }

  const needsRefresh = week.days.some(
    (day) => !day.past && day.validVersion !== null && day.validVersion.id !== day.plannedVersion?.id,
  )
  return (
    <section className="week-status week-status-confirmed">
      <h3>Settimana confermata</h3>
      <p>
        {week.confirmedAt !== null &&
          `Confermata il ${new Date(week.confirmedAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}. `}
        {weekOver
          ? 'La settimana è conclusa: i pasti restano come pianificati.'
          : 'Puoi modificare i giorni da oggi in poi; i giorni passati restano come pianificati.'}
      </p>
      {needsRefresh && (
        <div className="week-refresh">
          <p className="week-warning">
            Da alcune date vale una versione più recente del piano. Aggiornando, quei giorni ripartono dal nuovo piano e
            perdono scambi e sostituzioni; il pasto libero resta.
          </p>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void runAction({ action: 'refresh' }, 'Giorni aggiornati al piano valido.')}
            disabled={busy}
          >
            Aggiorna al piano valido
          </button>
        </div>
      )}
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
  // Changes need a confirmed week and apply from today on, swapping only with
  // days that use the same plan version.
  const changeable = week.status === 'confirmed' && !day.past && day.plannedVersion !== null
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
    <li className="week-day">
      <details open>
        <summary>
          <span>
            {day.dayName} {formatDay(day.date)}
          </span>
          {day.date === week.today && <span className="week-tag week-tag-today">Oggi</span>}
          {day.past && <span className="week-tag">Passato</span>}
        </summary>
        <div className="week-day-body">
          {day.plannedVersion && <p className="week-day-version">Piano: {versionName(day.plannedVersion)}</p>}
          {staleNote && <p className="week-warning">{staleNote}</p>}
          {day.meals.length === 0 ? (
            <p className="summary-missing">Nessun piano valido in questa data.</p>
          ) : (
            <ul className="week-meals">
              {day.meals.map((meal) => (
                <MealCard
                  key={meal.slot}
                  day={day}
                  meal={meal}
                  changeable={changeable}
                  targets={targets}
                  busy={busy}
                  runAction={runAction}
                />
              ))}
            </ul>
          )}
          {targets.length > 0 && (
            <details className="week-edit">
              <summary>Scambia il giorno</summary>
              <SwapForm
                id={`swap-day-${day.date}`}
                label="Scambia tutti i pasti con"
                submitLabel="Scambia i giorni"
                targets={targets}
                busy={busy}
                onSwap={(target) => runAction({ action: 'swapDays', dates: [day.date, target] }, 'Giorni scambiati.')}
              />
            </details>
          )}
        </div>
      </details>
    </li>
  )
}

function MealCard({
  day,
  meal,
  changeable,
  targets,
  busy,
  runAction,
}: {
  day: WeekDayView
  meal: WeekMealView
  changeable: boolean
  targets: WeekDayView[]
  busy: boolean
  runAction: RunAction
}) {
  const canSubstitute =
    changeable &&
    !meal.free &&
    (meal.combinations.length > 0 || meal.mealOptions.length > 0 || meal.rows.some((row) => row.options.length > 0))
  return (
    <li className={meal.free ? 'week-meal week-meal-free' : 'week-meal'}>
      <div className="week-meal-heading">
        <h4>{SLOT_LABELS[meal.slot]}</h4>
        {meal.free ? (
          <span className="week-tag week-tag-free">Pasto libero</span>
        ) : (
          <>
            {meal.sourceDayIndex !== day.dayIndex && (
              <span className="week-tag">Spostato da {meal.sourceDayName.toLowerCase()}</span>
            )}
            {meal.page !== null && <span className="week-meal-page">p. {meal.page}</span>}
          </>
        )}
      </div>
      {meal.free ? <FreeMealContent meal={meal} description={meal.free.description} /> : <PlannedMealContent meal={meal} />}
      {(canSubstitute || targets.length > 0) && (
        <details className="week-edit">
          <summary>Modifica</summary>
          {canSubstitute && (
            <SubstitutionForm
              key={JSON.stringify([
                meal.mealId,
                meal.sourceDayIndex,
                meal.combinationChoice,
                meal.mealChoice,
                meal.rows.map((row) => row.choice),
              ])}
              day={day}
              meal={meal}
              busy={busy}
              runAction={runAction}
            />
          )}
          {targets.length > 0 && (
            <SwapForm
              id={`move-${day.date}-${meal.slot}`}
              label="Scambia con lo stesso pasto di"
              submitLabel="Scambia il pasto"
              targets={targets}
              busy={busy}
              onSwap={(target) =>
                runAction({ action: 'moveMeal', slot: meal.slot, dates: [day.date, target] }, 'Pasti scambiati.')
              }
            />
          )}
        </details>
      )}
    </li>
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
            <p className="week-combination-choice">Combinazione: {meal.combinationChoice}</p>
          )}
          {plannedRows.length > 0 && openCombinations.length > 0 && (
            <p className="summary-note">In tutte le combinazioni:</p>
          )}
          {plannedRows.length > 0 && <PlannedRows rows={plannedRows} />}
          {openCombinations.length > 0 && (
            <details className="week-combinations">
              <summary>{openCombinations.length} combinazioni a scelta</summary>
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

function FreeMealContent({ meal, description }: { meal: WeekMealView; description: string | null }) {
  const replaced = meal.rows.flatMap((row) => row.components.map((component) => component.label))
  return (
    <>
      <p className="week-free-description">{description ?? 'Nessuna descrizione.'}</p>
      {meal.combinations.length > 0 ? (
        <p className="summary-note">Al posto del pasto previsto dal piano.</p>
      ) : (
        replaced.length > 0 && <p className="summary-note">Al posto di: {replaced.join(', ')}</p>
      )}
    </>
  )
}

function SubstitutionForm({
  day,
  meal,
  busy,
  runAction,
}: {
  day: WeekDayView
  meal: WeekMealView
  busy: boolean
  runAction: RunAction
}) {
  const [wholeMeal, setWholeMeal] = useState(meal.mealChoice ?? '')
  const [combination, setCombination] = useState(meal.combinationChoice ?? '')
  // Only the shared foods and those of the chosen combination can be substituted.
  const rows = meal.rows.filter(
    (row) => row.options.length > 0 && (row.combination === null || row.combination === combination),
  )
  const idPrefix = `substitution-${day.date}-${meal.slot}`

  function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const choices: WeekMealChoices = {
      combination: wholeMeal ? null : combination || null,
      meal: wholeMeal || null,
      rows: {},
    }
    if (!wholeMeal) {
      for (const row of rows) {
        const value = form.get(row.key)
        if (typeof value === 'string' && value) choices.rows[row.key] = value
      }
    }
    void runAction({ action: 'setChoices', date: day.date, slot: meal.slot, choices }, 'Sostituzioni salvate.')
  }

  return (
    <form className="week-form" onSubmit={save}>
      {meal.mealOptions.length > 0 && (
        <>
          <label htmlFor={`${idPrefix}-meal`}>Pasto intero</label>
          <select
            id={`${idPrefix}-meal`}
            value={wholeMeal}
            onChange={(event) => setWholeMeal(event.currentTarget.value)}
            disabled={busy}
          >
            <option value="">Come da piano</option>
            {meal.mealOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {`${foodLine(option.item)} (equivalenza${option.equivalence.page !== null ? `, p. ${option.equivalence.page}` : ''})`}
              </option>
            ))}
          </select>
        </>
      )}
      {meal.combinations.length > 0 && (
        <>
          <label htmlFor={`${idPrefix}-combination`}>Combinazione</label>
          <select
            id={`${idPrefix}-combination`}
            value={combination}
            onChange={(event) => setCombination(event.currentTarget.value)}
            disabled={busy || wholeMeal !== ''}
          >
            <option value="">Da scegliere, come da piano</option>
            {meal.combinations.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        </>
      )}
      {rows.map((row) => (
        <Fragment key={row.key}>
          <label htmlFor={`${idPrefix}-${row.key.replace(':', '-')}`}>
            {row.components.map((component) => component.label).join(' oppure ')}
          </label>
          <select
            id={`${idPrefix}-${row.key.replace(':', '-')}`}
            name={row.key}
            defaultValue={row.choice ?? ''}
            disabled={busy || wholeMeal !== ''}
          >
            <option value="">{row.components.length > 1 ? 'Da scegliere, come da piano' : 'Come da piano'}</option>
            {row.options.map((option) => (
              <option key={option.key} value={option.key}>
                {option.type === 'component'
                  ? foodLine(option.component)
                  : `${foodLine(option.item)} (equivalenza di ${option.replaces.label})`}
              </option>
            ))}
          </select>
        </Fragment>
      ))}
      <button className="secondary-button" type="submit" disabled={busy}>
        Salva le sostituzioni
      </button>
    </form>
  )
}

function SwapForm({
  id,
  label,
  submitLabel,
  targets,
  busy,
  onSwap,
}: {
  id: string
  label: string
  submitLabel: string
  targets: WeekDayView[]
  busy: boolean
  onSwap: (date: string) => Promise<void>
}) {
  async function swap(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const target = new FormData(form).get('target')
    if (typeof target !== 'string' || !target) return
    await onSwap(target)
    form.reset()
  }

  return (
    <form className="week-form" onSubmit={swap}>
      <label htmlFor={id}>{label}</label>
      <select id={id} name="target" required defaultValue="" disabled={busy}>
        <option value="" disabled>
          Scegli un giorno
        </option>
        {targets.map((target) => (
          <option key={target.date} value={target.date}>
            {`${target.dayName} ${formatDay(target.date)}`}
          </option>
        ))}
      </select>
      <button className="secondary-button" type="submit" disabled={busy}>
        {submitLabel}
      </button>
    </form>
  )
}
