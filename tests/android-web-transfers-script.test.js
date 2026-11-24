import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transfersSource = readFileSync(path.join(repoRoot, 'android', 'app', 'src', 'main', 'assets', 'web', 'transfers.js'), 'utf8');

function createHarness() {
    const messages = [];
    const listeners = new Map();
    const fetched = [];
    let counter = 0;

    class FakeEventTarget {
        addEventListener(type, fn, capture = false) {
            const key = `${type}:${Boolean(capture)}`;
            if (!listeners.has(key)) listeners.set(key, []);
            listeners.get(key).push(fn);
        }

        removeEventListener(type, fn, capture = false) {
            const key = `${type}:${Boolean(capture)}`;
            const list = listeners.get(key);
            if (!list) return;
            const index = list.indexOf(fn);
            if (index >= 0) list.splice(index, 1);
        }

        dispatchEvent() {
            return true;
        }
    }

    class FakeElement extends FakeEventTarget {
        click() {}
    }

    class FakeFormElement extends FakeElement {
        submit() {}
    }

    class FakeAnchorElement extends FakeElement {
        constructor(href, download) {
            super();
            this.href = href;
            this._download = download;
            this.isConnected = true;
        }

        hasAttribute(name) {
            return name === 'href' ? Boolean(this.href) : name === 'download' ? this._download !== null : false;
        }

        getAttribute(name) {
            return name === 'download' ? this._download : null;
        }

        getRootNode() {
            return this;
        }
    }

    class FakeAreaElement extends FakeAnchorElement {}

    class FakeEvent {
        constructor(type) {
            this.type = type;
            this.defaultPrevented = false;
            this.cancelable = true;
        }

        preventDefault() {
            this.defaultPrevented = true;
        }
    }

    const fakeUrl = class extends URL {};
    fakeUrl.createObjectURL = () => `blob:http://127.0.0.1:8000/item-${++counter}`;
    fakeUrl.revokeObjectURL = () => {};

    const sandbox = {
        Blob,
        Uint8Array,
        DataView,
        Map,
        Symbol,
        Promise,
        TypeError,
        URL: fakeUrl,
        Event: FakeEvent,
        EventTarget: FakeEventTarget,
        HTMLElement: FakeElement,
        HTMLFormElement: FakeFormElement,
        HTMLAnchorElement: FakeAnchorElement,
        HTMLAreaElement: FakeAreaElement,
        location: { origin: 'http://127.0.0.1:8000' },
        crypto: {
            getRandomValues(array) {
                array.fill(7);
                return array;
            },
        },
        btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
        setTimeout: () => 1,
        fetch: async (url) => {
            fetched.push(url);
            return { ok: true, blob: async () => new Blob(['fetched-fallback'], { type: 'text/plain' }) };
        },
        sillybunnyTransfers: {
            postMessage(payload) {
                messages.push(JSON.parse(payload));
            },
        },
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    sandbox.top = sandbox;
    sandbox.addEventListener = FakeEventTarget.prototype.addEventListener;
    sandbox.removeEventListener = FakeEventTarget.prototype.removeEventListener;

    vm.runInNewContext(transfersSource, sandbox);

    function clickDownload(href, name = 'export.txt') {
        const anchor = new FakeAnchorElement(href, name);
        const event = new FakeEvent('click');
        event.target = anchor;
        event.composedPath = () => [anchor];
        for (const fn of listeners.get('click:true') || []) fn(event);
        for (const fn of listeners.get('click:false') || []) fn(event);
    }

    return { sandbox, messages, fetched, clickDownload };
}

describe('Android WebView transfers.js bounded Blob cache', () => {
    test('evicts oldest unrevoked Blobs past the cap while serving recent Blobs directly', async () => {
        const { sandbox, messages, fetched, clickDownload } = createHarness();
        const urls = [];
        for (let index = 0; index < 150; index++) {
            urls.push(sandbox.URL.createObjectURL(new Blob([`payload-${index}`], { type: 'text/plain' })));
        }

        // Most recent URL resolves from the in-memory map without calling fetch.
        clickDownload(urls[149], 'recent.txt');
        await new Promise((resolve) => setImmediate(resolve));
        expect(fetched).toEqual([]);
        expect(messages.at(-1)).toMatchObject({ t: 'begin', name: 'recent.txt', size: 'payload-149'.length });

        // Oldest URL was evicted from the bounded cache and falls back cleanly to fetch.
        clickDownload(urls[0], 'oldest.txt');
        await new Promise((resolve) => setImmediate(resolve));
        expect(fetched).toEqual([urls[0]]);
        expect(messages.at(-1)).toMatchObject({ t: 'begin', name: 'oldest.txt', size: 'fetched-fallback'.length });
    });

    test('evicts oldest unrevoked Blobs when cumulative size exceeds the 32 MiB live byte budget', async () => {
        const { sandbox, messages, fetched, clickDownload } = createHarness();
        const chunkBytes = 10 * 1024 * 1024; // 10 MiB each
        const chunk = new Uint8Array(chunkBytes);
        const urls = [];
        for (let index = 0; index < 4; index++) {
            urls.push(sandbox.URL.createObjectURL(new Blob([chunk], { type: 'application/octet-stream' })));
        }

        // Total is 40 MiB > 32 MiB, so url[0] is evicted while urls[1..3] (30 MiB) stay cached.
        clickDownload(urls[3], 'newest.bin');
        await new Promise((resolve) => setImmediate(resolve));
        expect(fetched).toEqual([]);
        expect(messages.at(-1)).toMatchObject({ t: 'begin', name: 'newest.bin', size: chunkBytes });

        clickDownload(urls[1], 'second.bin');
        await new Promise((resolve) => setImmediate(resolve));
        expect(fetched).toEqual([]);
        expect(messages.at(-1)).toMatchObject({ t: 'begin', name: 'second.bin', size: chunkBytes });

        clickDownload(urls[0], 'evicted.bin');
        await new Promise((resolve) => setImmediate(resolve));
        expect(fetched).toEqual([urls[0]]);
        expect(messages.at(-1)).toMatchObject({ t: 'begin', name: 'evicted.bin', size: 'fetched-fallback'.length });
    });

    test('evicts oldest revoked Blobs when cumulative size exceeds the 16 MiB revoked byte budget', async () => {
        const { sandbox, messages, fetched, clickDownload } = createHarness();
        const chunkBytes = 6 * 1024 * 1024; // 6 MiB each
        const chunk = new Uint8Array(chunkBytes);
        const urls = [];
        for (let index = 0; index < 3; index++) {
            const url = sandbox.URL.createObjectURL(new Blob([chunk], { type: 'application/octet-stream' }));
            urls.push(url);
            sandbox.URL.revokeObjectURL(url);
        }

        // Revoked total was 18 MiB > 16 MiB, so url[0] is evicted while urls[1..2] (12 MiB) stay cached.
        clickDownload(urls[2], 'revoked-newest.bin');
        await new Promise((resolve) => setImmediate(resolve));
        expect(fetched).toEqual([]);
        expect(messages.at(-1)).toMatchObject({ t: 'begin', name: 'revoked-newest.bin', size: chunkBytes });

        clickDownload(urls[1], 'revoked-second.bin');
        await new Promise((resolve) => setImmediate(resolve));
        expect(fetched).toEqual([]);
        expect(messages.at(-1)).toMatchObject({ t: 'begin', name: 'revoked-second.bin', size: chunkBytes });

        clickDownload(urls[0], 'revoked-evicted.bin');
        await new Promise((resolve) => setImmediate(resolve));
        expect(fetched).toEqual([urls[0]]);
        expect(messages.at(-1)).toMatchObject({ t: 'begin', name: 'revoked-evicted.bin', size: 'fetched-fallback'.length });
    });
});
