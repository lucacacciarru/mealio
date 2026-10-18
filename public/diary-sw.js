/* Only the anonymous SPA document and explicitly public code/assets belong here.
 * The diary, its queue and session expiry live in IndexedDB, never Cache API. */
const CACHE_PREFIX = 'mealio-public-'
const CACHE_NAME = `${CACHE_PREFIX}v2`
const SHELL_URL = new URL('/', self.location.origin).href
const PUBLIC_ROUTES = { '/': true, '/settimana': true, '/dieta': true }

function publicAsset(input) {
  let url
  try { url = new URL(input, self.location.origin) } catch { return null }
  if (url.origin !== self.location.origin || url.username || url.password) return null
  if (/\.(?:pdf|json|sqlite|db)(?:$|\/)/i.test(url.pathname)) return null
  // Production Vite assets, plus its public development modules. Never broaden
  // this to all same-origin GETs: API/import/PDF responses contain private data.
  const production = url.pathname.startsWith('/assets/') && /\.(?:m?js|css|woff2?|ttf|otf|svg|png|jpe?g|webp|ico)$/.test(url.pathname)
  const development = (
    url.pathname.startsWith('/src/') || url.pathname.startsWith('/node_modules/') ||
    url.pathname.startsWith('/@vite/') || url.pathname.startsWith('/@id/') ||
    url.pathname === '/@react-refresh' || url.pathname === '/@tanstack-start/styles.css'
  )
  return production || development ? url.href : null
}

function publicResponse(response, url) {
  if (!response.ok || response.redirected || new URL(response.url || url).origin !== self.location.origin) return false
  const contentType = response.headers.get('content-type') || ''
  return /(?:javascript|ecmascript|text\/css|font\/|application\/(?:font|vnd\.ms-fontobject)|image\/)/i.test(contentType)
}

function referencedAssets(html, base) {
  // Inspect only public HTML, never JavaScript strings or commented examples.
  const urls = new Set()
  const add = (value) => {
    try {
      const url = publicAsset(new URL(value.replace(/&amp;/g, '&'), base).href)
      if (url) urls.add(url)
    } catch { /* Ignore non-URL markup. */ }
  }
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) add(match[1])
  // TanStack's development entry is an inline import in the public document.
  for (const match of html.matchAll(/["'](\/(?:assets|src|@vite|@id|@tanstack-start)\/[^"'\s<>]+|\/@react-refresh)["']/g)) add(match[1])
  return urls
}

async function cacheAssets(inputs) {
  const cache = await caches.open(CACHE_NAME)
  const pending = [...new Set([...inputs].map(publicAsset).filter(Boolean))]
  for (let index = 0; index < pending.length; index += 6) {
    await Promise.all(pending.slice(index, index + 6).map(async (url) => {
      if (new URL(url).pathname.startsWith('/assets/') && await cache.match(url)) return
      const response = await fetch(url, { credentials: 'omit', cache: 'no-cache', redirect: 'error' })
      if (!publicResponse(response, url)) throw new Error('Public asset unavailable')
      await cache.put(url, response)
    }))
  }
}

async function cacheShell(response) {
  if (!response.ok || response.redirected || !/text\/html/i.test(response.headers.get('content-type') || '')) throw new Error('Public shell unavailable')
  const text = await response.clone().text()
  const assets = referencedAssets(text, SHELL_URL)
  if (!assets.size) throw new Error('SPA entry unavailable')
  if ([...assets].every((url) => new URL(url).pathname.startsWith('/assets/'))) {
    const manifest = await fetch('/mealio-assets.json', { credentials: 'omit', cache: 'no-cache', redirect: 'error' })
    if (!manifest.ok) throw new Error('Public asset manifest unavailable')
    const urls = await manifest.json()
    if (!Array.isArray(urls) || urls.length === 0 || urls.some((url) => typeof url !== 'string' || !publicAsset(url))) {
      throw new Error('Public asset manifest invalid')
    }
    for (const url of urls) assets.add(url)
  }
  // Publish a new shell only once its entry/dependencies are cached. A failed
  // deployment download leaves the previous working shell available offline.
  await cacheAssets(assets)
  const cache = await caches.open(CACHE_NAME)
  await cache.put(SHELL_URL, response)
}

async function fetchPublicShell() {
  return fetch(SHELL_URL, { credentials: 'omit', cache: 'no-cache', redirect: 'error' })
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await cacheShell(await fetchPublicShell())
    // No skipWaiting or reload messages: existing pages retain their worker
    // until it is safe to activate the next version.
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_PUBLIC_ASSETS' || !Array.isArray(event.data.urls)) return
  // Messages contain resource URLs only. No HTML, session or diary data is
  // accepted, and the same strict allowlist is applied to every supplied URL.
  event.waitUntil(cacheAssets(event.data.urls.filter((url) => typeof url === 'string')).catch(() => undefined))
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  // Do not intercept private endpoints, PDF downloads or arbitrary navigation.
  // Route queries are interpreted by the client, never used as cache keys.
  // Serve the anonymous root document without redirecting the requested path.
  if (request.mode === 'navigate' && Object.hasOwn(PUBLIC_ROUTES, url.pathname)) {
    const shell = fetchPublicShell()
    event.waitUntil(shell.then((response) => cacheShell(response.clone())).catch(() => undefined))
    event.respondWith(shell.then((response) => {
      if (!response.ok) throw new Error('Shell unavailable')
      return response
    }).catch(async () => {
      const cached = await (await caches.open(CACHE_NAME)).match(SHELL_URL)
      return cached || new Response('Mealio non è disponibile offline. Collegati e apri l’app almeno una volta.', {
        status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      })
    }))
    return
  }
  if (request.mode === 'navigate') return
  const asset = publicAsset(request.url)
  if (!asset) return
  // Hashed production files are immutable. Development modules use the network
  // first so enabling offline support does not freeze Vite's current sources.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME)
    const cached = await cache.match(asset)
    if (cached && url.pathname.startsWith('/assets/')) return cached
    try {
      const response = await fetch(asset, { credentials: 'omit', redirect: 'error' })
      if (publicResponse(response, asset)) {
        await cache.put(asset, response.clone())
        return response
      }
      if (cached && !response.ok) return cached
      return response
    } catch (cause) {
      if (cached) return cached
      throw cause
    }
  })())
})
