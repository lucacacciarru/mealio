import { Fragment, useEffect, useState } from 'react'
import type { ChangeEvent, SyntheticEvent } from 'react'
import { Link } from '@tanstack/react-router'
import './plan-import-workspace.css'
import type { PlanReview } from '../server/plan-import-schema'
import { apiRequest } from './api'
import { FoodText, SLOT_LABELS } from './plan-text'

const DAY_LABELS = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'] as const
const SLOT_ORDER = ['breakfast', 'morning_snack', 'lunch', 'afternoon_snack', 'dinner'] as const
const MAX_FILE_BYTES = 15 * 1024 * 1024

type ImportStatus = 'uploaded' | 'extracted' | 'activated'
type ImportSummary = {
  id: string
  originalName: string
  byteSize: number
  status: ImportStatus
  createdAt: number
  sourceAvailable: boolean
}
type ImportDetail = ImportSummary & { extraction: PlanReview | null; validFrom: string | null }
type BusyAction = 'upload' | 'extract' | 'activate' | null
type Meal = PlanReview['days'][number]['meals'][number]
type MealComponent = Meal['components'][number]
type Equivalence = PlanReview['equivalences'][number]

function summaryOf({ id, originalName, byteSize, status, createdAt, sourceAvailable }: ImportSummary): ImportSummary {
  return { id, originalName, byteSize, status, createdAt, sourceAvailable }
}

