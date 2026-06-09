const SB_SW_CACHE_VERSION = 'sillybunny-cache-v20260609a';
const SB_STATIC_CACHE = `${SB_SW_CACHE_VERSION}-static`;
const SB_SHELL_CACHE = `${SB_SW_CACHE_VERSION}-shell`;
const SB_FRONTEND_ASSET_PREFIX = '/frontend-assets/';
const SB_HASHED_FRONTEND_ASSET_RE = /-[a-f0-9]{8,}\.[a-z0-9]+$/i;

const SB_STALE_WHILE_REVALIDATE_PREFIXES = Object.freeze([
    '/lib/',
    '/css/',
    '/img/',
    '/webfonts/',
]);

const SB_NETWORK_FIRST_EXTENSIONS = Object.freeze([
    '.html',
    '.js',
    '.mjs',
]);

function isSameOrigin(url) {
    return url.origin === self.location.origin;
}

function shouldStaleWhileRevalidate(url) {
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
    return response && response.ok && response.type === 'basic';
}

async function putCache(cache, request, response) {
    if (!isCacheableResponse(response)) {
        return;
    }

    await cache.put(request, response.clone());
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(SB_STATIC_CACHE);
    const cachedResponse = await cache.match(request);
    const freshResponse = fetch(request)
        .then((response) => {
            putCache(cache, request, response).catch((error) => {
                console.debug('SillyBunny service worker skipped static cache update.', error);
            });

            return response;
        })
        .catch((error) => {
            if (cachedResponse) {
                return cachedResponse;
            }

            throw error;
        });

    return cachedResponse || freshResponse;
}

async function cacheFirst(request) {
    const cache = await caches.open(SB_STATIC_CACHE);
    const cachedResponse = await cache.match(request);

    if (cachedResponse) {
        return cachedResponse;
    }

    const response = await fetch(request);
    await putCache(cache, request, response).catch((error) => {
        console.debug('SillyBunny service worker skipped immutable cache update.', error);
    });
    return response;
}

async function networkFirst(request) {
    const cache = await caches.open(SB_SHELL_CACHE);

    try {
        const response = await fetch(request);
        await putCache(cache, request, response).catch((error) => {
            console.debug('SillyBunny service worker skipped shell cache update.', error);
        });
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
        event.respondWith(cacheFirst(request));
        return;
    }

    if (shouldStaleWhileRevalidate(url)) {
        event.respondWith(staleWhileRevalidate(request));
        return;
    }

    if (shouldNetworkFirst(url)) {
        event.respondWith(networkFirst(request));
    }
});
