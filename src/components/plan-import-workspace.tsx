import { Fragment, useEffect, useState } from 'react'
import type { ChangeEvent, SyntheticEvent } from 'react'
import type { PlanReview } from '../server/plan-import-schema'

const SLOT_LABELS = {
  breakfast: 'Colazione',
  morning_snack: 'Spuntino mattutino',
  lunch: 'Pranzo',
  afternoon_snack: 'Spuntino pomeridiano',
  dinner: 'Cena',
} as const
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
type ImportDetail = ImportSummary & { extraction: PlanReview | null }
type BusyAction = 'upload' | 'extract' | 'activate' | null
type Meal = PlanReview['days'][number]['meals'][number]
type MealComponent = Meal['components'][number]
type Equivalence = PlanReview['equivalences'][number]
type FoodFields = {
  label: string
  quantityText: string | null
  unitText: string | null
  state?: MealComponent['review']['state']
  notes?: string | null
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('Risposta del servizio non leggibile.')
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : 'Operazione non riuscita.'
    throw new Error(message)
  }
  return payload as T
}

function summaryOf({ id, originalName, byteSize, status, createdAt, sourceAvailable }: ImportSummary): ImportSummary {
  return { id, originalName, byteSize, status, createdAt, sourceAvailable }
}

function todayDate(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
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

  useEffect(() => {
    let cancelled = false
    void apiRequest<{ imports: ImportSummary[] }>('/api/imports')
      .then((payload) => {
        if (!cancelled) {
          setImports((current) => {
            const merged = new Map(payload.imports.map((item) => [item.id, item]))
            current.forEach((item) => merged.set(item.id, item))
            return [...merged.values()]
              .sort((left, right) => right.createdAt - left.createdAt)
              .slice(0, 30)
          })
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Impossibile caricare le importazioni.')
      })
    return () => {
      cancelled = true
    }
  }, [])

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

  function closeDetail() {
    setDetail(null)
    setError('')
    setNotice('')
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
      setDetail({ ...extracted, extraction })
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
    setDetail({ ...saved, extraction: null })
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
      setDetail({ ...detail, status: 'activated' })
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
    <section className="plan-import-workspace" aria-labelledby="plan-import-title">
      <div className="workspace-heading">
        <div>
          <span className="eyebrow">Piano alimentare</span>
          <h2 id="plan-import-title">Carica il PDF, leggi il riepilogo.</h2>
          <p>L’AI legge il piano e ti mostra cosa ha trovato per ogni giorno e pasto.</p>
        </div>
        {detail && (
          <button className="secondary-button workspace-nav-button" type="button" onClick={closeDetail} disabled={busy !== null}>
            Carica un altro PDF
          </button>
        )}
      </div>

      {error && <p className="message error-message" role="alert">{error}</p>}
      {notice && <p className="message success-message" role="status">{notice}</p>}

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
              <button type="button" className="text-button" onClick={closeDetail} disabled={busy !== null}>
                Tutti i PDF
              </button>
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

          {detail.extraction && <PlanSummary extraction={detail.extraction} />}

          {detail.status === 'extracted' &&
            (detail.sourceAvailable ? (
              <form className="activation-form import-step-card" onSubmit={activate}>
                <h3>Usa questo piano</h3>
                <p>Diventa il piano attivo dalla data che scegli.</p>
                <label htmlFor="import-valid-from">Attivo dal</label>
                <input
                  id="import-valid-from"
                  type="date"
                  required
                  value={validFrom}
                  onChange={(event) => setValidFrom(event.currentTarget.value)}
                  disabled={busy !== null}
                />
                <button className="primary-button" type="submit" disabled={busy !== null || !validFrom}>
                  {busy === 'activate' ? 'Attivazione…' : 'Attiva il piano'}
                </button>
              </form>
            ) : (
              <section className="import-step-card" role="status">
                <h3>Attivazione sospesa</h3>
                <p>Il PDF originale non è disponibile: ripristinalo per attivare il piano.</p>
              </section>
            ))}

          {detail.status === 'activated' && (
            <section className="completed-card">
              <h3>Piano attivato</h3>
              <p>Questo piano è già in uso dalla data scelta.</p>
            </section>
          )}
        </div>
      ) : openingId ? (
        <p className="loading-inline" role="status">Apertura del PDF…</p>
      ) : (
        <div className="import-start-grid">
          <form className="import-upload-card" onSubmit={uploadAndAnalyze}>
            <h3>Nuovo piano</h3>
            <label htmlFor="plan-pdf-file">File PDF</label>
            <input
              id="plan-pdf-file"
              type="file"
              accept="application/pdf,.pdf"
              onChange={handleFileChange}
              disabled={busy !== null}
            />
            {selectedFile && <p className="field-hint">{selectedFile.name} · {formatBytes(selectedFile.size)}</p>}
            <button className="primary-button" type="submit" disabled={busy !== null || !selectedFile}>
              {busy === 'upload' ? 'Caricamento…' : 'Carica e analizza'}
            </button>
            <p className="privacy-note">
              Il PDF resta salvato in privato e viene inviato all’AI tramite OpenRouter, solo a fornitori che non conservano i dati, per leggere il piano. Massimo 15 MB.
            </p>
          </form>

          <section className="import-history-card" aria-labelledby="import-history-title">
            <h3 id="import-history-title">PDF caricati</h3>
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
                      disabled={busy !== null}
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
          </section>
        </div>
      )}
    </section>
  )
}

