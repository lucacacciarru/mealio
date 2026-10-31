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

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })
}

function isAcceptedPdf(file: File): boolean {
  return file.name.toLowerCase().endsWith('.pdf') && file.size <= MAX_FILE_BYTES
}

function statusLabel(status: ImportStatus): string {
  if (status === 'uploaded') return 'Da analizzare'
  if (status === 'extracted') return 'Da attivare'
  return 'Attivato'
}

export function PlanImportWorkspace() {
  const [imports, setImports] = useState<ImportSummary[]>([])
  const [detail, setDetail] = useState<ImportDetail | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
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
        setImports(recent)
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

  function upsertImport(item: ImportSummary) {
    const summary = summaryOf(item)
    setImports((current) =>
      current.some((existing) => existing.id === summary.id)
        ? current.map((existing) => (existing.id === summary.id ? summary : existing))
        : [summary, ...current].slice(0, 30),
    )
  }

  async function openImport(id: string) {
    setError('')
    setNotice('')
    setOpeningId(id)
    try {
      setDetail(await apiRequest<ImportDetail>(`/api/imports?id=${encodeURIComponent(id)}`))
      setValidFrom(todayDate())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Impossibile aprire l’importazione.')
    } finally {
      setOpeningId(null)
    }
  }


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
      upsertImport(extracted)
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
    upsertImport(saved)
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
      upsertImport({ ...detail, status: 'activated' })
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

  return (
    <section className="plan-import-workspace" aria-label="Pasti della dieta">

      {error && (
        <div role="alert">
          <p className="message error-message">{error}</p>
          <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => setLoadRevision((revision) => revision + 1)}>Riprova caricamento</button>
        </div>
      )}
      {notice && <p className="message success-message" role="status">{notice}</p>}
      {detail && openingId && <p className="loading-inline" role="status">Apertura del PDF…</p>}

      {detail ? (
        <div className="import-detail-stack">
          <div className="import-session-heading">
            <div>
              <h3>{detail.originalName}</h3>
              <p>{formatBytes(detail.byteSize)} · {statusLabel(detail.status)}</p>
            </div>
            <div className="import-session-links">
              {detail.sourceAvailable && (
                <a
                  className="text-button"
                  href={`/api/imports?id=${encodeURIComponent(detail.id)}&file=1`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Apri il PDF
                </a>
              )}
              <a className="text-button" href="#diet-other-pdfs">Altri PDF</a>
            </div>
          </div>

          {busy === 'extract' ? (
            <section className="import-step-card" role="status">
              <h3>Analisi in corso…</h3>
              <p>L’AI sta leggendo il PDF: può volerci qualche minuto. Lascia aperta la pagina.</p>
            </section>
          ) : detail.status === 'uploaded' ? (
            <section className="import-step-card">
              <h3>Analisi non completata</h3>
              {detail.sourceAvailable ? (
                <>
                  <p>Il PDF è salvato. Riprova: verrà inviato di nuovo all’AI tramite OpenRouter.</p>
                  <button className="primary-button" type="button" onClick={() => void analyze(detail)} disabled={busy !== null}>
                    Analizza di nuovo
                  </button>
                </>
              ) : (
                <p>Il PDF originale non è più disponibile: caricalo di nuovo.</p>
              )}
            </section>
          ) : null}

          {detail.status === 'activated' && (
            <section className="completed-card">
              <h3>Dieta già attivata</h3>
              <p>Puoi organizzare i pasti e le varianti settimana per settimana. Le settimane già salvate restano invariate.</p>
              <Link className="primary-button" to="/settimana" search={{ start: planningWeek(detail.validFrom) }}>Pianifica la settimana</Link>
            </section>
          )}
          {detail.status === 'extracted' &&
            (detail.sourceAvailable ? (
              <form className="activation-form import-step-card" onSubmit={activate}>
                <h3>Usa questa dieta</h3>
                <p>Scegli da quando seguirla. L’analisi da sola non attiva la dieta; le settimane già salvate restano invariate.</p>
                <label htmlFor="import-valid-from">Attivo dal</label>
                <input
                  id="import-valid-from"
                  type="date"
                  required
                  value={validFrom}
                  onChange={(event) => setValidFrom(event.currentTarget.value)}
                  disabled={busy !== null || openingId !== null}
                />
                <button className="primary-button" type="submit" disabled={busy !== null || openingId !== null || !validFrom}>
                  {busy === 'activate' ? 'Attivazione…' : 'Usa questa dieta'}
                </button>
              </form>
            ) : (
              <section className="import-step-card" role="status">
                <h3>Attivazione sospesa</h3>
                <p>Il PDF originale non è disponibile: ripristinalo per attivare il piano.</p>
              </section>
            ))}

          {detail.extraction && <PlanSummary key={detail.id} extraction={detail.extraction} />}
        </div>
      ) : loading || openingId ? (
        <p className="loading-inline" role="status">Caricamento della dieta…</p>
      ) : null}
      <div className="diet-secondary" id="diet-other-pdfs">
          <details className="diet-upload-details" open={!loading && !detail && imports.length === 0}>
            <summary>{detail ? 'Carica un altro PDF' : 'Carica il PDF della dieta'}</summary>
          <form className="import-upload-card" onSubmit={uploadAndAnalyze}>
            <h3>Il PDF del professionista</h3>
            <label htmlFor="plan-pdf-file">File PDF</label>
            <input
              id="plan-pdf-file"
              type="file"
              accept="application/pdf,.pdf"
              onChange={handleFileChange}
              disabled={busy !== null || loading || openingId !== null}
            />
            {selectedFile && <p className="field-hint">{selectedFile.name} · {formatBytes(selectedFile.size)}</p>}
            <button className="primary-button" type="submit" disabled={busy !== null || loading || openingId !== null || !selectedFile}>
              {busy === 'upload' ? 'Caricamento…' : 'Carica e analizza'}
            </button>
            <p className="privacy-note">
              Premendo “Carica e analizza” acconsenti a inviare il PDF a un modello AI tramite OpenRouter. Il documento viene conservato in privato. Solo PDF, massimo 15 MB.
            </p>
            <details className="diet-technical-details">
              <summary>Dettagli sul trattamento AI</summary>
              <p>La richiesta usa solo endpoint a conservazione zero (ZDR) e il parser PDF nativo. Le impostazioni Plugin dell’account OpenRouter devono lasciare <code>file-parser</code> non forzato o impostarlo su <code>native</code>: ZDR non copre i backend dei plugin.</p>
            </details>
          </form>
          </details>

          <details className="import-history-card">
            <summary>PDF caricati ({imports.length})</summary>
            {imports.length === 0 ? (
              <p className="empty-state">Non hai ancora caricato PDF.</p>
            ) : (
              <ul className="import-history-list">
                {imports.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="import-history-item"
                      onClick={() => void openImport(item.id)}
                      disabled={busy !== null || loading || openingId !== null}
                    >
                      <span>
                        <strong>{item.originalName}</strong>
                        <small>{new Date(item.createdAt).toLocaleString('it-IT')} · {formatBytes(item.byteSize)}</small>
                      </span>
                      <span className={`status-pill status-${item.status}`}>
                        {item.sourceAvailable ? statusLabel(item.status) : 'PDF non disponibile'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </div>
    </section>
  )
}

function PlanSummary({ extraction }: { extraction: PlanReview }) {
  const days = [...extraction.days].sort((left, right) => left.dayIndex - right.dayIndex)
  const [selectedDay, setSelectedDay] = useState(days[0]?.dayIndex ?? 0)
  const equivalences = extraction.equivalences.filter((equivalence) => !equivalence.removed)
  const foodCount = days.reduce(
    (total, day) =>
      total + day.meals.reduce((sum, meal) => sum + meal.components.filter((component) => !component.removed).length, 0),
    0,
  )
  return (
    <section className="plan-summary" aria-labelledby="plan-summary-title">
      <h3 id="plan-summary-title">Pasti e varianti dal PDF</h3>
      <p className="plan-summary-counts">
        {days.length} giorni · {foodCount} alimenti
        {equivalences.length > 0 ? ` · ${equivalences.length} equivalenze` : ''}
      </p>
      <p className="summary-note">Riepilogo di sola lettura: Mealio non aggiunge alimenti, quantità o varianti. Controlla gli avvisi e confronta il PDF originale.</p>
      <WarningList warnings={extraction.warnings} />
      <div className="diet-day-picker" role="group" aria-label="Giorno della dieta">
        {days.map((day) => {
          const warnings = day.meals.reduce((total, meal) => total + mealWarnings(meal).length, 0)
          return (
            <button className="secondary-button" type="button" key={day.dayIndex} aria-pressed={selectedDay === day.dayIndex} onClick={() => setSelectedDay(day.dayIndex)}>
              {DAY_LABELS[day.dayIndex]}{warnings > 0 ? ` · ${warnings} avvisi` : ''}
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
          <summary>Equivalenze</summary>
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
      <details className="diet-provenance">
        <summary>Riferimenti al PDF</summary>
        {meal.source.page !== null && <p>Pagina {meal.source.page}</p>}
        {meal.source.quote && <blockquote>{meal.source.quote}</blockquote>}
        {components.map((component, index) => (
          <div key={index}>
            <strong>{component.review.label}</strong>
            {component.source?.page != null && <span> · pagina {component.source.page}</span>}
            {component.source?.quote && <blockquote>{component.source.quote}</blockquote>}
            {component.review.notes && <p>{component.review.notes}</p>}
          </div>
        ))}
      </details>
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
      <details className="diet-provenance">
        <summary>Riferimenti al PDF</summary>
        {equivalence.source?.page != null && <p>Pagina {equivalence.source.page}</p>}
        {equivalence.source?.quote && <blockquote>{equivalence.source.quote}</blockquote>}
        {items.map((item, index) => (
          <div key={index}>
            <strong>{item.review.label}</strong>
            {item.source?.page != null && <span> · pagina {item.source.page}</span>}
            {item.source?.quote && <blockquote>{item.source.quote}</blockquote>}
          </div>
        ))}
      </details>
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
