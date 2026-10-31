import { Fragment, useEffect, useId, useRef, useState } from 'react'
import type { SyntheticEvent } from 'react'
import { Link } from '@tanstack/react-router'
import type { GroceryRound } from '../db/schema'
import type { GroceryFood, GroceryLine, GroceryRoundView, GroceryView } from '../server/groceries'
import { apiRequest } from './api'
import { FoodText, SLOT_LABELS } from './plan-text'
import './grocery.css'

type LineRef = { round: GroceryRound; foodKey: string; unit: string; cooked: boolean }
type GroceryAction =
  | (LineRef & { action: 'check'; name: string; quantity: number | null })
  | (LineRef & { action: 'uncheck' })
  | { action: 'setPantry'; foodKey: string; unit: string; name: string; quantity: number | null }
  | { action: 'addManual'; round: GroceryRound; id: string; label: string; quantityText: string | null }
  | { action: 'setManualChecked'; id: string; checked: boolean }
  | { action: 'deleteManual'; id: string }
  | {
      action: 'setFoodRules'
      foodKey: string
      aisle: string | null
      unit: string | null
      packageSize: number | null
      storageDays: number | null
      alwaysAtHome: boolean
      conversions: { unit: string; factor: number }[]
    }
type RunAction = (action: GroceryAction, success?: string) => Promise<boolean>
type RunActions = (actions: GroceryAction[], success?: string) => Promise<boolean>
type RoundLine = { round: GroceryRound; line: GroceryLine }
type WeeklyLine = { line: GroceryLine; contributions: RoundLine[] }

const ROUND_NAMES: Record<GroceryRound, string> = { monday: 'Lunedì', thursday: 'Giovedì' }
// Round identities stay internal so existing purchases and pantry records keep
// their meaning even though the shopping screen presents one weekly list.
function weeklyAisles(rounds: GroceryRoundView[]): { name: string | null; lines: WeeklyLine[] }[] {
  const groups = new Map<string | null, Map<string, RoundLine[]>>()
  for (const round of rounds) {
    for (const aisle of round.aisles) {
      const lines = groups.get(aisle.name) ?? new Map<string, RoundLine[]>()
      groups.set(aisle.name, lines)
      for (const line of aisle.lines) {
        const key = JSON.stringify([line.foodKey, line.unit, line.cooked])
        const contributions = lines.get(key) ?? []
        contributions.push({ round: round.round, line })
        lines.set(key, contributions)
      }
    }
  }
  return [...groups].map(([name, lines]) => ({
    name,
    lines: [...lines.values()].map((contributions) => {
      const first = contributions[0]!.line
      const sum = (field: 'needed' | 'packages' | 'toBuy' | 'surplus') => {
        const values = contributions.map(({ line }) => line[field])
        return values.some((value) => value === null)
          ? null
          : Math.round(values.reduce<number>((total, value) => total + value!, 0) * 1000) / 1000
      }
      return {
        contributions,
        line: {
          ...first,
          needed: sum('needed'),
          packages: sum('packages'),
          toBuy: sum('toBuy'),
          surplus: sum('surplus'),
          pantry: contributions.reduce((total, { line }) => total + line.pantry, 0),
          unquantifiedUses: contributions.reduce((total, { line }) => total + line.unquantifiedUses, 0),
          unspecifiedStateUses: contributions.reduce((total, { line }) => total + line.unspecifiedStateUses, 0),
          uses: contributions.flatMap(({ line }) => line.uses),
          check: null,
          delta: null,
        },
      }
    }).sort((left, right) => left.line.name.localeCompare(right.line.name, 'it') || left.line.unit.localeCompare(right.line.unit, 'it')),
  })).sort((left, right) => Number(left.name === null) - Number(right.name === null))
}

const quantityFormat = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2, useGrouping: false })

// A bare count shows the number alone, as printed in the plan.
function amount(quantity: number, unit: string): string {
  const value = quantityFormat.format(quantity)
  return unit ? `${value} ${unit}` : value
}

function unitName(unit: string): string {
  return unit || 'numero'
}

function formatDay(date: string, options: Intl.DateTimeFormatOptions = {}): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('it-IT', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    ...options,
  })
}

function purchaseText(line: GroceryLine): string {
  if (line.toBuy === null) return line.cooked ? 'da valutare' : 'quantità da definire'
  if (line.toBuy === 0) return 'già in dispensa'
  if (line.packages === null) return amount(line.toBuy, line.unit)
  return `${line.packages} ${line.packages === 1 ? 'confezione' : 'confezioni'} · ${amount(line.toBuy, line.unit)}`
}

