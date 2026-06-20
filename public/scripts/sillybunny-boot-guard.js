// SillyBunny: surface iOS/WebKit boot failures that otherwise leave the preloader up forever.
(function () {
    'use strict';

    var bootCompleted = false;
    var failureShown = false;
    var failureDismissed = false;
    var lastFailure = null;
    var timeoutId = null;
    var timeoutWarningShown = false;
    var loaderRemovalGraceActive = false;
    var BOOT_TIMEOUT_MS = 25000;
    var BOOT_TIMEOUT_RETRY_MS = 10000;
    var BOOT_TIMEOUT_LOADER_REMOVAL_GRACE_MS = 2000;
    var MAX_BOOT_TIMEOUT_MS = 90000;
    var bootStartedAt = Date.now();

    var THIRD_PARTY_EXTENSION_PATH = '/scripts/extensions/third-party/';

    function isThirdPartyExtensionSource(value) {
        try {
            return String(value || '').indexOf(THIRD_PARTY_EXTENSION_PATH) !== -1;
        } catch (_error) {
            return false;
        }
    }

    function describeError(error) {
        try {
            if (!error) {
                return 'Unknown startup error.';
            }

            if (typeof error === 'string') {
                return error;
            }

            if (error.stack) {
                return String(error.stack);
            }

            if (error.message) {
                return String(error.message);
            }

            return String(error);
        } catch (_error) {
            return 'Unable to read startup error details.';
        }
    }

    function recordFailure(message, error) {
        var details = message || 'SillyBunny startup failed.';
        var errorDetails = describeError(error);

        if (errorDetails && details.indexOf(errorDetails) === -1) {
            details += '\n' + errorDetails;
        }

        lastFailure = details;
        window.setTimeout(function () {
            showFailure(details);
        }, 0);
    }

    function clearBrowserCaches() {
        var tasks = [];

        try {
            if ('caches' in window && window.caches.keys) {
                tasks.push(window.caches.keys().then(function (keys) {
                    return Promise.all(keys.map(function (key) {
                        return window.caches.delete(key);
                    }));
                }));
            }
        } catch (error) {
            console.warn('Unable to access frontend caches before reload.', error);
        }

        try {
            if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
                tasks.push(navigator.serviceWorker.getRegistrations().then(function (registrations) {
                    return Promise.all(registrations.map(function (registration) {
                        return registration.unregister();
                    }));
                }));
            }
        } catch (error) {
            console.warn('Unable to access service worker registrations before reload.', error);
        }

        return Promise.all(tasks);
    }

    function reloadAfterCacheClear(button) {
        button.disabled = true;
        button.textContent = 'Clearing cache...';

        clearBrowserCaches()
            .catch(function (error) {
                console.warn('Unable to clear frontend caches before reload.', error);
            })
            .then(function () {
                window.location.reload();
            });
    }

    function removeElement(element) {
        if (!element) {
            return;
        }

        if (typeof element.remove === 'function') {
            element.remove();
            return;
        }

        if (element.parentNode) {
            element.parentNode.removeChild(element);
        }
    }

    function queryAll(selector, root) {
        try {
            return Array.prototype.slice.call((root || document).querySelectorAll(selector));
        } catch (_error) {
            return [];
        }
    }

    function isStartupLoaderActive() {
        try {
            return Boolean(document.querySelector('#loader, .splash-screen, #load-spinner, dialog #loader, dialog .splash-screen, dialog #load-spinner'));
        } catch (_error) {
            return false;
        }
    }

    function removeStartupLoaderArtifacts() {
        queryAll('dialog').forEach(function (dialog) {
            try {
                if (dialog.querySelector('#loader, .splash-screen, #load-spinner')) {
                    removeElement(dialog);
                }
            } catch (_error) {
                // Keep surfacing the boot failure even if a browser rejects a selector.
            }
        });

        queryAll('#loader, .splash-screen, #load-spinner, ._poly_dialog_overlay').forEach(removeElement);
    }

    function getElapsedBootTimeMs() {
        return Date.now() - bootStartedAt;
    }

    function scheduleBootTimeout(delay) {
        timeoutId = window.setTimeout(handleBootTimeout, delay);
    }

    function handleBootTimeout() {
        if (bootCompleted || failureShown || failureDismissed) {
            return;
        }

        if (!lastFailure && isStartupLoaderActive()) {
            loaderRemovalGraceActive = false;

            if (!timeoutWarningShown && getElapsedBootTimeMs() >= MAX_BOOT_TIMEOUT_MS) {
                timeoutWarningShown = true;
                console.warn('SillyBunny startup is still waiting for the loader to finish; no startup error was captured.');
                showFailure('Startup timed out before SillyBunny removed the preloader.');
                return;
            }

            scheduleBootTimeout(BOOT_TIMEOUT_RETRY_MS);
            return;
        }

        if (!lastFailure && !loaderRemovalGraceActive) {
            loaderRemovalGraceActive = true;
            scheduleBootTimeout(BOOT_TIMEOUT_LOADER_REMOVAL_GRACE_MS);
            return;
        }

        showFailure(lastFailure || 'Startup timed out after the preloader disappeared before SillyBunny finished booting.');
    }

    function showFailure(details) {
        if (bootCompleted || failureShown || failureDismissed) {
            return;
        }

        var preloader = document.getElementById('preloader');
        if (!preloader) {
            return;
        }

        failureShown = true;
        removeStartupLoaderArtifacts();
        preloader.innerHTML = '';
        preloader.removeAttribute('aria-hidden');
        preloader.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:#1d2128;color:#f4f7fb;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;backdrop-filter:none;-webkit-backdrop-filter:none;';

        var panel = document.createElement('div');
        panel.style.cssText = 'width:min(100%,520px);max-height:calc(100vh - 48px);overflow:auto;border:1px solid rgba(255,255,255,.22);border-radius:18px;background:#0e1218;box-shadow:0 20px 60px rgba(0,0,0,.55);padding:22px;line-height:1.45;';

        var title = document.createElement('h1');
        title.textContent = 'SillyBunny could not finish loading';
        title.style.cssText = 'margin:0 0 10px;font-size:22px;line-height:1.2;color:#f4f7fb;';

        var message = document.createElement('p');
        message.textContent = 'Your browser stopped during startup. This can happen on iOS WebKit when stale cached files or blocked storage prevent the app modules from loading.';
        message.style.cssText = 'margin:0 0 16px;color:#d5dce8;';

        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Clear frontend cache and reload';
        button.style.cssText = 'width:100%;border:0;border-radius:12px;background:#6ee7b7;color:#0f172a;font-weight:700;font-size:16px;padding:12px 14px;cursor:pointer;';
        button.addEventListener('click', function () {
            reloadAfterCacheClear(button);
        });

        var dismissButton = document.createElement('button');
        dismissButton.type = 'button';
        dismissButton.textContent = 'Continue anyway';
        dismissButton.style.cssText = 'width:100%;margin-top:10px;border:1px solid rgba(255,255,255,.3);border-radius:12px;background:transparent;color:#e2e8f0;font-weight:600;font-size:15px;padding:11px 14px;cursor:pointer;';
        dismissButton.addEventListener('click', function () {
            failureDismissed = true;
            if (timeoutId) {
                window.clearTimeout(timeoutId);
            }
            removeElement(preloader);
        });

        var hint = document.createElement('p');
        hint.textContent = 'If this keeps happening, clear this site\'s Safari/Chrome website data and reload.';
        hint.style.cssText = 'margin:14px 0 0;color:#b0bccd;font-size:14px;';

        var summary = document.createElement('details');
        summary.style.cssText = 'margin-top:16px;color:#d5dce8;';

        var summaryTitle = document.createElement('summary');
        summaryTitle.textContent = 'Startup error details';

        var pre = document.createElement('pre');
        pre.textContent = details || lastFailure || 'Startup timed out before SillyBunny removed the preloader.';
        pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;margin:10px 0 0;padding:12px;border-radius:10px;background:#0f172a;color:#e2e8f0;font-size:12px;';

        summary.appendChild(summaryTitle);
        summary.appendChild(pre);
        panel.appendChild(title);
        panel.appendChild(message);
        panel.appendChild(button);
        panel.appendChild(dismissButton);
        panel.appendChild(hint);
        panel.appendChild(summary);
        preloader.appendChild(panel);
    }

    window.SillyBunnyBootGuard = {
        bootCompleted: function () {
            bootCompleted = true;
            loaderRemovalGraceActive = false;
            if (timeoutId) {
                window.clearTimeout(timeoutId);
            }
        },
        showFailure: showFailure,
    };

    window.addEventListener('error', function (event) {
        if (bootCompleted) {
            return;
        }

        if (event.target && event.target !== window) {
            var target = event.target;
            var tagName = target.tagName;
            var rel = target.rel || '';
            var url = target.src || target.href || '';

            if (isThirdPartyExtensionSource(url)) {
                console.warn('SillyBunny boot guard ignored a third-party extension resource failure.', url);
                return;
            }

            if (tagName === 'SCRIPT' || (tagName === 'LINK' && rel.indexOf('modulepreload') !== -1)) {
                recordFailure('Failed to load startup resource: ' + url, event.error);
            }

            return;
        }

        if (isThirdPartyExtensionSource(event.filename)) {
            console.warn('SillyBunny boot guard ignored a third-party extension startup error.', event.filename);
            return;
        }

        var source = event.filename ? ' at ' + event.filename + ':' + event.lineno + ':' + event.colno : '';
        recordFailure(String(event.message || 'Startup script error') + source, event.error);
    }, true);

    window.addEventListener('unhandledrejection', function (event) {
        if (bootCompleted) {
            return;
        }

        if (isThirdPartyExtensionSource(describeError(event.reason))) {
            console.warn('SillyBunny boot guard ignored a third-party extension startup rejection.', event.reason);
            return;
        }

        recordFailure('Unhandled startup promise rejection.', event.reason);
    });

    scheduleBootTimeout(BOOT_TIMEOUT_MS);
}());
