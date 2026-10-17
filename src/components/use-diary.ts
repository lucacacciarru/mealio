import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlanSlot } from '../db/schema'
import { CHECK_IN_NOTE_MAX_LENGTH } from '../diary'
import type { DiaryDay, DiaryMutation } from '../diary'

type QueuedMutation = {
  sequence?: number
  mutation: DiaryMutation
  plans: DiaryDay['meals'][number]['plan'][]
  problem?: { kind: 'conflict'; message: string; day: DiaryDay } | { kind: 'retry' | 'blocked'; message: string }
}
type Metadata = { key: string; value: string | number } | { key: 'lease'; owner: string; until: number }
type LocalState = { day: DiaryDay | null; queue: QueuedMutation[]; expiresAt: number; generation: string }
type SyncResult = { kind: 'done' | 'busy' | 'offline' | 'expired' | 'conflict' | 'failed'; message?: string; reachable?: boolean }

const DATABASE = 'mealio-diary'
const CHANGE_EVENT = 'mealio-diary-change'
const SESSION_ERROR = 'Sessione scaduta. Accedi di nuovo: le registrazioni in attesa sono conservate.'
const STORAGE_ERROR = 'Memoria locale non disponibile. La registrazione non è stata salvata; libera spazio o abilita la memoria del browser e riprova.'
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' })
let database: Promise<IDBDatabase> | undefined
let channel: BroadcastChannel | undefined
let syncing: Promise<SyncResult> | undefined
let assetObserver: PerformanceObserver | undefined

function todayInRome(time = Date.now()): string {
  const parts = dateFormatter.formatToParts(time)
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)!.value).join('-')
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Operazione non riuscita.'
}

function changes(): BroadcastChannel | undefined {
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(CHANGE_EVENT)
      channel.onmessage = () => window.dispatchEvent(new Event(CHANGE_EVENT))
    } catch {
      // IndexedDB transactions still serialize tabs; the active timer refreshes
      // views when the browser disables optional cross-tab notifications.
    }
  }
  return channel
}

function announce() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(CHANGE_EVENT))
  try { changes()?.postMessage('changed') } catch { /* Periodic refresh remains available. */ }
}

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error(STORAGE_ERROR))
        return
      }
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('days', { keyPath: 'date' })
        request.result.createObjectStore('queue', { keyPath: 'sequence', autoIncrement: true })
        request.result.createObjectStore('metadata', { keyPath: 'key' })
      }
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => { db.close(); database = undefined }
        resolve(db)
      }
      request.onerror = () => reject(new Error(STORAGE_ERROR))
      request.onblocked = () => reject(new Error('Chiudi le altre schede di Mealio per aggiornare la memoria locale.'))
    }).catch((cause: unknown) => { database = undefined; throw cause })
  }
  return database
}

function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error(STORAGE_ERROR))
  })
}

async function transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openDatabase()
  let tx: IDBTransaction
  try {
    // Strict durability asks the browser to flush accepted writes before reporting success.
    tx = db.transaction(['days', 'queue', 'metadata'], mode, mode === 'readwrite' ? { durability: 'strict' } : undefined)
  } catch {
    throw new Error(STORAGE_ERROR)
  }
  const completed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(new Error(STORAGE_ERROR))
  })
  // Attach the rejection handler immediately, including when work itself fails first.
  void completed.catch(() => undefined)
  try {
    const result = await work(tx)
    await completed
    return result
  } catch (cause) {
    try { tx.abort() } catch { /* The transaction may already have aborted. */ }
    await completed.catch(() => undefined)
    throw cause
  }
}

async function localState(tx: IDBTransaction, date: string): Promise<LocalState> {
  const [day, queue, session, generation] = await Promise.all([
    requested<DiaryDay | undefined>(tx.objectStore('days').get(date)),
    requested<QueuedMutation[]>(tx.objectStore('queue').getAll()),
    requested<Metadata | undefined>(tx.objectStore('metadata').get('expiresAt')),
    requested<Metadata | undefined>(tx.objectStore('metadata').get('generation')),
  ])
  return {
    day: day ?? null,
    queue,
    expiresAt: session && 'value' in session ? Number(session.value) : 0,
    generation: generation && 'value' in generation ? String(generation.value) : '',
  }
}