export function GroceryList({ weekStart, onWeekChange }: { weekStart: string | null; onWeekChange: (start: string | null) => void }) {
  const [view, setView] = useState<GroceryView | null>(null)
  const [pending, setPending] = useState<'load' | 'action' | null>('load')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const actionPending = useRef(false)
  const [loadRevision, setLoadRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    setPending('load')
    setError('')
    setNotice('')
    void apiRequest<GroceryView>(weekStart ? `/api/groceries?start=${encodeURIComponent(weekStart)}` : '/api/groceries')
      .then((current) => {
        if (!cancelled) setView(current)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Impossibile caricare la spesa.')
      })
      .finally(() => {
        if (!cancelled) setPending(null)
      })
    return () => {
      cancelled = true
    }
  }, [weekStart, loadRevision])

  async function runActions(actions: GroceryAction[], success?: string): Promise<boolean> {
    if (!view || pending !== null || actionPending.current || actions.length === 0) return false
    actionPending.current = true
    setPending('action')
    setError('')
    setNotice('')
    let saved = 0
    try {
      for (const action of actions) {
        const updated = await apiRequest<GroceryView>('/api/groceries', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...action, weekStart: view.weekStart }),
        })
        setView(updated)
        saved += 1
      }
      if (success) setNotice(success)
      return true
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Modifica non riuscita.'
      setError(`${saved > 0 ? `Salvate ${saved} di ${actions.length} modifiche. ` : ''}${message} Le spunte potrebbero essere salvate solo in parte: ricarica la lista prima di riprovare.`)
      try {
        setView(await apiRequest<GroceryView>(`/api/groceries?start=${encodeURIComponent(view.weekStart)}`))
      } catch {
        // Keep the last server-confirmed response, never a locally assumed save.
        setError((current) => `${current} Anche il ricaricamento non è riuscito.`)
      }
      return false
    } finally {
      actionPending.current = false
      setPending(null)
    }
  }

  const runAction: RunAction = (action, success) => runActions([action], success)

  const busy = pending !== null
  const aisles = view ? weeklyAisles(view.rounds) : []

  return (
    <section className="week-planner grocery-list" aria-labelledby="grocery-list-title" aria-busy={busy}>
      <div className="workspace-heading">
        <div>
          <span className="eyebrow">Spesa</span>
          <h2 id="grocery-list-title">La lista</h2>
          {view && (
            <p>
              {formatDay(view.weekStart, view.weekStart.slice(0, 4) === view.weekEnd.slice(0, 4) ? {} : { year: 'numeric' })}
              {' – '}
              {formatDay(view.weekEnd, { year: 'numeric' })}
            </p>
          )}
        </div>
        {view && (
          <nav className="week-nav" aria-label="Cambia settimana">
            <button className="secondary-button" type="button" onClick={() => onWeekChange(view.previousWeekStart)} disabled={busy}>
              ← Precedente
            </button>
            <button className="secondary-button" type="button" onClick={() => onWeekChange(view.nextWeekStart)} disabled={busy}>
              Successiva →
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onWeekChange(null)}
              disabled={busy || (view.today >= view.weekStart && view.today <= view.weekEnd)}
            >
              Settimana in corso
            </button>
          </nav>
        )}
      </div>

      <div className="grocery-feedback">
        {error && (
          <div role="alert">
            <p className="message error-message">{error}</p>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => setLoadRevision((revision) => revision + 1)}>
              Ricarica la lista
            </button>
          </div>
        )}
        {notice && <p className="message success-message" role="status">{notice}</p>}
      </div>
      {pending === 'load' && <p className="loading-inline" role="status">Caricamento della spesa…</p>}

      {view && (
        <div className="week-body">
          <GroceryStatus view={view} />
          {view.planned && (
            <>
              <WeeklyPanel view={view} aisles={aisles} busy={busy} runAction={runAction} runActions={runActions} />
              <details className="grocery-secondary">
                <summary>Dispensa e alimenti sempre in casa</summary>
                <PantrySummary view={view} busy={busy} runAction={runAction} />
                <AlwaysAtHome view={view} busy={busy} runAction={runAction} />
              </details>
            </>
          )}
        </div>
      )}
    </section>
  )
}

