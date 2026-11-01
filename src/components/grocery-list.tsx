import { useEffect, useId, useRef, useState } from 'react'
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

// Round identities stay internal so existing purchases keep their meaning even
// though the shopping screen presents one weekly list.
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

function formatDay(date: string, options: Intl.DateTimeFormatOptions = {}): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('it-IT', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    ...options,
  })
}

function purchaseText(line: GroceryLine): string {
  if (line.toBuy === null) return line.cooked && line.needed !== null ? `${amount(line.needed, line.unit)} a cotto` : ''
  if (line.packages === null) return amount(line.toBuy, line.unit)
  return `${line.packages} ${line.packages === 1 ? 'confezione' : 'confezioni'} · ${amount(line.toBuy, line.unit)}`
}

export function GroceryList({ weekStart, onWeekChange }: { weekStart: string | null; onWeekChange: (start: string | null) => void }) {
  const [view, setView] = useState<GroceryView | null>(null)
  const [pending, setPending] = useState<'load' | 'action' | null>('load')
  const [error, setError] = useState('')
  const actionPending = useRef(false)
  const [loadRevision, setLoadRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    setPending('load')
    setError('')
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

  async function runActions(actions: GroceryAction[]): Promise<boolean> {
    if (!view || pending !== null || actionPending.current || actions.length === 0) return false
    actionPending.current = true
    setPending('action')
    setError('')
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
      return true
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Modifica non riuscita.'
      setError(`${saved > 0 ? `Salvate ${saved} di ${actions.length} modifiche. ` : ''}${message}`)
      try {
        setView(await apiRequest<GroceryView>(`/api/groceries?start=${encodeURIComponent(view.weekStart)}`))
      } catch {
        // Keep the last server-confirmed response, never a locally assumed save.
      }
      return false
    } finally {
      actionPending.current = false
      setPending(null)
    }
  }

  const runAction: RunAction = (action) => runActions([action])

  const busy = pending !== null
  const aisles = view ? weeklyAisles(view.rounds) : []
  const isCurrentWeek = view ? view.today >= view.weekStart && view.today <= view.weekEnd : true

  return (
    <section className="grocery-list" aria-labelledby="grocery-list-title" aria-busy={busy}>
      <header className="week-header">
        <button className="week-arrow" type="button" aria-label="Settimana precedente" onClick={() => view && onWeekChange(view.previousWeekStart)} disabled={busy || !view}>←</button>
        <div className="week-header-title">
          <span className="eyebrow">Spesa</span>
          <h2 id="grocery-list-title">{view ? `${formatDay(view.weekStart)} – ${formatDay(view.weekEnd)}` : 'Caricamento…'}</h2>
        </div>
        <button className="week-arrow" type="button" aria-label="Settimana successiva" onClick={() => view && onWeekChange(view.nextWeekStart)} disabled={busy || !view}>→</button>
      </header>
      {!isCurrentWeek && (
        <button className="text-button week-back" type="button" onClick={() => onWeekChange(null)} disabled={busy}>Torna a questa settimana</button>
      )}

      {error && (
        <div className="grocery-feedback" role="alert">
          <p>{error}</p>
          <button className="text-button" type="button" disabled={busy} onClick={() => setLoadRevision((revision) => revision + 1)}>Ricarica</button>
        </div>
      )}

      {view && !view.planned && (
        <div className="week-empty">
          <p>Non c’è una dieta attiva per questa settimana.</p>
          <Link className="primary-button" to="/dieta">Carica la dieta</Link>
        </div>
      )}

      {view && view.planned && (
        <>
          <OpenDays view={view} />
          <GroceryItems view={view} aisles={aisles} busy={busy} runAction={runAction} runActions={runActions} />
          <NoLongerNeeded view={view} />
          <ManualItems items={view.rounds.flatMap((round) => round.manual)} busy={busy} runAction={runAction} />
          <AlwaysAtHome view={view} busy={busy} runAction={runAction} />
        </>
      )}
    </section>
  )
}

