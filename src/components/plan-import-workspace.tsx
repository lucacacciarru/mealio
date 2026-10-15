import { useEffect, useState } from 'react'
import type { ChangeEvent, SyntheticEvent } from 'react'
import type { PlanReview, PlanReviewComponent } from '../server/plan-import-schema'

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
type CatalogFood = {
  id: number
  canonicalName: string
  aliases: string[]
}
type CatalogUnit = { id: number; symbol: string; name: string | null }
type ImportDetail = ImportSummary & {
  authorizedAt: number | null
  extraction: PlanReview | null
  catalog: CatalogFood[]
  units: CatalogUnit[]
}
type BusyAction = 'upload' | 'extract' | 'activate' | null

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

function reviewComponentCanBeConfirmed(component: PlanReviewComponent): boolean {
  return (
    component.removed ||
    (component.review.label.trim().length > 0 &&
      component.review.page !== null &&
      Boolean(component.review.quote?.trim()))
  )
}

function reviewMealCanBeConfirmed(meal: PlanReview['days'][number]['meals'][number]): boolean {
  return (
    meal.review.page !== null &&
    Boolean(meal.review.quote?.trim()) &&
    meal.components.every(reviewComponentCanBeConfirmed)
  )
}

function reviewEquivalenceCanBeConfirmed(
  equivalence: PlanReview['equivalences'][number],
  review: PlanReview,
): boolean {
  if (equivalence.removed) return true
  const { dayIndex, slot, componentIndex } = equivalence.review.scope
  const day = review.days.find((item) => item.dayIndex === dayIndex)
  const meal = day?.meals.find((item) => item.slot === slot)
  const targetValid =
    Boolean(meal) &&
    (componentIndex === null || Boolean(meal?.components[componentIndex] && !meal.components[componentIndex].removed))
  const activeItems = equivalence.review.items.filter((item) => !item.removed)
  return (
    targetValid &&
    equivalence.review.page !== null &&
    Boolean(equivalence.review.quote?.trim()) &&
    activeItems.length > 0 &&
    activeItems.every(
      (item) => item.review.label.trim().length > 0 && item.review.page !== null && Boolean(item.review.quote?.trim()),
    )
  )
}
function findCatalogUnit(text: string | null, units: CatalogUnit[]): CatalogUnit | undefined {
  const normalized = text?.trim().toLocaleLowerCase('it')
  if (!normalized) return undefined
  return units.find((unit) =>
    [unit.symbol, unit.name].some((value) => value?.trim().toLocaleLowerCase('it') === normalized),
  )
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function PlanImportWorkspace() {
  const [imports, setImports] = useState<ImportSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ImportDetail | null>(null)
  const [extraction, setExtraction] = useState<PlanReview | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [planLabel, setPlanLabel] = useState('')
  const [validFrom, setValidFrom] = useState('')
  const [sendConsent, setSendConsent] = useState(false)
  const [finalConsent, setFinalConsent] = useState(false)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
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

  useEffect(() => {
    if (!activeId) {
      setDetail(null)
      setExtraction(null)
      setPlanLabel('')
      setSendConsent(false)
      setFinalConsent(false)
      return
    }
    let cancelled = false
    setLoadingDetail(true)
    setError('')
    void apiRequest<ImportDetail>(`/api/imports?id=${encodeURIComponent(activeId)}`)
      .then((payload) => {
        if (cancelled) return
        setDetail(payload)
        setExtraction(payload.extraction)
        setPlanLabel(payload.originalName.replace(/\.pdf$/i, ''))
        setSendConsent(false)
        setFinalConsent(false)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Impossibile aprire l’importazione.')
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeId])

  function updateMeal(
    dayIndex: number,
    slot: PlanReview['days'][number]['meals'][number]['slot'],
    update: (meal: PlanReview['days'][number]['meals'][number]) => PlanReview['days'][number]['meals'][number],
  ) {
    setExtraction((current) => {
      if (!current) return current
      return {
        ...current,
        days: current.days.map((day) =>
          day.dayIndex === dayIndex
            ? {
                ...day,
                meals: day.meals.map((meal) =>
                  meal.slot === slot ? { ...update(meal), reviewed: false } : meal,
                ),
              }
            : day,
        ),
      }
    })
  }

  function setMealReviewed(
    dayIndex: number,
    slot: PlanReview['days'][number]['meals'][number]['slot'],
    reviewed: boolean,
  ) {
    setExtraction((current) => {
      if (!current) return current
      return {
        ...current,
        days: current.days.map((day) =>
          day.dayIndex === dayIndex
            ? { ...day, meals: day.meals.map((meal) => meal.slot === slot ? { ...meal, reviewed } : meal) }
            : day,
        ),
      }
    })
  }

  function updateComponent(
    dayIndex: number,
    slot: PlanReview['days'][number]['meals'][number]['slot'],
    componentIndex: number,
    changes: Partial<PlanReviewComponent['review']>,
    removed?: boolean,
  ) {
    updateMeal(dayIndex, slot, (meal) => ({
      ...meal,
      components: meal.components.map((component, index) =>
        index === componentIndex
          ? {
              ...component,
              review: { ...component.review, ...changes },
              removed: removed ?? component.removed,
            }
          : component,
      ),
    }))
  }

  function addComponent(dayIndex: number, slot: PlanReview['days'][number]['meals'][number]['slot']) {
    updateMeal(dayIndex, slot, (meal) => ({
      ...meal,
      components: [
        ...meal.components,
        {
          source: null,
          review: {
            label: '',
            quantityText: null,
            unitText: null,
            state: 'unspecified',
            alternativeGroup: null,
            page: null,
            quote: null,
            notes: null,
            foodId: null,
          },
          removed: false,
        },
      ],
    }))
  }

  function updateEquivalence(
    equivalenceIndex: number,
    update: (equivalence: PlanReview['equivalences'][number]) => PlanReview['equivalences'][number],
  ) {
    setExtraction((current) => {
      if (!current) return current
      return {
        ...current,
        equivalences: current.equivalences.map((equivalence, index) =>
          index === equivalenceIndex ? { ...update(equivalence), reviewed: false } : equivalence,
        ),
      }
    })
  }

  function setEquivalenceReviewed(equivalenceIndex: number, reviewed: boolean) {
    setExtraction((current) => {
      if (!current) return current
      return {
        ...current,
        equivalences: current.equivalences.map((equivalence, index) =>
          index === equivalenceIndex ? { ...equivalence, reviewed } : equivalence,
        ),
      }
    })
  }

  function updateEquivalenceItem(
    equivalenceIndex: number,
    itemIndex: number,
    changes: Partial<PlanReview['equivalences'][number]['review']['items'][number]['review']>,
    removed?: boolean,
  ) {
    updateEquivalence(equivalenceIndex, (equivalence) => ({
      ...equivalence,
      review: {
        ...equivalence.review,
        items: equivalence.review.items.map((item, index) =>
          index === itemIndex
            ? { ...item, review: { ...item.review, ...changes }, removed: removed ?? item.removed }
            : item,
        ),
      },
    }))
  }

  function addEquivalence() {
    setExtraction((current) => {
      if (!current || current.equivalences.length >= 100) return current
      return {
        ...current,
        equivalences: [
          ...current.equivalences,
          {
            source: null,
            review: {
              scope: { dayIndex: null, slot: null, componentIndex: null },
              page: null,
              quote: null,
              note: null,
              items: [],
            },
            reviewed: false,
            removed: false,
          },
        ],
      }
    })
  }

  function upsertImport(saved: ImportSummary) {
    setImports((current) => [saved, ...current.filter((item) => item.id !== saved.id)].slice(0, 30))
  }

  async function uploadPdf(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setNotice('')
    const form = event.currentTarget
    if (!selectedFile) {
      setError('Scegli un PDF da salvare.')
      return
    }
    if (!selectedFile.name.toLowerCase().endsWith('.pdf') || selectedFile.size > MAX_FILE_BYTES) {
      setError('Scegli un file PDF non superiore a 15 MB.')
      return
    }
    setBusy('upload')
    try {
      const saved = await apiRequest<ImportSummary>('/api/imports', {
        method: 'POST',
        headers: {
          'content-type': 'application/pdf',
          'x-file-name': encodeURIComponent(selectedFile.name),
        },
        body: selectedFile,
      })
      form.reset()
      setSelectedFile(null)
      upsertImport(saved)
      setNotice('PDF salvato nello spazio privato. Nessuna estrazione è stata avviata.')
      setActiveId(saved.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Salvataggio del PDF non riuscito.')
    } finally {
      setBusy(null)
    }
  }

  async function authorizeExtraction() {
    if (!activeId || !detail || !sendConsent) return
    setError('')
    setNotice('')
    setBusy('extract')
    try {
      const payload = await apiRequest<{ extraction: PlanReview }>('/api/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'extract', id: activeId, confirmed: true }),
      })
      setExtraction(payload.extraction)
      setDetail((current) => current ? { ...current, status: 'extracted', extraction: payload.extraction } : current)
      setSendConsent(false)
      setNotice('Estrazione completata. Verifica ogni pasto e ogni citazione sul PDF prima di confermare.')
      upsertImport({ ...detail, status: 'extracted' })
    } catch (cause) {
      setSendConsent(false)
      setError(cause instanceof Error ? cause.message : 'Estrazione non riuscita.')
    } finally {
      setBusy(null)
    }
  }

  async function confirmPlan(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeId || !extraction || !detail || !finalConsent) return
    setError('')
    setNotice('')
    setBusy('activate')
    try {
      const result = await apiRequest<{ versionId: number; validFrom: string }>('/api/imports', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'activate',
          id: activeId,
          label: planLabel,
          validFrom,
          confirmed: finalConsent,
          extraction,
        }),
      })
      setDetail({ ...detail, status: 'activated', extraction })
      setFinalConsent(false)
      setNotice(`Piano confermato e attivato dal ${result.validFrom} (versione ${result.versionId}).`)
      upsertImport({ ...detail, status: 'activated' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Conferma del piano non riuscita.')
    } finally {
      setBusy(null)
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setError('')
    const file = event.currentTarget.files?.[0] ?? null
    if (file && (!file.name.toLowerCase().endsWith('.pdf') || file.size > MAX_FILE_BYTES)) {
      setSelectedFile(null)
      setError('Scegli un file PDF non superiore a 15 MB.')
      return
    }
    setSelectedFile(file)
  }

  const allMealsReviewed = Boolean(extraction?.days.every((day) => day.meals.every((meal) => meal.reviewed)))
  const allEquivalencesReviewed = Boolean(
    extraction?.equivalences.every((equivalence) => equivalence.removed || equivalence.reviewed),
  )
  const allReviewed = allMealsReviewed && allEquivalencesReviewed

  return (
    <section className="plan-import-workspace" aria-labelledby="plan-import-title">
      <div className="workspace-heading">
        <div>
          <span className="eyebrow">Importazione del piano</span>
          <h2 id="plan-import-title">Rivedi il PDF, poi conferma.</h2>
          <p>Il piano non viene salvato come versione attiva finché non hai verificato i pasti e scelto una data.</p>
        </div>
        {activeId && (
          <button className="secondary-button workspace-nav-button" type="button" onClick={() => setActiveId(null)} disabled={busy !== null}>
            Nuova importazione
          </button>
        )}
      </div>

      {error && <p className="message error-message" role="alert">{error}</p>}
      {notice && <p className="message success-message" role="status">{notice}</p>}

      {!activeId ? (
        <div className="import-start-grid">
          <form className="import-upload-card" onSubmit={uploadPdf}>
            <h3>1. Salva il PDF originale</h3>
            <p>Il file viene conservato in modo privato. Il salvataggio non contatta Google Gemini e non modifica un piano.</p>
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
              {busy === 'upload' ? 'Salvataggio…' : 'Salva PDF senza estrarre'}
            </button>
            <p className="privacy-note">Massimo 15 MB. Il PDF resta nella cartella privata dei dati applicativi.</p>
          </form>

          <section className="import-history-card" aria-labelledby="import-history-title">
            <h3 id="import-history-title">Importazioni recenti</h3>
            {imports.length === 0 ? (
              <p className="empty-state">Non ci sono PDF salvati.</p>
            ) : (
              <ul className="import-history-list">
                {imports.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="import-history-item" onClick={() => setActiveId(item.id)}>
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
      ) : loadingDetail || !detail ? (
        <p className="loading-inline" role="status">Caricamento del PDF e della revisione…</p>
      ) : (
        <>
          <div className="import-session-heading">
            <div>
              <h3>{detail.originalName}</h3>
              <p>{formatBytes(detail.byteSize)} · {statusLabel(detail.status)}</p>
            </div>
            <button type="button" className="text-button" onClick={() => setActiveId(null)} disabled={busy !== null}>
              Torna alle importazioni
            </button>
          </div>
          <div className="import-review-layout">
            <section className="pdf-preview" aria-labelledby="source-pdf-title">
              <h3 id="source-pdf-title">PDF originale</h3>
              {detail.sourceAvailable ? (
                <>
                  <iframe
                    key={detail.id}
                    src={`/api/imports?id=${encodeURIComponent(detail.id)}&file=1`}
                    title={`PDF originale: ${detail.originalName}`}
                  />
                  <p>Le pagine e le citazioni estratte devono essere confrontate con questo documento.</p>
                </>
              ) : (
                <p className="privacy-note" role="status">
                  {detail.status === 'uploaded'
                    ? 'Il PDF originale non è disponibile nello storage. Ricarica il documento per avviare l’estrazione.'
                    : 'Il PDF originale non è disponibile nello storage. I dati e le citazioni salvate restano consultabili, ma il piano non può essere attivato finché non ripristini il documento.'}
                </p>
              )}
            </section>

            <div className="review-column">
              {detail.status === 'uploaded' && !detail.sourceAvailable && (
                <section className="import-step-card" aria-labelledby="missing-source-title">
                  <h3 id="missing-source-title">Estrazione non disponibile</h3>
                  <p>Ricarica il PDF originale prima di avviare l’estrazione.</p>
                </section>
              )}
              {detail.status === 'uploaded' && detail.sourceAvailable && (
                <section className="import-step-card">
                  <span className="step-number">2</span>
                  <h3>Estrazione assistita</h3>
                  <p>Google Gemini riceverà il PDF completo solo dopo la tua autorizzazione esplicita.</p>
                  <label className="consent-check">
                    <input
                      type="checkbox"
                      checked={sendConsent}
                      onChange={(event) => setSendConsent(event.currentTarget.checked)}
                      disabled={busy !== null}
                    />
                    <span>Confermo l’invio del PDF completo a Google Gemini per estrarre il piano da revisionare.</span>
                  </label>
                  <button className="primary-button" type="button" onClick={authorizeExtraction} disabled={busy !== null || !sendConsent}>
                    {busy === 'extract' ? 'Estrazione in corso…' : 'Autorizza e avvia estrazione'}
                  </button>
                  <p className="privacy-note">Nessuna estrazione automatica o in background. Un eventuale nuovo invio richiede un’altra conferma.</p>
                </section>
              )}

              {detail.status === 'extracted' && extraction && (
                <ReviewPanel
                  detail={detail}
                  extraction={extraction}
                  busy={busy !== null}
                  planLabel={planLabel}
                  validFrom={validFrom}
                  finalConsent={finalConsent}
                  allReviewed={allReviewed}
                  onPlanLabelChange={setPlanLabel}
                  onValidFromChange={setValidFrom}
                  onFinalConsentChange={setFinalConsent}
                  onConfirm={confirmPlan}
                  updateMeal={updateMeal}
                  setMealReviewed={setMealReviewed}
                  updateComponent={updateComponent}
                  addComponent={addComponent}
                  updateEquivalence={updateEquivalence}
                  updateEquivalenceItem={updateEquivalenceItem}
                  addEquivalence={addEquivalence}
                  setEquivalenceReviewed={setEquivalenceReviewed}
                />
              )}

              {detail.status === 'activated' && (
                <section className="completed-card" role="status">
                  <span className="step-number">✓</span>
                  <h3>Revisione confermata</h3>
                  <p>La versione attiva conserva la data d’inizio scelta, le citazioni, le quantità stampate e il PDF originale.</p>
                  {detail.extraction?.warnings.length ? (
                    <WarningList title="Avvisi dell’estrazione conservati" warnings={detail.extraction.warnings} />
                  ) : null}
                </section>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

type ReviewPanelProps = {
  detail: ImportDetail
  extraction: PlanReview
  busy: boolean
  planLabel: string
  validFrom: string
  finalConsent: boolean
  allReviewed: boolean
  onPlanLabelChange: (label: string) => void
  onValidFromChange: (date: string) => void
  onFinalConsentChange: (confirmed: boolean) => void
  onConfirm: (event: SyntheticEvent<HTMLFormElement>) => void
  updateMeal: (
    dayIndex: number,
    slot: PlanReview['days'][number]['meals'][number]['slot'],
    update: (meal: PlanReview['days'][number]['meals'][number]) => PlanReview['days'][number]['meals'][number],
  ) => void
  setMealReviewed: (
    dayIndex: number,
    slot: PlanReview['days'][number]['meals'][number]['slot'],
    reviewed: boolean,
  ) => void
  updateComponent: (
    dayIndex: number,
    slot: PlanReview['days'][number]['meals'][number]['slot'],
    componentIndex: number,
    changes: Partial<PlanReviewComponent['review']>,
    removed?: boolean,
  ) => void
  addComponent: (dayIndex: number, slot: PlanReview['days'][number]['meals'][number]['slot']) => void
  updateEquivalence: (
    index: number,
    update: (equivalence: PlanReview['equivalences'][number]) => PlanReview['equivalences'][number],
  ) => void
  updateEquivalenceItem: (
    equivalenceIndex: number,
    itemIndex: number,
    changes: Partial<PlanReview['equivalences'][number]['review']['items'][number]['review']>,
    removed?: boolean,
  ) => void
  setEquivalenceReviewed: (index: number, reviewed: boolean) => void
  addEquivalence: () => void
}

function ReviewPanel(props: ReviewPanelProps) {
  const {
    detail,
    extraction,
    busy,
    planLabel,
    validFrom,
    finalConsent,
    allReviewed,
    onPlanLabelChange,
    onValidFromChange,
    onFinalConsentChange,
    onConfirm,
  } = props
  return (
    <div className="review-form-stack">
      <section className="import-step-card">
        <span className="step-number">3</span>
        <h3>Revisione pasto per pasto</h3>
        <p>Controlla tutti i 35 pasti, correggi testo e provenienza, poi conferma ciascun pasto. Le alternative e le ambiguità restano esplicite.</p>
        {extraction.warnings.length > 0 && <WarningList title="Avvisi generali" warnings={extraction.warnings} />}
        {extraction.days.map((day) => (
          <details className="review-day" key={day.dayIndex} open={day.dayIndex === 0}>
            <summary>{DAY_LABELS[day.dayIndex]} <span>{day.meals.filter((meal) => meal.reviewed).length}/5 verificati</span></summary>
            <div className="review-day-meals">
              {[...day.meals].sort((left, right) => SLOT_ORDER.indexOf(left.slot) - SLOT_ORDER.indexOf(right.slot)).map((meal) => (
                <MealReview
                  key={meal.slot}
                  dayIndex={day.dayIndex}
                  meal={meal}
                  catalog={detail.catalog}
                  units={detail.units}
                  busy={busy}
                  updateMeal={props.updateMeal}
                  setMealReviewed={props.setMealReviewed}
                  updateComponent={props.updateComponent}
                  addComponent={props.addComponent}
                />
              ))}
            </div>
          </details>
        ))}
      </section>

      <section className="import-step-card">
        <span className="step-number">4</span>
        <h3>Equivalenze e ambito</h3>
        <p>Ogni equivalenza deve restare legata al pasto o al componente stampato. Un ambito non risolto non viene applicato globalmente.</p>
        {extraction.equivalences.map((equivalence, index) => (
          <EquivalenceReview
            key={index}
            index={index}
            equivalence={equivalence}
            extraction={extraction}
            catalog={detail.catalog}
            units={detail.units}
            busy={busy}
            updateEquivalence={props.updateEquivalence}
            updateEquivalenceItem={props.updateEquivalenceItem}
            setEquivalenceReviewed={props.setEquivalenceReviewed}
          />
        ))}
        <button className="secondary-button add-row-button" type="button" onClick={props.addEquivalence} disabled={busy || extraction.equivalences.length >= 100}>
          Aggiungi equivalenza dal PDF
        </button>
      </section>

      {detail.sourceAvailable ? (
        <form className="activation-form import-step-card" onSubmit={onConfirm}>
          <span className="step-number">5</span>
          <h3>Conferma e attiva</h3>
          <p>La conferma crea una nuova versione del piano; l’estrazione da sola non modifica né attiva dati.</p>
          <label htmlFor="import-plan-label">Nome della versione</label>
          <input id="import-plan-label" type="text" maxLength={160} value={planLabel} onChange={(event) => onPlanLabelChange(event.currentTarget.value)} disabled={busy} />
          <label htmlFor="import-valid-from">Data di attivazione</label>
          <input id="import-valid-from" type="date" required value={validFrom} onChange={(event) => onValidFromChange(event.currentTarget.value)} disabled={busy} />
          <label className="consent-check">
            <input type="checkbox" checked={finalConsent} onChange={(event) => onFinalConsentChange(event.currentTarget.checked)} disabled={busy || !allReviewed} />
            <span>Confermo di aver verificato sul PDF tutti i pasti e le citazioni; attiva questa versione dalla data scelta.</span>
          </label>
          {!allReviewed && <p className="field-hint">Conferma ogni pasto e ogni equivalenza prima dell’attivazione.</p>}
          <button className="primary-button" type="submit" disabled={busy || !allReviewed || !finalConsent || !validFrom}>
            {busy ? 'Conferma in corso…' : 'Conferma revisione e attiva il piano'}
          </button>
        </form>
      ) : (
        <section className="import-step-card" role="status">
          <span className="step-number">5</span>
          <h3>Attivazione bloccata</h3>
          <p>Ripristina il PDF originale per verificare pagine e citazioni. Il piano non può essere attivato finché la fonte non è disponibile.</p>
        </section>
      )}
    </div>
  )
}

type MealReviewProps = {
  dayIndex: number
  meal: PlanReview['days'][number]['meals'][number]
  catalog: CatalogFood[]
  units: CatalogUnit[]
  busy: boolean
  updateMeal: ReviewPanelProps['updateMeal']
  setMealReviewed: ReviewPanelProps['setMealReviewed']
  updateComponent: ReviewPanelProps['updateComponent']
  addComponent: ReviewPanelProps['addComponent']
}

function MealReview({ dayIndex, meal, catalog, units, busy, updateMeal, setMealReviewed, updateComponent, addComponent }: MealReviewProps) {
  const label = SLOT_LABELS[meal.slot]
  const canConfirm = reviewMealCanBeConfirmed(meal)
  const activeComponents = meal.components.filter((component) => !component.removed)
  return (
    <fieldset className="meal-review">
      <legend>{label}</legend>
      {meal.source.warnings.length > 0 && <WarningList title="Avvisi estratti" warnings={meal.source.warnings} />}
      {activeComponents.length === 0 && <p className="field-hint">Nessun componente estratto. Verifica il contenuto del pasto sul PDF e aggiungi ciò che è effettivamente stampato.</p>}
      <div className="review-fields-grid">
        <label>
          Pagina del pasto
          <input type="number" min={1} max={1000} value={meal.review.page ?? ''} onChange={(event) => updateMeal(dayIndex, meal.slot, (current) => ({ ...current, review: { ...current.review, page: event.currentTarget.value ? Number(event.currentTarget.value) : null } }))} disabled={busy} />
        </label>
        <label className="field-span-all">
          Citazione sorgente del pasto
          <textarea rows={2} maxLength={1200} value={meal.review.quote ?? ''} onChange={(event) => updateMeal(dayIndex, meal.slot, (current) => ({ ...current, review: { ...current.review, quote: event.currentTarget.value || null } }))} disabled={busy} />
        </label>
        <label className="field-span-all">
          Note del pasto
          <textarea rows={2} maxLength={2000} value={meal.review.notes ?? ''} onChange={(event) => updateMeal(dayIndex, meal.slot, (current) => ({ ...current, review: { ...current.review, notes: event.currentTarget.value || null } }))} disabled={busy} />
        </label>
      </div>

      {meal.components.map((component, index) => (
        <ComponentReview
          key={index}
          dayIndex={dayIndex}
          slot={meal.slot}
          componentIndex={index}
          component={component}
          catalog={catalog}
          units={units}
          busy={busy}
          updateComponent={updateComponent}
        />
      ))}
      <button className="secondary-button add-row-button" type="button" onClick={() => addComponent(dayIndex, meal.slot)} disabled={busy || meal.components.length >= 40}>
        Aggiungi componente dal PDF
      </button>
      <label className="meal-confirm-check">
        <input type="checkbox" checked={meal.reviewed} onChange={(event) => setMealReviewed(dayIndex, meal.slot, event.currentTarget.checked)} disabled={busy || (!canConfirm && !meal.reviewed)} />
        <span>Ho confrontato questo pasto e tutti i componenti con il PDF.</span>
      </label>
      {!canConfirm && !meal.reviewed && <p className="field-hint">Per verificare il pasto servono pagina, citazione e un’etichetta per ogni componente mantenuto.</p>}
    </fieldset>
  )
}

type ComponentReviewProps = {
  dayIndex: number
  slot: PlanReview['days'][number]['meals'][number]['slot']
  componentIndex: number
  component: PlanReviewComponent
  catalog: CatalogFood[]
  units: CatalogUnit[]
  busy: boolean
  updateComponent: ReviewPanelProps['updateComponent']
}

function ComponentReview({ dayIndex, slot, componentIndex, component, catalog, units, busy, updateComponent }: ComponentReviewProps) {
  const { review, source, removed } = component
  const sourceName = source ? `Componente ${componentIndex + 1} estratto` : `Componente ${componentIndex + 1} aggiunto in revisione`
  const foodName = catalog.find((food) => food.id === review.foodId)?.canonicalName
  const normalizedUnit = findCatalogUnit(review.unitText, units)
  const warnings = [...(source?.warnings ?? [])]
  if (!review.quantityText?.trim()) warnings.push('Quantità non rilevata: verifica sul PDF e lascia vuoto solo se non è indicata.')
  if (review.quantityText?.trim() && !review.unitText?.trim()) warnings.push('Unità non rilevata: non è stata supposta.')
  else if (review.unitText?.trim() && !normalizedUnit) warnings.push('Unità non riconosciuta dal catalogo; il testo originale verrà mantenuto.')
  if (review.state === 'unspecified') warnings.push('Stato crudo/cotto non specificato nel dato confermato.')
  if (!review.foodId) warnings.push('Alimento non collegato al catalogo; l’etichetta originale resta conservata.')
  return (
    <article className={`component-review${removed ? ' is-removed' : ''}`}>
      <div className="component-review-heading">
        <strong>{sourceName}</strong>
        <button type="button" className="text-button" onClick={() => updateComponent(dayIndex, slot, componentIndex, {}, !removed)} disabled={busy}>
          {removed ? 'Ripristina' : 'Rimuovi dal piano'}
        </button>
      </div>
      {source && <p className="source-snippet">Estratto: {source.label} · {source.quantityText ?? 'quantità assente'} {source.unitText ?? ''}</p>}
      {!removed && (
        <>
          {warnings.length > 0 && <WarningList title="Da verificare" warnings={warnings} />}
          <div className="review-fields-grid">
            <label>
              Alimento riportato o corretto
              <input type="text" maxLength={300} value={review.label} onChange={(event) => {
                const value = event.currentTarget.value
                const normalized = value.trim().toLocaleLowerCase('it')
                const match = catalog.find((food) =>
                  food.canonicalName.trim().toLocaleLowerCase('it') === normalized ||
                  food.aliases.some((alias) => alias.trim().toLocaleLowerCase('it') === normalized),
                )
                updateComponent(dayIndex, slot, componentIndex, { label: value, foodId: match?.id ?? null })
              }} disabled={busy} />
            </label>
            <label>
              Alimento normalizzato nel catalogo
              <select value={review.foodId ?? ''} onChange={(event) => updateComponent(dayIndex, slot, componentIndex, { foodId: event.currentTarget.value ? Number(event.currentTarget.value) : null })} disabled={busy}>
                <option value="">Non collegato</option>
                {catalog.map((food) => <option key={food.id} value={food.id}>{food.canonicalName}</option>)}
              </select>
            </label>
            <label>
              Quantità esattamente come scritta
              <input type="text" maxLength={100} value={review.quantityText ?? ''} onChange={(event) => updateComponent(dayIndex, slot, componentIndex, { quantityText: event.currentTarget.value || null })} disabled={busy} />
            </label>
            <label>
              Unità esattamente come scritta
              <input type="text" maxLength={80} value={review.unitText ?? ''} onChange={(event) => updateComponent(dayIndex, slot, componentIndex, { unitText: event.currentTarget.value || null })} disabled={busy} />
            </label>
            <label>
              Stato riportato
              <select value={review.state} onChange={(event) => updateComponent(dayIndex, slot, componentIndex, { state: event.currentTarget.value as typeof review.state })} disabled={busy}>
                <option value="unspecified">Non specificato</option>
                <option value="raw">Crudo</option>
                <option value="cooked">Cotto</option>
              </select>
            </label>
            <label>
              Gruppo alternative esplicito
              <input type="text" maxLength={100} value={review.alternativeGroup ?? ''} onChange={(event) => updateComponent(dayIndex, slot, componentIndex, { alternativeGroup: event.currentTarget.value || null })} disabled={busy} />
            </label>
            <label>
              Pagina della citazione
              <input type="number" min={1} max={1000} value={review.page ?? ''} onChange={(event) => updateComponent(dayIndex, slot, componentIndex, { page: event.currentTarget.value ? Number(event.currentTarget.value) : null })} disabled={busy} />
            </label>
            <label className="field-span-all">
              Citazione sorgente esatta
              <textarea rows={2} maxLength={1200} value={review.quote ?? ''} onChange={(event) => updateComponent(dayIndex, slot, componentIndex, { quote: event.currentTarget.value || null })} disabled={busy} />
            </label>
            <label className="field-span-all">
              Note
              <textarea rows={2} maxLength={1000} value={review.notes ?? ''} onChange={(event) => updateComponent(dayIndex, slot, componentIndex, { notes: event.currentTarget.value || null })} disabled={busy} />
            </label>
          </div>
          {foodName && <p className="field-hint">Collegato a: {foodName}. Il testo del PDF resta conservato separatamente.</p>}
        </>
      )}
      {removed && <p className="field-hint">Questo dato sorgente è conservato nell’importazione ma non entrerà nella nuova versione.</p>}
    </article>
  )
}

type EquivalenceReviewProps = {
  index: number
  equivalence: PlanReview['equivalences'][number]
  extraction: PlanReview
  catalog: CatalogFood[]
  units: CatalogUnit[]
  busy: boolean
  updateEquivalence: ReviewPanelProps['updateEquivalence']
  updateEquivalenceItem: ReviewPanelProps['updateEquivalenceItem']
  setEquivalenceReviewed: ReviewPanelProps['setEquivalenceReviewed']
}

function EquivalenceReview({ index, equivalence, extraction, catalog, units, busy, updateEquivalence, updateEquivalenceItem, setEquivalenceReviewed }: EquivalenceReviewProps) {
  const { review, source, removed } = equivalence
  const targetDay = extraction.days.find((day) => day.dayIndex === review.scope.dayIndex)
  const targetMeal = targetDay?.meals.find((meal) => meal.slot === review.scope.slot)
  const warnings = [...(source?.warnings ?? [])]
  if (review.scope.dayIndex === null || review.scope.slot === null) warnings.push('Ambito dell’equivalenza non risolto.')
  for (const [itemIndex, item] of review.items.entries()) {
    if (item.removed) continue
    const prefix = `Elemento ${itemIndex + 1}: `
    if (!item.review.quantityText?.trim()) warnings.push(`${prefix}quantità non rilevata.`)
    if (item.review.quantityText?.trim() && !item.review.unitText?.trim()) warnings.push(`${prefix}unità non rilevata.`)
    else if (item.review.unitText?.trim() && !findCatalogUnit(item.review.unitText, units)) warnings.push(`${prefix}unità non riconosciuta dal catalogo; il testo resta conservato.`)
    if (!item.review.foodId) warnings.push(`${prefix}alimento non collegato al catalogo.`)
  }
  return (
    <article className={`equivalence-review${removed ? ' is-removed' : ''}`}>
      <div className="component-review-heading">
        <strong>{source ? `Equivalenza ${index + 1} estratta` : `Equivalenza ${index + 1} aggiunta in revisione`}</strong>
        <button type="button" className="text-button" onClick={() => updateEquivalence(index, (current) => ({ ...current, removed: !current.removed }))} disabled={busy}>
          {removed ? 'Ripristina' : 'Rimuovi'}
        </button>
      </div>
      {warnings.length > 0 && !removed && <WarningList title="Da verificare" warnings={warnings} />}
      {removed ? (
        <p className="field-hint">I dati sorgente restano conservati, ma l’equivalenza non verrà attivata.</p>
      ) : (
        <>
          <div className="review-fields-grid">
            <label>
              Giorno di applicazione
              <select value={review.scope.dayIndex ?? ''} onChange={(event) => updateEquivalence(index, (current) => ({
                ...current,
                review: { ...current.review, scope: { dayIndex: event.currentTarget.value ? Number(event.currentTarget.value) : null, slot: current.review.scope.slot, componentIndex: null } },
              }))} disabled={busy}>
                <option value="">Seleziona giorno</option>
                {DAY_LABELS.map((day, dayIndex) => <option key={day} value={dayIndex}>{day}</option>)}
              </select>
            </label>
            <label>
              Pasto di applicazione
              <select value={review.scope.slot ?? ''} onChange={(event) => updateEquivalence(index, (current) => ({
                ...current,
                review: { ...current.review, scope: { dayIndex: current.review.scope.dayIndex, slot: event.currentTarget.value ? event.currentTarget.value as typeof current.review.scope.slot : null, componentIndex: null } },
              }))} disabled={busy}>
                <option value="">Seleziona pasto</option>
                {SLOT_ORDER.map((slot) => <option key={slot} value={slot}>{SLOT_LABELS[slot]}</option>)}
              </select>
            </label>
            <label>
              Componente di applicazione
              <select value={review.scope.componentIndex ?? ''} onChange={(event) => updateEquivalence(index, (current) => ({
                ...current,
                review: { ...current.review, scope: { ...current.review.scope, componentIndex: event.currentTarget.value ? Number(event.currentTarget.value) : null } },
              }))} disabled={busy || !targetMeal}>
                <option value="">Pasto intero</option>
                {targetMeal?.components.map((component, componentIndex) => !component.removed ? (
                  <option key={componentIndex} value={componentIndex}>{component.review.label || `Componente ${componentIndex + 1}`}</option>
                ) : null)}
              </select>
            </label>
            <label>
              Pagina dell’equivalenza
              <input type="number" min={1} max={1000} value={review.page ?? ''} onChange={(event) => updateEquivalence(index, (current) => ({ ...current, review: { ...current.review, page: event.currentTarget.value ? Number(event.currentTarget.value) : null } }))} disabled={busy} />
            </label>
            <label className="field-span-all">
              Citazione sorgente esatta
              <textarea rows={2} maxLength={1200} value={review.quote ?? ''} onChange={(event) => updateEquivalence(index, (current) => ({ ...current, review: { ...current.review, quote: event.currentTarget.value || null } }))} disabled={busy} />
            </label>
            <label className="field-span-all">
              Nota
              <textarea rows={2} maxLength={1000} value={review.note ?? ''} onChange={(event) => updateEquivalence(index, (current) => ({ ...current, review: { ...current.review, note: event.currentTarget.value || null } }))} disabled={busy} />
            </label>
          </div>
          {review.items.map((item, itemIndex) => (
            <article className={`component-review${item.removed ? ' is-removed' : ''}`} key={itemIndex}>
              <div className="component-review-heading">
                <strong>{item.source ? `Elemento ${itemIndex + 1}` : `Elemento aggiunto ${itemIndex + 1}`}</strong>
                <button type="button" className="text-button" onClick={() => updateEquivalenceItem(index, itemIndex, {}, !item.removed)} disabled={busy}>
                  {item.removed ? 'Ripristina' : 'Rimuovi'}
                </button>
              </div>
              {!item.removed && (
                <div className="review-fields-grid">
                  <label>
                    Alimento
                    <input type="text" maxLength={300} value={item.review.label} onChange={(event) => {
                      const value = event.currentTarget.value
                      const normalized = value.trim().toLocaleLowerCase('it')
                      const match = catalog.find((food) =>
                        food.canonicalName.trim().toLocaleLowerCase('it') === normalized ||
                        food.aliases.some((alias) => alias.trim().toLocaleLowerCase('it') === normalized),
                      )
                      updateEquivalenceItem(index, itemIndex, { label: value, foodId: match?.id ?? null })
                    }} disabled={busy} />
                  </label>
                  <label>
                    Alimento nel catalogo
                    <select value={item.review.foodId ?? ''} onChange={(event) => updateEquivalenceItem(index, itemIndex, { foodId: event.currentTarget.value ? Number(event.currentTarget.value) : null })} disabled={busy}>
                      <option value="">Non collegato</option>
                      {catalog.map((food) => <option key={food.id} value={food.id}>{food.canonicalName}</option>)}
                    </select>
                  </label>
                  <label>
                    Quantità
                    <input type="text" maxLength={100} value={item.review.quantityText ?? ''} onChange={(event) => updateEquivalenceItem(index, itemIndex, { quantityText: event.currentTarget.value || null })} disabled={busy} />
                  </label>
                  <label>
                    Unità
                    <input type="text" maxLength={80} value={item.review.unitText ?? ''} onChange={(event) => updateEquivalenceItem(index, itemIndex, { unitText: event.currentTarget.value || null })} disabled={busy} />
                  </label>
                  <label>
                    Pagina
                    <input type="number" min={1} max={1000} value={item.review.page ?? ''} onChange={(event) => updateEquivalenceItem(index, itemIndex, { page: event.currentTarget.value ? Number(event.currentTarget.value) : null })} disabled={busy} />
                  </label>
                  <label className="field-span-all">
                    Citazione sorgente esatta
                    <textarea rows={2} maxLength={1200} value={item.review.quote ?? ''} onChange={(event) => updateEquivalenceItem(index, itemIndex, { quote: event.currentTarget.value || null })} disabled={busy} />
                  </label>
                </div>
              )}
              {item.removed && <p className="field-hint">Elemento sorgente conservato ma escluso dalla versione.</p>}
            </article>
          ))}
          <button className="secondary-button add-row-button" type="button" onClick={() => updateEquivalence(index, (current) => ({
            ...current,
            review: {
              ...current.review,
              items: [...current.review.items, {
                source: null,
                review: { label: '', quantityText: null, unitText: null, page: null, quote: null, foodId: null },
                removed: false,
              }],
            },
          }))} disabled={busy || review.items.length >= 40}>
            Aggiungi elemento
          </button>
          <label className="meal-confirm-check">
            <input type="checkbox" checked={equivalence.reviewed} onChange={(event) => setEquivalenceReviewed(index, event.currentTarget.checked)} disabled={busy || (!reviewEquivalenceCanBeConfirmed(equivalence, extraction) && !equivalence.reviewed)} />
            <span>Ho verificato questa equivalenza, il suo ambito e tutte le citazioni.</span>
          </label>
          {!reviewEquivalenceCanBeConfirmed(equivalence, extraction) && !equivalence.reviewed && <p className="field-hint">Completa ambito, pagina, citazioni e almeno un elemento per verificare l’equivalenza.</p>}
        </>
      )}
    </article>
  )
}

function WarningList({ title, warnings }: { title: string; warnings: string[] }) {
  const uniqueWarnings = [...new Set(warnings)]
  if (uniqueWarnings.length === 0) return null
  return (
    <div className="review-warning">
      <strong>{title}</strong>
      <ul>{uniqueWarnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>
    </div>
  )
}

function statusLabel(status: ImportStatus): string {
  if (status === 'uploaded') return 'PDF salvato'
  if (status === 'extracted') return 'Da revisionare'
  return 'Confermato'
}