function GroceryStatus({ view }: { view: GroceryView }) {
  if (!view.planned) {
    return (
      <section className="week-status" role="status">
        <h3>Nessuna dieta valida per queste date</h3>
        <p>Non c’è una dieta valida in questa settimana da cui ricavare gli alimenti dei pasti.</p>
        <Link className="grocery-status-link" to="/dieta">Consulta o attiva una dieta →</Link>
      </section>
    )
  }
  const unplannedCount = view.unplannedDays.length
  return (
    <section className={unplannedCount > 0 ? 'week-status week-status-pending' : 'week-status'}>
      <h3>La spesa segue il calendario</h3>
      <p>La lista include solo gli alimenti delle giornate aggiunte al calendario. Le giornate ancora in bozza sono escluse.</p>
      {unplannedCount > 0 && (
        <div className="grocery-draft-days">
          <p><strong>{unplannedCount === 1 ? '1 giornata ancora da aggiungere' : `${unplannedCount} giornate ancora da aggiungere`}</strong></p>
          <ul aria-label="Giornate in bozza escluse dalla spesa">
            {view.unplannedDays.map((day) => (
              <li key={day.date}>{day.dayName} {formatDay(day.date, { month: 'short' })}</li>
            ))}
          </ul>
          <Link className="grocery-status-link" to="/settimana" search={{ start: view.weekStart }}>
            Pianifica in Settimana →
          </Link>
        </div>
      )}
      {view.freeMeal && (
        <p className="grocery-free-meal">
          Pasto libero escluso dalla spesa: {view.freeMeal.dayName.toLowerCase()} {formatDay(view.freeMeal.date)} ·{' '}
          {SLOT_LABELS[view.freeMeal.slot].toLowerCase()}.
        </p>
      )}
    </section>
  )
}

function WeeklyPanel({ view, aisles, busy, runAction, runActions }: {
  view: GroceryView
  aisles: ReturnType<typeof weeklyAisles>
  busy: boolean
  runAction: RunAction
  runActions: RunActions
}) {
  const foods = new Map(view.foods.map((food) => [food.key, food]))
  const pantry = new Map(view.pantry.map((entry) => [JSON.stringify([entry.foodKey, entry.unit]), entry.quantity]))
  return (
    <div className="grocery-week">
      {view.unplannedDays.length === 0 && (
        <Link className="grocery-status-link" to="/settimana" search={{ start: view.weekStart }}>
          Rivedi i pasti in Settimana →
        </Link>
      )}
      {aisles.length === 0 && (
        <p className="summary-missing">
          Nessun alimento da comprare dalle giornate aggiunte al calendario.
          {view.unplannedDays.length > 0 && ' Aggiungi le giornate in bozza da Settimana per includerne gli alimenti.'}
          {' '}Acquisti già registrati e aggiunte manuali restano separati.
        </p>
      )}
      {aisles.map((aisle) => (
        <section className="grocery-aisle" key={aisle.name ?? ''} aria-label={aisle.name ?? 'Alimenti'}>
          <h3>{aisle.name ?? 'Alimenti'}</h3>
          <ul className="grocery-items">
            {aisle.lines.map(({ line, contributions }) => (
              <GroceryItem
                key={JSON.stringify([line.foodKey, line.unit, line.cooked])}
                contributions={contributions}
                line={line}
                food={foods.get(line.foodKey)!}
                pantry={pantry.get(JSON.stringify([line.foodKey, line.unit])) ?? null}
                aisles={view.aisles}
                busy={busy}
                runAction={runAction}
                runActions={runActions}
              />
            ))}
          </ul>
        </section>
      ))}
      {view.rounds.some((round) => round.noLongerNeeded.length > 0) && (
        <details className="grocery-secondary">
          <summary>Acquisti non più necessari per i pasti scelti</summary>
          {view.rounds.map((round) => (
            <Fragment key={round.round}>
              {round.noLongerNeeded.length > 0 && <p className="field-hint">Acquisti registrati: {ROUND_NAMES[round.round].toLowerCase()}.</p>}
              <NoLongerNeeded round={round} busy={busy} runAction={runAction} />
            </Fragment>
          ))}
        </details>
      )}
      <ManualItems items={view.rounds.flatMap((round) => round.manual)} busy={busy} runAction={runAction} />
    </div>
  )
}

