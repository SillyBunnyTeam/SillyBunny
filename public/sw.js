const SB_SW_CACHE_VERSION = 'sillybunny-cache-v20261124a';
const SB_STATIC_CACHE = `${SB_SW_CACHE_VERSION}-static`;
const SB_SHELL_CACHE = `${SB_SW_CACHE_VERSION}-shell`;
const SB_FRONTEND_ASSET_PREFIX = '/frontend-assets/';
const SB_HASHED_FRONTEND_ASSET_RE = /-[a-f0-9]{8,}\.[a-z0-9]+$/i;
const SB_IPV4_LOOPBACK_RE = /^127(?:\.\d{1,3}){3}$/;

const SB_STALE_WHILE_REVALIDATE_PREFIXES = Object.freeze([
    '/lib/',
    '/css/',
    '/img/',
    '/webfonts/',
]);

// Unhashed .js/.mjs modules stay out of Service Worker interception so warm reloads
// never serialize the module graph to Cache Storage or bypass native V8 bytecode caching.
const SB_NETWORK_FIRST_EXTENSIONS = Object.freeze([
    '.html',
]);

function isSameOrigin(url) {
    return url.origin === self.location.origin;
}

function isLoopbackHost(hostname) {
    const normalized = String(hostname || '').toLowerCase();
    return normalized === 'localhost'
        || normalized === '::1'
        || normalized === '[::1]'
        || SB_IPV4_LOOPBACK_RE.test(normalized);
}

function shouldStaleWhileRevalidate(url) {
    if (isLoopbackHost(url.hostname)) {
        return false;
    }

    return SB_STALE_WHILE_REVALIDATE_PREFIXES.some(prefix => url.pathname.startsWith(prefix));
}

function isFrontendAsset(url) {
    return url.pathname.startsWith(SB_FRONTEND_ASSET_PREFIX);
}

function shouldCacheFirst(url) {
    return isFrontendAsset(url) && SB_HASHED_FRONTEND_ASSET_RE.test(url.pathname);
}

function shouldNetworkFirst(url) {
    return url.pathname === '/' || SB_NETWORK_FIRST_EXTENSIONS.some(extension => url.pathname.endsWith(extension));
}

function isCacheableResponse(response) {
    return Boolean(response && response.ok && response.type === 'basic');
}

function queueCachePut(event, cache, request, response, debugMessage) {
    if (!isCacheableResponse(response)) {
        return;
    }

    // Clone synchronously before returning `response` to `respondWith`, then persist in the background.
    const responseClone = response.clone();
    const writePromise = cache.put(request, responseClone).catch((error) => {
        console.debug(debugMessage, error);
    });

    if (event && typeof event.waitUntil === 'function') {
        event.waitUntil(writePromise);
    }
}

async function staleWhileRevalidate(request, event) {
    const cache = await caches.open(SB_STATIC_CACHE);
    const cachedResponse = await cache.match(request);
    const networkFetch = fetch(request)
        .then((response) => {
            queueCachePut(event, cache, request, response, 'SillyBunny service worker skipped static cache update.');
            return response;
        });

    if (cachedResponse) {
        if (event && typeof event.waitUntil === 'function') {
            event.waitUntil(networkFetch.catch(() => {}));
        } else {
            networkFetch.catch(() => {});
        }
        return cachedResponse;
    }

    return networkFetch;
}

async function cacheFirst(request, event) {
    const cache = await caches.open(SB_STATIC_CACHE);
    const cachedResponse = await cache.match(request);

    if (cachedResponse) {
        return cachedResponse;
    }

    const response = await fetch(request);
    queueCachePut(event, cache, request, response, 'SillyBunny service worker skipped immutable cache update.');
    return response;
}

async function networkFirst(request, event) {
    const cache = await caches.open(SB_SHELL_CACHE);

    try {
        const response = await fetch(request);
        queueCachePut(event, cache, request, response, 'SillyBunny service worker skipped shell cache update.');
        return response;
    } catch (error) {
        const cachedResponse = await cache.match(request);

        if (cachedResponse) {
            return cachedResponse;
        }

        throw error;
    }
}

self.addEventListener('install', () => {
    self.skipWaiting();
});

// SillyBunny: iOS WebKit keeps the current page controlled by this service worker until the
// page unloads, even after registration.unregister(). Without this the SW would re-populate
// its caches during the pre-reload window and the reload navigation itself, undoing a cache
// clear. The page posts { type: 'SB_CLEAR_CACHES' } and waits for the matching reply before
// reloading.
async function deleteSillyBunnyCaches() {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
        .filter(cacheName => cacheName.startsWith('sillybunny-cache-'))
        .map(cacheName => caches.delete(cacheName)));
}

self.addEventListener('message', (event) => {
    if (event.data?.type !== 'SB_CLEAR_CACHES') {
        return;
    }

    event.waitUntil((async () => {
        let ok = true;
        try {
            await deleteSillyBunnyCaches();
        } catch (error) {
            console.error('SillyBunny service worker failed to clear caches on request.', error);
            ok = false;
        }

        const port = event.ports?.[0];
        if (port) {
            port.postMessage({ type: 'SB_CLEAR_CACHES_DONE', ok });
        }
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames
            .filter(cacheName => cacheName.startsWith('sillybunny-cache-') && cacheName !== SB_STATIC_CACHE && cacheName !== SB_SHELL_CACHE)
            .map(cacheName => caches.delete(cacheName)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    if (request.method !== 'GET') {
        return;
    }

    const url = new URL(request.url);

    if (!isSameOrigin(url)) {
        return;
    }

    if (isFrontendAsset(url) && !shouldCacheFirst(url)) {
        return;
    }

    if (shouldCacheFirst(url)) {
        event.respondWith(cacheFirst(request, event));
        return;
    }

    if (shouldStaleWhileRevalidate(url)) {
        event.respondWith(staleWhileRevalidate(request, event));
        return;
    }

    if (shouldNetworkFirst(url)) {
        event.respondWith(networkFirst(request, event));
    }
});