function PlanSummary({ extraction }: { extraction: PlanReview }) {
  const days = [...extraction.days].sort((left, right) => left.dayIndex - right.dayIndex)
  const equivalences = extraction.equivalences.filter((equivalence) => !equivalence.removed)
  const foodCount = days.reduce(
    (total, day) =>
      total + day.meals.reduce((sum, meal) => sum + meal.components.filter((component) => !component.removed).length, 0),
    0,
  )
  return (
    <section className="plan-summary" aria-labelledby="plan-summary-title">
      <h3 id="plan-summary-title">Cosa ha letto l’AI</h3>
      <p className="plan-summary-counts">
        {days.length} giorni · {foodCount} alimenti
        {equivalences.length > 0 ? ` · ${equivalences.length} equivalenze` : ''}
      </p>
      <WarningList warnings={extraction.warnings} />
      {days.map((day) => {
        const meals = [...day.meals].sort((left, right) => SLOT_ORDER.indexOf(left.slot) - SLOT_ORDER.indexOf(right.slot))
        const warningCount = meals.reduce((total, meal) => total + mealWarnings(meal).length, 0)
        return (
          <details className="summary-day" key={day.dayIndex} open={day.dayIndex === 0}>
            <summary>
              {DAY_LABELS[day.dayIndex]}
              {warningCount > 0 && (
                <span className="summary-day-warnings">{warningCount === 1 ? '1 avviso' : `${warningCount} avvisi`}</span>
              )}
            </summary>
            <div className="summary-meals">
              {meals.map((meal) => <MealSummary key={meal.slot} meal={meal} />)}
            </div>
          </details>
        )
      })}
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
      ...meal.components.flatMap((component) => (component.removed ? [] : component.source?.warnings ?? [])),
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
  return (
    <div className="summary-meal">
      <h4>{SLOT_LABELS[meal.slot]}</h4>
      {components.length === 0 ? (
        <p className="summary-missing">Nessun alimento letto.</p>
      ) : (
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
      )}
      {meal.review.notes && <p className="summary-note">{meal.review.notes}</p>}
      <WarningList warnings={mealWarnings(meal)} />
    </div>
  )
}

function FoodText({ food }: { food: FoodFields }) {
  const amount = [food.quantityText?.trim(), food.unitText?.trim()].filter(Boolean).join(' ')
  return (
    <span>
      {food.label}
      {amount ? (
        <span className="summary-amount"> {amount}</span>
      ) : (
        <span className="summary-missing"> · quantità non indicata</span>
      )}
      {food.state === 'raw' && <span className="summary-state"> a crudo</span>}
      {food.state === 'cooked' && <span className="summary-state"> a cotto</span>}
      {food.notes && <span className="summary-note"> ({food.notes})</span>}
    </span>
  )
}

// Mirrors activation: an equivalence is applied only when its day, meal, and optional food resolve.
function equivalenceScope(equivalence: Equivalence, extraction: PlanReview): { label: string; resolved: boolean } {
  const { dayIndex, slot, componentIndex } = equivalence.review.scope
  if (dayIndex === null || slot === null) return { label: 'Ambito non chiaro', resolved: false }
  const mealLabel = `${DAY_LABELS[dayIndex]} · ${SLOT_LABELS[slot]}`
  const meal = extraction.days
    .find((day) => day.dayIndex === dayIndex)
    ?.meals.find((candidate) => candidate.slot === slot)
  if (!meal) return { label: mealLabel, resolved: false }
  if (componentIndex === null) return { label: mealLabel, resolved: true }
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
