/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';

const RECONNECT_DOM = `
    <div id="options_button"></div>
    <div id="options"></div>
    <div id="export_button"></div>
    <div id="export_format_popup"></div>
    <div id="online_status_indicator" class="online_status_indicator"></div>
    <div id="online_status_text" class="online_status_text"></div>
    <div id="API-status-top" no_connection_text="No connection"></div>
    <select id="main_api">
        <option value="openai" selected>openai</option>
        <option value="textgenerationwebui">textgenerationwebui</option>
    </select>
    <button id="api_button_openai" class="api_button"></button>
    <div class="api_loading" style="display:none"></div>
    <input id="api_key_openai" value="" />
    <input id="api_key_linkapi" value="" />
    <input id="openai_reverse_proxy" value="" />
    <input id="openai_proxy_password" value="" />
    <select id="chat_completion_source">
        <option value="linkapi">linkapi</option>
        <option value="openai">openai</option>
    </select>
    <select id="model_openai_select"></select>
    <select id="model_linkapi_select"><optgroup id="linkapi_other_models"></optgroup></select>
    <input id="linkapi_model_id" value="" />
    <div id="chat"></div>
    <div id="message_template" hidden><div class="mes"><div class="mes_block"><div class="mes_text"></div></div></div></div>
    <textarea id="send_textarea"></textarea>
    <div id="send_but"></div>
    <div id="mes_stop"></div>
`;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function response(models) {
    return { ok: true, status: 200, json: async () => ({ data: models.map(id => ({ id })) }) };
}

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

