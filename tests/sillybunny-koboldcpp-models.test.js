/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const API = '/api/backends/text-completions/koboldcpp';
const SERVER_URL = 'http://127.0.0.1:5001';
const ACTIONS = ['initial_model', 'unload_model'];
const OLD_WORKER = { online: true, uptime: 3600 };
const NEW_WORKER = { online: true, uptime: 1 };

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.classList = { add: () => {}, toggle: () => {}, contains: () => false };
    }

    append(...children) {
        this.children.push(...children);
    }

    replaceChildren(...children) {
        this.children = children;
    }

    addEventListener() {}

    querySelectorAll() {
        return [];
    }
}

class FakeSelect extends FakeElement {
    value = '';
}

class FakeOption {
    constructor(text, value) {
        this.text = text;
        this.value = value;
    }
}

let clock;
let settings;
let statusCheck;
let script;
let servers;
let dom;
let toasts;
let command;
let popupResult;

/**
 * @param {string[]} names Option strings in the order the server sorts them
 * @param {{ admin?: number, loadedModel?: string|null, loadedFiles?: string[] }} [options] Admin mode and loaded model
 * @returns {object} Answer of the /models route
 */
function modelsAnswer(names, { admin = 1, loadedModel = null, loadedFiles = [] } = {}) {
    return {
        admin,
        entries: names.map(name => ({
            name,
            type: ACTIONS.includes(name) ? 'action' : /\.kcpp[st]$/i.test(name) ? 'config' : 'model',
        })),
        loadedModel,
        loadedFile: loadedFiles.length === 1 ? loadedFiles[0] : null,
        loadedFiles,
    };
}

/**
 * @param {object|null} state Answer of the /models route, or null when KoboldCpp cannot be reached
 */
function createServer(state) {
    return {
        state,
        loadResult: { success: true },
        uptimes: [OLD_WORKER],
        onPoll: null,
        loads: [],
        polls: 0,
    };
}

async function fakeFetch(url, options) {
    const route = String(url).slice(API.length + 1);
    const body = JSON.parse(options.body);
    const server = servers[body.api_server];
    if (options.signal?.aborted) {
        throw options.signal.reason;
    }

    let reply;
    if (route === 'models') {
        reply = server?.state ? { json: server.state } : { status: 502, json: { error: true } };
    } else if (route === 'load') {
        server.loads.push(body.filename);
        reply = typeof server.loadResult === 'number' ? { status: server.loadResult, json: { error: true } } : { json: server.loadResult };
    } else if (route === 'uptime') {
        server.polls++;
        server.onPoll?.(server.polls);
        reply = { json: server.uptimes.length > 1 ? server.uptimes.shift() : server.uptimes[0] };
    } else {
        throw new Error(`Unexpected request to ${url}`);
    }

    if (options.signal?.aborted) {
        throw options.signal.reason;
    }
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } });
}

function fakeJquery(target) {
    const wrapper = {
        on: (event, handler) => {
            if (target === '#koboldcpp_model' && event === 'change') {
                dom.onChange = handler;
            }
            return wrapper;
        },
        trigger: () => wrapper,
        val: () => dom.select.value,
        text: value => {
            if (target === '#koboldcpp_model_hint') {
                dom.hint = value;
            }
            return wrapper;
        },
        parent: () => wrapper,
        toggleClass: (className, isHidden) => {
            if (target === '#koboldcpp_model_hint') {
                dom.hintShown = !isHidden;
            }
            return wrapper;
        },
    };
    return wrapper;
}

/**
 * Imports the switcher with its dependencies mocked, as SillyBunny starts it.
 * @param {{ mainApi?: string, onlineStatus?: string, isSendPress?: boolean }} [options] Values that script.js exports
 */
async function loadSwitcher({ mainApi = 'textgenerationwebui', onlineStatus = 'koboldcpp/alpha', isSendPress = false } = {}) {
    jest.resetModules();
    const eventHandlers = {};
    await jest.unstable_mockModule('../public/script.js', () => ({
        abortStatusCheck: statusCheck,
        eventSource: { on: (name, handler) => { eventHandlers[name] = handler; } },
        event_types: { ONLINE_STATUS_CHANGED: 'online_status_changed' },
        getRequestHeaders: () => ({}),
        is_send_press: isSendPress,
        main_api: mainApi,
        online_status: onlineStatus,
        resultCheckStatus: script.resultCheckStatus,
        setOnlineStatus: script.setOnlineStatus,
        startStatusLoading: script.startStatusLoading,
        stopStatusLoading: script.stopStatusLoading,
    }));
    await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
        t: (strings, ...values) => String.raw({ raw: strings }, ...values),
    }));
    await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
        POPUP_TYPE: { TEXT: 1 },
        Popup: class {
            async show() {
                return popupResult;
            }

            complete() {}
        },
    }));
    await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommand.js', () => ({
        SlashCommand: { fromProps: props => props },
    }));
    await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
        ARGUMENT_TYPE: { STRING: 'string' },
        SlashCommandArgument: { fromProps: props => props },
    }));
    await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
        SlashCommandEnumValue: class {
            constructor(value, description) {
                this.value = value;
                this.description = description;
            }
        },
    }));
    await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandParser.js', () => ({
        SlashCommandParser: { addCommandObject: props => { command = props; } },
    }));
    await jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
        getStatusTextgen: script.getStatusTextgen,
        getTextGenServer: type => settings.server_urls[type ?? settings.type] ?? '',
        textgen_types: { KOBOLDCPP: 'koboldcpp', LLAMACPP: 'llamacpp' },
        textgenerationwebui_settings: settings,
    }));
    await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
        delay: async ms => {
            clock += ms;
        },
    }));

    const switcher = await import('../public/scripts/sillybunny-koboldcpp-models.js');
    switcher.initKoboldCppModels();
    return { ...switcher, onOnlineStatusChanged: eventHandlers.online_status_changed };
}

