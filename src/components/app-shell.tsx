import { useEffect, useRef, useState } from 'react'
import type { ReactNode, SyntheticEvent } from 'react'
import { Link, useLocation, useRouter } from '@tanstack/react-router'
import {
  clearDiaryStorage,
  hasOfflineDiarySession,
  pendingDiaryCount,
  registerDiaryWorker,
  rememberDiarySession,
  useDiarySync,
} from './use-diary'
import './app-shell.css'

type ViewState = 'loading' | 'signed-out' | 'signed-in'

export function AppShell({ children }: { children: ReactNode }) {
  const [view, setView] = useState<ViewState>('loading')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const sessionWasValid = useRef(false)
  const router = useRouter()
  const pathname = useLocation({ select: (location) => location.pathname })
  const sync = useDiarySync(view === 'signed-in')

  useEffect(() => {
    void registerDiaryWorker().then(async () => {
      if (import.meta.env.DEV) {
        await Promise.all([
          router.preloadRoute({ to: '/', search: { date: undefined } }),
          router.preloadRoute({ to: '/settimana', search: { start: undefined } }),
          router.preloadRoute({ to: '/dieta' }),
        ])
      }
    }).catch(() => {
      setError('La riapertura offline non è disponibile in questo browser.')
    })
    void refreshSession()
    const timer = window.setInterval(() => void refreshSession(), 60_000)
    const refresh = () => void refreshSession()
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
    }
  }, [router])

  useEffect(() => {
    if (view === 'signed-in') document.getElementById('main-content')?.focus()
  }, [pathname, view])

  async function refreshSession() {
    let response: Response
    try {
      response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' })
    } catch {
      const available = await hasOfflineDiarySession().catch(() => false)
      setView(available ? 'signed-in' : 'signed-out')
      if (!available) setError('Collegati per accedere e caricare il calendario su questo dispositivo.')
      return
    }
    if (!response.ok) {
      setView('signed-out')
      await rememberDiarySession(0).catch(() => undefined)
      if (response.status !== 401) setError('Impossibile verificare la sessione. Riprova tra poco.')
      else if (sessionWasValid.current) setError('Sessione scaduta. Accedi di nuovo: i check-in in attesa sono conservati.')
      sessionWasValid.current = false
      return
    }
    try {
      const session = await response.json() as { expiresAt: number }
      await rememberDiarySession(session.expiresAt)
    } catch {
      setError('Accesso riuscito, ma la memoria offline non è disponibile in questo browser.')
    }
    sessionWasValid.current = true
    setView('signed-in')
  }

  async function signIn(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setBusy(true)
    const form = event.currentTarget
    const password = new FormData(form).get('password')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
      })
      const payload = await response.json() as { error?: string }
      if (response.ok) {
        form.reset()
        await refreshSession()
      } else setError(payload.error ?? 'Accesso non riuscito.')
    } catch {
      setError('Impossibile contattare il servizio. Riprova tra poco.')
    } finally { setBusy(false) }
  }

  async function signOut(discardPending = false) {
    setBusy(true)
    setError('')
    try {
      if (!discardPending && await pendingDiaryCount() > 0) {
        setConfirmSignOut(true)
        return
      }
      await rememberDiarySession(0)
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
      if (!response.ok) throw new Error('Disconnessione non riuscita.')
      sessionWasValid.current = false
      setView('signed-out')
      setConfirmSignOut(false)
      await clearDiaryStorage(discardPending)
    } catch {
      setError('Disconnessione non completata. I dati locali non eliminati sono conservati: collegati e riprova.')
    } finally { setBusy(false) }
  }

  if (view !== 'signed-in') {
    return (
      <main className="page-shell access-shell">
        <header className="topbar">
          <Link className="brand" to="/" search={{ date: undefined }} aria-label="Mealio, calendario">
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
            <h1>Il tuo piano, giorno per giorno.</h1>
            <p>Accedi al tuo calendario dei pasti.</p>
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
        <Link className="brand" to="/" search={{ date: undefined }} aria-label="Mealio, calendario">
          <span className="brand-mark" aria-hidden="true">m</span><span>mealio</span>
        </Link>
        <nav className="app-navigation" aria-label="Navigazione principale">
          <Link className="app-nav-link" to="/" search={{ date: undefined }} activeOptions={{ exact: true, includeSearch: false }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2m-8 3h2"/></svg>
            <span>Calendario</span>
          </Link>
          <Link className="app-nav-link" to="/settimana" search={{ start: undefined }} activeOptions={{ includeSearch: false }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M9 9v12m6-12v12M7 2v4m10-4v4"/></svg>
            <span>Settimana</span>
          </Link>
          <Link className="app-nav-link" to="/dieta">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8m-8 4h6"/></svg>
            <span>Dieta</span>
          </Link>
        </nav>
        <div className="app-sidebar-footer">
          {(sync.pendingCount > 0 || !sync.online) && (
            <Link className="app-sync-status" to="/" search={{ date: undefined }}>
              {sync.conflict ? 'Conflitto da risolvere' : sync.pendingCount > 0 ? `${sync.pendingCount} da sincronizzare` : 'Offline'}
            </Link>
          )}
          <button className="app-sign-out" type="button" onClick={() => void signOut()} disabled={busy}>{busy ? 'Attendi…' : 'Esci'}</button>
        </div>
      </aside>
      <main className="app-main" id="main-content" tabIndex={-1}>
        {error && <p className="app-alert error-message" role="alert">{error}</p>}
        {sync.error && pathname !== '/' && <p className="app-alert error-message" role="alert">{sync.error} <Link to="/" search={{ date: undefined }}>Apri il calendario</Link></p>}
        {confirmSignOut && (
          <section className="app-logout-warning" role="alert" aria-label="Check-in in attesa">
            <p>Ci sono check-in ancora da sincronizzare. Uscendo li elimini da questo dispositivo.</p>
            <div className="app-logout-actions">
              <button className="secondary-button" type="button" onClick={() => setConfirmSignOut(false)} disabled={busy}>Resta e sincronizza</button>
              <button className="secondary-button" type="button" onClick={() => void signOut(true)} disabled={busy}>Esci ed elimina i check-in in attesa</button>
            </div>
          </section>
        )}
        {children}
      </main>
    </div>
  )
}