function GroceryItem({
  contributions,
  line,
  food,
  pantry,
  aisles,
  busy,
  runAction,
  runActions,
}: {
  contributions: RoundLine[]
  line: GroceryLine
  food: GroceryFood
  pantry: number | null
  aisles: string[]
  busy: boolean
  runAction: RunAction
  runActions: RunActions
}) {
  const id = useId()
  const checkableLines = contributions.filter(({ line: item }) => item.check !== null || item.toBuy !== 0)
  const checkable = checkableLines.length > 0
  const checked = checkable && checkableLines.every(({ line: item }) => item.check !== null)
  const partiallyChecked = !checked && checkableLines.some(({ line: item }) => item.check !== null)
  const changedPurchases = contributions.filter(({ line: item }) => item.check && item.delta !== null && item.delta !== 0)
  const hasAdditions = changedPurchases.some(({ line: item }) => item.delta! > 0)

  function toggle() {
    const actions: GroceryAction[] = checkableLines
      .filter(({ line: item }) => checked ? item.check !== null : item.check === null)
      .map(({ round, line: item }) => {
        const ref = { round, foodKey: item.foodKey, unit: item.unit, cooked: item.cooked }
        return checked
          ? { action: 'uncheck', ...ref }
          : { action: 'check', ...ref, name: item.name, quantity: item.toBuy }
      })
    void runActions(actions)
  }
  // The need is repeated only when pantry or packages make the purchase differ.
  const facts = [
    line.needed !== null &&
      (line.cooked || line.toBuy !== line.needed) &&
      `servono ${amount(line.needed, line.unit)}${line.cooked ? ' a cotto' : ''}`,
    line.pantry > 0 && `${amount(line.pantry, line.unit)} in dispensa`,
    line.packageSize !== null && `confezione da ${amount(line.packageSize, line.unit)}`,
    line.surplus !== null && line.surplus > 0 && `eccedenza ${amount(line.surplus, line.unit)}`,
    partiallyChecked && 'Parte già acquistata; spunta per segnare anche il resto',
    line.packages !== null && contributions.length > 1 && 'confezioni sommate dai due giri della settimana',
  ].filter(Boolean)
  const groceryUnit = food.rules?.unit ?? null
  const warnings = [
    line.cooked && 'Peso a cotto: la quantità da comprare a crudo non è calcolata.',
    line.unquantifiedUses > 0 &&
      `${line.unquantifiedUses} ${line.unquantifiedUses === 1 ? 'uso' : 'usi'} senza quantità numerica: controlla i dettagli.`,
    line.unspecifiedStateUses > 0 &&
      `Stato crudo/cotto non specificato in ${line.unspecifiedStateUses} ${line.unspecifiedStateUses === 1 ? 'uso' : 'usi'}.`,
    line.unconvertedUnit &&
      groceryUnit !== null &&
      `Nessuna regola converte ${line.unit ? `«${line.unit}»` : 'le quantità senza unità'} in ${unitName(groceryUnit)}.`,
    line.mixedUnits && 'Unità diverse: le quantità restano separate, senza conversioni presunte.',
    contributions.some(({ line: item }) => item.check !== null && (item.check.quantity === null || item.toBuy === null)) &&
      'Acquisto già registrato senza quantità confrontabili: verifica gli eventuali cambiamenti nei pasti.',
  ].filter(Boolean)
  const title = (
    <>
      <span className="grocery-item-name">{line.name}</span>
      <span className="grocery-item-amount">{purchaseText(line)}</span>
    </>
  )

  return (
    <li className={checked && !hasAdditions ? 'grocery-item grocery-item-checked' : 'grocery-item'}>
      <div className="grocery-item-main">
        {checkable ? (
          <>
            <input
              id={id}
              type="checkbox"
              checked={checked}
              ref={(input) => { if (input) input.indeterminate = partiallyChecked }}
              // Keep keyboard and VoiceOver focus during online saves.
              aria-disabled={busy}
              onChange={toggle}
            />
            <label htmlFor={id}>{title}</label>
          </>
        ) : (
          <div className="grocery-item-title">{title}</div>
        )}
      </div>
      {facts.length > 0 && <p className="grocery-item-facts">{facts.join(' · ')}</p>}
      {warnings.length > 0 && (
        <ul className="grocery-item-warnings">
          {warnings.map((warning) => (
            <li key={String(warning)}>{warning}</li>
          ))}
        </ul>
      )}
      {changedPurchases.map(({ round, line: item }) => (
        <div key={round} className={item.delta! > 0 ? 'grocery-delta grocery-delta-add' : 'grocery-delta'}>
          <p>
            Acquisto registrato {ROUND_NAMES[round].toLowerCase()}: {amount(item.check!.quantity!, item.unit)}.{' '}
            <strong>
              {item.delta! > 0
                ? `Da aggiungere: ${amount(item.delta!, item.unit)}`
                : `Non più necessario: ${amount(-item.delta!, item.unit)}`}
            </strong>
          </p>
          {item.delta! > 0 && (
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void runAction(
                { action: 'check', round, foodKey: item.foodKey, unit: item.unit, cooked: item.cooked, name: item.name, quantity: item.toBuy },
                'Acquisto aggiuntivo salvato.',
              )}
            >
              Segna come aggiunto
            </button>
          )}
        </div>
      ))}
      <details className="grocery-item-details">
        <summary>Pasti e dettagli</summary>
        <div className="grocery-item-details-body">
          <ul className="grocery-uses" aria-label={`Pasti che usano ${line.name}`}>
            {[...line.uses].sort((left, right) => left.date.localeCompare(right.date)).map((use, index) => (
              <li key={index}>
                <span className="grocery-use-when">
                  {use.dayName.slice(0, 3)} {Number(use.date.slice(8))} · {SLOT_LABELS[use.slot]}
                </span>{' '}
                <FoodText food={{ ...use, state: use.state ?? undefined }} />
                {use.substitution === 'alternative' && <span className="summary-note"> · alternativa scelta</span>}
                {use.substitution === 'equivalence' && <span className="summary-note"> · equivalenza</span>}
              </li>
            ))}
          </ul>
          {!line.cooked && (
            <PantryForm key={pantry ?? ''} line={line} pantry={pantry} busy={busy} runAction={runAction} />
          )}
          <details className="grocery-secondary">
            <summary>Opzioni alimento</summary>
            <FoodRulesForm key={JSON.stringify([food.aisle, food.rules])} food={food} aisles={aisles} busy={busy} runAction={runAction} />
          </details>
        </div>
      </details>
    </li>
  )
}

