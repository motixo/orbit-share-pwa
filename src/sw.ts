const worker: ServiceWorkerGlobalScope = self as typeof self & ServiceWorkerGlobalScope;
const CACHE = 'orbit-share-__VERSION__';
const development = ['localhost', '127.0.0.1', '[::1]'].includes(worker.location.hostname);
const FILES = ['/', '/index.html', '/style.css', '/app.js', '/download-worker.js', '/protocol.js', '/croc.js', '/croc-engine-worker.js', '/croc-sha256-worker.js', '/vendor/jsQR.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.json'];
worker.addEventListener('activate', event => {
  event.waitUntil((async () => {
    if (await (await caches.open(CACHE)).match('/index.html')) await discardPrevious();
    await worker.clients.claim();
  })());
});
async function discardPrevious() {
  const cache = await caches.open(CACHE);
  const history = await cache.match('/.orbit-previous-caches');
  if (!history) return;
  // A newer waiting worker may already have created its own cache.
  const keys: string[] = await history.json();
  await Promise.all(keys.filter(key => key.startsWith('orbit-share-') && key !== CACHE).map(key => caches.delete(key)));
  await cache.delete('/.orbit-previous-caches');
}
let preparing: Promise<void> | undefined;
worker.addEventListener('message', event => {
  if (event.data?.type === 'activate') {
    event.waitUntil(worker.skipWaiting());
  } else if (event.data?.type === 'prepare') {
    // Offline caching must not block activation or file downloads.
    preparing ??= (async () => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 20000);
      try {
        if (development) return;
        const previous = await caches.keys();
        const obsolete = !event.data.update && (worker.registration.waiting || worker.registration.installing) ? [] : previous;
        const cache = await caches.open(CACHE);
        if (!await cache.match('/index.html')) {
          await cache.addAll(FILES.map(path => new Request(path, { cache: 'reload', signal: abort.signal })));
          await cache.put('/.orbit-previous-caches', new Response(JSON.stringify(obsolete)));
        }
      } finally { clearTimeout(timer); }
    })();
    event.waitUntil(preparing.then(async () => {
      if (!event.data.update) await discardPrevious();
      event.ports[0]?.postMessage({ ready: true });
    }, () => {
      preparing = undefined;
      event.ports[0]?.postMessage({ ready: false });
    }));
  }
});
worker.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (development) return;
  event.respondWith(caches.open(CACHE).then(cache => cache.match(event.request, { ignoreSearch: true })).then(cached => cached || fetch(event.request).catch(async error => {
    const previous = await caches.match(event.request, { ignoreSearch: true });
    if (!previous) throw error;
    return previous;
  })));
});
