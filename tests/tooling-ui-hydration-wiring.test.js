/** @jest-environment jsdom */
/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importScriptModule } from './util/script-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const styleSource = readFileSync(path.join(repoRoot, 'public', 'style.css'), 'utf8');

let activeRuntime = null;
const originalHtml2Canvas = globalThis.window?.html2canvas;

afterEach(() => {
    activeRuntime?.cleanup();
    activeRuntime = null;
    if (typeof window !== 'undefined') {
        if (originalHtml2Canvas === undefined) {
            delete window.html2canvas;
        } else {
            window.html2canvas = originalHtml2Canvas;
        }
    }
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

const SCREENSHOT_DOM = `
    <div id="chat">
        <div class="mes" mesid="0">
            <div class="mes_block">
                <div class="mes_reasoning">
                    <div class="mes_reasoning_header">
                        <span class="mes_reasoning_header_title">Thought</span>
                    </div>
                    <blockquote>Reasoning note</blockquote>
                </div>
                <div class="mes_text">
                    <p>Hello world</p>
                    <span class="dc-gradient-text">Gradient</span>
                    <div class="ica--companion-title"><span>Companion</span></div>
                    <img class="test-img" src="/img/sample.png" srcset="/img/sample@2x.png 2x" />
                </div>
                <div class="mes_buttons">
                    <button class="mes_button mes_screenshot" type="button"></button>
                </div>
            </div>
        </div>
        <div class="mes" mesid="1">
            <div class="mes_block">
                <div class="mes_text"><p>Second message</p></div>
                <div class="mes_buttons">
                    <button class="mes_button mes_screenshot" type="button"></button>
                </div>
            </div>
        </div>
        <div class="mes" mesid="2">
            <div class="mes_block">
                <div class="mes_text"><p>Third message</p></div>
                <div class="mes_buttons">
                    <button class="mes_button mes_screenshot" type="button"></button>
                </div>
            </div>
        </div>
    </div>
    <button id="wand_message_screenshot" type="button"></button>
`;

function createMockCanvas() {
    return {
        width: 400,
        height: 200,
        toBlob(cb, mimeType) {
            cb(new Blob(['fake-png'], { type: mimeType || 'image/png' }));
        },
    };
}

async function createScreenshotRuntime({
    dom = SCREENSHOT_DOM,
    popupRange = null,
    html2canvasImpl = null,
    preloadHtml2Canvas = true,
    loadFileToDocument = null,
    fetchImpl = null,
    isMobile = false,
} = {}) {
    const popupOutcomes = [];
    const html2canvasSpy = jest.fn(async (surface, options) => {
        if (typeof html2canvasImpl === 'function') {
            return await html2canvasImpl(surface, options);
        }
        return createMockCanvas();
    });

    if (preloadHtml2Canvas) {
        window.html2canvas = html2canvasSpy;
    } else {
        delete window.html2canvas;
    }

    const loadFileMock = loadFileToDocument ?? jest.fn(async () => {
        window.html2canvas = html2canvasSpy;
    });
    const downloadMock = jest.fn();
    const getBase64Mock = jest.fn(async (blob) => `data:${blob?.type || 'application/octet-stream'};base64,ZmFrZQ==`);
    const fetchMock = fetchImpl ?? jest.fn(async (url) => {
        const target = String(url);
        if (target.includes('fa-solid-900.woff2')) {
            return { ok: true, status: 200, blob: async () => new Blob(['font'], { type: 'font/woff2' }) };
        }
        if (target.includes('/img/sample.png')) {
            return { ok: true, status: 200, blob: async () => new Blob(['png'], { type: 'image/png' }) };
        }
        if (target.includes('/api/characters/all') || target.includes('/api/backgrounds/all') || target.includes('/api/groups/all')) {
            return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '{}', blob: async () => new Blob(['']) };
    });

    class FakePopup {
        constructor(content, type, inputValue, options = {}) {
            this.content = content;
            this.type = type;
            this.options = options;
            this.result = 1;
            this.dlg = document.createElement('dialog');
            for (const input of options.customInputs ?? []) {
                const el = document.createElement('input');
                el.id = input.id;
                el.value = String(input.defaultState ?? '');
                this.dlg.appendChild(el);
            }
        }
        async show() {
            this.options.onOpening?.(this);
            if (popupRange) {
                const startEl = this.dlg.querySelector('#message_screenshot_start_id');
                const endEl = this.dlg.querySelector('#message_screenshot_end_id');
                if (startEl) startEl.value = String(popupRange.start);
                if (endEl) endEl.value = String(popupRange.end);
            }
            const allowedToClose = this.options.onClosing?.(this);
            popupOutcomes.push(allowedToClose);
            return this.result;
        }
    }

    const loaded = await importScriptModule({
        dom,
        fetch: fetchMock,
        mocks: {
            'scripts/popup.js': {
                Popup: FakePopup,
                POPUP_TYPE: { CONFIRM: 2 },
                POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
                callGenericPopup: jest.fn(async () => 1),
            },
            'scripts/utils.js': {
                download: downloadMock,
                loadFileToDocument: loadFileMock,
                getBase64Async: getBase64Mock,
                getCharaFilename: jest.fn(() => 'Alice Card'),
                isDataURL: v => typeof v === 'string' && v.startsWith('data:'),
                delay: jest.fn(async () => {}),
            },
            'scripts/RossAscends-mods.js': {
                isMobile: jest.fn(() => isMobile),
            },
        },
    });
    activeRuntime = loaded;

    const { script } = loaded;
    await loaded.runReady();

    script.characters.push({ name: 'Alice Card', avatar: 'alice.png', chat: 'alice-chat' });
    script.setCharacterId(0);
    script.setCharacterName('Alice Card');
    script.chat.push(
        { name: 'Alice', is_user: false, mes: 'Hello world', extra: {} },
        { name: 'User', is_user: true, mes: 'Second message', extra: {} },
        { name: 'Alice', is_user: false, mes: 'Third message', extra: {} },
    );

    return {
        ...loaded,
        html2canvasSpy,
        loadFileMock,
        downloadMock,
        fetchMock,
        getBase64Mock,
        popupOutcomes,
        async waitForDownload(expectedCalls = 1) {
            for (let i = 0; i < 80 && downloadMock.mock.calls.length < expectedCalls; i++) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        },
    };
}

describe('tooling UI hydration wiring', () => {
    test('normalizes reversed screenshot ranges, rejects invalid bounds, and builds deterministic filenames', async () => {
        const invalid = await createScreenshotRuntime({ popupRange: { start: 0, end: 99 } });
        document.querySelector('.mes[mesid="0"] .mes_screenshot').click();
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(invalid.popupOutcomes).toEqual([false]);
        expect(invalid.toastr.warning).toHaveBeenCalled();
        expect(invalid.downloadMock).not.toHaveBeenCalled();
        invalid.cleanup();
        activeRuntime = null;

        // Reversed range (2..0) normalizes to 0..2 and uses character slug in filename.
        const valid = await createScreenshotRuntime({ popupRange: { start: 2, end: 0 } });
        document.querySelector('.mes[mesid="0"] .mes_screenshot').click();
        await valid.waitForDownload(1);
        expect(valid.popupOutcomes).toEqual([true]);
        expect(valid.downloadMock).toHaveBeenCalledTimes(1);
        expect(valid.downloadMock.mock.calls[0][1]).toBe('alice-card-messages-0-2.png');
        expect(valid.downloadMock.mock.calls[0][2]).toBe('image/png');
    });

    test('lazily loads html2canvas once on demand and reuses it across captures', async () => {
        const runtime = await createScreenshotRuntime({ preloadHtml2Canvas: false, popupRange: { start: 1, end: 1 } });

        document.querySelector('.mes[mesid="1"] .mes_screenshot').click();
        await runtime.waitForDownload(1);
        expect(runtime.loadFileMock).toHaveBeenCalledTimes(1);
        expect(runtime.loadFileMock).toHaveBeenCalledWith('/lib/html2canvas.min.js', 'js');
        expect(runtime.downloadMock.mock.calls[0][1]).toBe('alice-card-message-1.png');

        // Second capture finds html2canvas already ready and skips loading again.
        document.querySelector('.mes[mesid="1"] .mes_screenshot').click();
        await runtime.waitForDownload(2);
        expect(runtime.loadFileMock).toHaveBeenCalledTimes(1);
    });

    test('renders inside #chat layout context, configures foreignObject subtree and onclone normalization, and embeds icon font', async () => {
        let captureParentDuringRender = null;
        let capturedOptions = null;
        let clonedDocState = null;

        let ignoreDetachedResult = null;
        let ignoreChatAncestorResult = null;

        const runtime = await createScreenshotRuntime({
            popupRange: { start: 0, end: 0 },
            html2canvasImpl: async (surface, options) => {
                captureParentDuringRender = surface.parentElement?.parentElement;
                capturedOptions = options;
                ignoreDetachedResult = options.ignoreElements(document.createElement('div'));
                ignoreChatAncestorResult = options.ignoreElements(document.getElementById('chat'));

                // Simulate html2canvas calling onclone on a cloned document containing the surface and a body style.
                const clonedDoc = document.implementation.createHTMLDocument('clone');
                const bodyStyle = clonedDoc.createElement('style');
                bodyStyle.textContent = '.pseudo-suppress{}';
                clonedDoc.body.appendChild(bodyStyle);
                const clonedSurface = clonedDoc.importNode(surface, true);
                clonedDoc.body.appendChild(clonedSurface);
                Object.defineProperty(clonedSurface, 'scrollWidth', { configurable: true, value: 800 });
                Object.defineProperty(clonedSurface, 'scrollHeight', { configurable: true, value: 40000 });

                options.onclone(clonedDoc, clonedSurface);
                clonedDocState = {
                    rootBg: clonedDoc.documentElement.style.backgroundColor,
                    surfaceHeight: clonedSurface.style.height,
                    mesGridRows: clonedSurface.querySelector('.mes')?.style.gridTemplateRows,
                    paragraphHeight: clonedSurface.querySelector('.mes_text p')?.style.height,
                    titleWidth: clonedSurface.querySelector('.mes_reasoning_header_title')?.style.width,
                    companionWidth: clonedSurface.querySelector('.ica--companion-title')?.style.width,
                    stylesText: Array.from(clonedSurface.querySelectorAll('style')).map(s => s.textContent).join('\n'),
                    bodyChildren: Array.from(clonedDoc.body.children),
                    clonedSurface,
                    scaleAfterClone: options.scale,
                };
                return createMockCanvas();
            },
        });

        document.querySelector('.mes[mesid="0"] .mes_screenshot').click();
        await runtime.waitForDownload(1);

        expect(captureParentDuringRender).toBe(document.getElementById('chat'));
        expect(document.querySelector('.sb-message-screenshot-shell')).toBeNull();
        expect(capturedOptions.foreignObjectRendering).toBe(true);
        expect(ignoreDetachedResult).toBe(true);
        expect(ignoreChatAncestorResult).toBe(false);

        expect(clonedDocState.rootBg).toBe('transparent');
        expect(clonedDocState.surfaceHeight).toBe('auto');
        expect(clonedDocState.mesGridRows).toBe('auto');
        expect(clonedDocState.paragraphHeight).toBe('auto');
        expect(clonedDocState.titleWidth).toBe('auto');
        expect(clonedDocState.companionWidth).toBe('auto');
        expect(clonedDocState.stylesText).toContain('font-family: \'Font Awesome 6 Free\'');
        expect(clonedDocState.stylesText).toContain('.pseudo-suppress{}');
        expect(clonedDocState.bodyChildren).toEqual([clonedDocState.clonedSurface]);
        // Scale is clamped by desktop maxCanvasSide (32767 / 40000) and pixelBudget.
        expect(clonedDocState.scaleAfterClone).toBeLessThan(1);
        expect(runtime.fetchMock).toHaveBeenCalledWith(
            '/webfonts/fa-solid-900.woff2',
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
    });

    test('inlines external images and clears failed images, while waiting for pending img assets', async () => {
        let capturedImgSrc = null;
        let capturedImgSrcset = null;
        let capturedFailedSrc = null;

        const domWithTwoImages = `
            <div id="chat">
                <div class="mes" mesid="0">
                    <div class="mes_block">
                        <div class="mes_text">
                            <img class="ok-img" src="/img/sample.png" srcset="/img/sample@2x.png 2x" />
                            <img class="bad-img" src="/img/broken.png" srcset="/img/broken@2x.png 2x" />
                        </div>
                        <div class="mes_buttons">
                            <button class="mes_button mes_screenshot" type="button"></button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const runtime = await createScreenshotRuntime({
            dom: domWithTwoImages,
            popupRange: { start: 0, end: 0 },
            fetchImpl: jest.fn(async (url) => {
                const target = String(url);
                if (target.includes('/img/broken.png')) {
                    return { ok: false, status: 404 };
                }
                if (target.includes('/img/sample.png')) {
                    return { ok: true, status: 200, blob: async () => new Blob(['png'], { type: 'image/png' }) };
                }
                if (target.includes('/api/characters/all') || target.includes('/api/backgrounds/all') || target.includes('/api/groups/all')) {
                    return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
                }
                return { ok: true, status: 200, json: async () => ({}), text: async () => '{}', blob: async () => new Blob(['font'], { type: 'font/woff2' }) };
            }),
            html2canvasImpl: async (surface) => {
                const okImg = surface.querySelector('.ok-img');
                const badImg = surface.querySelector('.bad-img');
                capturedImgSrc = okImg?.getAttribute('src');
                capturedImgSrcset = okImg?.srcset;
                capturedFailedSrc = badImg?.getAttribute('src');
                return createMockCanvas();
            },
        });

        // Mark both images complete so asset wait passes immediately.
        document.querySelectorAll('img').forEach(img => {
            Object.defineProperty(img, 'complete', { configurable: true, value: true });
        });

        document.querySelector('.mes[mesid="0"] .mes_screenshot').click();
        await runtime.waitForDownload(1);

        expect(capturedImgSrc).toMatch(/^data:image\/png;base64,/);
        expect(capturedImgSrcset).toBe('');
        expect(capturedFailedSrc).toBeNull();
    });

    test('routes foreignObject SVG through bounded FileReader data URI, neutralizes clone iframe waits, and cleans up globals', async () => {
        const NativeImageBefore = window.Image;
        const nativeEncodeBefore = window.encodeURIComponent;
        let encodedMarker = null;
        let encodedNormal = null;
        let neutralizedFontsReady = null;
        let neutralizedImages = null;
        let imageLoadedWithBase64 = false;

        const runtime = await createScreenshotRuntime({
            popupRange: { start: 0, end: 0 },
            html2canvasImpl: async () => {
                // 1. Appending a clone iframe causes the MutationObserver to neutralize fonts.ready and images.
                const iframe = document.createElement('iframe');
                iframe.className = 'html2canvas-container';
                document.body.appendChild(iframe);
                await Promise.resolve();
                neutralizedFontsReady = iframe.contentDocument?.fonts?.ready;
                neutralizedImages = iframe.contentDocument?.images;

                // 2. Non-SVG encodeURIComponent behaves normally; foreignObject SVG returns the marker.
                encodedNormal = window.encodeURIComponent('hello world');
                encodedMarker = window.encodeURIComponent('<svg><foreignObject>hi</foreignObject></svg>');

                // 3. Loading an Image with the marked SVG URL encodes it via FileReader into a base64 data URI.
                const img = new window.Image();
                await new Promise((resolve) => {
                    img.onload = () => resolve();
                    img.src = `data:image/svg+xml;charset=utf-8,${encodedMarker}`;
                    setTimeout(() => {
                        if (/^data:image\/svg\+xml;.*base64,/.test(img.src)) {
                            imageLoadedWithBase64 = true;
                        }
                        img.onload?.({});
                    }, 30);
                });

                return createMockCanvas();
            },
        });

        document.querySelector('.mes[mesid="0"] .mes_screenshot').click();
        await runtime.waitForDownload(1);

        expect(encodedNormal).toBe('hello%20world');
        expect(encodedMarker).toBe('__sillybunny_html2canvas_foreign_object__');
        expect(imageLoadedWithBase64).toBe(true);
        await expect(neutralizedFontsReady).resolves.toBeUndefined();
        expect(neutralizedImages).toEqual([]);

        // Globals and orphan clone containers are restored after capture finishes.
        expect(window.Image).toBe(NativeImageBefore);
        expect(window.encodeURIComponent).toBe(nativeEncodeBefore);
        expect(document.querySelectorAll('.html2canvas-container')).toHaveLength(0);
    });

    test('stretches reasoning headers only inside screenshot surfaces', () => {
        expect(styleSource).toContain('.sb-message-screenshot-surface .mes_reasoning_header {\n    flex: 1;\n}');
    });
});
