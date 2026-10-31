import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode, SyntheticEvent } from 'react'
import { Link, useLocation } from '@tanstack/react-router'
import './app-shell.css'

type ViewState = 'loading' | 'signed-out' | 'signed-in'

export function AppShell({ children }: { children: ReactNode }) {
  const [view, setView] = useState<ViewState>('loading')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const authBusy = useRef(false)
  const sessionRequest = useRef(0)
  const sessionWasValid = useRef(false)
  const pathname = useLocation({ select: (location) => location.pathname })

  const refreshSession = useCallback(async () => {
    if (authBusy.current) return
    const requestId = ++sessionRequest.current
    try {
      const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' })
      if (requestId !== sessionRequest.current || authBusy.current) return
      if (!response.ok) {
        setView('signed-out')
        if (response.status === 401) {
          if (sessionWasValid.current) setError('Sessione scaduta. Accedi di nuovo.')
          sessionWasValid.current = false
        } else setError('Impossibile verificare la sessione. Riprova tra poco.')
        return
      }
      sessionWasValid.current = true
      setError('')
      setView('signed-in')
    } catch {
      if (requestId !== sessionRequest.current || authBusy.current) return
      setView('signed-out')
      setError('Impossibile verificare la sessione. Controlla la connessione e riprova.')
    }
  }, [])

  useEffect(() => {
    // Retirement only: never register a worker or touch personal IndexedDB data.
    const retireWorker = async () => {
      if (!navigator.onLine || !('serviceWorker' in navigator)) return
      const registrations = await navigator.serviceWorker.getRegistrations()
      for (const registration of registrations) {
        const workers = [registration.active, registration.waiting, registration.installing]
        if (workers.some((worker) => worker && new URL(worker.scriptURL).origin === location.origin && new URL(worker.scriptURL).pathname === '/diary-sw.js')) {
          await registration.unregister()
        }
      }
      if ('caches' in window) {
        const names = await caches.keys()
        await Promise.all(names.filter((name) => name.startsWith('mealio-public-')).map((name) => caches.delete(name)))
      }
    }
    const retire = () => { void retireWorker().catch(() => { /* The retirement worker retries on its next update. */ }) }
    const refresh = () => { void refreshSession() }
    const expired = () => {
      ++sessionRequest.current
      sessionWasValid.current = false
      setView('signed-out')
      setError('Sessione scaduta. Accedi di nuovo.')
    }
    retire()
    refresh()
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    window.addEventListener('online', retire)
    window.addEventListener('mealio-session-expired', expired)
    return () => {
      ++sessionRequest.current
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      window.removeEventListener('online', retire)
      window.removeEventListener('mealio-session-expired', expired)
    }
  }, [refreshSession])

  useEffect(() => {
    if (view === 'signed-in') document.getElementById('main-content')?.focus()
  }, [pathname, view])

  async function signIn(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    if (authBusy.current) return
    authBusy.current = true
    ++sessionRequest.current
    setError('')
    setBusy(true)
    const form = event.currentTarget
    const password = new FormData(form).get('password')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
      })
      const payload = await response.json() as { error?: string }
      if (response.ok) {
        form.reset()
        authBusy.current = false
        await refreshSession()
      } else setError(payload.error ?? 'Accesso non riuscito.')
    } catch {
      setError('Impossibile contattare il servizio. Riprova tra poco.')
    } finally {
      authBusy.current = false
      setBusy(false)
    }
  }

  async function signOut() {
    if (authBusy.current) return
    if (document.querySelector('[data-note-dirty="true"]') && !window.confirm('Le note non salvate andranno perse. Uscire senza salvarle?')) return
    authBusy.current = true
    ++sessionRequest.current
    setBusy(true)
    setError('')
    // Unmount personal in-memory views immediately; late session replies are fenced.
    setView('loading')
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error('Disconnessione non riuscita.')
      sessionWasValid.current = false
      setView('signed-out')
    } catch {
      authBusy.current = false
      await refreshSession()
      setError('Disconnessione non completata. Controlla la connessione e riprova.')
    } finally {
      authBusy.current = false
      setBusy(false)
    }
  }

  if (view !== 'signed-in') {
    return (
      <main className="page-shell access-shell">
        <header className="topbar">
          <Link className="brand" to="/" search={{ start: undefined }} aria-label="Mealio, settimana">
            <span className="brand-mark" aria-hidden="true">m</span><span>mealio</span>
          </Link>
          <span className="topbar-note">il tuo spazio personale</span>
        </header>
        {view === 'loading' ? (
          <section className="panel loading-panel" aria-live="polite">
            <span className="eyebrow">Mealio</span><h1>Un momento…</h1><p>Sto verificando la sessione.</p>
          </section>
        ) : (
          <section className="panel login-panel">
            <span className="eyebrow">Accesso personale</span>
            <h1>La dieta, la settimana, la spesa.</h1>
            <p>Accedi per organizzare i pasti del tuo PDF.</p>
            <form className="login-form" onSubmit={signIn}>
              <label htmlFor="password">Password</label>
              <div className="password-field">
                <input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required minLength={1} disabled={busy} />
                <button className="password-visibility" type="button" aria-label={showPassword ? 'Nascondi password' : 'Mostra password'} aria-pressed={showPassword} onClick={() => setShowPassword((visible) => !visible)} disabled={busy}>
                  {showPassword ? 'Nascondi' : 'Mostra'}
                </button>
              </div>
              {error && <p className="message error-message" role="alert">{error}</p>}
              <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Verifica…' : 'Accedi'}</button>
            </form>
            <p className="privacy-note">Accesso riservato a una sola persona.</p>
          </section>
        )}
      </main>
    )
  }

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Vai al contenuto</a>
      <aside className="app-sidebar" aria-label="Mealio">
        <Link className="brand" to="/" search={{ start: undefined }} aria-label="Mealio, settimana">
          <span className="brand-mark" aria-hidden="true">m</span><span>mealio</span>
        </Link>
        <nav className="app-navigation" aria-label="Navigazione principale">
          <Link className="app-nav-link" to="/" search={{ start: undefined }} activeOptions={{ exact: true, includeSearch: false }} aria-current={pathname === '/settimana' ? 'page' : undefined}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M9 9v12m6-12v12M7 2v4m10-4v4"/></svg>
            <span>Settimana</span>
          </Link>
          <Link className="app-nav-link" to="/spesa" search={{ start: undefined }} activeOptions={{ includeSearch: false }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8zM9 8V6a3 3 0 0 1 6 0v2"/></svg>
            <span>Spesa</span>
          </Link>
          <Link className="app-nav-link" to="/dieta">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8m-8 4h6"/></svg>
            <span>Dieta</span>
          </Link>
        </nav>
        <div className="app-sidebar-footer">
          <Link className="app-diary-link" to="/calendario" search={{ date: undefined }}>Diario dei pasti</Link>
          <button className="app-sign-out" type="button" onClick={() => void signOut()} disabled={busy}>{busy ? 'Attendi…' : 'Esci'}</button>
        </div>
      </aside>
      <main className="app-main" id="main-content" tabIndex={-1}>
        {error && <p className="app-alert error-message" role="alert">{error}</p>}
        {children}
      </main>
    </div>
  )
}
