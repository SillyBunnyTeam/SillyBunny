/* global globalThis */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { ReadableStream, TransformStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { TextDecoder, TextEncoder } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import { jest } from '@jest/globals';

if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = TextDecoder;
if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = TextEncoder;
if (typeof globalThis.ReadableStream === 'undefined') globalThis.ReadableStream = ReadableStream;
if (typeof globalThis.TransformStream === 'undefined') globalThis.TransformStream = TransformStream;
if (typeof globalThis.structuredClone === 'undefined') {
    globalThis.structuredClone = value => deserialize(serialize(value));
}
if (typeof globalThis.Response === 'undefined') {
    globalThis.Response = class PolyfillResponse {
        constructor(body = null, init = {}) {
            this.body = body;
            this.status = init.status ?? 200;
            this.ok = this.status >= 200 && this.status < 300;
            this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers || {});
        }
        async arrayBuffer() {
            if (!this.body) return new ArrayBuffer(0);
            if (this.body instanceof Uint8Array) return this.body.buffer.slice(this.body.byteOffset, this.body.byteOffset + this.body.byteLength);
            if (typeof this.body === 'string') return new TextEncoder().encode(this.body).buffer;
            const reader = this.body.getReader();
            const chunks = [];
            let total = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                total += value.byteLength;
            }
            const out = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                out.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return out.buffer;
        }
        async text() {
            return new TextDecoder().decode(await this.arrayBuffer());
        }
        async json() {
            return JSON.parse(await this.text());
        }
    };
}
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.prototype.throwIfAborted !== 'function') {
    AbortSignal.prototype.throwIfAborted = function throwIfAborted() {
        if (this.aborted) {
            throw this.reason ?? new DOMException('The operation was aborted.', 'AbortError');
        }
    };
}

const pub = rel => fileURLToPath(new URL(`../../public/${rel}`, import.meta.url));
const jquerySource = readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');

function ensureJQuery() {
    if (typeof window.$ !== 'function') {
        (0, eval)(jquerySource);
    }
    globalThis.$ = window.$;
    globalThis.jQuery = window.jQuery;
}

function createEventSource() {
    const listeners = new Map();
    const on = (event, handler) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
    };
    const removeListener = (event, handler) => {
        const list = listeners.get(event);
        if (!list) return;
        listeners.set(event, list.filter(item => item !== handler));
    };
    return {
        listeners,
        on: jest.fn(on),
        once: jest.fn((event, handler) => {
            const wrapper = (...args) => {
                removeListener(event, wrapper);
                return handler(...args);
            };
            on(event, wrapper);
        }),
        removeListener: jest.fn(removeListener),
        off: jest.fn(removeListener),
        emit: jest.fn(async (event, ...args) => {
            for (const handler of [...(listeners.get(event) || [])]) {
                await handler(...args);
            }
        }),
    };
}

export function createStreamResponse(body, { status = 200, ok = status >= 200 && status < 300, contentType = 'application/json' } = {}) {
    const bytes = ArrayBuffer.isView(body)
        ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
        : new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
    const stream = new ReadableStream({
        start(controller) {
            if (bytes.byteLength > 0) controller.enqueue(bytes);
            controller.close();
        },
    });
    return {
        ok,
        status,
        headers: new Headers({
            'content-type': contentType,
            'content-length': String(bytes.byteLength),
        }),
        body: stream,
        async json() { return JSON.parse(new TextDecoder().decode(bytes)); },
        async text() { return new TextDecoder().decode(bytes); },
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    };
}