function PantryForm({ line, pantry, busy, runAction }: { line: GroceryLine; pantry: number | null; busy: boolean; runAction: RunAction }) {
  const id = useId()

  function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = String(new FormData(event.currentTarget).get('quantity') ?? '').trim()
    void runAction(
      { action: 'setPantry', foodKey: line.foodKey, unit: line.unit, name: line.name, quantity: value === '' ? null : Number(value) },
      'Dispensa aggiornata.',
    )
  }

  return (
    <form className="week-form grocery-inline-form" onSubmit={save}>
      <label htmlFor={id}>In casa prima della spesa di lunedì ({unitName(line.unit)})</label>
      <div className="grocery-field-row">
        <input id={id} name="quantity" type="number" inputMode="decimal" min="0" step="any" defaultValue={pantry ?? ''} disabled={busy} />
        <button className="secondary-button" type="submit" disabled={busy}>
          Salva dispensa
        </button>
      </div>
    </form>
  )
}

function FoodRulesForm({ food, aisles, busy, runAction }: { food: GroceryFood; aisles: string[]; busy: boolean; runAction: RunAction }) {
  const id = useId()
  const [unit, setUnit] = useState<string | null>(food.rules?.unit ?? null)
  const units = [...new Set([...food.units, 'g', 'ml'])]
  const others = unit === null ? [] : food.units.filter((other) => other !== unit)
  // Saved factors and package size refer to the saved unit only.
  const saved = unit !== null && unit === food.rules?.unit ? food.rules : null
  const factors = new Map(saved?.conversions.map((conversion) => [conversion.unit, conversion.factor]))

  function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const number = (name: string) => {
      const value = String(form.get(name) ?? '').trim()
      return value === '' ? null : Number(value)
    }
    void runAction(
      {
        action: 'setFoodRules',
        foodKey: food.key,
        aisle: String(form.get('aisle') ?? '').trim() || null,
        unit,
        packageSize: unit === null ? null : number('packageSize'),
        storageDays: number('storageDays'),
        alwaysAtHome: form.get('alwaysAtHome') === 'on',
        conversions: others.flatMap((other, index) => {
          const factor = number(`conversion-${index}`)
          return factor === null ? [] : [{ unit: other, factor }]
        }),
      },
      'Regole salvate.',
    )
  }

  return (
    <form className="week-form grocery-rules-form" onSubmit={save}>
      <fieldset disabled={busy}>
        <legend>Regole per {food.name}</legend>
        {food.foodId === null && (
          <p className="field-hint">Salvando, «{food.name}» entra nel catalogo degli alimenti con queste regole.</p>
        )}
        <label htmlFor={`${id}-aisle`}>Reparto</label>
        <input id={`${id}-aisle`} name="aisle" type="text" list={`${id}-aisles`} maxLength={60} defaultValue={food.aisle ?? ''} />
        <datalist id={`${id}-aisles`}>
          {aisles.map((aisle) => (
            <option key={aisle} value={aisle} />
          ))}
        </datalist>
        <label htmlFor={`${id}-unit`}>Unità della lista</label>
        <select id={`${id}-unit`} value={JSON.stringify(unit)} onChange={(event) => setUnit(JSON.parse(event.currentTarget.value) as string | null)}>
          <option value="null">Come nel piano, senza conversioni</option>
          {units.map((option) => (
            <option key={option} value={JSON.stringify(option)}>
              {option || 'numero (senza unità)'}
            </option>
          ))}
        </select>
        {unit !== null && (
          <>
            {others.map((other, index) => (
              <Fragment key={`${unit}:${other}`}>
                <label htmlFor={`${id}-conversion-${index}`}>
                  Quanto vale 1 {other || 'elemento senza unità'} in {unitName(unit)}
                </label>
                <input
                  id={`${id}-conversion-${index}`}
                  name={`conversion-${index}`}
                  type="number"
                  inputMode="decimal"
                  min="0.001"
                  step="any"
                  defaultValue={factors.get(other) ?? ''}
                />
              </Fragment>
            ))}
            <label htmlFor={`${id}-package`}>Una confezione contiene ({unitName(unit)})</label>
            <input
              key={unit}
              id={`${id}-package`}
              name="packageSize"
              type="number"
              inputMode="decimal"
              min="0.001"
              step="any"
              defaultValue={saved?.packageSize ?? ''}
            />
          </>
        )}
        <label htmlFor={`${id}-storage`}>Si conserva per (giorni dall’acquisto)</label>
        <input
          id={`${id}-storage`}
          name="storageDays"
          type="number"
          inputMode="numeric"
          min="0"
          max="365"
          step="1"
          defaultValue={food.rules?.storageDays ?? ''}
        />
        <p className="field-hint">
          Vuoto: gli usi da giovedì a domenica vanno nel giro del giovedì. Con 3 giorni o più anche gli usi del giovedì si
          comprano lunedì; con 6, tutta la settimana.
        </p>
        <label className="grocery-checkbox-label">
          <input name="alwaysAtHome" type="checkbox" defaultChecked={food.rules?.alwaysAtHome ?? false} />
          Sempre in casa: non metterlo in lista
        </label>
        <button className="secondary-button" type="submit">
          Salva le regole
        </button>
      </fieldset>
    </form>
  )
}