function overlay(state: LocalState): DiaryDay | null {
  if (!state.day) return null
  const day: DiaryDay = { ...state.day, today: todayInRome(), meals: state.day.meals.map((meal) => ({ ...meal })) }
  for (const queued of state.queue) {
    if (queued.mutation.date !== day.date) continue
    for (const entry of queued.mutation.entries) {
      const meal = day.meals.find((item) => item.plan.slot === entry.slot)
      if (!meal) continue
      if (!meal.checkIn) meal.plan = queued.plans.find((plan) => plan.slot === entry.slot) ?? meal.plan
      meal.checkIn = { followed: entry.followed, note: entry.note, recordedAt: entry.recordedAt, revision: entry.baseRevision + 1 }
    }
  }
  return day
}

// A late GET or a duplicated, timed-out POST must not replace a newer check-in.
async function cacheDay(tx: IDBTransaction, incoming: DiaryDay) {
  const store = tx.objectStore('days')
  const existing = await requested<DiaryDay | undefined>(store.get(incoming.date))
  const day = {
    ...incoming,
    meals: incoming.meals.map((meal) => {
      const previous = existing?.meals.find((item) => item.plan.slot === meal.plan.slot)
      return previous?.checkIn && previous.checkIn.revision > (meal.checkIn?.revision ?? 0) ? previous : meal
    }),
  }
  await requested(store.put(day))
}

export async function rememberDiarySession(expiresAt: number): Promise<void> {
  if (!Number.isFinite(expiresAt)) throw new Error('Scadenza della sessione non valida.')
  await transaction('readwrite', async (tx) => {
    const metadata = tx.objectStore('metadata')
    if (expiresAt > Date.now()) await requested(metadata.put({ key: 'expiresAt', value: expiresAt }))
    else await requested(metadata.delete('expiresAt'))
  })
  announce()
}

export async function hasOfflineDiarySession(): Promise<boolean> {
  return transaction('readonly', async (tx) => {
    const [session, days] = await Promise.all([
      requested<Metadata | undefined>(tx.objectStore('metadata').get('expiresAt')),
      requested(tx.objectStore('days').count()),
    ])
    const expiresAt = session && 'value' in session ? Number(session.value) : 0
    return expiresAt > Date.now() && days > 0
  })
}

export async function pendingDiaryCount(): Promise<number> {
  return transaction('readonly', async (tx) => requested(tx.objectStore('queue').count()))
}

export async function clearDiaryStorage(discardPending: boolean): Promise<void> {
  await transaction('readwrite', async (tx) => {
    if (!discardPending && await requested(tx.objectStore('queue').count()) > 0) {
      throw new Error('Ci sono nuovi check-in in attesa: i dati locali sono stati conservati. Accedi per sincronizzarli.')
    }
    await Promise.all(['days', 'queue', 'metadata'].map((name) => requested(tx.objectStore(name).clear())))
    await requested(tx.objectStore('metadata').put({ key: 'generation', value: crypto.randomUUID() }))
  })
  announce()
}

export async function registerDiaryWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) throw new Error('Questo browser non supporta il caricamento offline di Mealio.')
  const registration = await navigator.serviceWorker.register('/diary-sw.js', { scope: '/', updateViaCache: 'none' })
  const sendAssets = () => {
    const worker = registration.active
    if (!worker) return
    worker.postMessage({ type: 'CACHE_PUBLIC_ASSETS', urls: performance.getEntriesByType('resource').map((entry) => entry.name) })
  }
  if (!registration.active) {
    const worker = registration.installing ?? registration.waiting
    if (!worker) throw new Error('Impossibile preparare Mealio per il caricamento offline.')
    await new Promise<void>((resolve, reject) => {
      const stateChanged = () => {
        if (worker.state === 'activated' || worker.state === 'redundant') {
          worker.removeEventListener('statechange', stateChanged)
          if (worker.state === 'activated') resolve()
          else reject(new Error('Preparazione offline non riuscita. Collegati e ricarica Mealio.'))
        }
      }
      worker.addEventListener('statechange', stateChanged)
      stateChanged()
    })
  }
  if (!assetObserver && typeof PerformanceObserver !== 'undefined') {
    assetObserver = new PerformanceObserver((list) => {
      const worker = navigator.serviceWorker.controller ?? registration.active
      worker?.postMessage({ type: 'CACHE_PUBLIC_ASSETS', urls: list.getEntries().map((entry) => entry.name) })
    })
    assetObserver.observe({ type: 'resource', buffered: true })
  }
  sendAssets()
}

