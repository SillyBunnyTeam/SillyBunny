/* global globalThis */
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import Handlebars from 'handlebars';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));
const cachedJQuerySource = readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');

function ensureJsdomGlobals() {
    if (typeof globalThis.structuredClone !== 'function') {
        globalThis.structuredClone = value => v8.deserialize(v8.serialize(value));
    }
    if (typeof globalThis.window !== 'undefined' && typeof globalThis.window.matchMedia !== 'function') {
        globalThis.window.matchMedia = () => ({
            matches: false,
            media: '',
            addEventListener() {},
            removeEventListener() {},
        });
    }
}

ensureJsdomGlobals();

function loadJQuery() {
    if (typeof globalThis.window === 'undefined') {
        throw new Error('importConnectionManagerModule requires a jsdom test environment.');
    }
    if (!globalThis.window.jQuery) {
        (0, eval)(cachedJQuerySource);
    }
    const $ = globalThis.window.jQuery;
    if ($.fx) $.fx.off = true;
    globalThis.$ = $;
    globalThis.jQuery = $;
    globalThis.window.$ = $;
    return $;
}

class HarnessEventEmitter {
    constructor() {
        this.listeners = new Map();
    }

    on(event, fn) {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event).add(fn);
        return this;
    }

    once(event, fn) {
        const wrapped = (...args) => {
            this.removeListener(event, wrapped);
            return fn(...args);
        };
        return this.on(event, wrapped);
    }

    removeListener(event, fn) {
        this.listeners.get(event)?.delete(fn);
        return this;
    }

    async emit(event, ...args) {
        for (const fn of [...(this.listeners.get(event) ?? [])]) {
            await fn(...args);
        }
    }
}

/**
 * Renders a real Connection Manager Handlebars template from `public/scripts/extensions/connection-manager/`.
 * @param {string} templateName
 * @param {object} [data]
 */