export async function loadQigModule(options = {}) {
    jest.resetModules();
    ensureJQuery();

    const originalFetch = globalThis.fetch;
    const originalJQuery = globalThis.jQuery;
    const originalDollar = globalThis.$;
    const originalImage = globalThis.Image;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalURLCreateObjectURL = URL.createObjectURL;
    const originalURLRevokeObjectURL = URL.revokeObjectURL;
    const originalCapabilityRegistry = globalThis[Symbol.for('sillybunny.extensionCapabilities')];

    HTMLCanvasElement.prototype.getContext = () => null;

    localStorage.clear();
    if (options.localStorageEntries) {
        for (const [key, value] of Object.entries(options.localStorageEntries)) {
            localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
    }

    document.body.className = '';
    document.body.innerHTML = `
        <div id="extensions_settings"></div>
        <div id="chat"></div>
        <div id="rightSendForm"></div>
        <div id="send_form"><textarea id="send_textarea"></textarea></div>
    `;

    const toastr = {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        success: jest.fn(),
    };
    globalThis.toastr = toastr;

    // Provide a lightweight Image stub in jsdom so verifyRenderableImage succeeds on valid URLs.
    globalThis.Image = class FakeImage {
        constructor() {
            this.naturalWidth = 512;
            this.naturalHeight = 512;
            this.onload = null;
            this.onerror = null;
        }
        set src(value) {
            this._src = value;
            queueMicrotask(() => {
                if (this._src && String(this._src).includes('broken')) {
                    this.onerror?.(new Error('broken image'));
                } else {
                    this.onload?.();
                }
            });
        }
        get src() { return this._src; }
    };

    const createdBlobUrls = [];
    const revokedBlobUrls = [];
    URL.createObjectURL = jest.fn(() => {
        const url = `blob:qig-test-${createdBlobUrls.length + 1}`;
        createdBlobUrls.push(url);
        return url;
    });
    URL.revokeObjectURL = jest.fn(url => {
        revokedBlobUrls.push(url);
    });

    const eventSource = createEventSource();
    const event_types = {
        MESSAGE_RECEIVED: 'message_received',
        CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
        CHAT_CHANGED: 'chat_changed',
        SETTINGS_UPDATED: 'settings_updated',
    };

    const state = {
        characters: options.characters ?? [{ name: 'Seraphina', avatar: 'Seraphina.png', data: { extensions: {} } }],
        characterId: 'characterId' in options ? options.characterId : 0,
        groupId: options.groupId ?? null,
        groups: options.groups ?? [],
        chat: options.chat ?? [],
        chatId: options.chatId ?? 'chat-1',
        name1: options.name1 ?? 'User',
        name2: options.name2 ?? 'Seraphina',
        persona: options.persona ?? '',
        ConnectionManagerRequestService: options.ConnectionManagerRequestService ?? null,
    };

    const extension_settings = {
        'quick-image-gen': {
            setupWizardSeen: true,
            ...(options.qigSettings || {}),
        },
        ...(options.extensionSettings || {}),
    };

    let autoConfirmSaves = options.autoConfirmSaves ?? true;
    const saveSettingsDebounced = jest.fn();
    const saveSettings = options.saveSettings || jest.fn(async () => {
        if (autoConfirmSaves) {
            queueMicrotask(() => {
                void eventSource.emit(event_types.SETTINGS_UPDATED);
            });
        }
    });

    const defaultFetch = async (url, reqOptions) => {
        const target = String(url);
        if (target === '/api/settings/get') {
            return createStreamResponse({
                settings: JSON.stringify({ extension_settings }),
            });
        }
        if (target.startsWith('data:')) {
            const match = target.match(/^data:([^;]+);base64,([\s\S]+)$/);
            if (match) {
                return createStreamResponse(new Uint8Array(Buffer.from(match[2], 'base64')), { contentType: match[1] });
            }
        }
        if (options.fetch) {
            const custom = await options.fetch(url, reqOptions);
            if (custom !== undefined) return custom;
        }
        return createStreamResponse({});
    };
    const fetchMock = jest.fn(defaultFetch);
    globalThis.fetch = fetchMock;

    const getContext = jest.fn(() => ({
        characters: state.characters,
        characterId: state.characterId,
        groupId: state.groupId,
        groups: state.groups,
        chat: state.chat,
        chatId: state.chatId,
        name1: state.name1,
        name2: state.name2,
        persona: state.persona,
        extensionSettings: extension_settings,
        ConnectionManagerRequestService: state.ConnectionManagerRequestService,
        saveChat: jest.fn(async () => {}),
    }));

    const callGenericPopup = options.callGenericPopup || jest.fn(async () => 1);
    const saveBase64AsFile = options.saveBase64AsFile || jest.fn(async (_b64, subfolder, name, ext) => `/user/images/${subfolder}/${name}.${ext}`);
    const deleteNovelAIPreciseReferenceFile = jest.fn(async () => {});
    const mountedPreciseRefEditors = [];
    const mountNovelAIPreciseReferenceEditor = jest.fn((container, editorOptions) => {
        const handle = { container, options: editorOptions, refresh: jest.fn(), unmount: jest.fn() };
        mountedPreciseRefEditors.push(handle);
        return handle;
    });
    const slashCommands = new Map();

    await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({
        extension_settings,
        getContext,
    }));

    await jest.unstable_mockModule(pub('script.js'), () => ({
        eventSource,
        event_types,
        saveSettingsDebounced,
        saveSettings,
        generateQuietPrompt: jest.fn(async () => ''),
        generateRaw: jest.fn(async () => ''),
        generateRawData: jest.fn(async () => ({})),
        createRawPrompt: jest.fn(async () => ''),
        substituteParams: jest.fn(text => text),
        getRequestHeaders: jest.fn(() => ({ 'Content-Type': 'application/json' })),
    }));

    await jest.unstable_mockModule(pub('scripts/world-info.js'), () => ({
        checkWorldInfo: jest.fn(async () => ({ worldInfoBefore: '', worldInfoAfter: '' })),
    }));

    await jest.unstable_mockModule(pub('scripts/openai.js'), () => ({
        createGenerationParameters: jest.fn(() => ({})),
        getChatCompletionModel: jest.fn(() => 'gpt-4o'),
    }));

    await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
        saveBase64AsFile,
        getSanitizedFilename: jest.fn(name => String(name || 'image').replace(/[^a-zA-Z0-9._-]/g, '_')),
    }));

    await jest.unstable_mockModule(pub('scripts/RossAscends-mods.js'), () => ({
        humanizedDateTime: jest.fn(() => '2026-01-01_00-00-00'),
    }));

    await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
        callGenericPopup,
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3 },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
    }));

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommand.js'), () => ({
        SlashCommand: { fromProps: props => props },
    }));

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParser.js'), () => ({
        SlashCommandParser: {
            addCommandObject: jest.fn(cmd => { slashCommands.set(cmd.name, cmd); }),
        },
    }));

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandArgument.js'), () => ({
        ARGUMENT_TYPE: { STRING: 'string', BOOLEAN: 'boolean', NUMBER: 'number' },
        SlashCommandArgument: class SlashCommandArgument {
            constructor(...args) { this.args = args; }
            static fromProps(props) { return props; }
        },
        SlashCommandNamedArgument: class SlashCommandNamedArgument {
            constructor(...args) { this.args = args; }
            static fromProps(props) { return props; }
        },
    }));

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({
        SlashCommandEnumValue: class SlashCommandEnumValue {
            constructor(value, description) {
                this.value = value;
                this.description = description;
            }
        },
    }));

    await jest.unstable_mockModule(pub('scripts/novelai-precise-reference-ui.js'), () => ({
        deleteNovelAIPreciseReferenceFile,
        mountNovelAIPreciseReferenceEditor,
    }));

    if (options.resolveNovelAIPreciseReferences) {
        const realModule = await import(pub('scripts/novelai-precise-reference.js'));
        await jest.unstable_mockModule(pub('scripts/novelai-precise-reference.js'), () => ({
            ...realModule,
            resolveNovelAIPreciseReferences: options.resolveNovelAIPreciseReferences,
        }));
    }

    let pendingReadyCallback = null;
    if (options.deferReady) {
        const wrappedJQuery = (...args) => {
            if (typeof args[0] === 'function') {
                pendingReadyCallback = args[0];
                return;
            }
            return originalJQuery(...args);
        };
        Object.assign(wrappedJQuery, originalJQuery);
        globalThis.jQuery = wrappedJQuery;
        window.jQuery = wrappedJQuery;
    }

    if (options.failExtensionsImport) {
        await jest.unstable_mockModule(pub('scripts/extensions.js'), () => {
            throw new Error(options.failExtensionsImport);
        });
    }

    const qigModule = await import(pub('scripts/extensions/quick-image-gen/index.js'));

    if (!options.deferReady && !options.skipReadyWait) {
        await qigModule.ensureQuickImageGenReady(2000);
    }

    const cleanup = () => {
        try {
            qigModule.teardownQuickImageGen?.();
        } catch {
            // Ignore teardown errors when DOM was already cleared.
        }
        try {
            qigModule.deactivate?.();
        } catch {
            // Ignore deactivate errors.
        }
        globalThis.fetch = originalFetch;
        globalThis.jQuery = originalJQuery;
        window.jQuery = originalJQuery;
        globalThis.$ = originalDollar;
        globalThis.Image = originalImage;
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        URL.createObjectURL = originalURLCreateObjectURL;
        URL.revokeObjectURL = originalURLRevokeObjectURL;
        delete globalThis.toastr;
        localStorage.clear();
        if (originalCapabilityRegistry === undefined) {
            delete globalThis[Symbol.for('sillybunny.extensionCapabilities')];
        } else {
            Object.defineProperty(globalThis, Symbol.for('sillybunny.extensionCapabilities'), {
                configurable: true,
                value: originalCapabilityRegistry,
            });
        }
    };

    return {
        qigModule,
        state,
        extension_settings,
        eventSource,
        event_types,
        saveSettings,
        saveSettingsDebounced,
        setAutoConfirmSaves(value) { autoConfirmSaves = Boolean(value); },
        fetchMock,
        callGenericPopup,
        saveBase64AsFile,
        deleteNovelAIPreciseReferenceFile,
        mountNovelAIPreciseReferenceEditor,
        mountedPreciseRefEditors,
        slashCommands,
        toastr,
        createdBlobUrls,
        revokedBlobUrls,
        runReady() {
            const cb = pendingReadyCallback;
            pendingReadyCallback = null;
            return cb?.();
        },
        cleanup,
    };
}