function todayDate(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function planningWeek(validFrom: string | null): string {
  const today = todayDate()
  const date = new Date(`${validFrom && validFrom > today ? validFrom : today}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7)
  return date.toISOString().slice(0, 10)
}

function formatDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })
}

function isAcceptedPdf(file: File): boolean {
  return file.name.toLowerCase().endsWith('.pdf') && file.size <= MAX_FILE_BYTES
}

export function PlanImportWorkspace() {
  const [detail, setDetail] = useState<ImportDetail | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [validFrom, setValidFrom] = useState(todayDate)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loadRevision, setLoadRevision] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void apiRequest<{ imports: ImportSummary[] }>('/api/imports')
      .then(async (payload) => {
        if (cancelled) return
        const recent = [...payload.imports].sort((left, right) => right.createdAt - left.createdAt)
        const latest = recent.find((item) => item.sourceAvailable && item.status !== 'uploaded')
          ?? recent[0]
        if (latest) {
          const saved = await apiRequest<ImportDetail>(`/api/imports?id=${encodeURIComponent(latest.id)}`)
          if (!cancelled) setDetail(saved)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Impossibile caricare le importazioni.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loadRevision])

  async function analyze(target: ImportSummary) {
    setError('')
    setNotice('')
    setBusy('extract')
    try {
      const { extraction } = await apiRequest<{ extraction: PlanReview }>('/api/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'extract', id: target.id, confirmed: true }),
      })
      const extracted = { ...summaryOf(target), status: 'extracted' as const }
      setDetail({ ...extracted, extraction, validFrom: null })
      setNotice('Analisi completata.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Analisi non riuscita.')
    } finally {
      setBusy(null)
    }
  }

  async function uploadAndAnalyze(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedFile || busy !== null) return
    setError('')
    setNotice('')
    if (!isAcceptedPdf(selectedFile)) {
      setError('Scegli un file PDF non superiore a 15 MB.')
      return
    }
    const form = event.currentTarget
    setBusy('upload')
    let saved: ImportSummary
    try {
      saved = await apiRequest<ImportSummary>('/api/imports', {
        method: 'POST',
        headers: {
          'content-type': 'application/pdf',
          'x-file-name': encodeURIComponent(selectedFile.name),
        },
        body: selectedFile,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Caricamento del PDF non riuscito.')
      setBusy(null)
      return
    }
    form.reset()
    setSelectedFile(null)
    setDetail({ ...saved, extraction: null, validFrom: null })
    setValidFrom(todayDate())
    await analyze(saved)
  }

  async function activate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!detail || busy !== null) return
    setError('')
    setNotice('')
    setBusy('activate')
    try {
      const result = await apiRequest<{ versionId: number; validFrom: string }>('/api/imports', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'activate', id: detail.id, validFrom }),
      })
      setDetail({ ...detail, status: 'activated', validFrom: result.validFrom })
      setNotice(`Piano attivo dal ${formatDate(result.validFrom)}.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Attivazione non riuscita.')
    } finally {
      setBusy(null)
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setError('')
    const file = event.currentTarget.files?.[0] ?? null
    if (file && !isAcceptedPdf(file)) {
      setSelectedFile(null)
      setError('Scegli un file PDF non superiore a 15 MB.')
      return
    }
    setSelectedFile(file)
  }

  const locked = busy !== null || loading
  const uploadForm = (
    <form className="diet-upload" onSubmit={uploadAndAnalyze}>
      <label htmlFor="plan-pdf-file">PDF della dieta (massimo 15 MB)</label>
      <input id="plan-pdf-file" type="file" accept="application/pdf,.pdf" onChange={handleFileChange} disabled={locked} />
      <button className="primary-button" type="submit" disabled={locked || !selectedFile}>
        {busy === 'upload' ? 'Caricamento…' : 'Carica e analizza'}
      </button>
      <p className="diet-privacy">
        Il PDF resta privato e viene inviato a un modello AI tramite OpenRouter per leggere i pasti.
      </p>
    </form>
  )

  return (
    <section className="plan-import-workspace" aria-label="La tua dieta">
      {error && (
        <div className="diet-alert" role="alert">
          <p>{error}</p>
          <button className="text-button" type="button" disabled={busy !== null} onClick={() => setLoadRevision((revision) => revision + 1)}>Riprova</button>
        </div>
      )}
      {notice && <p className="diet-notice" role="status">{notice}</p>}

      {loading && !detail && <p className="loading-inline" role="status">Caricamento…</p>}

      {!loading && !detail && (
        <section className="diet-card">
          <h2>Carica la dieta del tuo professionista</h2>
          <p>Mealio legge i pasti dal PDF. Poi scegli cosa mangiare ogni settimana e ottieni la lista della spesa.</p>
          {uploadForm}
        </section>
      )}

      {detail && (
        <>
          <section className="diet-card">
            {busy === 'extract' ? (
              <div role="status">
                <h2>Sto leggendo il PDF…</h2>
                <p>Può volerci qualche minuto. Lascia aperta la pagina.</p>
              </div>
            ) : detail.status === 'activated' ? (
              <>
                <span className="eyebrow">Dieta attiva</span>
                <h2>{detail.validFrom ? `Dal ${formatDate(detail.validFrom)}` : 'Attiva'}</h2>
                <Link className="primary-button" to="/settimana" search={{ start: planningWeek(detail.validFrom), date: undefined }}>Scegli i pasti della settimana</Link>
              </>
            ) : detail.status === 'extracted' ? (
              detail.sourceAvailable ? (
                <form className="diet-activate" onSubmit={activate}>
                  <span className="eyebrow">Da attivare</span>
                  <h2>Controlla i pasti letti, poi attiva la dieta</h2>
                  <label htmlFor="import-valid-from">La seguo dal</label>
                  <input
                    id="import-valid-from"
                    type="date"
                    required
                    value={validFrom}
                    onChange={(event) => setValidFrom(event.currentTarget.value)}
                    disabled={locked}
                  />
                  <button className="primary-button" type="submit" disabled={locked || !validFrom}>
                    {busy === 'activate' ? 'Attivazione…' : 'Usa questa dieta'}
                  </button>
                </form>
              ) : (
                <p>Il PDF originale non è più disponibile: caricalo di nuovo per attivare la dieta.</p>
              )
            ) : detail.sourceAvailable ? (
              <>
                <h2>Lettura del PDF non riuscita</h2>
                <button className="primary-button" type="button" onClick={() => void analyze(detail)} disabled={busy !== null}>
                  Riprova
                </button>
              </>
            ) : (
              <p>Il PDF originale non è più disponibile: caricalo di nuovo.</p>
            )}
            <p className="diet-file">
              {detail.originalName}
              {detail.sourceAvailable && (
                <>
                  {' · '}
                  <a href={`/api/imports?id=${encodeURIComponent(detail.id)}&file=1`} target="_blank" rel="noreferrer">Apri il PDF</a>
                </>
              )}
            </p>
          </section>

          {detail.extraction && (
            <details className="diet-meals" open={detail.status === 'extracted'}>
              <summary>Vedi i pasti della dieta</summary>
              <PlanSummary key={detail.id} extraction={detail.extraction} />
            </details>
          )}

          <details className="diet-meals">
            <summary>Carica una nuova dieta</summary>
            {uploadForm}
          </details>
        </>
      )}
    </section>
  )
}

function PlanSummary({ extraction }: { extraction: PlanReview }) {
  const days = [...extraction.days].sort((left, right) => left.dayIndex - right.dayIndex)
  const [selectedDay, setSelectedDay] = useState(days[0]?.dayIndex ?? 0)
  const equivalences = extraction.equivalences.filter((equivalence) => !equivalence.removed)
  return (
    <section className="plan-summary" aria-labelledby="plan-summary-title">
      <h3 className="visually-hidden" id="plan-summary-title">Pasti della dieta</h3>
      <WarningList warnings={extraction.warnings} />
      <div className="diet-day-picker" role="group" aria-label="Giorno della dieta">
        {days.map((day) => {
          const warnings = day.meals.reduce((total, meal) => total + mealWarnings(meal).length, 0)
          return (
            <button type="button" key={day.dayIndex} aria-pressed={selectedDay === day.dayIndex} onClick={() => setSelectedDay(day.dayIndex)}>
              {DAY_LABELS[day.dayIndex].slice(0, 3)}{warnings > 0 ? ' ⚠' : ''}
            </button>
          )
        })}
      </div>
      {days.filter((day) => day.dayIndex === selectedDay).map((day) => (
        <section className="diet-selected-day" key={day.dayIndex} aria-label={DAY_LABELS[day.dayIndex]}>
          <h4>{DAY_LABELS[day.dayIndex]}</h4>
          <div className="summary-meals">
            {[...day.meals].sort((left, right) => SLOT_ORDER.indexOf(left.slot) - SLOT_ORDER.indexOf(right.slot)).map((meal) => <MealSummary key={meal.slot} meal={meal} />)}
          </div>
        </section>
      ))}
      {equivalences.length > 0 && (
        <details className="summary-day">
          <summary>Equivalenze ({equivalences.length})</summary>
          <ul className="summary-equivalences">
            {equivalences.map((equivalence, index) => (
              <EquivalenceSummary key={index} equivalence={equivalence} extraction={extraction} />
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function mealWarnings(meal: Meal): string[] {
  return [
    ...new Set([
      ...meal.source.warnings,
      ...meal.components.flatMap((component) =>
        component.removed
          ? []
          : [
              ...(component.source?.warnings ?? []),
              ...(component.review.state === 'unspecified'
                ? [`Stato crudo o cotto non specificato per ${component.review.label}.`]
                : []),
            ],
      ),
    ]),
  ]
}

// Components that share an explicit alternative group are printed as one "A oppure B" row.
function alternativeRows(components: MealComponent[]): MealComponent[][] {
  const rows: MealComponent[][] = []
  const rowByGroup = new Map<string, MealComponent[]>()
  for (const component of components) {
    const group = component.review.alternativeGroup?.trim()
    const existing = group ? rowByGroup.get(group) : undefined
    if (existing) {
      existing.push(component)
      continue
    }
    const row = [component]
    rows.push(row)
    if (group) rowByGroup.set(group, row)
  }
  return rows
}

function MealSummary({ meal }: { meal: Meal }) {
  const components = meal.components.filter((component) => !component.removed)
  // As in the planner, a meal offers a choice only with two or more combinations; foods
  // without a combination belong to all of them.
  const labels = [
    ...new Set(
      components
        .map((component) => component.review.combination)
        .filter((combination): combination is string => combination !== null),
    ),
  ]
  const combinations = labels.length > 1 ? labels : []
  const shared =
    combinations.length > 0 ? components.filter((component) => component.review.combination === null) : components
  return (
    <div className="summary-meal">
      <h4>{SLOT_LABELS[meal.slot]}</h4>
      {components.length === 0 ? (
        <p className="summary-missing">Nessun alimento letto.</p>
      ) : (
        <>
          {shared.length > 0 && combinations.length > 0 && <p className="summary-note">In tutte le varianti:</p>}
          {shared.length > 0 && <FoodRows components={shared} />}
          {combinations.length > 0 && (
            <>
              <p className="summary-note">{combinations.length} varianti consentite:</p>
              <ol className="summary-combinations">
                {combinations.map((combination) => (
                  <li key={combination}>
                    <strong>{combination}</strong>
                    <FoodRows
                      components={components.filter((component) => component.review.combination === combination)}
                    />
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
      {meal.review.notes && <p className="summary-note">{meal.review.notes}</p>}
      <WarningList warnings={mealWarnings(meal)} />
    </div>
  )
}

function FoodRows({ components }: { components: MealComponent[] }) {
  return (
    <ul className="summary-foods">
      {alternativeRows(components).map((row, rowIndex) => (
        <li key={rowIndex}>
          {row.map((component, index) => (
            <Fragment key={index}>
              {index > 0 && <span className="summary-or"> oppure </span>}
              <FoodText food={component.review} />
            </Fragment>
          ))}
        </li>
      ))}
    </ul>
  )
}

// Mirrors activation: unresolved scopes stay visible; only explicit meal/component scopes apply.
function equivalenceScope(equivalence: Equivalence, extraction: PlanReview): { label: string; resolved: boolean } {
  const { kind, dayIndex, slot, componentIndex } = equivalence.review.scope
  if (dayIndex === null || slot === null) return { label: 'Ambito non chiaro', resolved: false }
  const mealLabel = `${DAY_LABELS[dayIndex]} · ${SLOT_LABELS[slot]}`
  if (kind === 'unresolved') return { label: `${mealLabel} · ambito non chiaro`, resolved: false }
  const meal = extraction.days
    .find((day) => day.dayIndex === dayIndex)
    ?.meals.find((candidate) => candidate.slot === slot)
  if (!meal) return { label: mealLabel, resolved: false }
  if (kind === 'meal') return { label: `${mealLabel} · pasto intero`, resolved: true }
  if (componentIndex === null) return { label: `${mealLabel} · alimento non determinato`, resolved: false }
  const component = meal.components[componentIndex]
  if (!component || component.removed) return { label: `${mealLabel} · alimento non trovato`, resolved: false }
  return { label: `${mealLabel} · ${component.review.label}`, resolved: true }
}

function EquivalenceSummary({ equivalence, extraction }: { equivalence: Equivalence; extraction: PlanReview }) {
  const items = equivalence.review.items.filter((item) => !item.removed)
  const scope = equivalenceScope(equivalence, extraction)
  const warnings = [
    ...(equivalence.source?.warnings ?? []),
    ...items.flatMap((item) => item.source?.warnings ?? []),
  ]
  return (
    <li className="summary-equivalence">
      <strong>{scope.label}</strong>
      {(!scope.resolved || items.length === 0) && <span className="summary-missing"> · non verrà applicata</span>}
      {items.length > 0 && (
        <p>
          {items.map((item, index) => (
            <Fragment key={index}>
              {index > 0 && <span className="summary-or"> oppure </span>}
              <FoodText food={item.review} />
            </Fragment>
          ))}
        </p>
      )}
      {equivalence.review.note && <p className="summary-note">{equivalence.review.note}</p>}
      <WarningList warnings={warnings} />
    </li>
  )
}

function WarningList({ warnings }: { warnings: string[] }) {
  const uniqueWarnings = [...new Set(warnings)]
  if (uniqueWarnings.length === 0) return null
  return (
    <ul className="summary-warnings" aria-label="Avvisi">
      {uniqueWarnings.map((warning) => <li key={warning}>{warning}</li>)}
    </ul>
  )
}
