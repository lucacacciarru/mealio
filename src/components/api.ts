export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
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
