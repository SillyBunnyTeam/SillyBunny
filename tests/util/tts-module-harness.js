/* global globalThis */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';
import { SimpleMutex } from '../../public/scripts/util/SimpleMutex.js';

const pub = rel => fileURLToPath(new URL(`../../public/${rel}`, import.meta.url));
const jquerySource = readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');
const ttsSettingsHtml = readFileSync(pub('scripts/extensions/tts/settings.html'), 'utf8');

const BUILTIN_PROVIDER_MODULES = [
    ['edge.js', 'EdgeTtsProvider'],
    ['elevenlabs.js', 'ElevenLabsTtsProvider'],
    ['silerotts.js', 'SileroTtsProvider'],
    ['gpt-sovits-v2.js', 'GptSovitsV2Provider'],
    ['gpt-sovits-adapter.js', 'GptSoVITSAdapterProvider'],
    ['coqui.js', 'CoquiTtsProvider'],
    ['system.js', 'SystemTtsProvider'],
    ['novel.js', 'NovelTtsProvider'],
    ['openai.js', 'OpenAITtsProvider'],
    ['openai-compatible.js', 'OpenAICompatibleTtsProvider'],
    ['xtts.js', 'XTTSTtsProvider'],
    ['vits.js', 'VITSTtsProvider'],
    ['gsvi.js', 'GSVITtsProvider'],
    ['sbvits2.js', 'SBVits2TtsProvider'],
    ['alltalk.js', 'AllTalkTtsProvider'],
    ['cosyvoice.js', 'CosyVoiceProvider'],
    ['speecht5.js', 'SpeechT5TtsProvider'],
    ['azure.js', 'AzureTtsProvider'],
    ['google-translate.js', 'GoogleTranslateTtsProvider'],
    ['google-native.js', 'GoogleNativeTtsProvider'],
    ['chatterbox.js', 'ChatterboxTtsProvider'],
    ['kokoro.js', 'KokoroTtsProvider'],
    ['tts-webui.js', 'TtsWebuiProvider'],
    ['pollinations.js', 'PollinationsTtsProvider'],
    ['minimax.js', 'MiniMaxTtsProvider'],
    ['electronhub.js', 'ElectronHubTtsProvider'],
    ['chutes.js', 'ChutesTtsProvider'],
    ['volcengine.js', 'VolcengineTtsProvider'],
];

function createStubProviderClass(name) {
    return class StubTtsProvider {
        constructor() {
            this.settings = {};
            this.settingsHtml = `<div data-stub-provider="${name}"></div>`;
            this.separator = ' ... ';
        }
        async loadSettings(settings) {
            this.settings = settings || {};
        }
        async checkReady() {}
        async fetchTtsVoiceObjects() {
            return [{ name: 'Default Stub Voice', voice_id: 'stub-voice-1', lang: 'en-US' }];
        }
        async getVoice(voiceName) {
            return { name: voiceName, voice_id: voiceName };
        }
        async generateTts() {
            return 'data:audio/wav;base64,';
        }
        async onRefreshClick() {}
        previewTtsVoice() {}
    };
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
        makeFirst: jest.fn((event, handler) => {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).unshift(handler);
        }),
        emit: jest.fn(async (event, ...args) => {
            const handlers = [...(listeners.get(event) || [])];
            for (const handler of handlers) {
                await handler(...args);
            }
        }),
    };
}

function createModuleWorkerWrapperClass() {
    return class ModuleWorkerWrapper {
        constructor(callback) {
            this.mutex = new SimpleMutex(callback);
        }
        async update(...args) {
            return this.mutex.update(...args);
        }
    };
}

function ensureJQuery() {
    if (typeof window.$ !== 'function') {
        (0, eval)(jquerySource);
    }
    globalThis.$ = window.$;
    globalThis.jQuery = window.jQuery;
}

function createFakeAudioConstructor() {
    return class FakeAudio {
        constructor() {
            const el = document.createElement('audio');
            Object.defineProperty(el, 'play', {
                configurable: true,
                value: jest.fn(() => Promise.resolve()),
            });
            Object.defineProperty(el, 'pause', {
                configurable: true,
                value: jest.fn(),
            });
            Object.defineProperty(el, 'load', {
                configurable: true,
                value: jest.fn(),
            });
            return el;
        }
    };
}

