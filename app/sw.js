// Network first, cache as fallback: always fresh online, still opens offline (SP-04).
const CACHE = 'fa-shell-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'vendor/supabase.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/badge-96.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })
      .then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : undefined)))
  );
});

// ---------- notifications (NT-03…NT-06) ----------
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Family App', {
    body: d.body || '', tag: d.tag, renotify: !!d.tag && !d.quiet, // grouped shopping updates stay silent
    icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', data: { url: d.url || './' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope);
  const tab = url.searchParams.get('tab');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const c = cs.find((w) => 'focus' in w);
    if (c) { c.postMessage({ tab }); return c.focus(); }
    return self.clients.openWindow(url.href);
  }));
});
