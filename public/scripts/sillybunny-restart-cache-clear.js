// SillyBunny: clears browser caches twice after every server start.
// The server marks pending clears with the sillybunny_cache_boot cookie (see
// src/middleware/restartCacheClear.js) and sends Clear-Site-Data: "cache" on
// each index load until two passes are recorded. Each pass here also purges
// Cache Storage and service workers, records progress, and reloads. The second
// pass catches caches that a still-controlling service worker re-filled
// during the first reload (iOS WebKit keeps it attached until unload).
(function () {
    'use strict';

    var BOOT_COOKIE = 'sillybunny_cache_boot';
    var PROGRESS_COOKIE = 'sillybunny_cache_cleared';
    var PASSES = 2;
    var SERVICE_WORKER_ACK_TIMEOUT_MS = 3000;

    function readCookie(name) {
        var parts = String(document.cookie || '').split(';');
        for (var i = 0; i < parts.length; i++) {
            var separator = parts[i].indexOf('=');
            if (separator !== -1 && parts[i].slice(0, separator).trim() === name) {
                try {
                    return decodeURIComponent(parts[i].slice(separator + 1).trim());
                } catch (_error) {
                    return null;
                }
            }
        }
        return null;
    }

    function getCompletedPasses(bootId) {
        var progress = readCookie(PROGRESS_COOKIE);
        if (!progress) {
            return 0;
        }
        var separator = progress.lastIndexOf('.');
        if (separator === -1 || progress.slice(0, separator) !== bootId) {
            return 0;
        }
        var passes = Number(progress.slice(separator + 1));
        return passes > 0 && Math.floor(passes) === passes ? passes : 0;
    }

    function writeProgress(bootId, passes) {
        var secure = location.protocol === 'https:' ? '; Secure' : '';
        document.cookie = PROGRESS_COOKIE + '=' + encodeURIComponent(bootId + '.' + passes) + '; path=/; SameSite=Lax; max-age=31536000' + secure;
        return getCompletedPasses(bootId) === passes;
    }

    function purgeServiceWorkerCaches() {
        var controller = navigator.serviceWorker && navigator.serviceWorker.controller;
        if (!controller || typeof MessageChannel !== 'function') {
            return Promise.resolve();
        }
        return new Promise(function (resolve) {
            var channel = new MessageChannel();
            var timeout = window.setTimeout(resolve, SERVICE_WORKER_ACK_TIMEOUT_MS);
            channel.port1.onmessage = function () {
                window.clearTimeout(timeout);
                resolve();
            };
            controller.postMessage({ type: 'SB_CLEAR_CACHES' }, [channel.port2]);
        });
    }

    function clearBrowserCaches() {
        return purgeServiceWorkerCaches().then(function () {
            var tasks = [];
            if ('caches' in window && window.caches.keys) {
                tasks.push(window.caches.keys().then(function (keys) {
                    return Promise.all(keys.map(function (key) {
                        return window.caches.delete(key);
                    }));
                }));
            }
            if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
                tasks.push(navigator.serviceWorker.getRegistrations().then(function (registrations) {
                    return Promise.all(registrations.map(function (registration) {
                        return registration.unregister();
                    }));
                }));
            }
            return Promise.all(tasks);
        });
    }

    var bootId = readCookie(BOOT_COOKIE);
    if (!bootId) {
        return;
    }

    var completed = getCompletedPasses(bootId);
    if (completed >= PASSES) {
        return;
    }

    // Record the pass before purging so a failing purge cannot loop, and
    // never reload when the browser refuses the progress cookie.
    if (!writeProgress(bootId, completed + 1)) {
        return;
    }

    var pass = completed + 1;
    clearBrowserCaches()
        .catch(function (error) {
            console.warn('[Cache] Restart cache clear pass ' + pass + ' failed.', error);
        })
        .then(function () {
            console.info('[Cache] Restart cache clear pass ' + pass + ' of ' + PASSES + ' complete. Reloading.');
            window.location.reload();
        });
})();
