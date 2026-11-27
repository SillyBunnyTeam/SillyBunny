/* global globalThis */
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';

import { EventEmitter } from '../../public/lib/eventemitter.js';
import { event_types } from '../../public/scripts/events.js';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));
let cachedJQuerySource = null;

const defaultTag = (strings, ...values) => (
    Array.isArray(strings)
        ? strings.reduce((out, part, index) => out + part + (values[index] ?? ''), '')
        : String(strings ?? '')
);

function ensureJsdomBrowserGlobals() {
    if (typeof globalThis.structuredClone !== 'function') {
        globalThis.structuredClone = value => v8.deserialize(v8.serialize(value));
    }
    if (typeof globalThis.CSS === 'undefined') {
        globalThis.CSS = {
            supports: () => true,
            escape: value => String(value).replace(/([^\w-])/g, '\\$1'),
        };
    }
    if (typeof globalThis.requestAnimationFrame !== 'function') {
        globalThis.requestAnimationFrame = callback => {
            callback(0);
            return 0;
        };
    }
    if (typeof globalThis.cancelAnimationFrame !== 'function') {
        globalThis.cancelAnimationFrame = () => {};
    }
    if (typeof globalThis.ResizeObserver === 'undefined') {
        globalThis.ResizeObserver = class ResizeObserver {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
    if (typeof globalThis.IntersectionObserver === 'undefined') {
        globalThis.IntersectionObserver = class IntersectionObserver {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
    if (typeof globalThis.AbortSignal !== 'undefined' && typeof globalThis.AbortSignal.prototype.throwIfAborted !== 'function') {
        globalThis.AbortSignal.prototype.throwIfAborted = function throwIfAborted() {
            if (this.aborted) {
                throw this.reason ?? new DOMException('The operation was aborted.', 'AbortError');
            }
        };
    }
    if (typeof globalThis.Element !== 'undefined' && typeof globalThis.Element.prototype.getAnimations !== 'function') {
        globalThis.Element.prototype.getAnimations = () => [];
    }
    if (typeof globalThis.window !== 'undefined' && typeof globalThis.WheelEvent === 'undefined' && typeof globalThis.window.WheelEvent === 'function') {
        globalThis.WheelEvent = globalThis.window.WheelEvent;
    }
    if (typeof globalThis.window !== 'undefined') {
        if (typeof globalThis.window.matchMedia !== 'function') {
            globalThis.window.matchMedia = () => ({
                matches: false,
                media: '',
                addEventListener: () => {},
                removeEventListener: () => {},
                addListener: () => {},
                removeListener: () => {},
            });
        }
        if (typeof globalThis.window.requestAnimationFrame !== 'function') {
            globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;
        }
        if (typeof globalThis.window.cancelAnimationFrame !== 'function') {
            globalThis.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
        }
    }
}

function loadWrappedJQuery() {
    ensureJsdomBrowserGlobals();
    let real$ = globalThis.window?.jQuery || globalThis.$;
    if (typeof real$ !== 'function' || !real$.fn) {
        cachedJQuerySource ??= readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');
        (0, eval)(cachedJQuerySource);
        real$ = globalThis.window?.jQuery || globalThis.$;
    }
    if (real$.fx) {
        real$.fx.off = true;
    }
    for (const plugin of ['sortable', 'select2', 'transition', 'pagination', 'draggable', 'resizable']) {
        if (!real$.fn[plugin]) {
            real$.fn[plugin] = jest.fn(function () { return this; });
        }
    }

    const readyCallbacks = [];
    const wrapped$ = new Proxy(real$, {
        apply(target, thisArg, argArray) {
            if (argArray.length === 1 && typeof argArray[0] === 'function') {
                readyCallbacks.push(argArray[0]);
                return target(globalThis.document);
            }
            return Reflect.apply(target, thisArg, argArray);
        },
    });
    globalThis.$ = wrapped$;
    globalThis.jQuery = wrapped$;
    if (typeof globalThis.window !== 'undefined') {
        globalThis.window.$ = wrapped$;
        globalThis.window.jQuery = wrapped$;
    }

    return {
        $: real$,
        wrapped$,
        async runReady() {
            while (readyCallbacks.length) {
                const fn = readyCallbacks.shift();
                await fn(real$);
            }
        },
    };
}

const DEFAULT_SCRIPT_DOM = `
    <div id="options_button"></div>
    <div id="options"></div>
    <div id="export_button"></div>
    <div id="export_format_popup"></div>
    <div id="online_status_indicator"></div>
    <div id="online_status_text"></div>
    <select id="main_api">
        <option value="openai">openai</option>
        <option value="textgenerationwebui">textgenerationwebui</option>
        <option value="kobold">kobold</option>
        <option value="koboldhorde">koboldhorde</option>
        <option value="novel">novel</option>
    </select>
    <div id="chat"></div>
    <div id="message_template" hidden>
        <div class="mes">
            <div class="mes_block">
                <div class="ch_name"><span class="name_text"></span></div>
                <div class="mes_text"></div>
            </div>
        </div>
    </div>
    <textarea id="send_textarea"></textarea>
    <div id="send_but"></div>
    <div id="mes_stop"></div>
`;

/**
 * Imports the real `public/script.js` ESM module in jsdom with mocked heavy peer modules
 * and captured `jQuery(readyFn)` startup callbacks.
 *
 * Because `public/script.js` is imported directly, its `export let` bindings (`online_status`,
 * `main_api`, `is_send_press`, `chat`, `characters`, `this_chid`, `chat_metadata`, etc.) stay
 * live ESM bindings for every downstream module that imports `script.js`.
 *
 * @param {object} [options]
 * @param {string|null} [options.dom] - HTML mounted in `document.body` before import. Pass `null` to keep existing DOM.
 * @param {Iterable<string>} [options.keepReal] - Relative paths under `public/` (e.g. `'scripts/utils.js'`) to import unmodified.
 * @param {Record<string, object|Function>} [options.mocks] - Per-module mock overrides keyed by path under `public/`.
 * @param {Function} [options.fetch] - Custom `globalThis.fetch` implementation.
 * @param {object} [options.toastr] - Custom toastr overrides.
 * @param {EventEmitter} [options.eventSource] - Custom EventEmitter instance.
 */
export async function importScriptModule(options = {}) {
    jest.resetModules();
    ensureJsdomBrowserGlobals();

    if (options.dom !== null && typeof document !== 'undefined') {
        document.body.innerHTML = options.dom ?? DEFAULT_SCRIPT_DOM;
    }

    const trackedNativeListeners = [];
    const origDocAdd = typeof document !== 'undefined' ? document.addEventListener.bind(document) : null;
    const origWinAdd = typeof window !== 'undefined' ? window.addEventListener.bind(window) : null;
    if (origDocAdd) {
        document.addEventListener = function trackedDocAdd(type, listener, listenerOptions) {
            trackedNativeListeners.push([document, type, listener, listenerOptions]);
            return origDocAdd(type, listener, listenerOptions);
        };
    }
    if (origWinAdd) {
        window.addEventListener = function trackedWinAdd(type, listener, listenerOptions) {
            trackedNativeListeners.push([window, type, listener, listenerOptions]);
            return origWinAdd(type, listener, listenerOptions);
        };
    }

    const { $, runReady } = loadWrappedJQuery();
    const keepReal = new Set(options.keepReal ?? []);
    const customMocks = options.mocks ?? {};

    const toastr = {
        options: {},
        subscribe: jest.fn(),
        getContainer: jest.fn(() => $()),
        info: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        clear: jest.fn(),
        remove: jest.fn(),
        ...(options.toastr ?? {}),
    };
    globalThis.toastr = toastr;
    if (typeof globalThis.window !== 'undefined') {
        globalThis.window.toastr = toastr;
    }

    const eventSource = options.eventSource ?? new EventEmitter();
    const storageMap = new Map();
    const accountStorage = {
        getItem: jest.fn(key => (storageMap.has(key) ? storageMap.get(key) : null)),
        setItem: jest.fn((key, value) => storageMap.set(key, String(value))),
        removeItem: jest.fn(key => storageMap.delete(key)),
    };

    const oai_settings = {
        chat_completion_source: 'openai',
        openai_model: 'gpt-4o',
        stream_openai: false,
        openai_max_context: 8192,
        openai_max_tokens: 300,
        send_if_empty: '',
        impersonation_prompt: '[Impersonate]',
        prompts: [],
        prompt_order: [],
    };
    const power_user = {
        sort_field: 'name',
        sort_order: 'asc',
        sort_rule: null,
        instruct: { enabled: false },
        context: { story_string: '' },
        persona_description: '',
        persona_description_position: 0,
        markdown_engine: 'showdown',
        max_context: 4096,
        fast_ui_mode: false,
        reduced_motion: false,
        waifuMode: false,
        movingUI: false,
        noShadows: false,
        chat_truncation: 100,
        streaming_fps: 30,
        smooth_streaming: false,
        smooth_streaming_speed: 25,
        auto_scroll_chat_to_bottom: true,
        continue_nudge_prompt: '',
        continue_postfix: ' ',
        trim_spaces: true,
        prefer_character_prompt: true,
        prefer_character_jailbreak: true,
        custom_stopping_strings: '',
        custom_stopping_strings_macro: false,
        collapse_newlines: false,
        pin_examples: false,
        strip_examples: false,
        disable_group_trimming: false,
        single_line: false,
        show_card_avatar_urls: false,
        always_force_name2: false,
        multigen: false,
        multigen_first_chunk: 50,
        multigen_next_chunks: 30,
        auto_continue: { enabled: false, allow_chat_completions: false, target_length: 400 },
        request_token_probabilities: false,
        show_group_chat_queue: false,
        reasoning: { prefix: '', suffix: '' },
        sysprompt: { enabled: false, content: '' },
    };
    const extension_settings = {
        note: { allowWIScan: false },
    };

    const createLocalForageStore = () => {
        const map = new Map();
        return {
            getItem: jest.fn(async key => (map.has(key) ? map.get(key) : null)),
            setItem: jest.fn(async (key, val) => { map.set(key, val); return val; }),
            removeItem: jest.fn(async key => { map.delete(key); }),
            clear: jest.fn(async () => { map.clear(); }),
            keys: jest.fn(async () => [...map.keys()]),
        };
    };

    const showdownConverter = {
        makeHtml: jest.fn(text => String(text ?? '')),
        setOption: jest.fn(),
        setFlavor: jest.fn(),
        addExtension: jest.fn(),
    };
    const showdown = {
        Converter: jest.fn(() => showdownConverter),
        setFlavor: jest.fn(),
        extension: jest.fn(),
        helper: { replaceRecursiveRegExp: jest.fn((v) => v) },
    };
    const libs = {
        showdown,
        markdownit: jest.fn(() => ({ render: jest.fn(v => String(v ?? '')), use: jest.fn().mockReturnThis() })),
        markdownItEmoji: jest.fn(),
        markdownItCjkFriendly: jest.fn(),
        moment: Object.assign(jest.fn(() => {
            const inst = {
                format: () => '2026-01-01',
                toISOString: () => '2026-01-01T00:00:00.000Z',
                valueOf: () => 0,
                isValid: () => true,
                unix: () => 0,
                diff: () => 0,
                locale: () => inst,
            };
            return inst;
        }), {
            unix: () => ({ format: () => '2026-01-01', valueOf: () => 0, diff: () => 0, isValid: () => true }),
            invalid: () => ({ format: () => '', valueOf: () => NaN, diff: () => 0, isValid: () => false }),
        }),
        DOMPurify: { sanitize: jest.fn(v => String(v ?? '')), addHook: jest.fn(), removeAllHooks: jest.fn() },
        hljs: { highlightElement: jest.fn(), highlightAuto: jest.fn(v => ({ value: v })) },
        Handlebars: { compile: jest.fn(tpl => () => String(tpl ?? '')), registerHelper: jest.fn() },
        localforage: Object.assign(createLocalForageStore(), {
            createInstance: jest.fn(() => createLocalForageStore()),
            dropInstance: jest.fn(async () => {}),
        }),
        SVGInject: Object.assign(jest.fn(), { setOptions: jest.fn() }),
        Popper: { createPopper: jest.fn(() => ({ update: jest.fn(), destroy: jest.fn() })) },
        lodash: {
            debounce: (fn) => Object.assign((...args) => fn(...args), { cancel: jest.fn(), flush: jest.fn() }),
            throttle: (fn) => Object.assign((...args) => fn(...args), { cancel: jest.fn(), flush: jest.fn() }),
            cloneDeep: v => v,
            isPlainObject: v => Boolean(v) && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype,
            isEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
            merge: Object.assign,
            range: (start, end, step = 1) => {
                const out = [];
                for (let value = start; value < end; value += step) {
                    out.push(value);
                }
                return out;
            },
            get: () => undefined,
            set: () => {},
            uniq: arr => [...new Set(arr)],
        },
        Fuse: class FakeFuse {
            constructor(list = []) { this.list = list; }
            search() { return []; }
        },
        Readability: class FakeReadability {},
        isProbablyReaderable: () => false,
    };

    let scriptRef = null;
    const defaultContext = () => ({
        extensionSettings: extension_settings,
        extensionPrompts: scriptRef?.extension_prompts ?? {},
        characters: scriptRef?.characters ?? [],
        chat: scriptRef?.chat ?? [],
        characterId: scriptRef?.this_chid,
        groupId: null,
        groups: [],
        chatMetadata: scriptRef?.chat_metadata ?? {},
        getCurrentChatId: () => scriptRef?.getCurrentChatId?.() ?? null,
    });

    const activeDebounceTimers = new Set();
    const defaultMocks = {
        'lib.js': {
            ...libs,
            initLibraryShims: jest.fn(),
            default: libs,
        },
        'scripts/events.js': { event_types, eventSource },
        'scripts/RossAscends-mods.js': {
            RA_CountCharTokens: jest.fn(),
            dragElement: jest.fn(),
            humanizedDateTime: jest.fn(() => '2026-01-01@00h00m00s'),
            favsToHotswap: jest.fn(),
            getMessageTimeStamp: jest.fn(() => '2026-01-01 00:00:00'),
            isMobile: jest.fn(() => false),
            initRossMods: jest.fn(),
        },
        'scripts/stats.js': {
            userStatsHandler: jest.fn(),
            statMesProcess: jest.fn(),
            initStats: jest.fn(),
        },
        'scripts/kai-settings.js': {
            generateKoboldWithStreaming: jest.fn(),
            kai_settings: { streaming_kobold: false },
            loadKoboldSettings: jest.fn(),
            getKoboldGenerationData: jest.fn(() => ({})),
            kai_flags: { can_use_streaming: false },
            koboldai_settings: [],
            koboldai_setting_names: [],
            initKoboldSettings: jest.fn(),
        },
        'scripts/textgen-settings.js': {
            textgenerationwebui_settings: { streaming: false, type: 'ooba' },
            loadTextGenSettings: jest.fn(),
            generateTextGenWithStreaming: jest.fn(),
            getTextGenGenerationData: jest.fn(() => ({})),
            textgen_types: { OOBA: 'ooba', LLAMACPP: 'llamacpp', KOBOLDCPP: 'koboldcpp' },
            parseTextgenLogprobs: jest.fn(),
            parseTabbyLogprobs: jest.fn(),
            initTextGenSettings: jest.fn(),
            getTextGenServer: jest.fn(() => ''),
            getStatusTextgen: jest.fn(async () => {}),
            SERVER_INPUTS: {},
        },
        'scripts/world-info.js': {
            world_info: { globalSelect: [] },
            getWorldInfoPrompt: jest.fn(async () => ({
                worldInfoString: '',
                worldInfoBefore: '',
                worldInfoAfter: '',
                worldInfoExamples: [],
                worldInfoDepth: [],
                anBefore: [],
                anAfter: [],
                outletEntries: {},
                allActivatedEntries: new Set(),
            })),
            getWorldInfoSettings: jest.fn(() => ({})),
            setWorldInfoSettings: jest.fn(),
            world_names: [],
            importEmbeddedWorldInfo: jest.fn(async () => {}),
            checkEmbeddedWorld: jest.fn(async () => false),
            setWorldInfoButtonClass: jest.fn(),
            wi_anchor_position: { before: 0, after: 1 },
            world_info_include_names: true,
            initWorldInfo: jest.fn(),
            charUpdatePrimaryWorld: jest.fn(),
            charSetAuxWorlds: jest.fn(),
            importWorldInfo: jest.fn(),
            createWorldInfoEntry: jest.fn(() => ({ uid: 1 })),
            syncWIOriginalDataEntry: jest.fn(),
            deleteWIOriginalDataValue: jest.fn(),
            reloadEditor: jest.fn(),
            loadWorldInfo: jest.fn(async () => ({ entries: {} })),
            saveWorldInfo: jest.fn(async () => {}),
        },
        'scripts/group-chats.js': {
            groups: [],
            selected_group: null,
            saveGroupChat: jest.fn(async () => {}),
            getGroups: jest.fn(async () => {}),
            generateGroupWrapper: jest.fn(async () => {}),
            is_group_generating: false,
            resetSelectedGroup: jest.fn(),
            select_group_chats: jest.fn(),
            regenerateGroup: jest.fn(async () => {}),
            group_generation_id: null,
            renameGroupMember: jest.fn(async () => {}),
            createNewGroupChat: jest.fn(async () => {}),
            getGroupAvatar: jest.fn(() => ''),
            deleteGroupChat: jest.fn(async () => {}),
            renameGroupChat: jest.fn(async () => {}),
            importGroupChat: jest.fn(async () => {}),
            getGroupBlock: jest.fn(() => $('<div></div>')),
            getGroupCharacterCardsLazy: jest.fn(() => ({})),
            getGroupDepthPrompts: jest.fn(() => []),
            deleteGroupChatByName: jest.fn(async () => {}),
            waitForQueuedGroupChatSaves: jest.fn(async () => {}),
            findGroupMemberId: jest.fn(),
            openGroupById: jest.fn(async () => true),
            getGroupMembers: jest.fn(() => []),
            runGroupMemberActionByChid: jest.fn(async () => {}),
        },
        'scripts/sillybunny-editor/dialog.js': { openAlert: jest.fn(async () => {}) },
        'scripts/sillybunny-chat-dialogs.js': { openChatHistoryDialog: jest.fn(async () => {}) },
        'scripts/sillybunny-connection-notices.js': { notifyNotConnected: jest.fn() },
        'scripts/sillybunny-connection-state.js': {
            setConnectionStatus: jest.fn(),
            setStatusCheckPending: jest.fn(),
        },
        'scripts/power-user.js': {
            collapseNewlines: jest.fn(v => v),
            loadPowerUserSettings: jest.fn(),
            playMessageSound: jest.fn(),
            fixMarkdown: jest.fn(v => v),
            power_user,
            persona_description_positions: { IN_PROMPT: 0, TOP_AN: 2, BOTTOM_AN: 3, AT_DEPTH: 9, NONE: 4 },
            getCustomStoppingStrings: jest.fn(() => []),
            MAX_CONTEXT_DEFAULT: 4096,
            MAX_RESPONSE_DEFAULT: 300,
            renderStoryString: jest.fn(() => ''),
            sortEntitiesList: jest.fn(list => list),
            registerDebugFunction: jest.fn(),
            flushEphemeralStoppingStrings: jest.fn(),
            resetMovableStyles: jest.fn(),
            forceCharacterEditorTokenize: jest.fn(),
            applyPowerUserSettings: jest.fn(),
            generatedTextFiltered: jest.fn(v => v),
            applyStylePins: jest.fn(),
            addEphemeralStoppingString: jest.fn(),
            chat_styles: {},
            context_presets: [],
            loadMovingUIState: jest.fn(),
            fuzzySearchCharacters: jest.fn(() => []),
            fuzzySearchGroups: jest.fn(() => []),
            fuzzySearchPersonas: jest.fn(() => []),
            fuzzySearchTags: jest.fn(() => []),
            fuzzySearchWorldInfo: jest.fn(() => []),
        },
        'scripts/openai.js': {
            setOpenAIMessageExamples: jest.fn(() => []),
            setOpenAIMessages: jest.fn(() => []),
            setupChatCompletionPromptManager: jest.fn(),
            prepareOpenAIMessages: jest.fn(async () => [[], 0]),
            sendOpenAIRequest: jest.fn(async () => ({ choices: [{ message: { content: 'AI reply' } }] })),
            loadOpenAISettings: jest.fn(),
            oai_settings,
            openai_messages_count: 0,
            chat_completion_sources: {
                OPENAI: 'openai',
                OPENAI_RESPONSES: 'openai_responses',
                CLAUDE: 'claude',
                MAKERSUITE: 'makersuite',
                GEMINI_INTERACTIONS: 'gemini_interactions',
                VERTEXAI: 'vertexai',
                OPENROUTER: 'openrouter',
                AI21: 'ai21',
                MISTRALAI: 'mistralai',
                CUSTOM: 'custom',
                COHERE: 'cohere',
                PERPLEXITY: 'perplexity',
                GROQ: 'groq',
                SILICONFLOW: 'siliconflow',
                ELECTRONHUB: 'electronhub',
                CHUTES: 'chutes',
                NANOGPT: 'nanogpt',
                DEEPSEEK: 'deepseek',
                AIMLAPI: 'aimlapi',
                XAI: 'xai',
                POLLINATIONS: 'pollinations',
                COMETAPI: 'cometapi',
                MOONSHOT: 'moonshot',
                FIREWORKS: 'fireworks',
                AZURE_OPENAI: 'azure_openai',
                ZAI: 'zai',
                MINIMAX: 'minimax',
            },
            getChatCompletionModel: jest.fn(() => oai_settings.openai_model),
            getCurrentReasoningEffort: jest.fn(() => null),
            getEffectivePromptBias: jest.fn(() => ''),
            proxies: [],
            loadProxyPresets: jest.fn(),
            selected_proxy: '',
            custom_endpoint_presets: [],
            loadCustomEndpointPresets: jest.fn(),
            selected_custom_endpoint_preset: '',
            initOpenAI: jest.fn(),
            reconnectOpenAi: jest.fn(),
            getStatusOpen: jest.fn(async () => {}),
            MINIMAX_ENDPOINT: '',
            POLLINATIONS_ENDPOINT: '',
            SILICONFLOW_ENDPOINT: '',
            ZAI_ENDPOINT: '',
            promptManager: {},
        },
        'scripts/nai-settings.js': {
            generateNovelWithStreaming: jest.fn(),
            getNovelGenerationData: jest.fn(() => ({})),
            getKayraMaxContextTokens: jest.fn(() => 8192),
            loadNovelSettings: jest.fn(),
            nai_settings: { streaming_novel: false },
            adjustNovelInstructionPrompt: jest.fn(v => v),
            parseNovelAILogprobs: jest.fn(),
            novelai_settings: [],
            novelai_setting_names: [],
            initNovelAISettings: jest.fn(),
        },
        'scripts/bookmarks.js': {
            initBookmarks: jest.fn(),
            showBookmarksButtons: jest.fn(),
            updateBookmarkDisplay: jest.fn(),
        },
        'scripts/horde.js': {
            horde_settings: {},
            loadHordeSettings: jest.fn(),
            generateHorde: jest.fn(),
            getStatusHorde: jest.fn(),
            getHordeModels: jest.fn(),
            adjustHordeGenerationParams: jest.fn(),
            isHordeGenerationNotAllowed: jest.fn(() => false),
            MIN_LENGTH: 16,
            initHorde: jest.fn(),
        },
        'scripts/utils.js': {
            debounce: (fn, timeout = 0) => {
                let timer;
                const wrapped = (...args) => {
                    if (timer) {
                        clearTimeout(timer);
                        activeDebounceTimers.delete(timer);
                    }
                    timer = setTimeout(() => {
                        activeDebounceTimers.delete(timer);
                        fn(...args);
                    }, timeout);
                    activeDebounceTimers.add(timer);
                };
                wrapped.cancel = () => {
                    if (timer) {
                        clearTimeout(timer);
                        activeDebounceTimers.delete(timer);
                        timer = null;
                    }
                };
                return wrapped;
            },
            delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
            trimToEndSentence: v => v,
            trimToStartSentence: v => v,
            countOccurrences: (str, sub) => (String(str).split(sub).length - 1),
            isOdd: n => n % 2 !== 0,
            sortMoments: () => 0,
            timestampToMoment: () => libs.moment(),
            download: jest.fn(),
            isDataURL: v => typeof v === 'string' && v.startsWith('data:'),
            getCharaFilename: () => 'char',
            PAGINATION_TEMPLATE: '',
            waitUntilCondition: async (condition, timeout = 1000, interval = 100, { rejectOnTimeout = true } = {}) => new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    clearInterval(intervalId);
                    (rejectOnTimeout ? reject : resolve)(new Error('Timed out waiting for condition to be true'));
                }, timeout);
                const intervalId = setInterval(() => {
                    if (condition()) {
                        clearTimeout(timeoutId);
                        clearInterval(intervalId);
                        resolve();
                    }
                }, interval);
            }),
            escapeRegex: s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            resetScrollHeight: jest.fn(async () => {}),
            onlyUnique: (v, i, a) => a.indexOf(v) === i,
            getBase64Async: jest.fn(async () => ''),
            humanFileSize: n => `${n} B`,
            Stopwatch: class {
                start() {}
                stop() { return 0; }
                async tick(callback) { await callback(); }
            },
            isValidUrl: () => true,
            ensureImageFormatSupported: jest.fn(async v => v),
            flashHighlight: jest.fn(),
            toggleDrawer: jest.fn(),
            isElementInViewport: jest.fn(() => true),
            copyText: jest.fn(async () => {}),
            escapeHtml: s => String(s ?? ''),
            saveBase64AsFile: jest.fn(async () => ({ path: '' })),
            equalsIgnoreCaseAndAccents: (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase(),
            localizePagination: jest.fn(),
            renderPaginationDropdown: jest.fn(),
            paginationDropdownChangeHandler: jest.fn(),
            importFromExternalUrl: jest.fn(),
            shiftUpByOne: arr => arr,
            shiftDownByOne: arr => arr,
            canUseNegativeLookbehind: () => true,
            trimSpaces: s => String(s ?? '').trim(),
            clamp: (v, min, max) => Math.min(Math.max(v, min), max),
            shakeElement: jest.fn(),
            createTimeout: jest.fn(() => ({ signal: new AbortController().signal, clear: jest.fn() })),
            loadFileToDocument: jest.fn(async () => {}),
            getSanitizedFilename: s => String(s ?? ''),
            getStringHash: () => 0,
            uuidv4: jest.fn(() => '00000000-0000-4000-8000-000000000000'),
            isTrueBoolean: v => ['true', 'on', '1', 'yes'].includes(String(v ?? '').toLowerCase().trim()),
            isFalseBoolean: v => ['false', 'off', '0', 'no'].includes(String(v ?? '').toLowerCase().trim()),
            findChar: jest.fn(),
            getCharIndex: jest.fn(() => -1),
            regexFromString: input => {
                try {
                    const m = String(input ?? '').match(/^\/([\w\W]+?)\/([gimsydvu]*)$/);
                    if (!m) return undefined;
                    return new RegExp(m[1], m[2]);
                } catch {
                    return undefined;
                }
            },
            showFontAwesomePicker: jest.fn(),
            stringToRange: jest.fn(),
            findPersona: jest.fn(),
            resolveAvatarData: jest.fn(),
            shuffle: jest.fn(arr => arr),
            createThumbnail: jest.fn(async v => v),
            extractAllWords: () => [],
            initScrollHeight: jest.fn(),
            includesIgnoreCaseAndAccents: (a, b) => String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
        },
        'scripts/extensions.js': {
            cancelDebouncedMetadataSave: jest.fn(),
            doDailyExtensionUpdatesCheck: jest.fn(),
            extension_settings,
            initExtensions: jest.fn(async () => {}),
            loadExtensionSettings: jest.fn(),
            runGenerationInterceptors: jest.fn(async () => false),
            getContext: jest.fn(defaultContext),
            saveMetadataDebounced: jest.fn(),
        },
        'scripts/slash-commands.js': {
            COMMENT_NAME_DEFAULT: 'Note',
            CONNECT_API_MAP: {},
            executeSlashCommandsOnChatInput: jest.fn(async () => ({ isAborted: false })),
            executeSlashCommandsWithOptions: jest.fn(async () => ({ pipe: '' })),
            initDefaultSlashCommands: jest.fn(),
            initSlashCommandAutoComplete: jest.fn(),
            isExecutingCommandsFromChatInput: jest.fn(() => false),
            pauseScriptExecution: jest.fn(),
            stopScriptExecution: jest.fn(),
            UNIQUE_APIS: [],
        },
        'scripts/autocomplete/MacroAutoComplete.js': { initMacroAutoComplete: jest.fn() },
        'scripts/tags.js': {
            tag_map: {},
            tags: [],
            filterByTagState: jest.fn(list => list),
            isBogusFolder: jest.fn(() => false),
            isBogusFolderOpen: jest.fn(() => false),
            chooseBogusFolder: jest.fn(),
            getTagBlock: jest.fn(() => $('<span></span>')),
            loadTagsSettings: jest.fn(),
            printTagFilters: jest.fn(),
            getTagKeyForEntity: jest.fn(() => ''),
            printTagList: jest.fn(),
            createTagMapFromList: jest.fn(),
            renameTagKey: jest.fn(),
            importTags: jest.fn(),
            tag_filter_type: {},
            compareTagsForSort: jest.fn(() => 0),
            initTags: jest.fn(),
            applyTagsOnCharacterSelect: jest.fn(),
            applyTagsOnGroupSelect: jest.fn(),
            tag_import_setting: { ASK: 0, ALL: 1, ONLY_EXISTING: 2, NONE: 3 },
            applyCharacterTagsToMessageDivs: jest.fn(),
            getTagsList: jest.fn(() => []),
        },
        'scripts/sillybunny-folders.js': {
            convertLegacyTagFolders: jest.fn(),
            getFolderId: jest.fn(() => null),
            removeEntityKey: jest.fn(),
            setFolder: jest.fn(async () => {}),
        },
        'scripts/sillybunny-first-run-defaults.js': {
            seedQuickImageGenFirstRun: jest.fn(),
            showFirstRunWelcome: jest.fn(),
        },
        'scripts/sillybunny-request-errors.js': {
            extractProviderMessage: jest.fn(() => ''),
            getThrownResponseFailure: jest.fn(() => null),
            showRequestError: jest.fn(),
        },
        'scripts/secrets.js': {
            checkOpenRouterAuth: jest.fn(),
            initSecrets: jest.fn(),
            readSecretState: jest.fn(async () => {}),
        },
        'scripts/showdown-exclusion.js': { markdownExclusionExt: jest.fn(() => []) },
        'scripts/showdown-underscore.js': { markdownUnderscoreExt: jest.fn(() => []) },
        'scripts/authors-note.js': {
            NOTE_MODULE_NAME: 'note',
            getAuthorsNoteDepth: jest.fn(() => 4),
            getAuthorsNotePosition: jest.fn(() => 1),
            getAuthorsNoteRole: jest.fn(() => 0),
            initAuthorsNote: jest.fn(),
            setFloatingPrompt: jest.fn(),
            shouldWIAddPrompt: false,
        },
        'scripts/PromptManager.js': { registerPromptManagerMigration: jest.fn() },
        'scripts/extensions/regex/engine.js': {
            getRegexedString: jest.fn(v => v),
            regex_placement: { USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 },
        },
        'scripts/extensions/in-chat-agents/regex-scripts.js': {
            AGENT_REGEX_PLACEMENT: {},
            applyRegexScriptList: jest.fn(v => v),
        },
        'scripts/extensions/in-chat-agents/regex-snapshot-store.js': {
            resolveRegexScriptsForSnapshot: jest.fn(() => []),
        },
        'scripts/extensions/in-chat-agents/companion/companion-shared.js': {
            consolidateCompanionChatHistory: jest.fn(() => ({ host: null, entries: [] })),
            hasCompanionChatHistoryForHiddenHost: jest.fn(() => false),
            selectCompanionChatHistory: jest.fn(() => new Map()),
        },
        'scripts/logprobs.js': {
            initLogprobs: jest.fn(),
            saveLogprobsForActiveMessage: jest.fn(),
        },
        'scripts/filters.js': {
            FILTER_STATES: {},
            FILTER_TYPES: {},
            FilterHelper: class {
                setFilterData() {}
                getFilterData() { return null; }
                applyFilters() { return []; }
                clearFuzzySearchCaches() {}
            },
            isFilterState: () => false,
        },
        'scripts/cfg-scale.js': {
            getCfgPrompt: jest.fn(() => ({ value: '', depth: 0 })),
            getGuidanceScale: jest.fn(() => null),
            initCfg: jest.fn(),
        },
        'scripts/instruct-mode.js': {
            force_output_sequence: jest.fn(v => v),
            formatInstructModeChat: jest.fn(v => v),
            formatInstructModePrompt: jest.fn(v => v),
            formatInstructModeExamples: jest.fn(v => v),
            formatInstructModeStoryString: jest.fn(v => v),
            getInstructStoppingSequences: jest.fn(() => []),
            instruct_presets: [],
            selectContextPreset: jest.fn(),
            selectInstructPreset: jest.fn(),
        },
        'scripts/i18n.js': {
            initLocales: jest.fn(async () => {}),
            t: defaultTag,
            translate: v => String(v ?? ''),
            getCurrentLocale: () => 'en',
        },
        'scripts/tokenizers.js': {
            getFriendlyTokenizerName: jest.fn(() => 'OpenAI'),
            getTokenCount: jest.fn(() => 0),
            getTokenCountAsync: jest.fn(async () => 0),
            initTokenizers: jest.fn(),
            saveTokenCache: jest.fn(),
            decodeTextTokens: jest.fn(async () => ''),
            getAvailableTokenizers: jest.fn(() => []),
            getTextTokens: jest.fn(async () => []),
            selectTokenizer: jest.fn(),
        },
        'scripts/personas.js': {
            user_avatar: 'user-default.png',
            getUserAvatars: jest.fn(async () => []),
            getUserAvatar: jest.fn(() => 'img/user-default.png'),
            setUserAvatar: jest.fn(),
            initPersonas: jest.fn(),
            setPersonaDescription: jest.fn(),
            initUserAvatar: jest.fn(),
            updatePersonaConnectionsAvatarList: jest.fn(),
            isPersonaPanelOpen: jest.fn(() => false),
        },
        'scripts/backgrounds.js': {
            getBackgrounds: jest.fn(async () => {}),
            initBackgrounds: jest.fn(),
            loadBackgroundSettings: jest.fn(),
            background_settings: {},
            getBackgroundTargets: jest.fn(() => []),
        },
        'scripts/action-loader.js': {
            dismissPreloader: jest.fn(),
            loader: {
                show: jest.fn(),
                hide: jest.fn(),
                ToastMode: { STATIC: 'static', PROGRESS: 'progress' },
                start: jest.fn(() => ({ finish: jest.fn(), fail: jest.fn(), update: jest.fn(), dismiss: jest.fn() })),
            },
        },
        'scripts/BulkEditOverlay.js': {
            BulkEditOverlay: class {
                getState() { return false; }
                stop() {}
            },
        },
        'scripts/textgen-models.js': { initTextGenModels: jest.fn() },
        'scripts/chats.js': {
            appendFileContent: jest.fn(v => v),
            hasPendingFileAttachment: jest.fn(() => false),
            populateFileAttachment: jest.fn(),
            decodeStyleTags: jest.fn(v => v),
            encodeStyleTags: jest.fn(v => v),
            isExternalMediaAllowed: jest.fn(() => true),
            preserveNeutralChat: jest.fn(),
            restoreNeutralChat: jest.fn(),
            formatCreatorNotes: jest.fn(v => v),
            initChatUtilities: jest.fn(),
            addDOMPurifyHooks: jest.fn(),
            hideChatMessageRange: jest.fn(async () => {}),
        },
        'scripts/preset-manager.js': {
            getPresetManager: jest.fn(() => null),
            initPresetManager: jest.fn(),
        },
        'scripts/macros.js': {
            evaluateMacros: jest.fn(v => v),
            getLastMessageId: jest.fn(() => 0),
            initMacros: jest.fn(),
        },
        'scripts/user.js': {
            currentUser: { handle: 'default-user', name: 'User' },
            setUserControls: jest.fn(),
        },
        'scripts/popup.js': {
            POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
            POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 },
            Popup: Object.assign(class { async show() { return 1; } }, {
                show: { confirm: jest.fn(async () => 1), input: jest.fn(async () => '') },
            }),
            callGenericPopup: jest.fn(async () => 1),
            fixToastrForDialogs: jest.fn(),
        },
        'scripts/templates.js': {
            renderTemplate: jest.fn(() => ''),
            renderTemplateAsync: jest.fn(async () => ''),
        },
        'scripts/sillybunny-editor/adapters/window-content-dialogs.js': { scenarioOverrideOptions: jest.fn(() => ({})) },
        'scripts/scrapers.js': { initScrapers: jest.fn() },
        'scripts/samplerSelect.js': {
            initCustomSelectedSamplers: jest.fn(),
            validateDisabledSamplers: jest.fn(),
        },
        'scripts/dragdrop.js': { DragAndDropHandler: class {} },
        'scripts/keyboard.js': { INTERACTABLE_CONTROL_CLASS: 'interactable', initKeyboard: jest.fn() },
        'scripts/dynamic-styles.js': { loadStylesheetAsync: jest.fn(async () => {}), initDynamicStyles: jest.fn() },
        'scripts/input-md-formatting.js': { initInputMarkdown: jest.fn() },
        'scripts/sysprompt.js': { initSystemPrompts: jest.fn() },
        'scripts/extensions-slashcommands.js': { registerExtensionSlashCommands: jest.fn() },
        'scripts/tool-calling.js': {
            ToolManager: {
                RECURSE_LIMIT: 5,
                initToolSlashCommands: jest.fn(),
                isToolCallingSupported: jest.fn(() => false),
                canPerformToolCalls: jest.fn(() => false),
                recurse: jest.fn(async () => false),
                parseToolCalls: jest.fn(() => []),
                hasToolCalls: jest.fn(() => false),
                registerFunctionTool: jest.fn(),
                unregisterFunctionTool: jest.fn(),
            },
        },
        'scripts/util/showdown-patch.js': { addShowdownPatch: jest.fn() },
        'scripts/browser-fixes.js': { applyBrowserFixes: jest.fn() },
        'scripts/sortable-handle-classes.js': { batchSortableHandleClasses: jest.fn() },
        'scripts/sillybunny-editor/reorder-menu.js': {
            adoptUpstreamSortables: jest.fn(),
            reorderMenuItems: jest.fn(() => []),
        },
        'scripts/server-history.js': {
            initServerHistory: jest.fn(),
            onServerConnectClick: jest.fn(),
        },
        'scripts/setting-search.js': { initSettingsSearch: jest.fn() },
        'scripts/bulk-edit.js': { initBulkEdit: jest.fn() },
        'scripts/st-context.js': { getContext: jest.fn(() => ({ extensionSettings: extension_settings })) },
        'scripts/reasoning.js': {
            extractReasoningFromData: jest.fn(() => ''),
            extractReasoningSignatureFromData: jest.fn(() => ''),
            initReasoning: jest.fn(),
            parseReasoningInSwipes: jest.fn(),
            PromptReasoning: class {
                static getLatestPrefix() { return ''; }
                prefixIncomplete = false;
                prefixReasoning = '';
                prefixReasoningFormatted = '';
                addToMessage(message) { return message; }
                isLimitReached() { return false; }
                removePrefix(text) { return text; }
            },
            ReasoningHandler: class {
                reasoning = '';
                initContinue() {}
                async process() {}
                updateDom() {}
                updateReasoning() {}
                hasReasoningContent() { return false; }
                getDuration() { return 0; }
                async finish() {}
            },
            removeReasoningFromString: jest.fn(v => v),
            updateReasoningUI: jest.fn(),
        },
        'scripts/util/AccountStorage.js': { accountStorage },
        'scripts/welcome-screen.js': {
            initWelcomeScreen: jest.fn(),
            openPermanentAssistantChat: jest.fn(async () => {}),
            openPermanentAssistantCard: jest.fn(async () => {}),
            getPermanentAssistantAvatar: jest.fn(() => ''),
        },
        'scripts/data-maid.js': { initDataMaid: jest.fn() },
        'scripts/itemized-prompts.js': {
            clearItemizedPrompts: jest.fn(),
            deleteItemizedPromptForMessage: jest.fn(),
            deleteItemizedPrompts: jest.fn(),
            findItemizedPromptSet: jest.fn(() => null),
            initItemizedPrompts: jest.fn(),
            itemizedParams: {},
            itemizedPrompts: [],
            loadItemizedPrompts: jest.fn(async () => {}),
            promptItemize: jest.fn(),
            replaceItemizedPromptText: jest.fn(),
            saveItemizedPrompts: jest.fn(async () => {}),
            swapItemizedPrompts: jest.fn(),
        },
        'scripts/system-messages.js': {
            getSystemMessageByType: jest.fn(() => null),
            initSystemMessages: jest.fn(),
            SAFETY_CHAT: [],
            sendSystemMessage: jest.fn(async () => {}),
            system_message_types: { NARRATOR: 'narrator', GENERIC: 'generic', WELCOME: 'welcome' },
            system_messages: {},
        },
        'scripts/a11y.js': { initAccessibility: jest.fn() },
        'scripts/quick-context-size-enhancer.js': { initQuickContextSizeEnhancer: jest.fn() },
        'scripts/util/stream-fadein.js': { applyStreamDomPatch: jest.fn(), applyStreamFadeIn: jest.fn() },
        'scripts/dom-handlers.js': { initDomHandlers: jest.fn() },
        'scripts/audio-player.js': { AudioPlayer: class {} },
        'scripts/macros/engine/MacroEnvBuilder.js': { MacroEnvBuilder: class {} },
        'scripts/message-formatter.js': {
            MessageFormatter: {
                stage: {
                    BEFORE_REGEX: 'before_regex',
                    AFTER_REGEX: 'after_regex',
                    BEFORE_MARKDOWN: 'before_markdown',
                    AFTER_MARKDOWN: 'after_markdown',
                },
                runStage: jest.fn((_stage, text) => text),
            },
        },
        'scripts/macros/engine/MacroEngine.js': { MacroEngine: class {} },
        'scripts/chat-backups.js': { addChatBackupsBrowser: jest.fn() },
        'scripts/macros/engine/MacroDiagnostics.js': { onboardingExperimentalMacroEngine: jest.fn() },
        'scripts/request-compression.js': {
            compressRequest: jest.fn(async req => req),
            setRequestCompressionConfig: jest.fn(),
        },
        'scripts/swipe-picker.js': {
            canJumpToSwipeForMessage: jest.fn(() => false),
            canOpenSwipePickerForMessage: jest.fn(() => false),
            initSwipePicker: jest.fn(),
        },
        'scripts/mobile-send-button.js': {
            bindIOSFastTapSendButton: jest.fn(),
            isIOSWebKitPlatform: jest.fn(() => false),
        },
        'scripts/sillybunny-delete-confirm.js': {
            DELETE_CHOICE: { CANCEL: 0, CONFIRM: 1 },
            confirmMessageDeletion: jest.fn(async () => 1),
            confirmVerb: jest.fn(async () => true),
        },
        'scripts/sillybunny-temporary-chat.js': {
            beginTemporaryChat: jest.fn(async () => {}),
            endTemporaryChat: jest.fn(async () => {}),
            leaveTemporaryChat: jest.fn(async () => {}),
            showTemporaryChatError: jest.fn(),
        },
        'scripts/sillybunny-editor/adapters/preset-lorebook-dialogs.js': {
            presetChoicesOptions: jest.fn(() => ({})),
            embeddedLorebookOptions: jest.fn(() => ({})),
            lorebookSortingOptions: jest.fn(() => ({})),
            lorebookSelectOptions: jest.fn(() => ({})),
        },
        'scripts/sillybunny-editor/adapters/misc-dialogs.js': { messageScreenshotOptions: jest.fn(() => ({ onOpening: jest.fn() })) },
        'scripts/sillybunny-character-editor.js': {
            beginCharacterEditorLoad: jest.fn(),
            loadCharacterEditorGreetings: jest.fn(async () => {}),
            openCharacterEditorSession: jest.fn(),
            openCharacterEditorCreateSession: jest.fn(),
            captureCharacterEditorSave: jest.fn(),
            markCharacterEditorSaved: jest.fn(),
            getCharacterEditorAlternateGreetings: jest.fn(() => []),
            getCharacterEditorGroupGreetings: jest.fn(() => []),
            syncCharacterEditorFavorite: jest.fn(),
            discardCharacterEditorForEntity: jest.fn(),
        },
        'scripts/resumable-generation.js': {
            fetchResumable: jest.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => ({ results: [{ text: 'AI reply' }] }),
                text: async () => '',
            })),
            registerGenerationCommitPlan: jest.fn(),
            settleGenerationCommit: jest.fn(),
        },
        'scripts/server-generations.js': {
            createGenerationCommitPlan: jest.fn(() => null),
            initServerGenerations: jest.fn(),
            reloadServerCommittedReply: jest.fn(async () => false),
        },
        'scripts/card-script-detection.js': {
            CARD_SCRIPT_MARKER_TAG: 'data-sb-card-script',
            buildCardScriptToastKey: jest.fn(() => ''),
            forgetAllCardScripts: jest.fn(),
            getCardScriptSnapshot: jest.fn(() => ({})),
            hasCardScriptToastBeenShown: jest.fn(() => false),
            markCardScriptHtml: jest.fn(v => v),
            markCardScriptToastShown: jest.fn(),
        },
        'scripts/card-script-runtime.js': {
            configureCardScriptRuntime: jest.fn(),
            initCardScriptRuntime: jest.fn(),
        },
    };

    const resolvedMocks = {};
    for (const [relPath, baseMock] of Object.entries(defaultMocks)) {
        if (keepReal.has(relPath)) continue;
        const override = customMocks[relPath];
        const finalMock = typeof override === 'function'
            ? override(baseMock)
            : (override ? { ...baseMock, ...override } : baseMock);
        resolvedMocks[relPath] = finalMock;
        await jest.unstable_mockModule(pub(relPath), () => finalMock);
    }

    for (const [relPath, override] of Object.entries(customMocks)) {
        if (relPath in defaultMocks || keepReal.has(relPath)) continue;
        const finalMock = typeof override === 'function' ? override({}) : override;
        resolvedMocks[relPath] = finalMock;
        await jest.unstable_mockModule(pub(relPath), () => finalMock);
    }

    if (options.fetch) {
        globalThis.fetch = options.fetch;
    } else if (typeof globalThis.fetch !== 'function') {
        globalThis.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({}),
            text: async () => '',
        }));
    }

    const script = await import(pub('script.js'));
    scriptRef = script;
    if (options.initMarkdown !== false) {
        script.reloadMarkdownProcessor();
    }

    return {
        script,
        runReady,
        $,
        eventSource,
        toastr,
        mocks: resolvedMocks,
        state: {
            oai_settings,
            power_user,
            extension_settings,
            accountStorage,
        },
        cleanup() {
            try {
                $(document).off();
                $(window).off();
            } catch {
                // Ignore if jsdom window is already torn down.
            }
            for (const [target, type, listener, listenerOptions] of trackedNativeListeners) {
                try {
                    target.removeEventListener(type, listener, listenerOptions);
                } catch {
                    // Ignore teardown errors.
                }
            }
            trackedNativeListeners.length = 0;
            if (origDocAdd && typeof document !== 'undefined') {
                document.addEventListener = origDocAdd;
            }
            if (origWinAdd && typeof window !== 'undefined') {
                window.addEventListener = origWinAdd;
            }
            for (const timer of activeDebounceTimers) {
                clearTimeout(timer);
            }
            activeDebounceTimers.clear();
            script.cancelDebouncedChatSave?.();
        },
    };
}
