self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
// The worker's own requests to the other loopback port, under 127.0.0.1 and under the app's host ({{HOST}}, the
// host this script was served from): the shell's service worker hook answers both locally.
const LEAKS = { '/sw-leak': 'http://127.0.0.1:{{OTHER}}/sw-leak', '/sw-leak-label': 'http://{{HOST}}:{{OTHER}}/sw-leak-label' };
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === '/sw-probe') {
    event.respondWith(fetch(event.request).then((r) => r.text()).then((t) => new Response('sw:' + t)));
  } else if (LEAKS[url.pathname]) {
    event.respondWith(fetch(LEAKS[url.pathname], { mode: 'no-cors', credentials: 'include' })
      .then((r) => new Response('leak-status:' + r.status + ':' + r.type), (e) => new Response('leak-err:' + e.name)));
  }
});