async function createReconnectHarness() {
    const fetchMock = jest.fn(async (url) => {
        if (url === '/api/settings/get') {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    settings: '{}',
                    openai_setting_names: [],
                    openai_settings: [],
                }),
            };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    });

    const storageMap = new Map([['ReverseProxyWarningAcknowledged', 'true']]);
    const accountStorage = {
        init: jest.fn(),
        getState: jest.fn(() => ({})),
        getItem: jest.fn(key => (storageMap.has(key) ? storageMap.get(key) : null)),
        setItem: jest.fn((key, value) => storageMap.set(key, String(value))),
        removeItem: jest.fn(key => storageMap.delete(key)),
    };
    const popupConfirm = jest.fn().mockResolvedValue(true);
    const setStatusCheckPending = jest.fn();
    const countStatusLoadingStart = jest.fn();

    loaded = await importScriptModule({
        dom: RECONNECT_DOM,
        keepReal: ['scripts/openai.js'],
        fetch: fetchMock,
        mocks: {
            'scripts/group-chats.js': (base) => ({
                ...base,
                getGroupNames: jest.fn(() => []),
            }),
            'scripts/util/AccountStorage.js': { accountStorage },
            'scripts/secrets.js': (base) => ({
                ...base,
                rotateSecret: jest.fn(async () => 'secret-id'),
                writeSecret: jest.fn(async () => 'secret-id'),
                secret_state: new Proxy({}, { get: () => true }),
                SECRET_KEYS: new Proxy({}, { get: (_target, key) => String(key).toLowerCase() }),
            }),
            'scripts/sse-stream.js': (base) => ({
                ...base,
                default: class EventSourceStream {},
                getEventSourceStream: jest.fn(),
            }),
            'scripts/logprobs.js': (base) => ({
                ...base,
                saveLogprobsForActiveMessage: jest.fn(),
            }),
            'scripts/popup.js': (base) => ({
                ...base,
                Popup: Object.assign(jest.fn(), { show: { confirm: popupConfirm, text: jest.fn(), input: jest.fn() } }),
            }),
            'scripts/sillybunny-connection-state.js': {
                setConnectionStatus: jest.fn(),
                setStatusCheckPending,
            },
            'scripts/sillybunny-koboldcpp-models.js': (base) => ({
                ...base,
                countStatusLoadingStart,
                getKoboldCppChatState: jest.fn(() => null),
                refreshKoboldCppModels: jest.fn(async () => {}),
                countKoboldCppChatTokens: jest.fn(async () => 0),
                isKoboldCppChatCompletion: jest.fn(() => false),
                initKoboldCppModels: jest.fn(),
            }),
            'scripts/sillybunny-connection-notices.js': {
                flagMissingKey: jest.fn(),
            },
            'scripts/sillybunny-editor/option-details.js': {
                registerOptionDetails: jest.fn(),
                hasOptionDetails: jest.fn(() => false),
                toDetails: jest.fn(v => v),
                detailsToText: jest.fn(() => ''),
                renderDetails: jest.fn(() => document.createElement('div')),
                icon: jest.fn(),
                link: jest.fn(),
                badge: jest.fn(),
                createDetailsMapper: jest.fn(() => jest.fn()),
            },
            'scripts/sillybunny-model-details.js': {
                describeAimlapiModel: jest.fn(),
                describeChutesModel: jest.fn(),
                describeElectronHubModel: jest.fn(),
                describeHordeModel: jest.fn(),
                describeMancerModel: jest.fn(),
                describeOpenRouterModel: jest.fn(),
                describeTogetherModel: jest.fn(),
                plainText: value => String(value ?? ''),
            },
            'scripts/PromptManager.js': {
                chatCompletionDefaultPrompts: { prompts: [] },
                INJECTION_POSITION: { RELATIVE: 0, ABSOLUTE: 1 },
                Prompt: class Prompt { constructor(data = {}) { Object.assign(this, data); } },
                PromptManager: class PromptManager {
                    init() {}
                    setChatCompletion() {}
                    preparePrompt(p) { return p; }
                    log() {}
                    render() {}
                    getPromptCollection() { return { collection: [] }; }
                    getPromptOrderForCharacter() { return []; }
                    getPromptById() { return null; }
                    isPromptDisabledForActiveCharacter() { return false; }
                },
                promptManagerDefaultPromptOrders: [],
            },
            'scripts/textgen-models.js': {
                getCurrentDreamGenModelTokenizer: jest.fn(() => null),
                getCurrentOpenRouterModelTokenizer: jest.fn(() => null),
                openRouterModels: [],
                setOpenRouterProviders: jest.fn(),
                syncNanoGptProvidersForModel: jest.fn(),
                syncOpenRouterProvidersForModel: jest.fn(),
                updateNanoGptProvidersWarning: jest.fn(),
                updateOpenRouterProvidersWarning: jest.fn(),
            },
            'scripts/tokenizers.js': (base) => ({
                ...base,
                countChatCompletionPayloadTokensOpenAIAsync: jest.fn(async () => 0),
                countTokensOpenAIAsync: jest.fn(async () => 0),
                getTokenizerModel: jest.fn(() => 'gpt-4o'),
                primeOpenAITokenCache: jest.fn(),
                tokenizers: {},
            }),
            'scripts/utils.js': (base) => ({
                ...base,
                createThumbnail: jest.fn(),
                download: jest.fn(),
                getAudioDurationFromDataURL: jest.fn(async () => 0),
                getBase64Async: jest.fn(async () => ''),
                getFileText: jest.fn(async () => ''),
                getImageSizeFromDataURL: jest.fn(async () => ({ width: 0, height: 0 })),
                getSortableDelay: jest.fn(() => 0),
                getStringHash: jest.fn(value => String(value ?? '')),
                getVideoDurationFromDataURL: jest.fn(async () => 0),
                isFalseBoolean: value => value === false || String(value).toLowerCase() === 'false',
                isTrueBoolean: value => value === true || String(value).toLowerCase() === 'true',
                isUuid: jest.fn(() => false),
                parseJsonFile: jest.fn(async () => ({})),
                resetScrollHeight: jest.fn(),
                stringFormat: (str, ...args) => String(str).replace(/\{(\d+)\}/g, (_m, i) => args[i] ?? ''),
                textValueMatcher: jest.fn(() => true),
            }),
            'scripts/sillybunny-delete-confirm.js': {
                confirmVerb: jest.fn(() => ({})),
            },
            'scripts/sillybunny-editor/adapters/window-content-dialogs.js': {
                accountProfileOptions: jest.fn(() => ({})),
                snapshotsOptions: jest.fn(() => ({})),
                adminPanelOptions: jest.fn(() => ({})),
                scenarioOverrideOptions: jest.fn(() => ({})),
                customEndpointParametersOptions: jest.fn(() => ({})),
            },
            'scripts/sillybunny-request-errors.js': {
                createFailedResponseError: jest.fn(async () => new Error('Request failed')),
                showRequestError: jest.fn(),
                getFailureStatus: jest.fn(() => 500),
            },
        },
    });

    await loaded.runReady();
    loaded.$('#main_api').val('openai').trigger('change');
    const openai = await import('../public/scripts/openai.js');
    openai.oai_settings.chat_completion_source = 'linkapi';
    openai.oai_settings.linkapi_endpoint = 'global';
    openai.oai_settings.reverse_proxy = '';
    openai.oai_settings.proxy_password = '';

    fetchMock.mockReset();
    setStatusCheckPending.mockClear();
    countStatusLoadingStart.mockClear();
    accountStorage.setItem.mockClear();
    loaded.toastr.error.mockClear();

    const connectEvents = loaded.$._data(document.getElementById('api_button_openai'), 'events');
    const clickHandler = connectEvents.click[0].handler;
    const connect = () => clickHandler({ stopPropagation() {} });
    const cancel = () => loaded.$('.api_loading').trigger('click');
    const switchSource = (source) => {
        loaded.script.cancelStatusCheck('Chat Completion source changed');
        openai.oai_settings.chat_completion_source = source;
    };
    const isLoading = () => document.querySelector('.api_loading').style.display !== 'none';
    const isConnectDisabled = () => document.querySelector('.api_button').classList.contains('disabled');
    const getModels = () => openai.model_list.map(model => model.id);

    return {
        script: loaded.script,
        openai,
        $: loaded.$,
        fetchMock,
        accountStorage,
        storageMap,
        popupConfirm,
        setStatusCheckPending,
        countStatusLoadingStart,
        toastr: loaded.toastr,
        connect,
        cancel,
        switchSource,
        isLoading,
        isConnectDisabled,
        getModels,
    };
}

