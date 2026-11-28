/* global globalThis */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';
import { SimpleMutex } from '../../public/scripts/util/SimpleMutex.js';

const pub = rel => fileURLToPath(new URL(`../../public/${rel}`, import.meta.url));
const jquerySource = readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');

function ensureJQuery() {
    if (typeof window === 'undefined') return;
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

export async function loadExpressionsModule(options = {}) {
    jest.resetModules();
    ensureJQuery();

    const hasDom = typeof document !== 'undefined';
    if (hasDom) {
        document.body.className = '';
        document.body.innerHTML = '<div id="expressions_container"></div>';
    }

    const trackedIntervals = [];
    const originalSetInterval = globalThis.setInterval;
    const originalFetch = globalThis.fetch;

    globalThis.setInterval = (...args) => {
        const id = originalSetInterval(...args);
        trackedIntervals.push(id);
        return id;
    };

    if (options.fetch) {
        globalThis.fetch = options.fetch;
    }

    const toastr = {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        success: jest.fn(),
    };
    globalThis.toastr = toastr;

    const legacyMacros = new Map();
    const modernMacros = new Map();
    const eventSource = createEventSource();
    const event_types = {
        CHAT_CHANGED: 'chat_changed',
        MOVABLE_PANELS_RESET: 'movable_panels_reset',
        GROUP_UPDATED: 'group_updated',
        SETTINGS_UPDATED: 'settings_updated',
    };

    const state = {
        characters: options.characters ?? [{ name: 'Bunny', avatar: 'Bunny.png' }],
        this_chid: 'this_chid' in options ? options.this_chid : 0,
        selected_group: options.selected_group ?? null,
        online_status: options.online_status ?? 'connected',
        chat: options.chat ?? [],
    };

    const extension_settings = {
        expressions: {
            custom: [],
            api: 99,
            fallback_expression: 'joy',
            showDefault: false,
            ...(options.expressionsSettings || {}),
        },
        expressionOverrides: [],
        ...(options.extensionSettings || {}),
    };

    const power_user = {
        experimental_macro_engine: Boolean(options.experimentalMacroEngine),
        ...(options.powerUser || {}),
    };

    const getContext = jest.fn(() => ({
        characters: state.characters,
        characterId: state.this_chid,
        groupId: state.selected_group,
        chat: state.chat,
        chatMetadata: {},
        name1: 'User',
        name2: state.characters[state.this_chid]?.name ?? '',
    }));

    await jest.unstable_mockModule(pub('lib.js'), () => ({
        Fuse: class Fuse {
            constructor(list) { this.list = list; }
            search() { return []; }
        },
    }));

    await jest.unstable_mockModule(pub('scripts/macros.js'), () => ({
        MacrosParser: {
            registerMacro: jest.fn((name, handler) => { legacyMacros.set(name, handler); }),
        },
    }));

    await jest.unstable_mockModule(pub('scripts/macros/macro-system.js'), () => ({
        macros: {
            register: jest.fn((name, definition) => { modernMacros.set(name, definition.handler); }),
            category: { MISC: 'misc' },
            valueType: { STRING: 'string' },
        },
    }));

    await jest.unstable_mockModule(pub('script.js'), () => ({
        get characters() { return state.characters; },
        eventSource,
        event_types,
        generateQuietPrompt: jest.fn(async () => ''),
        generateRaw: jest.fn(async () => ''),
        getRequestHeaders: jest.fn(() => ({})),
        get online_status() { return state.online_status; },
        saveSettingsDebounced: jest.fn(),
        substituteParams: jest.fn(value => value),
        substituteParamsExtended: jest.fn(value => value),
        system_message_types: { GENERIC: 'generic' },
        get this_chid() { return state.this_chid; },
    }));

    await jest.unstable_mockModule(pub('scripts/RossAscends-mods.js'), () => ({
        dragElement: jest.fn(),
        isMobile: jest.fn(() => false),
    }));

    await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({
        getContext,
        getApiUrl: jest.fn(() => 'http://localhost:5100'),
        modules: options.modules ?? [],
        extension_settings,
        ModuleWorkerWrapper: class ModuleWorkerWrapper {
            constructor(callback) { this.mutex = new SimpleMutex(callback); }
            async update(...args) { return this.mutex.update(...args); }
        },
        doExtrasFetch: jest.fn(async () => ({ ok: false })),
        renderExtensionTemplateAsync: jest.fn(async () => '<div id="expressions_settings"><select id="expression_fallback"></select><div id="expression_custom_list"></div><select id="expression_api"></select></div>'),
    }));

    await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({
        loadMovingUIState: jest.fn(),
        performFuzzySearch: jest.fn(() => []),
        power_user,
    }));

    await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
        onlyUnique: (value, index, array) => array.indexOf(value) === index,
        debounce: fn => fn,
        getCharaFilename: jest.fn((_chid, { manualAvatarKey } = {}) => {
            const name = manualAvatarKey || state.characters[state.this_chid]?.avatar || 'Bunny.png';
            return String(name).replace(/\.[^.]+$/, '');
        }),
        trimToEndSentence: s => s,
        trimToStartSentence: s => s,
        waitUntilCondition: jest.fn(async () => {}),
        findChar: jest.fn(() => null),
        isFalseBoolean: value => value === false || value === 'false',
        includesIgnoreCaseAndAccents: (a, b) => String(a).toLowerCase().includes(String(b).toLowerCase()),
    }));

    await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({
        hideMutedSprites: jest.fn(),
        get selected_group() { return state.selected_group; },
    }));

    await jest.unstable_mockModule(pub('scripts/textgen-settings.js'), () => ({
        isJsonSchemaSupported: jest.fn(() => false),
    }));

    await jest.unstable_mockModule(pub('scripts/constants.js'), () => ({
        debounce_timeout: { relaxed: 10 },
    }));

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParser.js'), () => ({
        SlashCommandParser: { addCommandObject: jest.fn() },
    }));

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommand.js'), () => ({
        SlashCommand: { fromProps: props => props },
    }));

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandArgument.js'), () => ({
        ARGUMENT_TYPE: { STRING: 'string', BOOLEAN: 'boolean' },
        SlashCommandArgument: class SlashCommandArgument {
            constructor(description, typeList, isRequired) {
                this.description = description;
                this.typeList = typeList;
                this.isRequired = isRequired;
            }
            static fromProps(props) { return props; }
        },
        SlashCommandNamedArgument: class SlashCommandNamedArgument {
            constructor(props) { Object.assign(this, props); }
            static fromProps(props) { return props; }
        },
    }));

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({
        SlashCommandEnumValue: class SlashCommandEnumValue {
            constructor(value, description, type, typeIcon) {
                this.value = value;
                this.description = description;
                this.type = type;
                this.typeIcon = typeIcon;
            }
        },
        enumTypes: { enum: 'enum', name: 'name' },
    }));

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandCommonEnumsProvider.js'), () => ({
        commonEnumProviders: {
            characters: () => () => [],
            boolean: () => () => ['true', 'false'],
        },
    }));

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandReturnHelper.js'), () => ({
        slashCommandReturnHelper: { enumList: () => ['pipe'] },
    }));

    await jest.unstable_mockModule(pub('scripts/extensions/shared.js'), () => ({
        generateWebLlmChatPrompt: jest.fn(async () => ''),
        isWebLlmSupported: jest.fn(() => false),
    }));

    await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
        Popup: { show: { confirm: jest.fn(async () => 0) } },
        POPUP_RESULT: { AFFIRMATIVE: 1 },
    }));

    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/utility-dialogs.js'), () => ({
        adoptExpressionsSettings: jest.fn(),
    }));

    await jest.unstable_mockModule(pub('scripts/sillybunny-delete-confirm.js'), () => ({
        confirmVerb: jest.fn(async () => false),
    }));

    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
        t: (strings, ...values) => strings.reduce((acc, part, idx) => acc + part + (values[idx] ?? ''), ''),
    }));

    await jest.unstable_mockModule(pub('scripts/reasoning.js'), () => ({
        removeReasoningFromString: s => s,
    }));

    await jest.unstable_mockModule(pub('scripts/extensions/expressions/expressions-agent.js'), () => ({
        DEFAULT_EXPRESSION_SPRITE_PROMPT: 'default sprite prompt',
        LEGACY_DEFAULT_EXPRESSION_SPRITE_PROMPT: 'legacy sprite prompt',
        getAgentExpressionLabel: jest.fn(async () => null),
        isExpressionsAgentAvailable: jest.fn(() => false),
        maybeGenerateExpressionSprite: jest.fn(async () => null),
        maybeGenerateExpressionSpriteSheet: jest.fn(async () => null),
        stopExpressionSpriteGeneration: jest.fn(),
        syncExpressionsAgentProfile: jest.fn(async () => {}),
        cleanupExpressionAgentSpinner: jest.fn(),
    }));

    const expressionsModule = await import(pub('scripts/extensions/expressions/index.js'));

    const cleanup = () => {
        for (const id of trackedIntervals) {
            clearInterval(id);
        }
        trackedIntervals.length = 0;
        globalThis.setInterval = originalSetInterval;
        globalThis.fetch = originalFetch;
        delete globalThis.toastr;
    };

    return {
        expressionsModule,
        state,
        extension_settings,
        power_user,
        eventSource,
        event_types,
        legacyMacros,
        modernMacros,
        cleanup,
    };
}
