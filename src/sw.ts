const worker: ServiceWorkerGlobalScope = self as typeof self & ServiceWorkerGlobalScope;
const CACHE = 'orbit-share-v32';
const development = ['localhost', '127.0.0.1', '[::1]'].includes(worker.location.hostname);
const FILES = ['/', '/index.html', '/style.css', '/app.js', '/download-worker.js', '/protocol.js', '/croc.js', '/croc-engine-worker.js', '/croc-sha256-worker.js', '/vendor/jsQR.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.json'];
worker.addEventListener('install', event => {
  event.waitUntil((development ? Promise.resolve() : caches.open(CACHE).then(cache => cache.addAll(FILES))).then(() => worker.skipWaiting()));
});
worker.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => worker.clients.claim()));
});
worker.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const download = url.pathname.match(/^\/downloads\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/);
  if (download) {
    let finish!: () => void;
    event.waitUntil(new Promise<void>(resolve => { finish = resolve; }));
    event.respondWith(saveDownload(download[1], url.searchParams.get('name') || 'download', finish));
    return;
  }
  if (development) return;
  event.respondWith(caches.match(event.request, { ignoreSearch: true }).then(cached => cached || fetch(event.request)));
});

async function saveDownload(id: string, name: string, finish: () => void): Promise<Response> {
  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('orbit-downloads');
    const file = await (await directory.getFileHandle(id)).getFile();
    const reader = file.stream().getReader();
    const discard = async () => {
      try { await directory.removeEntry(id); } catch {} finally { finish(); }
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            await discard();
          } else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
          await reader.cancel(error).catch(() => {});
          await discard();
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); } finally { await discard(); }
      },
    });
    const encoded = encodeURIComponent(name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16));
    return new Response(stream, { headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(file.size),
      'Content-Disposition': "attachment; filename*=UTF-8''" + encoded,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch {
    finish();
    return new Response('Download unavailable', { status: 404 });
  }
}
