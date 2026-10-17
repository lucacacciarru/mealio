import { useEffect, useState } from 'react'
import type { SyntheticEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { PlanImportWorkspace } from '../components/plan-import-workspace'
import { WeekPlanner } from '../components/week-planner'

export const Route = createFileRoute('/')({ component: HomePage })

type ViewState = 'loading' | 'signed-out' | 'signed-in'

function HomePage() {
  const [view, setView] = useState<ViewState>('loading')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  // Remounts the planner after a plan activation so it reloads the week.
  const [planRevision, setPlanRevision] = useState(0)

  useEffect(() => {
    void refreshSession()
  }, [])

  async function refreshSession() {
    try {
      const response = await fetch('/api/auth/session', {
        credentials: 'same-origin',
        cache: 'no-store',
      })
      setView(response.ok ? 'signed-in' : 'signed-out')
    } catch {
      setView('signed-out')
      setError('Impossibile contattare il servizio. Riprova tra poco.')
    }
  }

  async function signIn(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setBusy(true)

    const form = event.currentTarget
    const password = new FormData(form).get('password')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const payload = (await response.json()) as { error?: string }
      if (response.ok) {
        form.reset()
        setView('signed-in')
      } else {
        setError(payload.error ?? 'Accesso non riuscito.')
      }
    } catch {
      setError('Impossibile contattare il servizio. Riprova tra poco.')
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    setBusy(true)
    setError('')
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      })
      setView('signed-out')
    } catch {
      setError('Impossibile completare la disconnessione.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Mealio, pagina iniziale">
          <span className="brand-mark" aria-hidden="true">m</span>
          <span>mealio</span>
        </a>
        <span className="topbar-note">il tuo spazio personale</span>
      </header>

      {view === 'loading' ? (
        <section className="panel loading-panel" aria-live="polite">
          <span className="eyebrow">Mealio</span>
          <h1>Un momento…</h1>
          <p>Sto verificando la sessione.</p>
        </section>
      ) : view === 'signed-in' ? (
        <section className="panel workspace-panel">
          <div className="workspace-topline">
            <div>
              <span className="eyebrow">Area privata</span>
              <h1>Il tuo piano, con le fonti sempre visibili.</h1>
            </div>
            <button className="secondary-button" type="button" onClick={signOut} disabled={busy}>
              {busy ? 'Attendi…' : 'Esci'}
            </button>
          </div>
          {error && <p className="message error-message" role="alert">{error}</p>}
          <WeekPlanner key={planRevision} />
          <PlanImportWorkspace onPlanActivated={() => setPlanRevision((revision) => revision + 1)} />
        </section>
      ) : (
        <section className="panel login-panel">
          <span className="eyebrow">Accesso personale</span>
          <h1>Rientra nel tuo spazio.</h1>
          <p>Inserisci la password per continuare.</p>
          <form className="login-form" onSubmit={signIn}>
            <label htmlFor="password">Password</label>
            <div className="password-field">
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                minLength={1}
                disabled={busy}
              />
              <button
                className="password-visibility"
                type="button"
                aria-label={showPassword ? 'Nascondi password' : 'Mostra password'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((visible) => !visible)}
                disabled={busy}
              >
                {showPassword ? 'Nascondi' : 'Mostra'}
              </button>
            </div>
            {error && <p className="message error-message" role="alert">{error}</p>}
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? 'Verifica…' : 'Accedi'}
              <span aria-hidden="true">↗</span>
            </button>
          </form>
          <p className="privacy-note">Accesso riservato a una sola persona.</p>
        </section>
      )}

      <footer className="footer-note">Un passo alla volta, con cura.</footer>
    </main>
  )
}
