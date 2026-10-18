import { Link, useBlocker } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import type { DiaryDay } from '../diary'
import { CHECK_IN_NOTE_MAX_LENGTH } from '../diary'
import { SLOT_LABELS } from './plan-text'
import { useDiary } from './use-diary'
import { PlannedMealContent } from './week-planner'
import './calendar.css'

const fullDateFormatter = new Intl.DateTimeFormat('it-IT', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Rome',
})

const weekDateFormatter = new Intl.DateTimeFormat('it-IT', {
  day: 'numeric', month: 'short', timeZone: 'Europe/Rome',
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

export function TodayDiary({ date, onDateChange }: {
  date: string | null
  onDateChange: (date: string | null) => void
}) {
  const diary = useDiary(date)
  const [acting, setActing] = useState(false)
  const [actionError, setActionError] = useState<{ date: string; message: string } | null>(null)
  const actionLock = useRef(false)
  const calendarRef = useRef<HTMLElement>(null)
  const today = diary.day?.today ?? todayInRome()
  const selectedDate = date ?? today
  // The route is authoritative even before the hook has opened its new date.
  const day = diary.day?.date === selectedDate ? diary.day : null
  const weekStart = mondayOf(selectedDate)
  const busy = diary.loading || diary.saving || acting
  const readOnly = selectedDate !== today
  const future = selectedDate > today
  const canRecord = Boolean(day?.snapshotId) && !readOnly && !busy && !diary.conflict
  const error = diary.error || (actionError?.date === selectedDate ? actionError.message : '')

  useBlocker({
    shouldBlockFn: () => !confirmDiscardNotes(calendarRef.current),
    enableBeforeUnload: () => Boolean(calendarRef.current?.querySelector('[data-note-dirty="true"]')),
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

  return (
    <section className="calendar" ref={calendarRef} aria-labelledby="calendar-title" aria-busy={busy}>
      <header className="calendar-heading">
        <div>
          <span className="calendar-eyebrow">Calendario</span>
          <h1 id="calendar-title"><time dateTime={selectedDate}>{fullDateFormatter.format(new Date(`${selectedDate}T12:00:00Z`))}</time></h1>
        </div>
        <details className="calendar-date-picker">
          <summary aria-label="Scegli una data">Data</summary>
          <label className="calendar-date" htmlFor="calendar-date">Vai alla data
            <input id="calendar-date" type="date" value={selectedDate} disabled={busy} onChange={(event) => {
              const nextDate = event.currentTarget.value
              if (event.currentTarget.validity.valid && /^\d{4}-\d{2}-\d{2}$/.test(nextDate)) {
                onDateChange(nextDate)
                event.currentTarget.closest('details')?.removeAttribute('open')
              }
            }} />
          </label>
        </details>
      </header>

      <nav className="calendar-navigation" aria-label="Scegli il giorno del calendario">
        <div className="calendar-week-controls">
          <button type="button" className="secondary-button calendar-week-arrow" aria-label="Settimana precedente" disabled={busy}
            onClick={() => onDateChange(adjacentDate(selectedDate, -7))}><span aria-hidden="true">←</span></button>
          <p className="calendar-week-label">{weekDateFormatter.format(new Date(`${weekStart}T12:00:00Z`))} – {weekDateFormatter.format(new Date(`${adjacentDate(weekStart, 6)}T12:00:00Z`))}</p>
          {selectedDate !== today && <button type="button" className="secondary-button calendar-today-shortcut" disabled={busy} onClick={() => onDateChange(null)}>Oggi</button>}
          <button type="button" className="secondary-button calendar-week-arrow" aria-label="Settimana successiva" disabled={busy}
            onClick={() => onDateChange(adjacentDate(selectedDate, 7))}><span aria-hidden="true">→</span></button>
        </div>
        <div className="calendar-week-days">
          {Array.from({ length: 7 }, (_, index) => {
            const stripDate = adjacentDate(weekStart, index)
            const selected = stripDate === selectedDate
            const isToday = stripDate === today
            const value = new Date(`${stripDate}T12:00:00Z`)
            return (
              <button key={stripDate} type="button" className="calendar-week-day" disabled={busy}
                aria-pressed={selected} aria-current={isToday ? 'date' : undefined}
                aria-label={`${fullDateFormatter.format(value)}${isToday ? ', oggi' : ''}${selected ? ', selezionato' : ''}`}
                onClick={() => { if (!selected) onDateChange(stripDate) }}>
                <span className="calendar-week-day-name">{value.toLocaleDateString('it-IT', { weekday: 'short', timeZone: 'Europe/Rome' })}</span>
                <span className="calendar-week-day-number">{value.getUTCDate()}</span>
                <span className="calendar-week-day-mark">{isToday ? 'Oggi' : selected ? 'Scelto' : '\u00a0'}</span>
              </button>
            )
          })}
        </div>
      </nav>

      <div className="calendar-feedback" aria-live="polite">
        {!diary.online && <p>Offline · {day ? 'copia salvata sul dispositivo' : 'collegati per caricare questa data'}.</p>}
        {diary.pendingCount > 0 && <p>{diary.pendingCount} {diary.pendingCount === 1 ? 'registrazione salvata sul dispositivo, da sincronizzare' : 'registrazioni salvate sul dispositivo, da sincronizzare'}.</p>}
        {diary.loading && <p role="status">Caricamento della giornata…</p>}
        {(diary.saving || acting) && !diary.loading && <p role="status">Salvataggio in corso…</p>}
        {error && !diary.conflict && <p className="calendar-error" role="alert">{error}</p>}
        {(error || diary.pendingCount > 0) && !diary.conflict && (
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void perform(() => diary.retrySync())}>Riprova caricamento e sincronizzazione</button>
        )}
        {diary.conflict && (
          <div className="calendar-conflict" role="alert">
            <p>Check-in diversi sul server. Le modifiche locali sono conservate: scegli quali mantenere.</p>
            <div className="calendar-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => {
                if (confirmDiscardNotes(calendarRef.current)) void perform(() => diary.resolveConflict('local'))
              }}>Usa i miei check-in</button>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => {
                if (confirmDiscardNotes(calendarRef.current)) void perform(() => diary.resolveConflict('server'))
              }}>Mantieni quelli sul server</button>
            </div>
          </div>
        )}
      </div>

      <div className="calendar-day-heading">
        <p className="calendar-mode">{future ? 'Anteprima · sola lettura' : readOnly ? 'Storico · sola lettura' : 'I pasti di oggi'}</p>
        {day && day.meals.length > 0 && !readOnly && (
          <button type="button" className="primary-button" disabled={!canRecord} onClick={() => {
            if (confirmDiscardNotes(calendarRef.current)) void perform(() => diary.followAll())
          }}>Tutto seguito</button>
        )}
      </div>

      {day ? (
        <>
          <div className="calendar-plan">
            <div className="calendar-plan-line">
              <p>{day.weekStatus === 'confirmed' ? 'Settimana confermata' : 'Piano originale · da confermare'}</p>
              <Link to="/settimana" search={{ start: weekStart }} aria-label="Pianifica la settimana">Pianifica →</Link>
            </div>
            {day.plannedVersion?.id !== day.validVersion?.id && <p className="calendar-warning">La pianificazione usa una dieta diversa da quella valida per questa data. Rivedi la settimana se vuoi aggiornarla.</p>}
          </div>

          {day.meals.length > 0 ? (
            <>
              <ol className="calendar-meals">
                {day.meals.map((meal) => (
                  <DiaryMeal key={`${day.date}-${meal.plan.slot}`} meal={meal} readOnly={readOnly} disabled={!canRecord}
                    record={(followed, note) => perform(() => diary.record(meal.plan.slot, followed, note))} />
                ))}
              </ol>
            <details className="calendar-provenance">
              <summary>Versione e origine del piano</summary>
              <div>
                <p>Piano della giornata: <strong>{day.plannedVersion?.label ?? (day.plannedVersion ? `Versione ${day.plannedVersion.id}` : 'Nessuna versione disponibile')}</strong>.</p>
                {day.plannedVersion?.id !== day.validVersion?.id && (
                  <p>La versione valida per questa data è {day.validVersion?.label ?? (day.validVersion ? `Versione ${day.validVersion.id}` : 'non disponibile')}; il piano mostrato conserva la versione della pianificazione.</p>
                )}
                <p>I pasti già registrati conservano il piano della prima registrazione, anche se la pianificazione cambia.</p>
                <Link to="/dieta">Consulta o cambia la dieta →</Link>
              </div>
            </details>
              <p className="calendar-help calendar-status-help">Non registrato non significa non seguito. Le note si salvano esplicitamente; l’orario del check-in è automatico (Europe/Rome).</p>
            </>
          ) : (
            <div className="calendar-empty">
              <p>Nessun pasto pianificato per questa data. Sono mostrati solo i pasti presenti nel piano.</p>
              <Link to="/dieta">Consulta o attiva una dieta →</Link>
              <Link to="/settimana" search={{ start: weekStart }}>Apri la pianificazione →</Link>
            </div>
          )}
        </>
      ) : !diary.loading && (
        <div className="calendar-empty">
          <p>{diary.online ? 'Giornata non disponibile. Riprova a caricarla.' : 'Questa giornata non è disponibile sul dispositivo. Puoi scegliere un’altra data o tornare a oggi.'}</p>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => {
            if (selectedDate === today) void perform(() => diary.retrySync())
            else onDateChange(null)
          }}>{selectedDate === today ? 'Ricarica oggi' : 'Torna a oggi'}</button>
          <Link to="/dieta">Vai alla dieta →</Link>
        </div>
      )}
    </section>
  )
}

