// Retirement endpoint for previously installed Mealio workers. This script has
// no fetch handler and never reads or removes personal IndexedDB data.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim()
    await self.registration.unregister()
    const names = await caches.keys()
    await Promise.all(names.filter((name) => name.startsWith('mealio-public-')).map((name) => caches.delete(name)))
  })())
})