function renderConnectionManagerTemplate(templateName, data = {}) {
    const filePath = pub(`scripts/extensions/connection-manager/${templateName}.html`);
    // Strip HTML comments and surrounding whitespace like DOMPurify in renderTemplateAsync so $(html)[0] is the root element.
    const source = readFileSync(filePath, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
    return Handlebars.compile(source)(data);
}

/**
 * Imports the real `public/scripts/extensions/connection-manager/index.js` inside jsdom.
 * Mounts `#rm_api_block` automatically if not already in the DOM, and optionally runs `init()`.
 * @param {object} [options]
 */
export async function importConnectionManagerModule(options = {}) {
    jest.resetModules();
    ensureJsdomGlobals();
    const $ = loadJQuery();

    if (!document.getElementById('rm_api_block')) {
        document.body.innerHTML = '<div id="rm_api_block"></div>';
    }

    const toastr = {
        info: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        ...(options.toastr ?? {}),
    };
    globalThis.toastr = toastr;
    globalThis.window.toastr = toastr;

    const eventSource = options.eventSource ?? new HarnessEventEmitter();
    const event_types = {
        CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
        CONNECTION_PROFILE_CREATED: 'connection_profile_created',
        CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
        CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
        APP_READY: 'app_ready',
        SETTINGS_LOADED: 'settings_loaded',
        ...(options.event_types ?? {}),
    };

    const state = {
        main_api: options.main_api ?? 'openai',
        online_status: options.online_status ?? 'connected',
        extension_settings: options.extension_settings ?? {
            connectionManager: {
                selectedProfile: '',
                profiles: [],
                folders: [],
                favorites: [],
            },
        },
        oai_settings: options.oai_settings ?? {
            chat_completion_source: 'openai',
        },
        selected_custom_endpoint_preset: options.selected_custom_endpoint_preset ?? { name: 'None', secretId: '' },
    };

    const commandLog = [];
    const commands = {};
    const makeDefaultCommand = name => ({
        name,
        callback: jest.fn(async (args, argument) => {
            commandLog.push({ command: name, args, argument });
            return options.commandValues?.[name] ?? '';
        }),
    });

    for (const name of [
        'api', 'preset', 'secret-id', 'custom-endpoint-profile', 'api-url', 'model',
        'service-tier', 'proxy', 'stop-strings', 'start-reply-with', 'reasoning-template',
        'request-reasoning', 'reasoning-effort', 'verbosity', 'enable-web-search',
        'request-images', 'request-image-resolution', 'request-image-aspect-ratio',
        'custom-reasoning-preset', 'custom-reasoning-param-format', 'custom-reasoning-param-name',
        'custom-reasoning-enabled-value', 'custom-reasoning-disabled-value',
        'custom-include-body', 'custom-exclude-body', 'custom-include-headers',
        'prompt-post-processing', 'regex-preset',
        'sysprompt', 'sysprompt-state', 'instruct', 'context', 'instruct-state', 'tokenizer',
    ]) {
        commands[name] = makeDefaultCommand(name);
    }

    if (options.commands) {
        for (const [name, fn] of Object.entries(options.commands)) {
            commands[name] = {
                name,
                callback: jest.fn(async (args, argument) => {
                    commandLog.push({ command: name, args, argument });
                    return await fn(args, argument);
                }),
            };
        }
    }

    const addedCommands = new Map();
    const SlashCommandParser = {
        commands,
        addCommandObject: jest.fn(cmd => {
            addedCommands.set(cmd.name, cmd);
            commands[cmd.name] = cmd;
        }),
    };

    const scriptMock = {
        activateSendButtons: jest.fn(),
        deactivateSendButtons: jest.fn(),
        event_types,
        eventSource,
        get main_api() { return state.main_api; },
        get online_status() { return state.online_status; },
        saveSettings: jest.fn(async () => {}),
        saveSettingsDebounced: jest.fn(),
        ...(options.script ?? {}),
    };

    const renderExtensionTemplateAsync = jest.fn(async (_moduleName, templateName, data = {}) => (
        renderConnectionManagerTemplate(templateName, data)
    ));

    const getContext = jest.fn(() => ({
        mainApi: state.main_api,
        onlineStatus: state.online_status,
        extensionSettings: state.extension_settings,
        ...(options.context ?? {}),
    }));

    const popupResult = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
    const popupType = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 };
    const popupCalls = [];
    const callGenericPopup = jest.fn(async (content, type, inputValue, popupOptions) => {
        popupCalls.push({ kind: 'callGenericPopup', content, type, inputValue, options: popupOptions });
        if (options.onPopup) return await options.onPopup({ kind: 'callGenericPopup', content, type, inputValue, options: popupOptions });
        return popupResult.CANCELLED;
    });
    const PopupMock = jest.fn(function (content, type, inputValue, popupOptions) {
        this.content = content;
        this.type = type;
        this.inputValue = inputValue;
        this.options = popupOptions;
        popupCalls.push({ kind: 'Popup', content, type, inputValue, options: popupOptions });
        this.show = jest.fn(async () => {
            if (options.onPopup) return await options.onPopup({ kind: 'Popup', content, type, inputValue, options: popupOptions, instance: this });
            return popupResult.CANCELLED;
        });
    });
    PopupMock.show = {
        confirm: jest.fn(async () => popupResult.AFFIRMATIVE),
        input: jest.fn(async () => ''),
    };

    let uuidCounter = 0;
    const cancelDebounce = jest.fn();
    const utilsMock = {
        cancelDebounce,
        collapseSpaces: value => String(value ?? '').replace(/\s+/g, ' ').trim(),
        getUniqueName: jest.fn(name => name),
        isFalseBoolean: value => value === false || value === 'false' || value === '0',
        isTrueBoolean: value => value === true || value === 'true' || value === '1',
        uuidv4: jest.fn(() => `profile-uuid-${++uuidCounter}`),
        waitUntilCondition: jest.fn(async () => {}),
        ...(options.utils ?? {}),
    };

    const openaiMock = {
        chat_completion_sources: {
            OPENAI: 'openai',
            CLAUDE: 'claude',
            CUSTOM: 'custom',
            OPENROUTER: 'openrouter',
        },
        maybeApplyModelSamplingProfile: jest.fn(),
        oai_settings: state.oai_settings,
        get selected_custom_endpoint_preset() { return state.selected_custom_endpoint_preset; },
        syncCustomEndpointPresetSelectionBySecretId: jest.fn(),
        ...(options.openai ?? {}),
    };

    const noticeMock = {
        abandonProfileSwitchReport: jest.fn(),
        beginProfileSwitchReport: jest.fn(payload => ({ ...payload, token: 'report' })),
        clearProfileSwitchOrigin: jest.fn(),
        finishProfileSwitchReport: jest.fn(async () => {}),
        initProfileChangeNotice: jest.fn(),
        markScriptedProfileSwitch: jest.fn(),
        refreshProfileSetsLine: jest.fn(),
        takeProfileSwitchStart: jest.fn(() => ({ origin: 'user', notify: true, previousProfileId: '' })),
        ...(options.notice ?? {}),
    };

    const dialogsMock = {
        adaptProfileDeletion: jest.fn(() => ({ tier: 'dialog' })),
        adaptProfileDetails: jest.fn(),
        adaptProfileFolders: jest.fn(),
        profileDialogOptions: jest.fn((_el, opts = {}) => ({ tier: 'dialog', edit: Boolean(opts.edit) })),
        releaseProfileDialog: jest.fn(),
        ...(options.dialogs ?? {}),
    };

    const sharedMock = {
        ConnectionManagerRequestService: {
            sendRequest: jest.fn(async () => ({ content: '' })),
        },
        getProfileServiceTier: jest.fn(() => ''),
        ...(options.shared ?? {}),
    };

    const i18nMock = {
        t: (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), ''),
        translate: text => text,
    };

    await jest.unstable_mockModule(pub('lib.js'), () => ({
        DOMPurify: { sanitize: value => String(value ?? '') },
        Fuse: class { search() { return []; } },
    }));
    await jest.unstable_mockModule(pub('script.js'), () => scriptMock);
    await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({
        extension_settings: state.extension_settings,
        getContext,
        renderExtensionTemplateAsync,
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/status-page.js'), () => ({
        ensureSpinnerStyles: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
        callGenericPopup,
        Popup: PopupMock,
        POPUP_RESULT: popupResult,
        POPUP_TYPE: popupType,
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-delete-confirm.js'), () => ({
        confirmVerb: jest.fn(async () => true),
    }));
    await jest.unstable_mockModule(pub('scripts/utils.js'), () => utilsMock);
    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => i18nMock);
    await jest.unstable_mockModule(pub('scripts/secrets.js'), () => ({
        getSecretLabelById: jest.fn(id => id ? `Secret(${id})` : ''),
    }));
    await jest.unstable_mockModule(pub('scripts/openai.js'), () => openaiMock);
    await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({
        performFuzzySearch: jest.fn(() => []),
    }));
    await jest.unstable_mockModule(pub('scripts/streaming-display.js'), () => ({
        StreamingDisplay: class {},
    }));
    await jest.unstable_mockModule(pub('scripts/reasoning.js'), () => ({
        formatReasoning: jest.fn(text => text),
    }));
    await jest.unstable_mockModule(pub('scripts/extensions/shared.js'), () => sharedMock);
    await jest.unstable_mockModule(pub('scripts/extensions/connection-manager/profile-change-notice.js'), () => noticeMock);
    if (options.useRealDialogs !== true) {
        await jest.unstable_mockModule(pub('scripts/extensions/connection-manager/sillybunny-dialogs.js'), () => dialogsMock);
    }

    const enumProxy = new Proxy({ boolean: () => () => ['true', 'false'] }, {
        get: (target, prop) => target[prop] ?? jest.fn(() => []),
    });
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommand.js'), () => ({
        SlashCommand: { fromProps: jest.fn(props => props) },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandAbortController.js'), () => ({
        SlashCommandAbortController: class {},
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandArgument.js'), () => {
        class MockSlashCommandArgument {
            constructor(description, typeList, isRequired, acceptsMultiple, defaultValue, enumList) {
                Object.assign(this, { description, typeList, isRequired, acceptsMultiple, defaultValue, enumList });
            }
            static fromProps(props) { return props; }
        }
        class MockSlashCommandNamedArgument {
            constructor(name, description, typeList, isRequired, acceptsMultiple, defaultValue, enumList) {
                Object.assign(this, { name, description, typeList, isRequired, acceptsMultiple, defaultValue, enumList });
            }
            static fromProps(props) { return props; }
        }
        return {
            ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', LIST: 'list', CLOSURE: 'closure' },
            SlashCommandArgument: MockSlashCommandArgument,
            SlashCommandNamedArgument: MockSlashCommandNamedArgument,
        };
    });
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandCommonEnumsProvider.js'), () => ({
        commonEnumProviders: enumProxy,
        enumIcons: new Proxy({}, { get: () => '' }),
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandDebugController.js'), () => ({
        SlashCommandDebugController: class {},
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({
        SlashCommandEnumValue: class { constructor(value) { this.value = value; } },
        enumTypes: { enum: 'enum', name: 'name', command: 'command' },
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandClosure.js'), () => ({
        SlashCommandClosure: class {},
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParser.js'), () => ({
        SlashCommandParser,
    }));
    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandScope.js'), () => ({
        SlashCommandScope: class {},
    }));

    const connectionManager = await import('../../public/scripts/extensions/connection-manager/index.js');
    if (options.autoInit !== false) {
        await connectionManager.init();
    }

    return {
        connectionManager,
        $,
        state,
        eventSource,
        event_types,
        commandLog,
        commands,
        addedCommands,
        popupCalls,
        mocks: {
            script: scriptMock,
            utils: utilsMock,
            openai: openaiMock,
            notice: noticeMock,
            dialogs: dialogsMock,
            shared: sharedMock,
            toastr,
            Popup: PopupMock,
            callGenericPopup,
            renderExtensionTemplateAsync,
        },
    };
}
