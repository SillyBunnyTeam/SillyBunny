/* global globalThis */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import { jest } from '@jest/globals';

if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.prototype.throwIfAborted !== 'function') {
    AbortSignal.prototype.throwIfAborted = function throwIfAborted() {
        if (this.aborted) {
            throw this.reason ?? new DOMException('The operation was aborted.', 'AbortError');
        }
    };
}

const pub = rel => fileURLToPath(new URL(`../../public/${rel}`, import.meta.url));
const jquerySource = readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');
const sdSettingsTemplateSource = readFileSync(pub('scripts/extensions/stable-diffusion/settings.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();

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
    return {
        listeners,
        on: jest.fn(on),
        makeLast: jest.fn(on),
        emit: jest.fn(async (event, ...args) => {
            for (const handler of [...(listeners.get(event) || [])]) {
                await handler(...args);
            }
        }),
    };
}

export async function loadSdModule(options = {}) {
    jest.resetModules();
    ensureJQuery();

    const originalFetch = globalThis.fetch;
    const originalCss = globalThis.CSS;
    const originalCapabilityRegistry = globalThis[Symbol.for('sillybunny.extensionCapabilities')];

    globalThis.CSS = { supports: () => true };
    document.body.className = '';
    document.body.innerHTML = `
        <div id="sd_container"></div>
        <div id="extensionsMenu"></div>
        <div id="sd_dropdown"></div>
    `;

    const toastr = {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        success: jest.fn(),
    };
    globalThis.toastr = toastr;

    if (options.fetch) {
        globalThis.fetch = options.fetch;
    } else {
        globalThis.fetch = jest.fn(async () => ({ ok: true, json: async () => [], text: async () => '' }));
    }

    const eventSource = createEventSource();
    const event_types = {
        EXTRAS_CONNECTED: 'extras_connected',
        CHAT_CHANGED: 'chat_changed',
        IMAGE_SWIPED: 'image_swiped',
        SECRET_WRITTEN: 'secret_written',
        SECRET_DELETED: 'secret_deleted',
        SECRET_ROTATED: 'secret_rotated',
        MESSAGE_SENT: 'message_sent',
        MESSAGE_RECEIVED: 'message_received',
    };

    const state = {
        chatId: options.chatId ?? 'chat-1',
        this_chid: 'this_chid' in options ? options.this_chid : 0,
        selected_group: options.selected_group ?? null,
        characters: options.characters ?? [{ name: 'Seraphina', avatar: 'Seraphina.png' }],
        chat: options.chat ?? [],
        user_avatar: options.user_avatar ?? 'user.png',
    };

    const extension_settings = {
        sd: options.sdSettings ? { ...options.sdSettings } : {},
        ...(options.extensionSettings || {}),
    };

    const secret_state = {
        ...(options.secretState || {}),
    };

    const SECRET_KEYS = {
        OPENAI: 'api_key_openai',
        NOVEL: 'api_key_novel',
        BFL: 'api_key_bfl',
        XAI: 'api_key_xai',
        VERTEXAI_SERVICE_ACCOUNT: 'vertexai_service_account',
        VERTEXAI: 'api_key_vertexai',
        MAKERSUITE: 'api_key_makersuite',
        FALAI: 'api_key_falai',
        STABILITY: 'api_key_stability',
        AIMLAPI: 'api_key_aimlapi',
        COMFY_RUNPOD: 'api_key_comfy_runpod',
        POLLINATIONS: 'api_key_pollinations',
        WORKERS_AI: 'api_key_workers_ai',
        TOGETHERAI: 'api_key_togetherai',
        CHUTES: 'api_key_chutes',
        ELECTRONHUB: 'api_key_electronhub',
        NANOGPT: 'api_key_nanogpt',
        GOOGLE: 'api_key_google',
        ZAI: 'api_key_zai',
        OPENROUTER: 'api_key_openrouter',
        HORDE: 'api_key_horde',
        HUGGINGFACE: 'api_key_huggingface',
    };

    const saveSettingsDebounced = jest.fn();
    const saveBase64AsFile = options.saveBase64AsFile || jest.fn(async (_data, name, fileName, ext) => `/user/images/${name}/${fileName}.${ext}`);
    const appendMediaToMessage = jest.fn();
    const slashCommands = new Map();

    const getContext = jest.fn(() => ({
        characters: state.characters,
        characterId: state.this_chid,
        groupId: state.selected_group,
        chat: state.chat,
        chatId: state.chatId,
        saveChat: jest.fn(async () => {}),
    }));

    const substituteParams = options.substituteParams || jest.fn((text, opts) => {
        if (opts && typeof opts === 'object') {
            return String(text ?? '').replaceAll('{{char}}', opts.name2Override || state.characters[state.this_chid]?.name || '');
        }
        return String(text ?? '');
    });

    const compiledTemplate = Handlebars.compile(sdSettingsTemplateSource);

    await jest.unstable_mockModule(pub('lib.js'), () => ({
        Popper: { createPopper: jest.fn(() => ({ update: jest.fn(), destroy: jest.fn() })) },
    }));

    await jest.unstable_mockModule(pub('script.js'), () => ({
        animation_duration: 0,
        appendMediaToMessage,
        event_types,
        eventSource,
        formatCharacterAvatar: jest.fn(v => v),
        generateQuietPrompt: jest.fn(async () => ''),
        getCharacterAvatar: jest.fn(() => ''),
        getCurrentChatId: () => state.chatId,
        getRequestHeaders: jest.fn(() => ({ 'Content-Type': 'application/json' })),
        getUserAvatar: jest.fn(() => ''),
        saveSettingsDebounced,
        substituteParams,
        substituteParamsExtended: jest.fn(text => text),
        systemUserName: 'System',
        get this_chid() { return state.this_chid; },
        get user_avatar() { return state.user_avatar; },
    }));

    await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({
        doExtrasFetch: jest.fn(async () => ({ ok: false })),
        extension_settings,
        getApiUrl: jest.fn(() => 'http://localhost:5100'),
        getContext,
        modules: options.modules ?? [],
        renderExtensionTemplateAsync: jest.fn(async (_ext, name, data = {}) => {
            if (name === 'settings') return compiledTemplate(data);
            return '';
        }),
        writeExtensionField: jest.fn(async () => {}),
    }));

    await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({
        get selected_group() { return state.selected_group; },
    }));

    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/utility-dialogs.js'), () => ({
        utilityFormOptions: () => ({}),
        adoptImageGenerationSettings: jest.fn(),
    }));

    await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
        clamp: (value, min, max) => Math.min(Math.max(value, min), max),
        debounce: fn => fn,
        deepMerge: (target, source) => ({ ...target, ...source }),
        delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
        getBase64Async: jest.fn(async () => ''),
        getCharaFilename: jest.fn((_chid, { manualAvatarKey } = {}) => {
            const avatar = manualAvatarKey || state.characters[state.this_chid]?.avatar || 'Seraphina.png';
            return String(avatar).replace(/\.[^.]+$/, '');
        }),
        initScrollHeight: jest.fn(),
        isFalseBoolean: value => value === false || value === 'false',
        isTrueBoolean: value => value === true || value === 'true',
        resetScrollHeight: jest.fn(),
        saveBase64AsFile,
        stringFormat: (str, ...args) => String(str).replace(/\{(\d+)\}/g, (_, idx) => args[Number(idx)] ?? ''),
    }));

    await jest.unstable_mockModule(pub('scripts/RossAscends-mods.js'), () => ({
        getMessageTimeStamp: jest.fn(() => 'now'),
        humanizedDateTime: jest.fn(() => options.timestamp || 'timestamp'),
    }));

    await jest.unstable_mockModule(pub('scripts/secrets.js'), () => ({
        SECRET_KEYS,
        secret_state,
    }));

    await jest.unstable_mockModule(pub('scripts/nai-settings.js'), () => ({
        getNovelAnlas: jest.fn(() => 0),
        getNovelUnlimitedImageGeneration: jest.fn(() => false),
        loadNovelSubscriptionData: jest.fn(async () => {}),
    }));

    await jest.unstable_mockModule(pub('scripts/extensions/shared.js'), () => ({
        getMultimodalCaption: jest.fn(async () => ''),
    }));

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParser.js'), () => ({
        SlashCommandParser: {
            addCommandObject: jest.fn(cmd => { slashCommands.set(cmd.name, cmd); }),
        },
    }));

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommand.js'), () => ({
        SlashCommand: { fromProps: props => props },
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

    await jest.unstable_mockModule(pub('scripts/constants.js'), () => ({
        debounce_timeout: { relaxed: 10 },
        IMAGE_OVERSWIPE: { DISABLED: 0 },
        MEDIA_DISPLAY: { GALLERY: 'gallery', LIST: 'list' },
        MEDIA_SOURCE: { GENERATED: 'generated' },
        MEDIA_TYPE: { IMAGE: 'image', VIDEO: 'video' },
        SCROLL_BEHAVIOR: { KEEP: 'keep' },
        SWIPE_DIRECTION: { RIGHT: 1 },
        VIDEO_EXTENSIONS: ['mp4', 'webm'],
    }));

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({
        SlashCommandEnumValue: class SlashCommandEnumValue {
            constructor(value, description) {
                this.value = value;
                this.description = description;
            }
        },
    }));

    await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
        callGenericPopup: jest.fn(async () => null),
        Popup: { show: { confirm: jest.fn(async () => 0), input: jest.fn(async () => null) } },
        POPUP_TYPE: { TEXT: 1, INPUT: 2, CONFIRM: 3 },
    }));

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandCommonEnumsProvider.js'), () => ({
        commonEnumProviders: {
            boolean: () => () => ['true', 'false'],
        },
    }));

    await jest.unstable_mockModule(pub('scripts/tool-calling.js'), () => ({
        ToolManager: {
            registerFunctionTool: jest.fn(),
            unregisterFunctionTool: jest.fn(),
        },
    }));

    await jest.unstable_mockModule(pub('scripts/macros/macro-system.js'), () => ({
        macros: { register: jest.fn() },
        MacroCategory: { PROMPTS: 'prompts' },
    }));

    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
        t: (strings, ...values) => strings.reduce((acc, part, idx) => acc + part + (values[idx] ?? ''), ''),
        translate: (value) => value,
    }));

    await jest.unstable_mockModule(pub('scripts/openai.js'), () => ({
        oai_settings: { vertexai_auth_mode: 'api_key' },
    }));

    await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({
        power_user: { experimental_macro_engine: false },
    }));

    await jest.unstable_mockModule(pub('scripts/macros.js'), () => ({
        MacrosParser: { registerMacro: jest.fn() },
    }));

    await jest.unstable_mockModule(pub('scripts/action-loader.js'), () => ({
        ActionLoaderHandle: class ActionLoaderHandle {
            async hide() {}
        },
        loader: {
            show: jest.fn(async () => ({ hide: jest.fn(async () => {}) })),
        },
    }));

    await jest.unstable_mockModule(pub('scripts/novelai-precise-reference-ui.js'), () => ({
        deleteNovelAIPreciseReferenceFile: jest.fn(async () => {}),
        mountNovelAIPreciseReferenceEditor: jest.fn(() => ({ refresh: jest.fn(), unmount: jest.fn() })),
    }));

    if (options.resolveNovelAIPreciseReferences) {
        const realModule = await import(pub('scripts/novelai-precise-reference.js'));
        await jest.unstable_mockModule(pub('scripts/novelai-precise-reference.js'), () => ({
            ...realModule,
            resolveNovelAIPreciseReferences: options.resolveNovelAIPreciseReferences,
        }));
    }

    const sdModule = await import(pub('scripts/extensions/stable-diffusion/index.js'));

    const cleanup = () => {
        globalThis.fetch = originalFetch;
        globalThis.CSS = originalCss;
        delete globalThis.toastr;
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
        sdModule,
        state,
        extension_settings,
        secret_state,
        SECRET_KEYS,
        saveSettingsDebounced,
        saveBase64AsFile,
        appendMediaToMessage,
        slashCommands,
        toastr,
        eventSource,
        event_types,
        cleanup,
    };
}
