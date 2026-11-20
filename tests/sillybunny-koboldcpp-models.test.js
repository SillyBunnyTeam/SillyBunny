/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import vm from 'node:vm';
import { loadDeclarations } from './util/load-declarations.js';

const API = '/api/backends/text-completions/koboldcpp';
const SERVER_URL = 'http://127.0.0.1:5001';
const NEW_SERVER_URL = 'http://127.0.0.1:5002';
const ACTIONS = ['initial_model', 'unload_model'];
const STOPPED_WAITING = 'Stopped waiting for KoboldCpp. Click Connect when it has finished loading.';
const OLD_WORKER = { online: true, uptime: 3600 };
const NEW_WORKER = { online: true, uptime: 1 };

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.classList = { add: () => {}, toggle: () => {}, contains: () => false };
        this.attributes = {};
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    getAttribute(name) {
        return this.attributes[name] ?? null;
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
let popupContent;

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
        nextState: null,
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
        if (server.nextState && server.loadResult?.success) {
            server.state = server.nextState;
        }
    } else if (route === 'uptime') {
        server.polls++;
        await server.onPoll?.(server.polls);
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
            constructor(content) {
                popupContent = content;
            }

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
    // The real startStatusLoading() in script.js calls this hook.
    script.startStatusLoading.mockImplementation(switcher.countStatusLoadingStart);
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

function getDropdown() {
    const options = dom.select.children.flatMap(child => child instanceof FakeOption ? [child] : child.children);
    return {
        labels: options.map(option => option.text),
        values: options.map(option => option.value),
        value: dom.select.value,
        hint: dom.hintShown ? dom.hint : '',
    };
}

/**
 * Lets work that the switcher starts without awaiting it finish.
 */
async function settle() {
    for (let turn = 0; turn < 10; turn++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

beforeEach(() => {
    clock = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    settings = { type: 'koboldcpp', server_urls: { koboldcpp: SERVER_URL } };
    statusCheck = new AbortController();
    popupResult = null;
    popupContent = null;
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
        server.state = modelsAnswer(['Mistral-Small.gguf', 'Mistral-Small.kcpps', ...ACTIONS], { loadedModel: 'koboldcpp/Mistral-Small', loadedFiles: ['Mistral-Small.gguf'] });
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

describe('restart check', () => {
    test('takes only a worker that started after the load request as the restart', async () => {
        const server = servers[SERVER_URL];
        server.nextState = modelsAnswer(['alpha.gguf', 'beta.gguf', ...ACTIONS], { loadedModel: 'koboldcpp/beta', loadedFiles: ['beta.gguf'] });
        server.uptimes = [OLD_WORKER, OLD_WORKER, NEW_WORKER];
        await loadSwitcher();

        await expect(runCommand('beta.gguf')).resolves.toBe('beta.gguf');

        expect(server.polls).toBe(3);
        expect(script.setOnlineStatus).toHaveBeenCalledWith('no_connection');
        expect(script.getStatusTextgen).toHaveBeenCalledTimes(1);
        expect(getDropdown().value).toBe('beta.gguf');
    });

    test('without an uptime, takes a return after an offline poll as the restart', async () => {
        const server = servers[SERVER_URL];
        server.nextState = modelsAnswer(['alpha.gguf', 'beta.gguf', ...ACTIONS], { loadedModel: 'koboldcpp/beta', loadedFiles: ['beta.gguf'] });
        server.uptimes = [{ online: true, uptime: null }, { online: false, uptime: null }, { online: true, uptime: null }];
        await loadSwitcher();

        await expect(runCommand('beta.gguf')).resolves.toBe('beta.gguf');

        expect(server.polls).toBe(3);
    });

    test('gives up after the switch timeout when KoboldCpp never shows a restart', async () => {
        const server = servers[SERVER_URL];
        server.uptimes = [{ online: true, uptime: null }];
        await loadSwitcher();

        await expect(runCommand('beta.gguf')).resolves.toBe('');

        expect(server.polls).toBe(15 * 60 * 1000 / 2000);
        expect(toasts.warning).toHaveBeenCalledWith('KoboldCpp did not come back within 15 minutes. Check the KoboldCpp console, then click Connect.', 'KoboldCpp');
        expect(script.resultCheckStatus).toHaveBeenCalledTimes(1);
        expect(script.getStatusTextgen).not.toHaveBeenCalled();
        expect(getDropdown().labels).toEqual(['-- Connect to the API --']);
    });
});

describe('end of the restart wait', () => {
    test('an abort while KoboldCpp stays selected, from the Cancel button or a deleted API key, stops the wait and enables Connect again', async () => {
        const server = servers[SERVER_URL];
        server.onPoll = () => statusCheck.abort();
        await loadSwitcher();

        await expect(runCommand('beta.gguf')).resolves.toBe('');

        expect(server.polls).toBe(1);
        expect(script.startStatusLoading).toHaveBeenCalledTimes(1);
        expect(script.stopStatusLoading).toHaveBeenCalledTimes(1);
        expect(script.resultCheckStatus).not.toHaveBeenCalled();
        expect(toasts.info).toHaveBeenLastCalledWith(STOPPED_WAITING, 'KoboldCpp');
        expect(getDropdown().labels).toEqual(['-- Connect to the API --']);
    });

    test('a change of the main API or the Text Completion type stops the wait and enables Connect again', async () => {
        const server = servers[SERVER_URL];
        server.onPoll = () => {
            statusCheck.abort();
            settings.type = 'llamacpp';
        };
        await loadSwitcher();

        await expect(runCommand('beta.gguf')).resolves.toBe('');

        expect(server.polls).toBe(1);
        expect(script.stopStatusLoading).toHaveBeenCalledTimes(1);
        expect(script.resultCheckStatus).not.toHaveBeenCalled();
        expect(toasts.info).toHaveBeenLastCalledWith(STOPPED_WAITING, 'KoboldCpp');
    });

    test('a status check that starts during the wait, such as the Connect click of a type change, ends the loading state itself', async () => {
        const server = servers[SERVER_URL];
        server.onPoll = () => {
            statusCheck.abort();
            settings.type = 'llamacpp';
            script.startStatusLoading();
        };
        await loadSwitcher();

        await expect(runCommand('beta.gguf')).resolves.toBe('');

        expect(server.polls).toBe(1);
        expect(script.startStatusLoading).toHaveBeenCalledTimes(2);
        expect(script.stopStatusLoading).not.toHaveBeenCalled();
        expect(script.resultCheckStatus).not.toHaveBeenCalled();
        expect(toasts.info).toHaveBeenLastCalledWith(STOPPED_WAITING, 'KoboldCpp');
    });

    test('a status check that starts during the wait keeps the loading state when the wait times out', async () => {
        const server = servers[SERVER_URL];
        server.uptimes = [{ online: true, uptime: null }];
        server.onPoll = poll => {
            if (poll === 1) {
                script.startStatusLoading();
            }
        };
        await loadSwitcher();

        await expect(runCommand('beta.gguf')).resolves.toBe('');

        expect(server.polls).toBe(15 * 60 * 1000 / 2000);
        expect(script.stopStatusLoading).not.toHaveBeenCalled();
        expect(script.resultCheckStatus).not.toHaveBeenCalled();
    });

    test('a new KoboldCpp URL stops the wait on the old server, enables Connect and lists the new server', async () => {
        const server = servers[SERVER_URL];
        servers[NEW_SERVER_URL] = createServer(modelsAnswer(['gamma.gguf', ...ACTIONS], { loadedModel: 'koboldcpp/gamma', loadedFiles: ['gamma.gguf'] }));
        let switcher;
        server.onPoll = () => {
            settings.server_urls.koboldcpp = NEW_SERVER_URL;
            // The status check for the new URL can finish before the wait sees the change.
            void switcher.refreshKoboldCppModels();
        };
        switcher = await loadSwitcher();

        await expect(runCommand('beta.gguf')).resolves.toBe('');
        await settle();

        expect(server.polls).toBe(1);
        expect(script.stopStatusLoading).toHaveBeenCalledTimes(1);
        expect(toasts.info).toHaveBeenLastCalledWith(STOPPED_WAITING, 'KoboldCpp');
        expect(getDropdown()).toMatchObject({ values: ['gamma.gguf', ...ACTIONS], value: 'gamma.gguf' });
    });

    test('Connect right after Cancel lists the loaded model once the wait ends', async () => {
        const server = servers[SERVER_URL];
        server.nextState = modelsAnswer(['alpha.gguf', 'beta.gguf', ...ACTIONS], { loadedModel: 'koboldcpp/beta', loadedFiles: ['beta.gguf'] });
        let switcher;
        server.onPoll = () => {
            // The status check of the Connect click can answer before the wait sees the abort.
            statusCheck.abort();
            script.startStatusLoading();
            void switcher.refreshKoboldCppModels();
        };
        switcher = await loadSwitcher();

        await expect(runCommand('beta.gguf')).resolves.toBe('');
        await settle();

        expect(toasts.info).toHaveBeenLastCalledWith(STOPPED_WAITING, 'KoboldCpp');
        expect(getDropdown()).toMatchObject({ values: ['alpha.gguf', 'beta.gguf', ...ACTIONS], value: 'beta.gguf' });
    });

    test('a status check that answers during the wait lists the loaded model when the wait times out', async () => {
        const server = servers[SERVER_URL];
        server.nextState = modelsAnswer(['alpha.gguf', 'beta.gguf', ...ACTIONS], { loadedModel: 'koboldcpp/beta', loadedFiles: ['beta.gguf'] });
        server.uptimes = [{ online: true, uptime: null }];
        let switcher;
        server.onPoll = poll => {
            if (poll === 1) {
                script.startStatusLoading();
                void switcher.refreshKoboldCppModels();
            }
        };
        switcher = await loadSwitcher();

        await expect(runCommand('beta.gguf')).resolves.toBe('');
        await settle();

        expect(getDropdown()).toMatchObject({ values: ['alpha.gguf', 'beta.gguf', ...ACTIONS], value: 'beta.gguf' });
    });

    test('stopping the script stops the wait while another API is active', async () => {
        const server = servers[SERVER_URL];
        const scriptAbort = { signal: { aborted: false } };
        server.onPoll = () => {
            scriptAbort.signal.aborted = true;
        };
        await loadSwitcher({ mainApi: 'openai' });

        await expect(runCommand('beta.gguf', { _abortController: scriptAbort })).resolves.toBe('');

        expect(server.polls).toBe(1);
        expect(script.startStatusLoading).not.toHaveBeenCalled();
        expect(script.stopStatusLoading).not.toHaveBeenCalled();
        expect(toasts.info).toHaveBeenLastCalledWith(STOPPED_WAITING, 'KoboldCpp');
        expect(getDropdown().labels).toEqual(['-- Connect to the API --']);
    });

    test('stopping the script stops the wait and enables Connect again while KoboldCpp is active', async () => {
        const server = servers[SERVER_URL];
        const scriptAbort = { signal: { aborted: false } };
        server.onPoll = () => {
            scriptAbort.signal.aborted = true;
        };
        await loadSwitcher();

        await expect(runCommand('beta.gguf', { _abortController: scriptAbort })).resolves.toBe('');

        expect(server.polls).toBe(1);
        expect(script.stopStatusLoading).toHaveBeenCalledTimes(1);
        expect(script.resultCheckStatus).not.toHaveBeenCalled();
        expect(toasts.info).toHaveBeenLastCalledWith(STOPPED_WAITING, 'KoboldCpp');
    });
});

describe('report after the restart', () => {
    const NAMES = ['alpha.gguf', 'beta.gguf', 'gamma.kcpps', 'delta.kcppt', ...ACTIONS];
    const NO_MODEL = 'KoboldCpp restarted without a model. Check the KoboldCpp console for load errors.';
    const MODEL_UNKNOWN = 'KoboldCpp restarted, but SillyBunny could not read which model it loaded. Click Connect to check.';

    test.each([
        ['a model that loaded', 'beta.gguf', { loadedModel: 'koboldcpp/beta', loadedFiles: ['beta.gguf'] }, 'success', 'Loaded beta.gguf.', 'beta.gguf'],
        ['a model when KoboldCpp came back with another model', 'beta.gguf', { loadedModel: 'koboldcpp/alpha', loadedFiles: ['alpha.gguf'] }, 'warning', 'KoboldCpp restarted with alpha.gguf instead of beta.gguf. Check the KoboldCpp console for load errors.', ''],
        ['a model when KoboldCpp came back without a model', 'beta.gguf', { loadedModel: 'inactive' }, 'warning', 'KoboldCpp restarted without a model instead of loading beta.gguf. Check the KoboldCpp console for load errors.', ''],
        ['an unload that worked', 'unload_model', { loadedModel: 'inactive' }, 'success', 'Model unloaded.', 'unload_model'],
        ['an unload when the model stayed loaded', 'unload_model', { loadedModel: 'koboldcpp/alpha', loadedFiles: ['alpha.gguf'] }, 'warning', 'KoboldCpp restarted with alpha.gguf still loaded.', ''],
        ['a reload of the launch model with the model KoboldCpp reports', 'initial_model', { loadedModel: 'koboldcpp/alpha', loadedFiles: ['alpha.gguf'] }, 'success', 'KoboldCpp restarted with alpha.', 'initial_model'],
        ['a reload of the launch model when KoboldCpp came back without a model', 'initial_model', { loadedModel: 'inactive' }, 'warning', NO_MODEL, ''],
        ['a config with the model KoboldCpp reports', 'gamma.kcpps', { loadedModel: 'koboldcpp/beta', loadedFiles: ['beta.gguf'] }, 'success', 'KoboldCpp restarted with beta.', 'gamma.kcpps'],
        ['a config when KoboldCpp came back without a model', 'delta.kcppt', { loadedModel: 'inactive' }, 'warning', NO_MODEL, ''],
        ['a config when KoboldCpp did not report a model', 'gamma.kcpps', { loadedModel: null }, 'warning', MODEL_UNKNOWN, 'gamma.kcpps'],
    ])('reports %s', async (_case, name, loaded, type, message, result) => {
        const server = servers[SERVER_URL];
        server.state = modelsAnswer(NAMES, { loadedModel: 'koboldcpp/alpha', loadedFiles: ['alpha.gguf'] });
        server.nextState = modelsAnswer(NAMES, loaded);
        server.uptimes = [NEW_WORKER];
        await loadSwitcher();

        await expect(runCommand(name)).resolves.toBe(result);

        expect(toasts[type].mock.calls.map(([text]) => text)).toEqual([message]);
    });

    test.each(['beta.gguf', 'unload_model', 'gamma.kcpps', 'initial_model'])('reports that the model is unknown when KoboldCpp cannot be read after a restart for %s', async name => {
        const server = servers[SERVER_URL];
        server.state = modelsAnswer(NAMES, { loadedModel: 'koboldcpp/alpha', loadedFiles: ['alpha.gguf'] });
        server.uptimes = [NEW_WORKER];
        server.onPoll = () => {
            server.state = null;
        };
        await loadSwitcher();

        await expect(runCommand(name)).resolves.toBe(name);

        expect(toasts.success).not.toHaveBeenCalled();
        expect(toasts.warning.mock.calls.map(([text]) => text)).toEqual([MODEL_UNKNOWN]);
    });

    test('accepts the loaded file when another file gives KoboldCpp the same model name', async () => {
        const server = servers[SERVER_URL];
        server.state = modelsAnswer(['a/model.gguf', 'b/model.gguf', ...ACTIONS], { loadedModel: 'koboldcpp/model', loadedFiles: ['a/model.gguf', 'b/model.gguf'] });
        server.nextState = server.state;
        server.uptimes = [NEW_WORKER];
        await loadSwitcher();

        await expect(runCommand('b/model.gguf')).resolves.toBe('b/model.gguf');

        expect(server.loads).toEqual(['b/model.gguf']);
        expect(toasts.warning).not.toHaveBeenCalled();
        expect(toasts.success).toHaveBeenCalledWith('Loaded b/model.gguf.', 'KoboldCpp');
        expect(getDropdown()).toMatchObject({ labels: ['model (loaded)', 'a/model.gguf', 'b/model.gguf', 'Reload launch model', 'Unload model'], value: '' });
    });
});

describe('load requests that fail', () => {
    test('reports a load that KoboldCpp turned down and keeps the list', async () => {
        const server = servers[SERVER_URL];
        server.loadResult = { success: false };
        await loadSwitcher();

        await expect(runCommand('beta.gguf')).resolves.toBe('');

        expect(server.polls).toBe(0);
        expect(toasts.error).toHaveBeenCalledWith('KoboldCpp did not accept "beta.gguf". Click Connect to refresh the list.', 'KoboldCpp');
        expect(script.setOnlineStatus).not.toHaveBeenCalled();
        expect(script.resultCheckStatus).toHaveBeenCalledTimes(1);
        expect(getDropdown()).toMatchObject({ values: ['alpha.gguf', 'beta.gguf', ...ACTIONS], value: 'alpha.gguf' });
    });

    test('reports a load request that did not reach KoboldCpp and keeps the list', async () => {
        const server = servers[SERVER_URL];
        server.loadResult = 502;
        jest.spyOn(console, 'error').mockImplementation(() => {});
        await loadSwitcher();

        await expect(runCommand('beta.gguf')).resolves.toBe('');

        expect(server.polls).toBe(0);
        expect(toasts.error).toHaveBeenCalledWith('Could not reach KoboldCpp.', 'KoboldCpp');
        expect(script.resultCheckStatus).toHaveBeenCalledTimes(1);
        expect(getDropdown()).toMatchObject({ values: ['alpha.gguf', 'beta.gguf', ...ACTIONS], value: 'alpha.gguf' });
    });
});

describe('/kcpp-model results', () => {
    test('returns an empty string when no KoboldCpp URL is set', async () => {
        settings.server_urls.koboldcpp = '';
        await loadSwitcher();

        await expect(runCommand('beta.gguf')).resolves.toBe('');

        expect(fetch).not.toHaveBeenCalled();
        expect(toasts.warning).toHaveBeenCalledWith('Set the KoboldCpp API URL in API Connections first.', 'KoboldCpp');
    });

    test('returns an empty string when KoboldCpp cannot be reached', async () => {
        servers[SERVER_URL].state = null;
        await loadSwitcher();

        await expect(runCommand('beta.gguf')).resolves.toBe('');

        expect(toasts.error).toHaveBeenCalledWith('Could not reach KoboldCpp.', 'KoboldCpp');
    });

    test('returns an empty string and shows why when admin mode is off', async () => {
        servers[SERVER_URL].state = modelsAnswer([], { admin: 0, loadedModel: 'koboldcpp/alpha' });
        await loadSwitcher();

        await expect(runCommand('beta.gguf')).resolves.toBe('');

        expect(toasts.warning).toHaveBeenCalledWith('Start KoboldCpp with --admin and --admindir to switch models here.', 'KoboldCpp');
        expect(getDropdown()).toMatchObject({ labels: ['Admin mode is off'], hint: 'Start KoboldCpp with --admin and --admindir to switch models here.' });
    });

    test('returns the name of an entry that is already loaded without a restart', async () => {
        const server = servers[SERVER_URL];
        await loadSwitcher();

        await expect(runCommand('alpha.gguf')).resolves.toBe('alpha.gguf');
        server.state = modelsAnswer(['alpha.gguf', 'beta.gguf', ...ACTIONS], { loadedModel: 'inactive' });
        await expect(runCommand('unload_model')).resolves.toBe('unload_model');

        expect(server.loads).toEqual([]);
    });

    test('loads the entry chosen in the picker, and returns an empty string when the picker closes', async () => {
        const server = servers[SERVER_URL];
        server.nextState = modelsAnswer(['alpha.gguf', 'beta.gguf', ...ACTIONS], { loadedModel: 'koboldcpp/beta', loadedFiles: ['beta.gguf'] });
        server.uptimes = [NEW_WORKER];
        await loadSwitcher();

        popupResult = 'beta.gguf';
        await expect(runCommand('')).resolves.toBe('beta.gguf');
        popupResult = null;
        await expect(runCommand('')).resolves.toBe('');

        expect(server.loads).toEqual(['beta.gguf']);
    });

    test('gives the picker search box, entries and loaded mark their accessible roles and names', async () => {
        await loadSwitcher();

        await runCommand('');

        const search = popupContent.children.find(child => child.type === 'search');
        const items = popupContent.children.filter(child => child.dataset.entry);
        const [mark] = items.find(item => item.dataset.entry === 'alpha.gguf').children;
        expect(search.getAttribute('aria-label')).toBe('Search...');
        expect(items.map(item => item.getAttribute('role'))).toEqual(['button', 'button', 'button', 'button']);
        expect(mark).toMatchObject({ tagName: 'i', title: 'Loaded', attributes: { role: 'img', 'aria-label': 'Loaded' } });
    });

    test('answers that KoboldCpp is still restarting while a switch waits', async () => {
        const server = servers[SERVER_URL];
        let restart;
        server.onPoll = () => new Promise(resolve => {
            restart = resolve;
        });
        server.nextState = modelsAnswer(['alpha.gguf', 'beta.gguf', ...ACTIONS], { loadedModel: 'koboldcpp/beta', loadedFiles: ['beta.gguf'] });
        server.uptimes = [NEW_WORKER];
        await loadSwitcher();

        const switching = runCommand('beta.gguf');
        await settle();
        await expect(runCommand('alpha.gguf')).resolves.toBe('');
        expect(getDropdown()).toMatchObject({ labels: ['beta.gguf'], hint: 'KoboldCpp restarts to switch models. Generation is unavailable until it is back.' });
        restart();

        await expect(switching).resolves.toBe('beta.gguf');
        expect(toasts.info).toHaveBeenCalledWith('KoboldCpp is still restarting.', 'KoboldCpp');
        expect(server.loads).toEqual(['beta.gguf']);
    });
});

describe('dropdown', () => {
    test('loads the entry chosen in the dropdown and then selects it', async () => {
        const server = servers[SERVER_URL];
        server.nextState = modelsAnswer(['alpha.gguf', 'beta.gguf', ...ACTIONS], { loadedModel: 'koboldcpp/beta', loadedFiles: ['beta.gguf'] });
        server.uptimes = [NEW_WORKER];
        const switcher = await loadSwitcher();
        await switcher.refreshKoboldCppModels();

        dom.select.value = 'beta.gguf';
        dom.onChange();
        await settle();

        expect(server.loads).toEqual(['beta.gguf']);
        expect(toasts.success).toHaveBeenCalledWith('Loaded beta.gguf.', 'KoboldCpp');
        expect(getDropdown()).toMatchObject({ values: ['alpha.gguf', 'beta.gguf', ...ACTIONS], value: 'beta.gguf' });
    });

    test('says which settings models and configs load with', async () => {
        const switcher = await loadSwitcher();
        await switcher.refreshKoboldCppModels();

        expect(getDropdown().hint).toBe('Models load with KoboldCpp\'s default settings, or its --baseconfig file when set. Configs (.kcpps, .kcppt) load their own settings.');
    });

    test('says that KoboldCpp listed no files when it lists only its actions, and keeps the actions', async () => {
        servers[SERVER_URL].state = modelsAnswer(ACTIONS, { loadedModel: 'inactive' });
        const switcher = await loadSwitcher();
        await switcher.refreshKoboldCppModels();

        expect(getDropdown()).toMatchObject({ values: ['', ...ACTIONS], hint: 'KoboldCpp listed no files. Check the folder set with --admindir.' });
    });

    test('asks for the admin password when KoboldCpp needs one and lists nothing', async () => {
        servers[SERVER_URL].state = modelsAnswer([], { admin: 2 });
        const switcher = await loadSwitcher();
        await switcher.refreshKoboldCppModels();

        expect(getDropdown()).toMatchObject({ labels: ['No files to load'], hint: 'KoboldCpp needs its admin password. Enter it as the API key above, then click Connect.' });
    });
});

describe('getStatusTextgen() hook', () => {
    /**
     * Runs getStatusTextgen() from textgen-settings.js against a server that reports a loaded model.
     * @param {string} type Text Completion type
     * @param {number} [checks] Number of status checks to run
     * @returns {Promise<string[]>} Online status at each refresh of the switcher
     */
    async function runStatusChecks(type, checks = 1) {
        const refreshes = [];
        const context = vm.createContext({
            console,
            textgenerationwebui_settings: { type },
            textgen_types: { KOBOLDCPP: 'koboldcpp', LLAMACPP: 'llamacpp', GENERIC: 'generic', OOBA: 'ooba' },
            getTextGenServer: () => SERVER_URL,
            BIAS_CACHE: new Map(),
            BIAS_KEY: 'bias',
            fetch: async () => new Response(JSON.stringify({ result: 'koboldcpp/alpha' })),
            getRequestHeaders: () => ({}),
            abortStatusCheck: new AbortController(),
            online_status: 'no_connection',
            power_user: { instruct: { enabled: false } },
            autoSelectInstructPreset: () => false,
            sessionStorage: { setItem: () => {}, removeItem: () => {} },
            TOKENIZER_SUPPORTED_KEY: 'tokenization',
            resultCheckStatus: () => {},
            refreshKoboldCppModels: async () => {
                refreshes.push(context.online_status);
            },
        });
        context.setOnlineStatus = value => {
            context.online_status = value;
        };
        loadDeclarations(context, 'scripts/textgen-settings.js', ['getStatusTextgen']);

        for (let check = 0; check < checks; check++) {
            await context.getStatusTextgen();
        }
        return refreshes;
    }

    test('refreshes the switcher after every KoboldCpp status check, once the new status is set', async () => {
        await expect(runStatusChecks('koboldcpp', 2)).resolves.toEqual(['koboldcpp/alpha', 'koboldcpp/alpha']);
    });

    test('leaves the switcher alone for other Text Completion types', async () => {
        await expect(runStatusChecks('ooba')).resolves.toEqual([]);
    });
});
