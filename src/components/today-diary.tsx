import { Link, useBlocker } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import type { DiaryDay } from '../diary'
import { CHECK_IN_NOTE_MAX_LENGTH } from '../diary'
import { SLOT_LABELS } from './plan-text'
import { useDiary } from './use-diary'
import { MealFoods } from './week-planner'
import './today.css'

const dayFormatter = new Intl.DateTimeFormat('it-IT', {
  weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Rome',
})

function todayInRome(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)!.value).join('-')
}

function adjacentDate(date: string, offset: number): string {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + offset)
  return value.toISOString().slice(0, 10)
}

function mondayOf(date: string): string {
  return adjacentDate(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7))
}

function confirmDiscardNotes(element: HTMLElement | null): boolean {
  return !element?.querySelector('[data-note-dirty="true"]') || window.confirm('Le note non salvate andranno perse. Continuare senza salvarle?')
}

// Home screen: what to eat on a day, and a one-tap check-in for today's meals.
export function TodayDiary({ date, onDateChange }: {
  date: string | null
  onDateChange: (date: string | null) => void
}) {
  const diary = useDiary(date)
  const [acting, setActing] = useState(false)
  const [actionError, setActionError] = useState<{ date: string; message: string } | null>(null)
  const actionLock = useRef(false)
  const rootRef = useRef<HTMLElement>(null)
  const today = diary.day?.today ?? todayInRome()
  const selectedDate = date ?? today
  // The route is authoritative even before the hook has opened its new date.
  const day = diary.day?.date === selectedDate ? diary.day : null
  const busy = diary.loading || diary.saving || acting
  const isToday = selectedDate === today
  const hasDiet = Boolean(day?.validVersion || day?.plannedVersion)
  const canRecord = Boolean(day?.snapshotId) && isToday && !busy && !diary.conflict
  const error = diary.error || (actionError?.date === selectedDate ? actionError.message : '')
  const recorded = day?.meals.filter((meal) => meal.checkIn !== null).length ?? 0
  const followed = day?.meals.filter((meal) => meal.checkIn?.followed).length ?? 0
  const dayLabel = dayFormatter.format(new Date(`${selectedDate}T12:00:00Z`))

  useBlocker({
    shouldBlockFn: () => !confirmDiscardNotes(rootRef.current),
    enableBeforeUnload: () => Boolean(rootRef.current?.querySelector('[data-note-dirty="true"]')),
  })

  async function perform(action: () => Promise<void>) {
    if (actionLock.current) return
    actionLock.current = true
    setActing(true)
    setActionError(null)
    try {
      await action()
    } catch (cause) {
      setActionError({ date: selectedDate, message: cause instanceof Error ? cause.message : 'Operazione non riuscita. Riprova.' })
    } finally {
      actionLock.current = false
      setActing(false)
    }
  }

  // useBlocker already confirms before a navigation discards unsaved notes.
  const goTo = onDateChange

  return (
    <section className="today" ref={rootRef} aria-labelledby="today-title" aria-busy={busy}>
      <header className="today-heading">
        <button type="button" className="today-arrow" aria-label="Giorno precedente" disabled={busy}
          onClick={() => goTo(adjacentDate(selectedDate, -1))}>←</button>
        <div className="today-title">
          <span className="eyebrow">{isToday ? 'Oggi' : selectedDate < today ? 'Giorno passato' : 'In programma'}</span>
          <h1 id="today-title"><time dateTime={selectedDate}>{dayLabel}</time></h1>
        </div>
        <button type="button" className="today-arrow" aria-label="Giorno successivo" disabled={busy}
          onClick={() => goTo(adjacentDate(selectedDate, 1))}>→</button>
      </header>
      {!isToday && (
        <button type="button" className="text-button today-back" disabled={busy} onClick={() => goTo(null)}>Torna a oggi</button>
      )}

      <div className="today-feedback" aria-live="polite">
        {diary.loading && <p role="status">Caricamento…</p>}
        {error && !diary.conflict && (
          <div className="today-error" role="alert">
            <p>{error}</p>
            <button type="button" className="text-button" disabled={busy} onClick={() => {
              if (confirmDiscardNotes(rootRef.current)) void perform(() => diary.reload())
            }}>Riprova</button>
          </div>
        )}
        {diary.conflict && (
          <div className="today-error" role="alert">
            <p>Questi pasti sono stati registrati anche da un altro dispositivo.</p>
            <div className="today-actions">
              <button type="button" className="text-button" disabled={busy} onClick={() => {
                if (confirmDiscardNotes(rootRef.current)) void perform(() => diary.resolveConflict('local'))
              }}>Usa i miei</button>
              <button type="button" className="text-button" disabled={busy} onClick={() => {
                if (confirmDiscardNotes(rootRef.current)) void perform(() => diary.resolveConflict('server'))
              }}>Tieni gli altri</button>
            </div>
          </div>
        )}
      </div>

      {day && day.meals.length > 0 && (
        <>
          {isToday && (
            <p className="today-progress">
              {recorded === 0 ? 'Tocca «Seguito» dopo ogni pasto.' : `${followed} di ${day.meals.length} pasti seguiti`}
            </p>
          )}
          <ol className="today-meals">
            {day.meals.map((meal) => (
              <TodayMeal key={`${day.date}-${meal.plan.slot}`} meal={meal} editable={isToday} disabled={!canRecord}
                record={(nextFollowed, note) => perform(() => diary.record(meal.plan.slot, nextFollowed, note))} />
            ))}
          </ol>
          {isToday && day.meals.some((meal) => meal.checkIn?.followed !== true) && (
            <button type="button" className="secondary-button today-all" disabled={!canRecord} onClick={() => {
              if (confirmDiscardNotes(rootRef.current)) void perform(() => diary.followAll())
            }}>Segna tutto come seguito</button>
          )}
          {selectedDate >= today && (
            <Link className="text-button today-week-link" to="/settimana" search={{ start: mondayOf(selectedDate), date: selectedDate }}>
              Cambia i pasti di questo giorno →
            </Link>
          )}
        </>
      )}

      {day && day.meals.length === 0 && (
        <div className="today-empty">
          {selectedDate < today ? (
            <p>Nessun pasto registrato in questo giorno.</p>
          ) : hasDiet ? (
            <>
              <p>Prima scegli i pasti di questo giorno.</p>
              <Link className="primary-button" to="/settimana" search={{ start: mondayOf(selectedDate), date: selectedDate }}>Scegli i pasti</Link>
            </>
          ) : (
            <>
              <p>Non c’è ancora una dieta attiva per questa data.</p>
              <Link className="primary-button" to="/dieta">Carica la dieta</Link>
            </>
          )}
        </div>
      )}
    </section>
  )
}

