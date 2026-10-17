// Errors whose message is safe to show to the user, with the HTTP status the
// API route should answer with.
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function readBodyUpTo(request: Request, limit: number): Promise<Buffer> {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new HttpError('Dimensione della richiesta non valida.', 400)
    }
    if (parsedLength > limit) throw new HttpError('Richiesta troppo grande.', 413)
  }

  const reader = request.body?.getReader()
  if (!reader) throw new HttpError('File o richiesta vuoti.', 400)
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > limit) {
        await reader.cancel()
        throw new HttpError('Richiesta troppo grande.', 413)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes)
}

export function requestHasSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}
