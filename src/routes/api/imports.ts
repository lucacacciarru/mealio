import { createFileRoute } from '@tanstack/react-router'
import {
  activatePlanImport,
  extractPlanImport,
  getPlanImport,
  listPlanImports,
  MAX_PLAN_PDF_BYTES,
  readPlanImportPdf,
  savePlanImport,
} from '../../server/plan-imports'
import { hasValidSession } from '../../server/auth'
import { HttpError, readBodyUpTo, requestHasSameOrigin } from '../../server/http'

const responseHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

export const Route = createFileRoute('/api/imports')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!hasValidSession(request)) {
          return Response.json({ error: 'Accesso richiesto.' }, { status: 401, headers: responseHeaders })
        }
        const url = new URL(request.url)
        const id = url.searchParams.get('id')
        if (url.searchParams.get('file') === '1') {
          if (!id) {
            return Response.json({ error: 'Importazione non trovata.' }, { status: 404, headers: responseHeaders })
          }
          try {
            const { originalName, bytes } = await readPlanImportPdf(id)
            return new Response(new Uint8Array(bytes), {
              headers: {
                ...responseHeaders,
                'content-type': 'application/pdf',
                'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(originalName)}`,
                'content-length': String(bytes.length),
                'referrer-policy': 'no-referrer',
                'x-frame-options': 'SAMEORIGIN',
              },
            })
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            const message = error instanceof HttpError ? error.message : 'File PDF non disponibile.'
            return Response.json({ error: message }, { status, headers: responseHeaders })
          }
        }
        try {
          if (!id) return Response.json({ imports: listPlanImports() }, { headers: responseHeaders })
          return Response.json(getPlanImport(id), { headers: responseHeaders })
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          const message = error instanceof HttpError ? error.message : 'Impossibile leggere l’importazione.'
          return Response.json({ error: message }, { status, headers: responseHeaders })
        }
      },
      POST: async ({ request }) => {
        if (!hasValidSession(request)) {
          return Response.json({ error: 'Accesso richiesto.' }, { status: 401, headers: responseHeaders })
        }
        if (!requestHasSameOrigin(request)) {
          return Response.json({ error: 'Richiesta non valida.' }, { status: 403, headers: responseHeaders })
        }
        const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        try {
          if (mediaType === 'application/pdf') {
            const bytes = await readBodyUpTo(request, MAX_PLAN_PDF_BYTES)
            const result = await savePlanImport(request.headers.get('x-file-name') ?? 'piano.pdf', bytes)
            return Response.json(result, { status: 201, headers: responseHeaders })
          }
          if (mediaType !== 'application/json') {
            return Response.json({ error: 'Invia un PDF oppure una richiesta JSON valida.' }, { status: 415, headers: responseHeaders })
          }
          const body = await readBodyUpTo(request, 4096)
          const payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>
          if (payload.action !== 'extract' || typeof payload.id !== 'string') {
            return Response.json({ error: 'Richiesta di estrazione non valida.' }, { status: 400, headers: responseHeaders })
          }
          const extraction = await extractPlanImport(payload.id, payload.confirmed === true)
          return Response.json({ extraction }, { headers: responseHeaders })
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 400
          const message = error instanceof HttpError ? error.message : 'Richiesta non valida.'
          return Response.json({ error: message }, { status, headers: responseHeaders })
        }
      },
      PUT: async ({ request }) => {
        if (!hasValidSession(request)) {
          return Response.json({ error: 'Accesso richiesto.' }, { status: 401, headers: responseHeaders })
        }
        if (!requestHasSameOrigin(request)) {
          return Response.json({ error: 'Richiesta non valida.' }, { status: 403, headers: responseHeaders })
        }
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return Response.json({ error: 'Richiesta non valida.' }, { status: 415, headers: responseHeaders })
        }
        try {
          const body = await readBodyUpTo(request, 4096)
          const payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>
          if (payload.action !== 'activate' || typeof payload.id !== 'string' || typeof payload.validFrom !== 'string') {
            return Response.json({ error: 'Richiesta di attivazione non valida.' }, { status: 400, headers: responseHeaders })
          }
          const result = activatePlanImport(payload.id, payload.validFrom)
          return Response.json(result, { headers: responseHeaders })
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 400
          const message = error instanceof HttpError ? error.message : 'Attivazione del piano non riuscita.'
          return Response.json({ error: message }, { status, headers: responseHeaders })
        }
      },
    },
  },
})