// Days whose choices are still open contribute nothing until they are decided.
function OpenDays({ view }: { view: GroceryView }) {
  // Past days can no longer be planned: they simply do not count.
  const open = view.unplannedDays.filter((day) => day.date >= view.today)
  if (open.length === 0) return null
  const names = open.map((day) => day.dayName.toLowerCase())
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} e ${names.at(-1)}`
  return (
    <div className="week-notice">
      <p>
        Mancano delle scelte per {list}: quei pasti non sono ancora nella lista.
      </p>
      <Link className="text-button" to="/settimana" search={{ start: view.weekStart, date: open[0]!.date }}>
        Scegli i pasti →
      </Link>
    </div>
  )
}

function GroceryItems({ view, aisles, busy, runAction, runActions }: {
  view: GroceryView
  aisles: ReturnType<typeof weeklyAisles>
  busy: boolean
  runAction: RunAction
  runActions: RunActions
}) {
  const foods = new Map(view.foods.map((food) => [food.key, food]))
  const items = aisles.flatMap((aisle) => aisle.lines)
  const done = items.filter(({ contributions }) => isTaken(contributions)).length
  if (items.length === 0) {
    return <p className="grocery-empty">Niente da comprare per i pasti scelti.</p>
  }
  return (
    <div className="grocery-week">
      <p className="grocery-progress">{done === items.length ? 'Hai preso tutto.' : `${done} di ${items.length} presi`}</p>
      {aisles.map((aisle) => (
        <section className="grocery-aisle" key={aisle.name ?? ''} aria-label={aisle.name ?? 'Senza reparto'}>
          {(aisle.name !== null || aisles.length > 1) && <h3>{aisle.name ?? 'Senza reparto'}</h3>}
          <ul className="grocery-items">
            {/* Taken items sink to the bottom of their aisle. */}
            {[...aisle.lines]
              .sort((left, right) => Number(isTaken(left.contributions)) - Number(isTaken(right.contributions)))
              .map(({ line, contributions }) => (
                <GroceryItem
                  key={JSON.stringify([line.foodKey, line.unit, line.cooked])}
                  contributions={contributions}
                  line={line}
                  food={foods.get(line.foodKey)!}
                  aisles={view.aisles}
                  busy={busy}
                  runAction={runAction}
                  runActions={runActions}
                />
              ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function checkableOf(contributions: RoundLine[]): RoundLine[] {
  return contributions.filter(({ line }) => line.check !== null || line.toBuy !== 0)
}

function isChecked(contributions: RoundLine[]): boolean {
  const lines = checkableOf(contributions)
  return lines.length > 0 && lines.every(({ line }) => line.check !== null)
}

// Taken means nothing left to buy: a purchase the meals have since outgrown
// ("+X") is checked but not taken.
function isTaken(contributions: RoundLine[]): boolean {
  return isChecked(contributions) && !contributions.some(({ line }) => line.check !== null && line.delta !== null && line.delta > 0)
}

function GroceryItem({
  contributions,
  line,
  food,
  aisles,
  busy,
  runAction,
  runActions,
}: {
  contributions: RoundLine[]
  line: GroceryLine
  food: GroceryFood
  aisles: string[]
  busy: boolean
  runAction: RunAction
  runActions: RunActions
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const checkableLines = checkableOf(contributions)
  const checked = isChecked(contributions)
  const partiallyChecked = !checked && checkableLines.some(({ line: item }) => item.check !== null)
  const additions = contributions.filter(({ line: item }) => item.check && item.delta !== null && item.delta > 0)

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

  // Facts that change what to buy, in a single short line; missing or
  // ambiguous data stays visible instead of being guessed.
  const notes = [
    line.packages !== null && line.packageSize !== null && `${line.packages} × ${amount(line.packageSize, line.unit)}`,
    line.cooked && 'peso a cotto: quantità a crudo non calcolata',
    line.unquantifiedUses > 0 && (line.needed === null ? 'quantità non indicata nella dieta' : `${line.unquantifiedUses === 1 ? '1 uso' : `${line.unquantifiedUses} usi`} senza quantità`),
    line.unspecifiedStateUses > 0 && 'crudo/cotto non specificato',
    (line.mixedUnits || line.unconvertedUnit) && 'anche in altre unità',
    partiallyChecked && 'preso in parte',
  ].filter(Boolean)

  return (
    <li className={checked && additions.length === 0 ? 'grocery-item grocery-item-checked' : 'grocery-item'}>
      <div className="grocery-item-main">
        {checkableLines.length > 0 ? (
          <input
            id={id}
            type="checkbox"
            checked={checked}
            ref={(input) => { if (input) input.indeterminate = partiallyChecked }}
            // Keep keyboard and VoiceOver focus during online saves.
            aria-disabled={busy}
            onChange={() => { if (!busy) toggle() }}
          />
        ) : <span className="grocery-item-spacer" aria-hidden="true" />}
        <label htmlFor={checkableLines.length > 0 ? id : undefined}>
          <span className="grocery-item-name">{line.name}</span>
          <span className="grocery-item-amount">{purchaseText(line)}</span>
        </label>
        <button
          className="grocery-item-more"
          type="button"
          aria-label={`Dettagli di ${line.name}`}
          aria-expanded={open}
          aria-controls={`${id}-details`}
          onClick={() => setOpen(!open)}
        >
          ⋯
        </button>
      </div>
      {open && <ItemDetails id={`${id}-details`} line={line} food={food} aisles={aisles} busy={busy} runAction={runAction} />}
      {notes.length > 0 && <p className="grocery-item-facts">{notes.join(' · ')}</p>}
      {additions.map(({ round, line: item }) => (
        <div key={round} className="grocery-delta">
          <p>Dopo le ultime modifiche ai pasti: <strong>+{amount(item.delta!, item.unit)}</strong></p>
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => void runAction(
              { action: 'check', round, foodKey: item.foodKey, unit: item.unit, cooked: item.cooked, name: item.name, quantity: item.toBuy },
            )}
          >
            Preso
          </button>
        </div>
      ))}
    </li>
  )
}

// Saving keeps the food's other rules (units, packages, storage) as they are.
function saveFoodRules(food: GroceryFood, change: { aisle?: string | null; alwaysAtHome?: boolean }): GroceryAction {
  return {
    action: 'setFoodRules',
    foodKey: food.key,
    aisle: change.aisle !== undefined ? change.aisle : food.aisle,
    unit: food.rules?.unit ?? null,
    packageSize: food.rules?.packageSize ?? null,
    storageDays: food.rules?.storageDays ?? null,
    alwaysAtHome: change.alwaysAtHome ?? food.rules?.alwaysAtHome ?? false,
    conversions: food.rules?.conversions ?? [],
  }
}

function ItemDetails({ id: detailsId, line, food, aisles, busy, runAction }: {
  id: string
  line: GroceryLine
  food: GroceryFood
  aisles: string[]
  busy: boolean
  runAction: RunAction
}) {
  const id = useId()
  return (
    <div className="grocery-item-details" id={detailsId}>
      <ul className="grocery-uses" aria-label={`Pasti che usano ${line.name}`}>
        {[...line.uses].sort((left, right) => left.date.localeCompare(right.date)).map((use, index) => (
          <li key={index}>
            <span className="grocery-use-when">{use.dayName.slice(0, 3)} · {SLOT_LABELS[use.slot]}</span>{' '}
            <FoodText food={{ ...use, state: use.state ?? undefined }} />
          </li>
        ))}
      </ul>
      <form className="grocery-inline-form" onSubmit={(event) => {
        event.preventDefault()
        const aisle = String(new FormData(event.currentTarget).get('aisle') ?? '').trim() || null
        if (aisle !== food.aisle) void runAction(saveFoodRules(food, { aisle }))
      }}>
        <label htmlFor={`${id}-aisle`}>Reparto</label>
        <div className="grocery-field-row">
          <input id={`${id}-aisle`} name="aisle" type="text" list={`${id}-aisles`} maxLength={60} defaultValue={food.aisle ?? ''} disabled={busy} />
          <datalist id={`${id}-aisles`}>
            {aisles.map((aisle) => <option key={aisle} value={aisle} />)}
          </datalist>
          <button className="text-button" type="submit" disabled={busy}>Salva</button>
        </div>
      </form>
      <button className="text-button" type="button" disabled={busy} onClick={() => void runAction(saveFoodRules(food, { alwaysAtHome: true }))}>
        Ce l’ho sempre in casa: non metterlo in lista
      </button>
    </div>
  )
}

function ManualItems({ items, busy, runAction }: { items: GroceryRoundView['manual']; busy: boolean; runAction: RunAction }) {
  const id = useId()

  async function add(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const label = String(new FormData(form).get('label') ?? '').trim()
    if (!label) return
    const added = await runAction({ action: 'addManual', round: 'monday', id: crypto.randomUUID(), label, quantityText: null })
    if (added) form.reset()
  }

  return (
    <section className="grocery-aisle grocery-manual" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Aggiunte tue</h3>
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
                  onChange={(event) => { if (!busy) void runAction({ action: 'setManualChecked', id: item.id, checked: event.currentTarget.checked }) }}
                />
                <label htmlFor={`${id}-${item.id}`}>
                  <span className="grocery-item-name">{item.label}</span>
                  {item.quantityText && <span className="grocery-item-amount">{item.quantityText}</span>}
                </label>
                <button
                  className="grocery-remove"
                  type="button"
                  disabled={busy}
                  aria-label={`Togli ${item.label}`}
                  onClick={() => void runAction({ action: 'deleteManual', id: item.id })}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="grocery-add" onSubmit={add}>
        <label className="visually-hidden" htmlFor={`${id}-label`}>Aggiungi alla lista</label>
        <input id={`${id}-label`} name="label" type="text" required maxLength={120} placeholder="Aggiungi qualcos’altro…" disabled={busy} />
        <button className="secondary-button" type="submit" disabled={busy}>Aggiungi</button>
      </form>
    </section>
  )
}

// Purchases already made for meals that changed afterwards: shown so they
// are not silently forgotten.
function NoLongerNeeded({ view }: { view: GroceryView }) {
  // One tap records a check per round: merge them per line, as the list does.
  const merged = new Map<string, GroceryRoundView['noLongerNeeded'][number]>()
  for (const item of view.rounds.flatMap((round) => round.noLongerNeeded)) {
    const key = JSON.stringify([item.foodKey, item.unit, item.cooked])
    const previous = merged.get(key)
    merged.set(key, previous
      ? { ...previous, quantity: previous.quantity === null || item.quantity === null ? null : previous.quantity + item.quantity }
      : item)
  }
  const items = [...merged.values()].sort((left, right) => left.name.localeCompare(right.name, 'it'))
  if (items.length === 0) return null
  return (
    <details className="grocery-home">
      <summary>Comprati ma non più nei pasti ({items.length})</summary>
      <ul>
        {items.map((item) => (
          <li key={JSON.stringify([item.foodKey, item.unit, item.cooked])}>
            <span>{item.name}</span>
            {item.quantity !== null && <span>{amount(item.quantity, item.unit)}</span>}
          </li>
        ))}
      </ul>
    </details>
  )
}

function AlwaysAtHome({ view, busy, runAction }: { view: GroceryView; busy: boolean; runAction: RunAction }) {
  const foods = view.foods.filter((food) => view.alwaysAtHome.includes(food.key))
  if (foods.length === 0) return null
  return (
    <details className="grocery-home">
      <summary>Sempre in casa ({foods.length})</summary>
      <ul>
        {foods.map((food) => (
          <li key={food.key}>
            <span>{food.name}</span>
            <button className="text-button" type="button" disabled={busy} onClick={() => void runAction(saveFoodRules(food, { alwaysAtHome: false }))}>
              Rimetti in lista
            </button>
          </li>
        ))}
      </ul>
    </details>
  )
}
