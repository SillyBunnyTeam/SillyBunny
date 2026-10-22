self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === '/sw-probe') {
    event.respondWith(fetch(event.request).then((r) => r.text()).then((t) => new Response('sw:' + t)));
  } else if (url.pathname === '/sw-leak') {
    event.respondWith(fetch('http://127.0.0.1:{{OTHER}}/sw-leak', { mode: 'no-cors', credentials: 'include' })
      .then((r) => new Response('leak-status:' + r.status + ':' + r.type), (e) => new Response('leak-err:' + e.name)));
  }
});
