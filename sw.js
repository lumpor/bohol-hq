// Serves the app from cache (fast, works offline) and checks for a newer version in the
// background every time. When a file has changed, the page is told so it can offer an update.
const CACHE = 'boholhq-v2';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const CODE = /(\/|\.html|\.js|\.css|\.webmanifest)$/;

self.addEventListener('install', e => {
  // 'reload' skips the browser's own cache, so a new version never starts out with old files
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function tellPages() {
  for (const c of await self.clients.matchAll()) c.postMessage({ type: 'update-ready' });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    // copy now: the page reads the cached response's body before the comparison below runs
    const cachedCopy = cached && CODE.test(url.pathname) ? cached.clone() : null;
    const fresh = fetch(e.request, { cache: 'no-cache' }).then(async res => {
      if (!res.ok) return res;
      let changed = false;
      if (cachedCopy) {
        const [before, after] = await Promise.all([cachedCopy.text(), res.clone().text()]);
        changed = before !== after;
      }
      await cache.put(e.request, res.clone());
      if (changed) await tellPages();
      return res;
    }).catch(() => cached);
    if (!cached) return fresh;
    e.waitUntil(fresh);
    return cached;
  }));
});