export async function loadTtsModule(options = {}) {
    jest.resetModules();
    ensureJQuery();

    document.body.className = options.initialBodyClass || '';
    document.body.innerHTML = `
        <div id="tts_container"></div>
        <div id="tts_wand_container"></div>
    `;
    delete window._ttsExtensionInitialized;

    const trackedIntervals = [];
    const originalSetInterval = globalThis.setInterval;
    const originalAudio = globalThis.Audio;

    // Track intervals created by TTS init so cleanup never leaks Jest open handles.
    globalThis.setInterval = (...args) => {
        const id = originalSetInterval(...args);
        trackedIntervals.push(id);
        return id;
    };
    globalThis.Audio = createFakeAudioConstructor();

    const toastr = {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        success: jest.fn(),
    };
    globalThis.toastr = toastr;

    const eventSource = createEventSource();
    const event_types = {
        MESSAGE_SWIPED: 'message_swiped',
        CHAT_CHANGED: 'chat_changed',
        MESSAGE_DELETED: 'message_deleted',
        GROUP_UPDATED: 'group_updated',
        GENERATION_STARTED: 'generation_started',
        GENERATION_ENDED: 'generation_ended',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
        USER_MESSAGE_RENDERED: 'user_message_rendered',
        TTS_JOB_STARTED: 'tts_job_started',
        TTS_AUDIO_READY: 'tts_audio_ready',
        TTS_JOB_COMPLETE: 'tts_job_complete',
    };

    const state = {
        chatId: options.chatId ?? 'chat-1',
        name1: options.name1 ?? 'User',
        name2: options.name2 ?? 'Mona',
        characters: options.characters ?? [{ name: 'Mona' }],
        groupId: options.groupId ?? null,
        characterId: options.characterId ?? 0,
        chat: options.chat ?? [],
        streamingEnabled: options.streamingEnabled ?? false,
    };

    const extension_settings = {
        tts: options.ttsSettings ? { ...options.ttsSettings } : {},
        rvc: { enabled: false },
        vrm: { enabled: false },
        ...(options.extensionSettings || {}),
    };

    const power_user = {
        allow_name2_display: false,
        ...(options.powerUser || {}),
    };

    const storageMap = new Map();
    const accountStorage = {
        getItem: jest.fn(key => storageMap.get(key) ?? null),
        setItem: jest.fn((key, value) => { storageMap.set(key, String(value)); }),
        removeItem: jest.fn(key => { storageMap.delete(key); }),
    };

    const cancelTtsPlay = jest.fn();
    const saveSettingsDebounced = jest.fn();
    const substituteParams = jest.fn(text => text);
    const callGenericPopup = jest.fn(async () => 1);
    const releaseRowIds = jest.fn();
    const slashCommands = new Map();

    const renderExtensionTemplateAsync = options.renderExtensionTemplateAsync
        || jest.fn(async () => ttsSettingsHtml);

    const getContext = jest.fn(() => ({
        characters: state.characters,
        groupId: state.groupId,
        characterId: state.characterId,
        chatId: state.chatId,
        chat: state.chat,
        name1: state.name1,
        name2: state.name2,
    }));

    const providerOverrides = options.providers || {};

    await jest.unstable_mockModule(pub('script.js'), () => ({
        cancelTtsPlay,
        eventSource,
        event_types,
        getCurrentChatId: () => state.chatId,
        getRequestHeaders: jest.fn(() => ({})),
        isStreamingEnabled: () => state.streamingEnabled,
        get name2() { return state.name2; },
        saveSettingsDebounced,
        substituteParams,
    }));

    await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({
        ModuleWorkerWrapper: createModuleWorkerWrapperClass(),
        extension_settings,
        getContext,
        renderExtensionTemplateAsync,
    }));

    await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
        delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
        escapeRegex: text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        getBase64Async: jest.fn(async () => 'data:audio/wav;base64,'),
        getStringHash: text => {
            let hash = 0;
            const value = String(text ?? '');
            for (let i = 0; i < value.length; i++) {
                hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
            }
            return hash;
        },
        onlyUnique: (value, index, array) => array.indexOf(value) === index,
        regexFromString: input => {
            try {
                const match = String(input).match(/^\/(.*)\/([a-z]*)$/);
                return match ? new RegExp(match[1], match[2]) : new RegExp(input);
            } catch {
                return null;
            }
        },
    }));

    await jest.unstable_mockModule(pub('scripts/util/AccountStorage.js'), () => ({
        accountStorage,
    }));

    await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({
        power_user,
    }));

    await jest.unstable_mockModule(pub('scripts/constants.js'), () => ({
        debounce_timeout: { relaxed: 10 },
    }));

    await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2 },
        callGenericPopup,
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
        ARGUMENT_TYPE: { STRING: 'string' },
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
        enumTypes: { enum: 'enum' },
    }));

    await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandCommonEnumsProvider.js'), () => ({
        enumIcons: { voice: 'voice' },
    }));

    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
        applyLocale: html => html,
        t: (strings, ...values) => strings.reduce((acc, part, idx) => acc + part + (values[idx] ?? ''), ''),
    }));

    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/rows.js'), () => ({
        createButtonRow: ({ label, field, onActivate }) => {
            const row = document.createElement('div');
            row.className = 'ds-row';
            row.dataset.field = field;
            const labelEl = document.createElement('span');
            labelEl.className = 'ds-row-label';
            labelEl.textContent = label;
            const button = document.createElement('button');
            button.type = 'button';
            button.addEventListener('click', () => onActivate?.());
            row.append(labelEl, button);
            return { row, button };
        },
        createPrefGroup: ({ field, rows }) => {
            const section = document.createElement('section');
            section.dataset.field = field;
            for (const entry of rows) {
                section.append(entry.row);
            }
            return { section };
        },
        releaseRowIds,
    }));

    const skipProviders = new Set(options.skipProviders || []);
    for (const [file, exportName] of BUILTIN_PROVIDER_MODULES) {
        if (skipProviders.has(file)) continue;
        const ProviderClass = providerOverrides[exportName] || createStubProviderClass(exportName);
        await jest.unstable_mockModule(pub(`scripts/extensions/tts/${file}`), () => ({
            [exportName]: ProviderClass,
        }));
    }

    const ttsModule = await import(pub('scripts/extensions/tts/index.js'));

    const cleanup = () => {
        try {
            ttsModule.deactivate();
        } catch {
            // Ignore cleanup errors when audio element or DOM was already torn down.
        }
        for (const id of trackedIntervals) {
            clearInterval(id);
        }
        trackedIntervals.length = 0;
        globalThis.setInterval = originalSetInterval;
        globalThis.Audio = originalAudio;
        delete window._ttsExtensionInitialized;
        delete globalThis.toastr;
        delete globalThis.playFullConversation;
        delete globalThis.debugTtsPlayback;
        delete globalThis.tts_preview;
    };

    return {
        ttsModule,
        state,
        extension_settings,
        power_user,
        eventSource,
        event_types,
        cancelTtsPlay,
        saveSettingsDebounced,
        callGenericPopup,
        releaseRowIds,
        slashCommands,
        toastr,
        renderExtensionTemplateAsync,
        cleanup,
    };
}
