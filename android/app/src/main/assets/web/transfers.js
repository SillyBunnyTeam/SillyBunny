/*
 * Page export capture for the SillyBunny Android app's WebView (plan §4.5).
 *
 * The app adds this as a document-start script, together with the `sillybunnyTransfers` message
 * bridge, only for its exact origin, so it runs before any page script. It keeps the Blob behind
 * every `blob:` URL from the moment the URL is created and captures `<a download>` clicks, including
 * detached anchors and programmatic `click()` calls, so an export still works when the page revokes
 * the URL right after `click()`. Bytes are read in bounded chunks only after the user has chosen a
 * destination, and the app acknowledges every chunk. Same-origin HTTP(S) `<a download>` links are
 * handed to the app, which fetches them with the WebView's cookies. Form POSTs are reported so the
 * app never repeats one as a GET request.
 */
(() => {
    'use strict';

    const BRIDGE_NAME = 'sillybunnyTransfers';
    const API = Symbol.for('sillybunny.transfers');
    const KEEP_REVOKED_MS = 10000;
    const KEEP_HINT_MS = 10000;
    const KEY_CHARS = 64;
    const MAX_NAME_CHARS = 1024;
    const MAX_MIME_CHARS = 256;
    const BASE64_SLICE = 0x8000;

    const bridge = globalThis[BRIDGE_NAME];
    if (!bridge || typeof bridge.postMessage !== 'function' || Object.prototype.hasOwnProperty.call(globalThis, API)) {
        return;
    }
    // Page scripts have no use for the bridge; the app checks every message it receives anyway.
    try {
        delete globalThis[BRIDGE_NAME];
    } catch {
        // Not configurable in this WebView, so it stays visible.
    }

    const schedule = setTimeout.bind(globalThis);
    const nativeFetch = fetch.bind(globalThis);
    const blobSlice = Blob.prototype.slice;
    const now = () => Date.now();
    const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
        (byte) => byte.toString(16).padStart(2, '0')).join('');

    const send = (message) => {
        try {
            bridge.postMessage(JSON.stringify(message));
        } catch {
            // The app's side of the bridge is gone; there is nobody to tell.
        }
    };

    let doc = randomId();

    // Every frame of the app origin reports form POSTs, so a download they cause is never refetched.
    const reportPost = (form, submitter) => {
        try {
            if (!(form instanceof HTMLFormElement)) {
                return;
            }
            const button = submitter instanceof HTMLElement ? submitter : null;
            const method = button && button.hasAttribute('formmethod') ? button.formMethod : form.method;
            if (String(method).toLowerCase() !== 'post') {
                return;
            }
            const action = button && button.hasAttribute('formaction') ? button.formAction : form.action;
            send({ t: 'post', doc, url: String(action) });
        } catch {
            // Reporting must never break the page's own submission.
        }
    };
    window.addEventListener('submit', (event) => reportPost(event.target, event.submitter), true);
    const nativeSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function submit() {
        reportPost(this, null);
        return nativeSubmit.call(this);
    };

    if (window.top !== window) {
        return;
    }

    const live = new Map();
    const revoked = new Map();
    const hints = new Map();
    const exportsById = new Map();
    let sweeping = false;

    const sweep = () => {
        sweeping = false;
        const time = now();
        for (const [url, entry] of revoked) {
            if (time - entry.at > KEEP_REVOKED_MS) {
                revoked.delete(url);
            }
        }
        for (const [url, entry] of hints) {
            if (time - entry.at > KEEP_HINT_MS) {
                hints.delete(url);
            }
        }
        if (revoked.size > 0 || hints.size > 0) {
            scheduleSweep();
        }
    };
    const scheduleSweep = () => {
        if (!sweeping) {
            sweeping = true;
            schedule(sweep, Math.max(KEEP_REVOKED_MS, KEEP_HINT_MS));
        }
    };

    // Keep each Blob reachable by its URL; after revocation only for a short grace period.
    const nativeCreate = URL.createObjectURL;
    const nativeRevoke = URL.revokeObjectURL;
    URL.createObjectURL = function createObjectURL(...args) {
        const url = nativeCreate.apply(this, args);
        if (args[0] instanceof Blob) {
            live.set(url, args[0]);
        }
        return url;
    };
    URL.revokeObjectURL = function revokeObjectURL(...args) {
        const key = String(args[0]);
        const blob = live.get(key);
        if (blob) {
            live.delete(key);
            revoked.set(key, { blob, at: now() });
            scheduleSweep();
        }
        return nativeRevoke.apply(this, args);
    };

    const blobFor = (url) => {
        const kept = live.get(url) || revoked.get(url);
        return kept instanceof Blob ? kept : (kept && kept.blob) || null;
    };
    const keyOf = (url) => (url.startsWith('data:') && url.length > KEY_CHARS
        ? `${url.slice(0, KEY_CHARS)}#${url.length}`
        : url);
    const fetchBlob = (url) => nativeFetch(url).then((response) => {
        if (!response.ok) {
            throw new Error(`status ${response.status}`);
        }
        return response.blob();
    });

    const toBase64 = (buffer) => {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let index = 0; index < bytes.length; index += BASE64_SLICE) {
            binary += String.fromCharCode.apply(null, bytes.subarray(index, index + BASE64_SLICE));
        }
        return btoa(binary);
    };

    const close = (entry) => {
        entry.closed = true;
        entry.blob = null;
        exportsById.delete(entry.id);
    };
    const abort = (entry) => {
        if (!entry.closed) {
            close(entry);
            send({ t: 'abort', id: entry.id });
        }
    };

    // Streams the next chunk while fewer than `win` chunks wait for the app's acknowledgement.
    const pump = (entry) => {
        if (entry.closed || entry.reading || !entry.blob || !entry.chunk) {
            return;
        }
        const size = entry.blob.size;
        const start = entry.next * entry.chunk;
        if (start >= size) {
            if (!entry.ended) {
                entry.ended = true;
                send({ t: 'end', id: entry.id, size });
            }
            return;
        }
        if (entry.next - entry.acked >= entry.win) {
            return;
        }
        entry.reading = true;
        const seq = entry.next;
        blobSlice.call(entry.blob, start, Math.min(size, start + entry.chunk)).arrayBuffer().then((buffer) => {
            entry.reading = false;
            if (entry.closed) {
                return;
            }
            if (entry.bin) {
                const frame = new Uint8Array(8 + buffer.byteLength);
                const view = new DataView(frame.buffer);
                view.setUint32(0, entry.slot);
                view.setUint32(4, seq);
                frame.set(new Uint8Array(buffer), 8);
                bridge.postMessage(frame.buffer);
            } else {
                send({ t: 'chunk', id: entry.id, seq, data: toBase64(buffer) });
            }
            entry.next = seq + 1;
            pump(entry);
        }).catch(() => {
            entry.reading = false;
            abort(entry);
        });
    };

    // Announces an export once its Blob is in hand; the app answers with `ready` or `cancel`.
    const begin = (source, name, url) => {
        const entry = {
            id: randomId(), blob: null, closed: false, slot: 0, chunk: 0, win: 1, bin: false,
            next: 0, acked: 0, reading: false, ended: false,
        };
        exportsById.set(entry.id, entry);
        Promise.resolve(source).then((blob) => {
            if (entry.closed) {
                return;
            }
            if (!(blob instanceof Blob)) {
                throw new TypeError('not a Blob');
            }
            entry.blob = blob;
            send({
                t: 'begin',
                doc,
                id: entry.id,
                name: String(name || '').slice(0, MAX_NAME_CHARS),
                mime: String(blob.type || '').slice(0, MAX_MIME_CHARS),
                size: blob.size,
                key: url ? keyOf(url) : '',
            });
        }).catch(() => {
            if (!entry.closed) {
                close(entry);
                send({ t: 'fail', doc });
            }
        });
    };

    const anchorIn = (event) => {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
        for (const node of path) {
            if ((node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) && node.hasAttribute('href')) {
                return node;
            }
        }
        return null;
    };

    // A download the app can take: `blob:`/`data:`, or HTTP(S) of this exact origin.
    const downloadOf = (anchor) => {
        const name = anchor.getAttribute('download');
        if (name === null) {
            return null;
        }
        const href = anchor.href;
        let url;
        try {
            url = new URL(href);
        } catch {
            return null;
        }
        if (url.protocol === 'blob:' || url.protocol === 'data:') {
            return { href, name, http: false };
        }
        if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === location.origin) {
            return { href: url.href, name, http: true };
        }
        return null;
    };

    // Capture phase: remember the name even if a page handler later stops the click.
    const remember = (event) => {
        try {
            const anchor = anchorIn(event);
            const download = anchor && downloadOf(anchor);
            if (download) {
                hints.set(download.href, { name: download.name, at: now() });
                scheduleSweep();
            }
        } catch {
            // A hint is optional.
        }
    };

    // Last listener on the path: take the download unless the page cancelled the click.
    const take = (event) => {
        try {
            if (event.defaultPrevented || !event.cancelable) {
                return;
            }
            const anchor = anchorIn(event);
            const download = anchor && downloadOf(anchor);
            if (!download) {
                return;
            }
            if (download.http) {
                send({ t: 'get', doc, url: download.href, name: download.name.slice(0, MAX_NAME_CHARS) });
            } else {
                // Resolve the Blob now, before the page can revoke its URL.
                begin(blobFor(download.href) || fetchBlob(download.href), download.name, download.href);
            }
            event.preventDefault();
        } catch {
            // Leave the click to the WebView.
        }
    };
    window.addEventListener('click', remember, true);
    window.addEventListener('click', take, false);

    // A detached anchor's click never reaches window, so watch it at the root of its own tree.
    const watchDetached = (element, dispatch) => {
        if (!(element instanceof HTMLAnchorElement || element instanceof HTMLAreaElement) || element.isConnected) {
            return dispatch();
        }
        const root = element.getRootNode();
        root.addEventListener('click', remember, true);
        root.addEventListener('click', take, false);
        try {
            return dispatch();
        } finally {
            root.removeEventListener('click', remember, true);
            root.removeEventListener('click', take, false);
        }
    };
    const nativeClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function click() {
        return watchDetached(this, () => nativeClick.call(this));
    };
    const nativeDispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function dispatchEvent(event) {
        if (event instanceof Event && event.type === 'click') {
            return watchDetached(this, () => nativeDispatch.call(this, event));
        }
        return nativeDispatch.call(this, event);
    };

    const onNative = (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        const entry = message && typeof message.id === 'string' ? exportsById.get(message.id) : undefined;
        if (!entry) {
            return;
        }
        switch (message.t) {
            case 'ready':
                entry.slot = message.slot >>> 0;
                entry.chunk = Math.max(1, message.chunk | 0);
                entry.win = Math.max(1, message.win | 0);
                entry.bin = message.bin === true;
                pump(entry);
                break;
            case 'ack':
                entry.acked = Math.max(entry.acked, (message.seq | 0) + 1);
                pump(entry);
                break;
            case 'done':
            case 'cancel':
                close(entry);
                break;
            default:
                break;
        }
    };
    if (typeof bridge.addEventListener === 'function') {
        bridge.addEventListener('message', onNative);
    } else {
        bridge.onmessage = onNative;
    }

    window.addEventListener('pagehide', () => {
        for (const entry of Array.from(exportsById.values())) {
            close(entry);
        }
        send({ t: 'bye', doc });
    });
    window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
            doc = randomId();
            send({ t: 'hello', doc });
        }
    });

    // For the app: export a `blob:` URL the page navigated to or downloaded without a captured click.
    Object.defineProperty(globalThis, API, {
        value: Object.freeze({
            saveUrl(url) {
                const href = String(url);
                if (!href.startsWith('blob:')) {
                    return false;
                }
                const hint = hints.get(href);
                begin(blobFor(href) || fetchBlob(href), hint ? hint.name : '', href);
                return true;
            },
        }),
    });

    send({ t: 'hello', doc });
})();