function NoLongerNeeded({ round, busy, runAction }: { round: GroceryRoundView; busy: boolean; runAction: RunAction }) {
  if (round.noLongerNeeded.length === 0) return null
  return (
    <section className="grocery-aisle grocery-removed" aria-label="Non più necessario">
      <h4>Non più necessario</h4>
      <p className="field-hint">Li avevi spuntati, ma con la settimana di adesso non servono più in questo giro.</p>
      <ul className="grocery-items">
        {round.noLongerNeeded.map((item) => (
          <li key={JSON.stringify([item.foodKey, item.unit, item.cooked])} className="grocery-item">
            <div className="grocery-item-main">
              <div className="grocery-item-title">
                <span className="grocery-item-name">
                  {item.name}
                  {item.cooked && ' (peso a cotto)'}
                </span>
                <span className="grocery-item-amount">
                  {item.quantity !== null ? `acquistato ${amount(item.quantity, item.unit)}` : 'acquistato'}
                </span>
              </div>
              <button
                className="text-button"
                type="button"
                disabled={busy}
                aria-label={`Togli la spunta di ${item.name}`}
                onClick={() =>
                  void runAction(
                    { action: 'uncheck', round: round.round, foodKey: item.foodKey, unit: item.unit, cooked: item.cooked },
                    'Spunta tolta.',
                  )
                }
              >
                Togli la spunta
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ManualItems({ items, busy, runAction }: { items: GroceryRoundView['manual']; busy: boolean; runAction: RunAction }) {
  const id = useId()

  async function add(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const label = String(data.get('label') ?? '').trim()
    if (!label) return
    const added = await runAction(
      {
        action: 'addManual',
        round: 'monday',
        id: crypto.randomUUID(),
        label,
        quantityText: String(data.get('quantity') ?? '').trim() || null,
      },
      'Voce aggiunta.',
    )
    if (added) form.reset()
  }

  return (
    <section className="grocery-aisle grocery-manual" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Altre cose da comprare</h3>
      {items.length > 0 && (
        <ul className="grocery-items">
          {items.map((item) => (
            <li key={item.id} className={item.checkedAt ? 'grocery-item grocery-item-checked' : 'grocery-item'}>
              <div className="grocery-item-main">
                <input
                  id={`${id}-${item.id}`}
                  type="checkbox"
                  checked={item.checkedAt !== null}
                  aria-disabled={busy}
                  onChange={(event) => void runAction({ action: 'setManualChecked', id: item.id, checked: event.currentTarget.checked })}
                />
                <label htmlFor={`${id}-${item.id}`}>
                  <span className="grocery-item-name">{item.label}</span>
                  {item.quantityText && <span className="grocery-item-amount">{item.quantityText}</span>}
                </label>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  aria-label={`Togli ${item.label}`}
                  onClick={() => void runAction({ action: 'deleteManual', id: item.id }, 'Voce tolta.')}
                >
                  Togli
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="week-form grocery-manual-form" onSubmit={add}>
        <label htmlFor={`${id}-label`}>Aggiungi alla lista</label>
        <input id={`${id}-label`} name="label" type="text" required maxLength={120} disabled={busy} />
        <label htmlFor={`${id}-quantity`}>Quantità (facoltativa)</label>
        <input id={`${id}-quantity`} name="quantity" type="text" maxLength={60} disabled={busy} />
        <button className="secondary-button" type="submit" disabled={busy}>
          Aggiungi
        </button>
      </form>
    </section>
  )
}

function PantrySummary({ view, busy, runAction }: { view: GroceryView; busy: boolean; runAction: RunAction }) {
  return (
    <section className="week-free-panel grocery-panel" aria-labelledby="grocery-pantry-title">
      <h3 id="grocery-pantry-title">Dispensa della settimana</h3>
      <p>
        Quello che hai già in casa prima della spesa di lunedì: copre prima il giro di lunedì, poi quello di giovedì.
        Indicalo nei dettagli di ogni alimento; gli articoli spuntati in lista non vanno aggiunti qui.
      </p>
      {view.pantry.length === 0 ? (
        <p className="summary-missing">Nessuna scorta indicata per questa settimana.</p>
      ) : (
        <ul className="grocery-panel-list">
          {view.pantry.map((entry) => (
            <li key={JSON.stringify([entry.foodKey, entry.unit])}>
              <span>
                <strong>{entry.name}</strong> {amount(entry.quantity, entry.unit)}
                {!entry.used && <span className="summary-missing"> · nessun alimento in lista con questa unità</span>}
              </span>
              <button
                className="text-button"
                type="button"
                disabled={busy}
                aria-label={`Togli ${entry.name} dalla dispensa`}
                onClick={() =>
                  void runAction(
                    { action: 'setPantry', foodKey: entry.foodKey, unit: entry.unit, name: entry.name, quantity: null },
                    'Dispensa aggiornata.',
                  )
                }
              >
                Togli
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function AlwaysAtHome({ view, busy, runAction }: { view: GroceryView; busy: boolean; runAction: RunAction }) {
  const foods = view.foods.filter((food) => view.alwaysAtHome.includes(food.key))
  if (foods.length === 0) return null
  return (
    <section className="week-free-panel grocery-panel" aria-labelledby="grocery-home-title">
      <h3 id="grocery-home-title">Sempre in casa</h3>
      <p>Usati questa settimana ma esclusi dalla lista, perché li tieni sempre in casa.</p>
      <ul className="grocery-panel-list">
        {foods.map((food) => (
          <li key={food.key}>
            <details className="grocery-item-details">
              <summary>{food.name}</summary>
              <FoodRulesForm key={JSON.stringify([food.aisle, food.rules])} food={food} aisles={view.aisles} busy={busy} runAction={runAction} />
            </details>
          </li>
        ))}
      </ul>
    </section>
  )
}