function DiaryMeal({ meal, readOnly, disabled, record }: {
  meal: DiaryDay['meals'][number]
  readOnly: boolean
  disabled: boolean
  record: (followed: boolean, note: string | null) => Promise<void>
}) {
  const { plan, checkIn } = meal
  const mealRef = useRef<HTMLLIElement>(null)
  const label = SLOT_LABELS[plan.slot]
  const status = checkIn === null ? 'Non registrato' : checkIn.followed ? 'Seguito' : 'Non seguito'

  return (
    <li className="calendar-meal" ref={mealRef}>
      <div className="calendar-meal-heading">
        <div>
          <h3>{label}</h3>
          <p className="calendar-meal-state" data-followed={checkIn?.followed}>
            {status}{checkIn?.note && <span className="calendar-note-indicator"> · Nota salvata</span>}
          </p>
        </div>
        {!readOnly && (
          <button type="button" className="secondary-button calendar-quick-follow" aria-label={`${label}: seguito`}
            aria-pressed={checkIn?.followed === true} disabled={disabled} onClick={() => {
              if (confirmDiscardNotes(mealRef.current)) void record(true, checkIn?.note ?? null)
            }}>Seguito</button>
        )}
      </div>
      <div className="calendar-meal-foods">
        {plan.free ? (
          <div className="calendar-free">
            <strong>Pasto libero pianificato</strong>
            <p>{plan.free.description ?? 'Nessuna descrizione indicata.'}</p>
            <p className="calendar-help">Conta come seguito quando lo registri. Nessun alimento o valore nutrizionale aggiunto.</p>
          </div>
        ) : <PlannedMealContent meal={plan} />}
      </div>
      <details className="calendar-meal-details">
        <summary aria-label={`Dettagli di ${label}`}>{readOnly || plan.free ? 'Nota e orario' : 'Nota e non seguito'}</summary>
        <div>
          {checkIn && (
            <p className="calendar-timestamp">Registrato il <time dateTime={new Date(checkIn.recordedAt).toISOString()}>{new Date(checkIn.recordedAt).toLocaleString('it-IT', {
              dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Rome',
            })}</time> · Europe/Rome</p>
          )}
          {readOnly ? (
            <p className="calendar-saved-note"><strong>Nota:</strong> {checkIn?.note ?? 'Nessuna nota salvata.'}</p>
          ) : (
            <MealNoteForm key={JSON.stringify(checkIn)} meal={meal} disabled={disabled} record={record} />
          )}
        </div>
      </details>
    </li>
  )
}

