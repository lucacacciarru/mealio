import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlanSlot } from '../db/schema'
import { CHECK_IN_NOTE_MAX_LENGTH } from '../diary'
import type { DiaryDay, DiaryMutation } from '../diary'

const SESSION_ERROR = 'Sessione scaduta. Accedi di nuovo.'
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' })

type Conflict = { mutation: DiaryMutation; day: DiaryDay }

function todayInRome(): string {
  const parts = dateFormatter.formatToParts(Date.now())
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)!.value).join('-')
}


async function requestDiary(date: string | null, mutation?: DiaryMutation): Promise<{ day: DiaryDay; conflict: boolean }> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(mutation ? '/api/diary' : date ? `/api/diary?date=${encodeURIComponent(date)}` : '/api/diary', {
      method: mutation ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      ...(mutation ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(mutation) } : {}),
    })
    if (response.status === 401) {
      throw new Error(SESSION_ERROR)
    }
    const payload = await response.json() as DiaryDay & { error?: string; day?: DiaryDay }
    if (response.status === 409 && payload.day) return { day: payload.day, conflict: true }
    if (!response.ok) throw new Error(payload.error ?? 'Operazione non riuscita. Riprova.')
    return { day: payload, conflict: false }
  } catch (cause) {
    if (cause instanceof TypeError || (cause instanceof DOMException && cause.name === 'AbortError')) {
      throw new Error(mutation ? 'Risposta non ricevuta. Ricarica la giornata per verificare se la registrazione è stata salvata.' : 'Impossibile caricare la giornata. Controlla la connessione e riprova.')
    }
    throw cause
  } finally { window.clearTimeout(timeout) }
}

export function useDiary(date: string | null) {
  const [day, setDay] = useState<DiaryDay | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const mounted = useRef(false)
  const selected = useRef(date)
  const currentDay = useRef<DiaryDay | null>(null)
  const currentConflict = useRef<Conflict | null>(null)
  const operation = useRef(false)
  const loadId = useRef(0)
  selected.current = date

  const publish = useCallback((incoming: DiaryDay) => {
    currentDay.current = incoming
    setDay(incoming)
  }, [])

  const reportError = useCallback((cause: unknown) => {
    if (!mounted.current) return
    const text = cause instanceof Error ? cause.message : 'Operazione non riuscita. Riprova.'
    if (text === SESSION_ERROR) window.dispatchEvent(new Event('mealio-session-expired'))
    else setError(text)
  }, [])

  const reload = useCallback(async () => {
    const selectedDate = selected.current
    const requestId = ++loadId.current
    setLoading(true)
    setError('')
    try {
      const result = await requestDiary(selectedDate)
      if (!mounted.current || requestId !== loadId.current || selectedDate !== selected.current) return
      publish(result.day)
      currentConflict.current = null
      setConflict(null)
    } catch (cause) {
      if (requestId === loadId.current) reportError(cause)
    } finally {
      if (mounted.current && requestId === loadId.current) setLoading(false)
    }
  }, [publish, reportError])

  const submit = useCallback(async (mutation: DiaryMutation) => {
    const selectedDate = selected.current
    const requestId = ++loadId.current
    setLoading(false)
    const result = await requestDiary(null, mutation)
    if (!mounted.current || requestId !== loadId.current || selectedDate !== selected.current) return
    if (result.conflict) {
      // Keep the displayed note drafts until the user explicitly chooses a version.
      const next = { mutation, day: result.day }
      currentConflict.current = next
      setConflict(next)
    } else {
      publish(result.day)
      currentConflict.current = null
      setConflict(null)
    }
  }, [publish])

  const save = useCallback(async (slot: PlanSlot | null, followed: boolean, note: string | null) => {
    if (operation.current) return
    operation.current = true
    setSaving(true)
    setError('')
    try {
      const visible = currentDay.current
      if (!visible || visible.date !== (selected.current ?? todayInRome()) || visible.date !== todayInRome()) {
        throw new Error('Puoi registrare soltanto i pasti di oggi. Ricarica il giorno corrente.')
      }
      if (currentConflict.current) throw new Error('Risolvi il conflitto prima di aggiungere registrazioni.')
      if (slot && !visible.meals.some((meal) => meal.plan.slot === slot)) throw new Error('Pasto non disponibile per questo giorno.')
      const recordedAt = Date.now()
      const entries: DiaryMutation['entries'] = []
      for (const meal of visible.meals) {
        if (slot && meal.plan.slot !== slot) continue
        const nextNote = slot ? note?.trim() || null : meal.checkIn?.note ?? null
        const nextFollowed = slot ? followed : true
        if (nextNote && nextNote.length > CHECK_IN_NOTE_MAX_LENGTH) throw new Error(`La nota può contenere al massimo ${CHECK_IN_NOTE_MAX_LENGTH} caratteri.`)
        if (meal.checkIn?.followed === nextFollowed && meal.checkIn.note === nextNote) continue
        entries.push({ slot: meal.plan.slot, followed: nextFollowed, note: nextNote, recordedAt, baseRevision: meal.checkIn?.revision ?? 0 })
      }
      if (entries.length) await submit({ id: crypto.randomUUID(), date: visible.date, snapshotId: visible.snapshotId, entries })
    } catch (cause) {
      reportError(cause)
    } finally {
      operation.current = false
      if (mounted.current) setSaving(false)
    }
  }, [reportError, submit])

  const resolveConflict = useCallback(async (choice: 'local' | 'server') => {
    if (operation.current || !currentConflict.current) return
    const pending = currentConflict.current
    if (choice === 'server') {
      publish(pending.day)
      currentConflict.current = null
      setConflict(null)
      setError('')
      return
    }
    operation.current = true
    setSaving(true)
    setError('')
    try {
      if (pending.mutation.date !== todayInRome()) throw new Error('Il giorno è cambiato. Mantieni i check-in sul server e riapri oggi.')
      await submit({
        ...pending.mutation, id: crypto.randomUUID(), snapshotId: pending.day.snapshotId,
        entries: pending.mutation.entries.map((entry) => ({
          ...entry, baseRevision: pending.day.meals.find((meal) => meal.plan.slot === entry.slot)?.checkIn?.revision ?? 0,
        })),
      })
    } catch (cause) {
      reportError(cause)
    } finally {
      operation.current = false
      if (mounted.current) setSaving(false)
    }
  }, [publish, reportError, submit])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++loadId.current }
  }, [])

  useEffect(() => {
    currentDay.current = null
    currentConflict.current = null
    setDay(null)
    setConflict(null)
    void reload()
    return () => { ++loadId.current }
  }, [date, reload])

  return {
    day: day?.date === (date ?? todayInRome()) ? day : null,
    loading, saving, error, conflict: Boolean(conflict), reload, resolveConflict,
    record: (slot: PlanSlot, followed: boolean, note: string | null) => save(slot, followed, note),
    followAll: () => save(null, true, null),
  }
}