function TodayMeal({ meal, editable, disabled, record }: {
  meal: DiaryDay['meals'][number]
  editable: boolean
  disabled: boolean
  record: (followed: boolean, note: string | null) => Promise<void>
}) {
  const { plan, checkIn } = meal
  const itemRef = useRef<HTMLLIElement>(null)
  const label = SLOT_LABELS[plan.slot]
  const state = checkIn === null ? 'open' : checkIn.followed ? 'followed' : 'skipped'

  return (
    <li className="today-meal" data-state={state} ref={itemRef}>
      <div className="today-meal-heading">
        <h2>{label}</h2>
        {editable ? (
          <button type="button" className="today-check" aria-label={`${label}: seguito`}
            aria-pressed={checkIn?.followed === true} disabled={disabled} onClick={() => {
              if (checkIn?.followed === true || !confirmDiscardNotes(itemRef.current)) return
              void record(true, checkIn?.note ?? null)
            }}>
            <span aria-hidden="true">✓</span> Seguito
          </button>
        ) : checkIn && (
          <span className="today-status">{checkIn.followed ? 'Seguito' : 'Non seguito'}</span>
        )}
      </div>
      {plan.free ? (
        <p className="today-free"><strong>Pasto libero</strong>{plan.free.description ? ` · ${plan.free.description}` : ''}</p>
      ) : (
        <>
          <MealFoods meal={plan} />
          {plan.notes && <p className="meal-card-note">{plan.notes}</p>}
        </>
      )}
      {checkIn && !checkIn.followed && <p className="today-skipped">Non seguito</p>}
      {(editable || checkIn?.note) && (
        <details className="today-more">
          <summary>{checkIn?.note ? 'Nota' : 'Nota o non seguito'}</summary>
          {editable ? (
            <NoteForm key={JSON.stringify(checkIn)} meal={meal} disabled={disabled} record={record} />
          ) : (
            <p>{checkIn?.note}</p>
          )}
        </details>
      )}
    </li>
  )
}

// Reset only the draft when authoritative content changes. The surrounding
// <details> stays mounted.
function NoteForm({ meal, disabled, record }: {
  meal: DiaryDay['meals'][number]
  disabled: boolean
  record: (followed: boolean, note: string | null) => Promise<void>
}) {
  const { plan, checkIn } = meal
  const [note, setNote] = useState(checkIn?.note ?? '')
  const noteValue = note.trim() || null
  const dirty = noteValue !== (checkIn?.note ?? null)
  const noteId = `today-note-${plan.slot}`

  return (
    <form className="today-note" data-note-dirty={dirty} onSubmit={(event) => {
      event.preventDefault()
      if (!disabled && dirty) void record(checkIn?.followed ?? true, noteValue)
    }}>
      <label htmlFor={noteId}>Nota</label>
      <textarea id={noteId} value={note} maxLength={CHECK_IN_NOTE_MAX_LENGTH} rows={2} disabled={disabled}
        onChange={(event) => setNote(event.currentTarget.value)} />
      <div className="today-actions">
        <button type="submit" className="text-button" disabled={disabled || !dirty}>{checkIn ? 'Salva nota' : 'Salva nota e segna seguito'}</button>
        {!plan.free && (
          <button type="button" className="text-button" aria-pressed={checkIn?.followed === false}
            disabled={disabled || checkIn?.followed === false} onClick={() => void record(false, noteValue)}>Segna non seguito</button>
        )}
      </div>
    </form>
  )
}