async function requestDiary(date: string | null): Promise<DiaryDay> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(date ? `/api/diary?date=${encodeURIComponent(date)}` : '/api/diary', {
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
    })
    if (response.status === 401) {
      await rememberDiarySession(0)
      throw new DiaryRequestError(SESSION_ERROR, false, true)
    }
    const payload = await response.json() as DiaryDay & { error?: string }
    if (!response.ok) throw new DiaryRequestError(payload.error ?? 'Impossibile caricare il diario.', response.status >= 500)
    return payload
  } finally { window.clearTimeout(timeout) }
}

class DiaryRequestError extends Error {
  constructor(text: string, readonly transient: boolean, readonly expired = false) { super(text) }
}

async function enqueue(expected: DiaryDay, selected: PlanSlot | null, followed: boolean, note: string | null): Promise<boolean> {
  const date = expected.date
  return transaction('readwrite', async (tx) => {
    const state = await localState(tx, date)
    if (state.expiresAt <= Date.now()) throw new Error(SESSION_ERROR)
    if (date !== todayInRome()) throw new Error('Il giorno è cambiato. Apri Oggi prima di registrare un pasto.')
    if (state.queue.some((item) => item.problem?.kind === 'conflict')) throw new Error('Risolvi il conflitto prima di aggiungere registrazioni.')
    const day = overlay(state)
    if (!day || !day.snapshotId) throw new Error('Questo giorno non è disponibile nella memoria locale. Caricalo online prima di registrare.')
    if (selected && !day.meals.some((meal) => meal.plan.slot === selected)) throw new Error('Pasto non disponibile per questo giorno.')
    if (day.snapshotId !== expected.snapshotId) throw new Error('Il piano è cambiato in un’altra scheda. Ricarica Oggi prima di registrare.')
    if (selected) {
      const currentRevision = day.meals.find((meal) => meal.plan.slot === selected)?.checkIn?.revision ?? 0
      const expectedRevision = expected.meals.find((meal) => meal.plan.slot === selected)?.checkIn?.revision ?? 0
      if (currentRevision !== expectedRevision) throw new Error('Questo pasto è cambiato in un’altra scheda. Rileggi la registrazione prima di modificarla.')
    }
    const recordedAt = Date.now()
    if (todayInRome(recordedAt) !== date) throw new Error('Il giorno è cambiato. Apri Oggi prima di registrare un pasto.')
    const entries: DiaryMutation['entries'] = []
    const plans: QueuedMutation['plans'] = []
    for (const meal of day.meals) {
      if (selected && meal.plan.slot !== selected) continue
      const nextNote = selected ? note?.trim() || null : meal.checkIn?.note ?? null
      const nextFollowed = selected ? followed : true
      if (nextNote && nextNote.length > CHECK_IN_NOTE_MAX_LENGTH) throw new Error(`La nota può contenere al massimo ${CHECK_IN_NOTE_MAX_LENGTH} caratteri.`)
      if (meal.checkIn?.followed === nextFollowed && meal.checkIn.note === nextNote) continue
      entries.push({ slot: meal.plan.slot, followed: nextFollowed, note: nextNote, recordedAt, baseRevision: meal.checkIn?.revision ?? 0 })
      plans.push(meal.plan)
    }
    if (entries.length === 0) return false
    const queued: QueuedMutation = { mutation: { id: crypto.randomUUID(), date, snapshotId: day.snapshotId, entries }, plans }
    await requested(tx.objectStore('queue').add(queued))
    return true
  })
}

type Work = { queued: QueuedMutation; generation: string } | SyncResult

async function claimWork(owner: string): Promise<Work> {
  return transaction<Work>('readwrite', async (tx) => {
    const state = await localState(tx, todayInRome())
    if (!state.queue.length) return { kind: 'done' }
    if (state.expiresAt <= Date.now()) return { kind: 'expired', message: SESSION_ERROR }
    const queued = state.queue[0]
    if (queued.problem?.kind === 'conflict') return { kind: 'conflict', message: queued.problem.message }
    if (queued.problem?.kind === 'blocked') return { kind: 'failed', message: queued.problem.message }
    const metadata = tx.objectStore('metadata')
    const lease = await requested<Metadata | undefined>(metadata.get('lease'))
    if (lease && 'owner' in lease && lease.owner !== owner && lease.until > Date.now()) return { kind: 'busy' }
    // The lease is longer than the network timeout. If a suspended tab loses it,
    // another tab retries the same operation id; conditional commits fence late replies.
    await requested(metadata.put({ key: 'lease', owner, until: Date.now() + 45_000 }))
    return { queued, generation: state.generation }
  })
}