// Reset only the draft when authoritative content changes, including a different
// server note at the same revision. The surrounding <details> stays mounted.
function MealNoteForm({ meal, disabled, record }: {
  meal: DiaryDay['meals'][number]
  disabled: boolean
  record: (followed: boolean, note: string | null) => Promise<void>
}) {
  const { plan, checkIn } = meal
  const [note, setNote] = useState(checkIn?.note ?? '')
  const noteValue = note.trim() || null
  const dirty = noteValue !== (checkIn?.note ?? null)
  const label = SLOT_LABELS[plan.slot]
  const noteId = `calendar-note-${plan.slot}`
  const noteHelpId = `${noteId}-help`

  return (
    <form className="calendar-note-form" data-note-dirty={dirty} onSubmit={(event) => {
      event.preventDefault()
      if (!disabled && dirty) void record(checkIn?.followed ?? true, noteValue)
    }}>
      <label htmlFor={noteId}>Nota facoltativa · {label}</label>
      <textarea id={noteId} value={note} maxLength={CHECK_IN_NOTE_MAX_LENGTH} rows={3} disabled={disabled}
        aria-describedby={noteHelpId} onChange={(event) => setNote(event.currentTarget.value)} />
      <p id={noteHelpId} className="calendar-help">
        {note.length}/{CHECK_IN_NOTE_MAX_LENGTH} caratteri. {dirty ? 'Nota non salvata: usa Salva nota prima di uscire.' : 'Le note non si salvano automaticamente.'}
        {!checkIn && ' Salvando la nota registri anche il pasto come seguito.'}
      </p>
      <div className="calendar-actions">
        <button type="submit" className="secondary-button" disabled={disabled || !dirty}>{checkIn ? 'Salva nota' : 'Salva nota e segna seguito'}</button>
        {!plan.free && (
          <button type="button" className="secondary-button" aria-label={`${label}: non seguito`} aria-pressed={checkIn?.followed === false}
            disabled={disabled} onClick={() => void record(false, noteValue)}>Non seguito</button>
        )}
      </div>
    </form>
  )
}
