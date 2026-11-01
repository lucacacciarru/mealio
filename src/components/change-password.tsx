import { useState } from 'react'
import type { SyntheticEvent } from 'react'
import { apiRequest } from './api'

// The password lives in the app: change it here, no environment variables.
export function ChangePassword() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const next = String(data.get('next') ?? '')
    if (next !== data.get('confirm')) {
      setMessage({ error: true, text: 'Le due nuove password non coincidono.' })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      await apiRequest('/api/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current: String(data.get('current') ?? ''), next }),
      })
      form.reset()
      setMessage({ error: false, text: 'Password cambiata. Gli altri dispositivi dovranno accedere di nuovo.' })
    } catch (cause) {
      setMessage({ error: true, text: cause instanceof Error ? cause.message : 'Cambio non riuscito.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="diet-meals">
      <summary>Cambia password</summary>
      <form className="diet-upload" onSubmit={save}>
        <label htmlFor="password-current">Password attuale</label>
        <input id="password-current" name="current" type="password" autoComplete="current-password" required disabled={busy} />
        <label htmlFor="password-next">Nuova password (almeno 8 caratteri)</label>
        <input id="password-next" name="next" type="password" autoComplete="new-password" required minLength={8} disabled={busy} />
        <label htmlFor="password-confirm-next">Ripeti la nuova password</label>
        <input id="password-confirm-next" name="confirm" type="password" autoComplete="new-password" required minLength={8} disabled={busy} />
        {message && <p className={message.error ? 'diet-alert' : 'diet-notice'} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
        <button className="secondary-button" type="submit" disabled={busy}>{busy ? 'Salvataggio…' : 'Cambia password'}</button>
      </form>
    </details>
  )
}