async function commitWork(owner: string, work: Exclude<Work, SyncResult>, result: { day?: DiaryDay; problem?: QueuedMutation['problem']; expired?: boolean }): Promise<void> {
  await transaction('readwrite', async (tx) => {
    const state = await localState(tx, work.queued.mutation.date)
    if (state.generation !== work.generation) return
    const metadata = tx.objectStore('metadata')
    const lease = await requested<Metadata | undefined>(metadata.get('lease'))
    if (lease && 'owner' in lease && lease.owner === owner) await requested(metadata.delete('lease'))
    // Another tab may have completed this id or explicitly resolved its conflict.
    if (result.expired) await requested(metadata.put({ key: 'expiresAt', value: 0 }))
    if (state.queue[0]?.mutation.id !== work.queued.mutation.id) return
    if (result.day) await cacheDay(tx, result.day)
    const queue = tx.objectStore('queue')
    if (result.problem) await requested(queue.put({ ...state.queue[0], problem: result.problem }))
    else if (result.day) await requested(queue.delete(work.queued.sequence!))
  })
  announce()
}

async function flushQueue(continueSync?: () => boolean): Promise<SyncResult> {
  if (syncing) return syncing
  syncing = (async (): Promise<SyncResult> => {
    if (!navigator.onLine) return { kind: 'offline' }
    const owner = crypto.randomUUID()
    let sent = false
    for (;;) {
      if (continueSync && !continueSync()) return { kind: 'busy', reachable: sent || undefined }
      const work = await claimWork(owner)
      if ('kind' in work) return { ...work, reachable: sent || undefined }
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 20_000)
      let response: Response
      let payload: DiaryDay & { error?: string; day?: DiaryDay }
      try {
        response = await fetch('/api/diary', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(work.queued.mutation),
        })
        sent = true
        payload = response.status === 401 ? {} as typeof payload : await response.json() as typeof payload
      } catch {
        const text = 'Connessione non disponibile. Registrazioni salvate sul dispositivo, ancora da sincronizzare.'
        await commitWork(owner, work, { problem: { kind: 'retry', message: text } })
        return { kind: 'offline', message: text }
      } finally { window.clearTimeout(timeout) }
      if (response.status === 401) {
        await commitWork(owner, work, { expired: true })
        return { kind: 'expired', message: SESSION_ERROR, reachable: true }
      }
      if (response.status === 409 && payload.day) {
        const text = payload.error ?? 'Il diario è stato modificato altrove. Scegli quali registrazioni mantenere.'
        await commitWork(owner, work, { day: payload.day, problem: { kind: 'conflict', message: text, day: payload.day } })
        return { kind: 'conflict', message: text, reachable: true }
      }
      if (!response.ok) {
        const text = payload.error ?? 'Sincronizzazione non riuscita. Le registrazioni restano sul dispositivo.'
        const retry = response.status >= 500 || response.status === 408 || response.status === 429
        await commitWork(owner, work, { problem: { kind: retry ? 'retry' : 'blocked', message: text } })
        return { kind: 'failed', message: text, reachable: true }
      }
      await commitWork(owner, work, { day: payload })
    }
  })().finally(() => { syncing = undefined })
  return syncing
}

