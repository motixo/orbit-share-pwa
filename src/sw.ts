const worker: ServiceWorkerGlobalScope = self as typeof self & ServiceWorkerGlobalScope;
const CACHE = 'orbit-phone-v12';
const FILES = ['/', '/index.html', '/style.css', '/app.js', '/protocol.js', '/vendor/jsQR.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.json'];
worker.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => worker.skipWaiting()));
});
worker.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => worker.clients.claim()));
});
worker.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request, { ignoreSearch: true }).then(cached => cached || fetch(event.request)));
});