/**
 * @param {string} value Unnamed argument of /kcpp-model
 * @param {object} [args] Named arguments
 * @returns {Promise<string>} What the command returns
 */
function runCommand(value, args = {}) {
    return command.callback(args, value);
}

beforeEach(() => {
    clock = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    settings = { type: 'koboldcpp', server_urls: { koboldcpp: SERVER_URL } };
    statusCheck = new AbortController();
    popupResult = null;
    command = null;
    script = {
        getStatusTextgen: jest.fn(async () => {}),
        resultCheckStatus: jest.fn(),
        setOnlineStatus: jest.fn(),
        startStatusLoading: jest.fn(),
        stopStatusLoading: jest.fn(),
    };
    servers = {
        [SERVER_URL]: createServer(modelsAnswer(['alpha.gguf', 'beta.gguf', ...ACTIONS], { loadedModel: 'koboldcpp/alpha', loadedFiles: ['alpha.gguf'] })),
    };
    dom = { select: new FakeSelect('select'), hint: '', hintShown: false, onChange: null };
    globalThis.HTMLSelectElement = FakeSelect;
    globalThis.Option = FakeOption;
    globalThis.document = {
        getElementById: id => (id === 'koboldcpp_model' ? dom.select : null),
        createElement: tagName => new FakeElement(tagName),
    };
    globalThis.$ = fakeJquery;
    toasts = { info: jest.fn(() => ({})), success: jest.fn(), warning: jest.fn(), error: jest.fn(), clear: jest.fn() };
    globalThis.toastr = toasts;
    globalThis.fetch = jest.fn(fakeFetch);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('/kcpp-model names', () => {
    test('loads the entry whose full name is the argument when another entry has that file name', async () => {
        const server = servers[SERVER_URL];
        server.state = modelsAnswer(['a\\zeta.gguf', 'zeta.gguf', ...ACTIONS]);
        server.uptimes = [NEW_WORKER];
        await loadSwitcher();

        await runCommand('zeta.gguf');

        expect(server.loads).toEqual(['zeta.gguf']);
    });

    test('refuses a name that several entries share and says how many match', async () => {
        const server = servers[SERVER_URL];
        server.state = modelsAnswer(['Mistral-Small.gguf', 'Mistral-Small.kcpps', ...ACTIONS]);
        await loadSwitcher();

        await expect(runCommand('Mistral-Small')).resolves.toBe('');

        expect(server.loads).toEqual([]);
        expect(toasts.warning).toHaveBeenCalledWith('2 KoboldCpp files match "Mistral-Small". Use a longer part of the name.', 'KoboldCpp');
    });

    test('accepts a file name, a stem or a label that one entry has, in any letter case', async () => {
        const server = servers[SERVER_URL];
        server.state = modelsAnswer(['Mistral-Small.gguf', 'sub\\Qwen3-8B.Q4_K_M.gguf', 'Mistral-Small.kcpps', ...ACTIONS]);
        server.uptimes = [NEW_WORKER];
        await loadSwitcher();

        for (const query of ['qwen3-8b.q4_k_m.gguf', 'QWEN3-8B.Q4_K_M', 'mistral-small.kcpps', 'unload model']) {
            await runCommand(query);
        }

        expect(server.loads).toEqual(['sub\\Qwen3-8B.Q4_K_M.gguf', 'sub\\Qwen3-8B.Q4_K_M.gguf', 'Mistral-Small.kcpps', 'unload_model']);
    });

    test('accepts a part of a name only when one entry contains it', async () => {
        const server = servers[SERVER_URL];
        server.state = modelsAnswer(['Mistral-Small.gguf', 'Mistral-Small.kcpps', ...ACTIONS]);
        server.uptimes = [NEW_WORKER];
        await loadSwitcher();

        await expect(runCommand('mistral')).resolves.toBe('');
        await expect(runCommand('llama')).resolves.toBe('');
        await runCommand('kcpps');

        expect(server.loads).toEqual(['Mistral-Small.kcpps']);
        expect(toasts.warning.mock.calls.map(([message]) => message)).toEqual([
            '2 KoboldCpp files match "mistral". Use a longer part of the name.',
            'No KoboldCpp file matches "llama".',
        ]);
    });
});