async function resolveQueuedConflict(choice: 'local' | 'server') {
  await transaction('readwrite', async (tx) => {
    const state = await localState(tx, todayInRome())
    if (state.expiresAt <= Date.now()) throw new Error(SESSION_ERROR)
    const conflicted = state.queue.find((item) => item.problem?.kind === 'conflict')
    if (!conflicted || conflicted.problem?.kind !== 'conflict') return
    await cacheDay(tx, conflicted.problem.day)
    const server = await requested<DiaryDay>(tx.objectStore('days').get(conflicted.problem.day.date))
    const revisions = new Map(server.meals.map((meal) => [meal.plan.slot, meal.checkIn?.revision ?? 0]))
    const recordedPlans = new Map(server.meals.filter((meal) => meal.checkIn).map((meal) => [meal.plan.slot, meal.plan]))
    for (const queued of state.queue) {
      if (queued.mutation.date !== server.date) continue
      if (choice === 'server') {
        await requested(tx.objectStore('queue').delete(queued.sequence!))
      } else {
        // Rebasing is an explicit new operation, never a changed payload under an old id.
        const entries = queued.mutation.entries.map((entry) => {
          const baseRevision = revisions.get(entry.slot) ?? 0
          revisions.set(entry.slot, baseRevision + 1)
          return { ...entry, baseRevision }
        })
        const plans = queued.plans.map((plan) => recordedPlans.get(plan.slot) ?? plan)
        await requested(tx.objectStore('queue').put({ ...queued, plans, mutation: { ...queued.mutation, id: crypto.randomUUID(), entries }, problem: undefined }))
      }
    }
  })
  announce()
}

function midnightDelay(): number {
  const now = Date.now()
  const date = todayInRome(now)
  let low = now
  let high = now + 27 * 60 * 60 * 1000
  while (high - low > 100) {
    const middle = Math.floor((low + high) / 2)
    if (todayInRome(middle) === date) low = middle
    else high = middle
  }
  return high - now + 50
}

export function useDiarySync(enabled: boolean): { pendingCount: number; online: boolean; error: string; conflict: boolean } {
  const [status, setStatus] = useState({ pendingCount: 0, online: typeof navigator === 'undefined' || navigator.onLine, error: '', conflict: false })

  useEffect(() => {
    if (!enabled) return
    let active = true
    let running = false
    let connected = navigator.onLine
    changes()

    const synchronize = async () => {
      if (!active || running) return
      running = true
      try {
        const session = await transaction('readonly', async (tx) => requested<Metadata | undefined>(tx.objectStore('metadata').get('expiresAt')))
        if (!active) return
        const expiresAt = session && 'value' in session ? Number(session.value) : 0
        if (expiresAt <= Date.now()) {
          setStatus({ pendingCount: 0, online: connected, error: SESSION_ERROR, conflict: false })
          return
        }
        const result = await flushQueue(() => active)
        if (!active) return
        if (result.kind === 'offline') connected = false
        else if (result.reachable) connected = true
        const state = await transaction('readonly', async (tx) => {
          const [queue, expiry] = await Promise.all([
            requested<QueuedMutation[]>(tx.objectStore('queue').getAll()),
            requested<Metadata | undefined>(tx.objectStore('metadata').get('expiresAt')),
          ])
          return { queue, expiresAt: expiry && 'value' in expiry ? Number(expiry.value) : 0 }
        })
        if (!active) return
        if (state.expiresAt <= Date.now()) {
          setStatus({ pendingCount: 0, online: connected, error: SESSION_ERROR, conflict: false })
          return
        }
        setStatus({
          pendingCount: state.queue.length,
          online: connected,
          error: state.queue.find((item) => item.problem)?.problem?.message ?? result.message ?? '',
          conflict: state.queue.some((item) => item.problem?.kind === 'conflict'),
        })
      } catch (cause) {
        if (active) setStatus((current) => ({ ...current, online: connected, error: message(cause) }))
      } finally { running = false }
    }
    const changed = () => { void synchronize() }
    const online = () => { connected = true; changed() }
    const offline = () => {
      connected = false
      setStatus((current) => ({ ...current, online: false }))
      changed()
    }
    const retry = window.setInterval(changed, 15_000)
    window.addEventListener(CHANGE_EVENT, changed)
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    window.addEventListener('focus', changed)
    changed()
    return () => {
      active = false
      window.clearInterval(retry)
      window.removeEventListener(CHANGE_EVENT, changed)
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
      window.removeEventListener('focus', changed)
    }
  }, [enabled])

  return enabled ? status : { pendingCount: 0, online: typeof navigator === 'undefined' || navigator.onLine, error: '', conflict: false }
}