describe('Chat Completion reconnect status ownership', () => {
    test.each([
        ['fetch', false],
        ['fetch', true],
        ['body', false],
        ['body', true],
    ])('manual cancel during %s cleans up immediately and protects reconnect (completed: %s)', async (phase, completed) => {
        const harness = await createReconnectHarness();
        const oldResult = deferred();
        const newRequest = deferred();
        const parsing = deferred();
        const json = () => {
            parsing.resolve();
            return oldResult.promise;
        };
        harness.fetchMock
            .mockReturnValueOnce(phase === 'fetch' ? oldResult.promise : Promise.resolve({ ok: true, json }))
            .mockReturnValueOnce(newRequest.promise);

        const first = harness.connect();
        if (phase === 'body') await parsing.promise;
        const oldSignal = harness.fetchMock.mock.calls[0][1].signal;
        expect(harness.isLoading()).toBe(true);
        expect(harness.isConnectDisabled()).toBe(true);

        harness.cancel();

        expect(oldSignal.aborted).toBe(true);
        expect(harness.script.abortStatusCheck.signal.aborted).toBe(false);
        expect(harness.script.online_status).toBe('no_connection');
        expect(harness.isLoading()).toBe(false);
        expect(harness.isConnectDisabled()).toBe(false);

        const second = harness.connect();
        expect(harness.isLoading()).toBe(true);
        expect(harness.isConnectDisabled()).toBe(true);
        const newSignal = harness.fetchMock.mock.calls[1][1].signal;
        if (completed) {
            newRequest.resolve(response(['new-model']));
            await second;
        }

        if (phase === 'fetch') {
            oldResult.reject(oldSignal.reason);
        } else {
            oldResult.resolve({ data: [{ id: 'old-model' }] });
        }
        await first;

        expect(newSignal.aborted).toBe(false);
        expect(harness.isLoading()).toBe(!completed);
        expect(harness.isConnectDisabled()).toBe(!completed);
        expect(harness.script.online_status).toBe(completed ? 'Valid' : 'no_connection');
        expect(harness.getModels('linkapi')).toEqual(completed ? ['new-model'] : []);

        if (!completed) {
            newRequest.resolve(response(['new-model']));
            await second;
        }
        expect(harness.script.online_status).toBe('Valid');
        expect(harness.getModels('linkapi')).toEqual(['new-model']);
        expect(harness.isLoading()).toBe(false);
        expect(harness.isConnectDisabled()).toBe(false);
    });

    test('reports a check as pending from Connect until the check ends, and as not pending after a manual cancel', async () => {
        const harness = await createReconnectHarness();
        const result = deferred();
        harness.fetchMock.mockReturnValueOnce(result.promise);

        const first = harness.connect();
        expect(harness.setStatusCheckPending.mock.calls).toEqual([[true]]);

        result.resolve(response(['model']));
        await first;
        expect(harness.setStatusCheckPending.mock.calls).toEqual([[true], [false]]);

        harness.fetchMock.mockReturnValueOnce(deferred().promise);
        harness.connect();
        harness.cancel();
        expect(harness.setStatusCheckPending.mock.calls.at(-1)).toEqual([false]);
    });

    test.each(['linkapi', 'openai'])('connects to %s when requests do not overlap', async (source) => {
        const harness = await createReconnectHarness();
        harness.switchSource(source);
        harness.fetchMock.mockResolvedValue(response(['saved-model']));

        await harness.connect();

        expect(harness.script.online_status).toBe('Valid');
        expect(harness.isLoading()).toBe(false);
        expect(harness.getModels(source)).toEqual(['saved-model']);
    });

    test('an older startup failure cannot disconnect a successful reconnect', async () => {
        const harness = await createReconnectHarness();
        const startup = deferred();
        harness.fetchMock
            .mockReturnValueOnce(startup.promise)
            .mockResolvedValueOnce(response(['saved-linkapi-model']));

        const first = harness.connect();
        await harness.connect();
        expect(harness.script.online_status).toBe('Valid');

        startup.reject(new Error('Connection interrupted'));
        await first;

        expect(harness.script.online_status).toBe('Valid');
        expect(harness.getModels('linkapi')).toEqual(['saved-linkapi-model']);
    });

    test('switching profiles keeps the new connection loading when the old request aborts', async () => {
        const harness = await createReconnectHarness();
        const oldRequest = deferred();
        const newRequest = deferred();
        harness.fetchMock
            .mockReturnValueOnce(oldRequest.promise)
            .mockReturnValueOnce(newRequest.promise);

        const first = harness.connect();
        harness.switchSource('openai');
        const second = harness.connect();
        oldRequest.reject(new Error('Aborted'));
        await first;
        const loadingBeforeResponse = harness.isLoading();
        newRequest.resolve(response(['proxy-model']));
        await second;

        expect(loadingBeforeResponse).toBe(true);
        expect(harness.script.online_status).toBe('Valid');
    });

    test.each(['linkapi', 'openai'])('a stale model response cannot replace the model list after reconnecting to %s', async (source) => {
        const harness = await createReconnectHarness();
        const oldBody = deferred();
        harness.fetchMock.mockResolvedValueOnce({ ok: true, json: () => oldBody.promise });
        const first = harness.connect();
        await Promise.resolve();

        harness.switchSource(source);
        harness.fetchMock.mockResolvedValueOnce(response(['proxy-model']));
        await harness.connect();
        oldBody.resolve({ data: [{ id: 'old-linkapi-model' }] });
        await first;

        expect(harness.getModels(source)).toEqual(['proxy-model']);
        expect(harness.script.online_status).toBe('Valid');
    });

    test('a status response cannot reconnect an inactive API', async () => {
        const harness = await createReconnectHarness();
        const request = deferred();
        harness.fetchMock.mockReturnValueOnce(request.promise);
        const pending = harness.connect();
        harness.$('#main_api').val('textgenerationwebui').trigger('change');
        harness.script.setOnlineStatus('Text Completion connected');
        request.resolve(response(['old-linkapi-model']));
        await pending;

        expect(harness.script.online_status).toBe('Text Completion connected');
        expect(harness.getModels('linkapi')).toEqual([]);
    });

    test.each([true, false])('ignores a superseded proxy confirmation resolving to %s', async (confirmation) => {
        const harness = await createReconnectHarness();
        const popup = deferred();
        harness.storageMap.clear();
        harness.popupConfirm.mockReturnValueOnce(popup.promise);
        harness.switchSource('openai');
        harness.openai.oai_settings.reverse_proxy = 'https://proxy.example/v1';
        const first = harness.connect();
        await Promise.resolve();

        harness.switchSource('linkapi');
        harness.fetchMock.mockResolvedValueOnce(response(['saved-linkapi-model']));
        await harness.connect();
        popup.resolve(confirmation);
        await first;

        expect(harness.fetchMock).toHaveBeenCalledTimes(1);
        expect(harness.script.online_status).toBe('Valid');
        expect(harness.getModels('linkapi')).toEqual(['saved-linkapi-model']);
        expect(harness.accountStorage.setItem).not.toHaveBeenCalled();
        expect(harness.toastr.error).not.toHaveBeenCalled();
    });

    test('a current provider failure remains disconnected', async () => {
        const harness = await createReconnectHarness();
        harness.fetchMock.mockRejectedValueOnce(new Error('Connection interrupted'));
        await harness.connect();

        expect(harness.script.online_status).toBe('no_connection');
        expect(harness.isLoading()).toBe(false);
    });

    test('an invalid proxy ends the loading state and allows a later reconnect', async () => {
        const harness = await createReconnectHarness();
        harness.switchSource('openai');
        harness.openai.oai_settings.reverse_proxy = 'invalid proxy';

        await expect(harness.connect()).resolves.toBeUndefined();
        expect(harness.isLoading()).toBe(false);
        expect(harness.script.online_status).toBe('no_connection');
        expect(harness.fetchMock).not.toHaveBeenCalled();

        harness.openai.oai_settings.reverse_proxy = 'https://proxy.example/v1';
        harness.fetchMock.mockResolvedValueOnce(response(['proxy-model']));
        await harness.connect();
        expect(harness.script.online_status).toBe('Valid');
    });
});

describe('startStatusLoading() hook', () => {
    test('tells the KoboldCpp model switcher each time a status check starts the loading state', async () => {
        const harness = await createReconnectHarness();
        harness.fetchMock.mockResolvedValue(response(['saved-model']));

        await harness.connect();
        await harness.connect();

        expect(harness.countStatusLoadingStart).toHaveBeenCalledTimes(2);
    });
});