export function useDiary(date: string | null): {
  day: DiaryDay | null; loading: boolean; saving: boolean; error: string; notice: string; online: boolean;
  pendingCount: number; conflict: boolean; openDay(date: string | null): Promise<void>;
  record(slot: PlanSlot, followed: boolean, note: string | null): Promise<void>; followAll(): Promise<void>;
  retrySync(): Promise<void>; resolveConflict(choice: 'local' | 'server'): Promise<void>;
} {
  const [day, setDay] = useState<DiaryDay | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [online, setOnline] = useState(typeof navigator === 'undefined' || navigator.onLine)
  const [pendingCount, setPendingCount] = useState(0)
  const [conflict, setConflict] = useState(false)
  const selected = useRef<string | null>(date)
  const mounted = useRef(false)
  const operation = useRef(false)
  const loadId = useRef(0)
  const currentDay = useRef<DiaryDay | null>(null)
  const lastToday = useRef(todayInRome())
  const connection = useRef(typeof navigator === 'undefined' || navigator.onLine)
  const previousProblem = useRef('')

  const showLocal = useCallback(async () => {
    const date = selected.current ?? todayInRome()
    const state = await transaction('readonly', (tx) => localState(tx, date))
    if (!mounted.current || date !== (selected.current ?? todayInRome())) return
    const visible = state.expiresAt > Date.now() ? overlay(state) : null
    currentDay.current = visible
    setDay(visible)
    setPendingCount(state.expiresAt > Date.now() ? state.queue.length : 0)
    const problem = state.queue.find((item) => item.problem)?.problem
    setConflict(state.expiresAt > Date.now() && state.queue.some((item) => item.problem?.kind === 'conflict'))
    if (state.expiresAt <= Date.now()) {
      previousProblem.current = SESSION_ERROR
      setError(SESSION_ERROR)
      setNotice('')
    } else if (problem) {
      previousProblem.current = problem.message
      setError(problem.message)
      setNotice('Le registrazioni in attesa restano salvate sul dispositivo.')
    } else {
      const oldProblem = previousProblem.current
      previousProblem.current = ''
      setError((current) => current === oldProblem ? '' : current)
      setNotice(state.queue.length ? 'Registrazioni salvate sul dispositivo, in attesa di sincronizzazione.' :
        !connection.current ? 'Connessione non disponibile. Stai consultando la copia salvata sul dispositivo.' : '')
    }
  }, [])

  const synchronize = useCallback(async () => {
    try {
      const result = await flushQueue()
      if (result.kind === 'offline') connection.current = false
      else if (result.reachable) connection.current = true
      await showLocal()
      if (!mounted.current) return
      setOnline(connection.current)
      if (result.message) setError(result.message)
    } catch (cause) {
      if (mounted.current) setError(message(cause))
    }
  }, [showLocal])

  const openDay = useCallback(async (date: string | null) => {
    selected.current = date
    const requestId = ++loadId.current
    if (currentDay.current?.date !== (date ?? todayInRome())) currentDay.current = null
    if (mounted.current) { setLoading(true); setError(''); setNotice('') }
    try {
      const selectedDate = date ?? todayInRome()
      const calendarDate = new Date(`${selectedDate}T00:00:00.000Z`)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate) || !Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== selectedDate) {
        throw new Error('Seleziona una data valida.')
      }
      await showLocal()
      if (!navigator.onLine) {
        const state = await transaction('readonly', (tx) => localState(tx, selectedDate))
        if (state.expiresAt <= Date.now()) throw new Error(SESSION_ERROR)
        if (!state.day) throw new Error('Giorno non disponibile offline. Aprilo online per conservarne una copia su questo dispositivo.')
        return
      }
      const before = await transaction('readonly', (tx) => localState(tx, selectedDate))
      let fresh: DiaryDay | undefined
      try {
        fresh = await requestDiary(date)
      } catch (cause) {
        if (cause instanceof DiaryRequestError && !cause.transient) throw cause
        if (cause instanceof Error && cause.message === STORAGE_ERROR) throw cause
        connection.current = false
        if (mounted.current && requestId === loadId.current) setOnline(false)
        const cached = await transaction('readonly', (tx) => localState(tx, selectedDate))
        if (!cached.day || cached.expiresAt <= Date.now()) throw new Error(cached.expiresAt <= Date.now() ? SESSION_ERROR : 'Giorno non disponibile offline. Collegati per caricarlo almeno una volta.')
      }
      if (fresh) {
        const incoming = fresh
        await transaction('readwrite', async (tx) => {
          const state = await localState(tx, selectedDate)
          if (state.generation === before.generation && state.expiresAt > Date.now()) await cacheDay(tx, incoming)
        })
        connection.current = true
        announce()
        if (mounted.current && requestId === loadId.current) setOnline(true)
      }
      await showLocal()
      void synchronize()
    } catch (cause) {
      if (mounted.current && requestId === loadId.current) {
        setError(message(cause))
        if (cause instanceof DiaryRequestError && cause.expired) { setDay(null); currentDay.current = null }
      }
    } finally {
      if (mounted.current && requestId === loadId.current) setLoading(false)
    }
  }, [showLocal, synchronize])

  const save = useCallback(async (slot: PlanSlot | null, followed: boolean, note: string | null) => {
    if (operation.current) return
    operation.current = true
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const visible = currentDay.current
      if (!visible || visible.date !== todayInRome()) throw new Error('Puoi registrare soltanto i pasti di Oggi. Riapri il giorno corrente.')
      await enqueue(visible, slot, followed, note)
      // No optimistic UI is published before the IndexedDB transaction commits.
      announce()
      await showLocal()
      void synchronize()
    } catch (cause) { if (mounted.current) setError(message(cause)) }
    finally { operation.current = false; if (mounted.current) setSaving(false) }
  }, [showLocal, synchronize])

  const record = useCallback((slot: PlanSlot, followed: boolean, note: string | null) => save(slot, followed, note), [save])
  const followAll = useCallback(() => save(null, true, null), [save])
  const retrySync = useCallback(async () => {
    setError('')
    try {
      await transaction('readwrite', async (tx) => {
        const queue = await requested<QueuedMutation[]>(tx.objectStore('queue').getAll())
        for (const queued of queue) {
          if (queued.problem?.kind === 'blocked' || queued.problem?.kind === 'retry') await requested(tx.objectStore('queue').put({ ...queued, problem: undefined }))
        }
      })
      await synchronize()
      await openDay(selected.current)
    } catch (cause) { if (mounted.current) setError(message(cause)) }
  }, [openDay, synchronize])
  const resolveConflict = useCallback(async (choice: 'local' | 'server') => {
    if (operation.current) return
    operation.current = true
    setSaving(true)
    setError('')
    try {
      await resolveQueuedConflict(choice)
      await showLocal()
      await synchronize()
    } catch (cause) { if (mounted.current) setError(message(cause)) }
    finally { operation.current = false; if (mounted.current) setSaving(false) }
  }, [showLocal, synchronize])

  useEffect(() => {
    mounted.current = true
    changes()
    const changed = () => { void showLocal().catch((cause: unknown) => { if (mounted.current) setError(message(cause)) }) }
    const refresh = () => {
      if (!navigator.onLine) connection.current = false
      setOnline(connection.current)
      if (lastToday.current !== todayInRome()) {
        lastToday.current = todayInRome()
      }
      void openDay(selected.current)
    }
    const offline = () => { connection.current = false; setOnline(false); changed() }
    let midnight: ReturnType<typeof setTimeout>
    const scheduleMidnight = () => {
      midnight = setTimeout(() => { refresh(); scheduleMidnight() }, midnightDelay())
    }
    scheduleMidnight()
    const retry = window.setInterval(() => {
      if (lastToday.current !== todayInRome()) refresh()
      else void showLocal().catch((cause: unknown) => { if (mounted.current) setError(message(cause)) })
    }, 15_000)
    window.addEventListener(CHANGE_EVENT, changed)
    window.addEventListener('online', refresh)
    window.addEventListener('offline', offline)
    window.addEventListener('focus', refresh)
    return () => {
      mounted.current = false
      window.clearInterval(retry)
      clearTimeout(midnight)
      window.removeEventListener(CHANGE_EVENT, changed)
      window.removeEventListener('online', refresh)
      window.removeEventListener('offline', offline)
      window.removeEventListener('focus', refresh)
    }
  }, [openDay, showLocal, synchronize])

  useEffect(() => { void openDay(date) }, [date, openDay])

  const visibleDay = day?.date === (date ?? todayInRome()) ? day : null
  return { day: visibleDay, loading, saving, error, notice, online, pendingCount, conflict, openDay, record, followAll, retrySync, resolveConflict }
}
