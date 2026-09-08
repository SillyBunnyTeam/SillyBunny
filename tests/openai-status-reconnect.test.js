/* eslint-disable playwright/no-standalone-expect */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const openAiSource = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const scriptSource = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function functionSource(source, name) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\n}', start) + 2;
    if (start < 0 || end < 2) {
        throw new Error(`Missing function: ${name}`);
    }
    return `${source.slice(start - 6, start) === 'async ' ? 'async ' : ''}${source.slice(start, end)}`;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function createHarness() {
    const constantsStart = openAiSource.indexOf('export const chat_completion_sources =');
    const constantsEnd = openAiSource.indexOf('const REVERSE_PROXY_SOURCE_LABELS', constantsStart);
    const context = createContext({
        AbortController,
        AbortReason: Error,
        main_api: 'openai',
        oai_settings: { chat_completion_source: 'linkapi', linkapi_endpoint: 'global', reverse_proxy: '', proxy_password: '' },
        secret_state: new Proxy({}, { get: () => true }),
        SECRET_KEYS: new Proxy({}, { get: (_, key) => key }),
        selected_custom_endpoint_preset: null,
        abortStatusCheck: new AbortController(),
        online_status: 'no_connection',
        loading: false,
        models: [],
        fetch: jest.fn(),
        URL,
        DOMPurify: { sanitize: value => value },
        Popup: { show: { confirm: jest.fn().mockResolvedValue(true) } },
        renderTemplateAsync: jest.fn().mockResolvedValue('proxy warning'),
        getStringHash: value => value,
        accountStorage: { getItem: () => 'true', setItem: jest.fn() },
        updateFeatureSupportFlags: jest.fn(),
        saveSettingsDebounced: jest.fn(),
        writeSecret: jest.fn(),
        getRequestHeaders: () => ({}),
        isValidUrl: value => URL.canParse(value),
        t: strings => strings.join(''),
        console: { error: jest.fn(), log: jest.fn(), debug: jest.fn() },
        toastr: { error: jest.fn() },
        $: () => ({ val: () => '', empty: () => {} }),
    });
    runInContext(`
        ${openAiSource.slice(constantsStart, constantsEnd).replaceAll('export ', '')}
        function setOnlineStatus(status) { online_status = status; }
        function startStatusLoading() { loading = true; }
        function resultCheckStatus() { loading = false; }
        function saveModelList(data) { models = data; }
        ${functionSource(scriptSource, 'cancelStatusCheck')}
        ${functionSource(openAiSource, 'validateReverseProxy')}
        ${functionSource(openAiSource, 'getStatusOpen')}
        ${functionSource(openAiSource, 'onConnectButtonClick')}
    `, context);
    return {
        context,
        connect: () => context.onConnectButtonClick({ stopPropagation() {} }),
        switchSource(source) {
            context.cancelStatusCheck('Chat Completion source changed');
            context.oai_settings.chat_completion_source = source;
        },
    };
}

function response(models) {
    return { ok: true, json: async () => ({ data: models.map(id => ({ id })) }) };
}

describe('Chat Completion reconnect status ownership', () => {
    test.each(['linkapi', 'openai'])('connects to %s when requests do not overlap', async source => {
        const { context, connect, switchSource } = createHarness();
        switchSource(source);
        context.fetch.mockResolvedValue(response(['saved-model']));

        await connect();

        expect(context.online_status).toBe('Valid');
        expect(context.loading).toBe(false);
        expect(context.models).toEqual([{ id: 'saved-model' }]);
    });

    test('an older startup failure cannot disconnect a successful reconnect', async () => {
        const { context, connect } = createHarness();
        const startup = deferred();
        context.fetch.mockReturnValueOnce(startup.promise).mockResolvedValueOnce(response(['saved-linkapi-model']));

        const first = connect();
        await connect();
        expect(context.online_status).toBe('Valid');

        startup.reject(new Error('Connection interrupted'));
        await first;

        expect(context.online_status).toBe('Valid');
        expect(context.models).toEqual([{ id: 'saved-linkapi-model' }]);
    });

    test('switching profiles keeps the new connection loading when the old request aborts', async () => {
        const { context, connect, switchSource } = createHarness();
        const oldRequest = deferred();
        const newRequest = deferred();
        context.fetch.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);

        const first = connect();
        switchSource('openai');
        const second = connect();
        oldRequest.reject(new Error('Aborted'));
        await first;
        const loadingBeforeResponse = context.loading;
        newRequest.resolve(response(['proxy-model']));
        await second;

        expect(loadingBeforeResponse).toBe(true);
        expect(context.online_status).toBe('Valid');
    });

    test.each(['linkapi', 'openai'])('a stale model response cannot replace the model list after reconnecting to %s', async source => {
        const { context, connect, switchSource } = createHarness();
        const oldBody = deferred();
        context.fetch.mockResolvedValueOnce({ ok: true, json: () => oldBody.promise });
        const first = connect();
        await Promise.resolve();

        switchSource(source);
        context.fetch.mockResolvedValueOnce(response(['proxy-model']));
        await connect();
        oldBody.resolve({ data: [{ id: 'old-linkapi-model' }] });
        await first;

        expect(context.models).toEqual([{ id: 'proxy-model' }]);
        expect(context.online_status).toBe('Valid');
    });

    test('a status response cannot reconnect an inactive API', async () => {
        const { context, connect } = createHarness();
        const request = deferred();
        context.fetch.mockReturnValueOnce(request.promise);
        const pending = connect();
        context.main_api = 'textgenerationwebui';
        context.online_status = 'Text Completion connected';
        request.resolve(response(['old-linkapi-model']));
        await pending;

        expect(context.online_status).toBe('Text Completion connected');
        expect(context.models).toEqual([]);
    });

    test.each([true, false])('ignores a superseded proxy confirmation resolving to %s', async confirmation => {
        const { context, connect, switchSource } = createHarness();
        const popup = deferred();
        context.accountStorage.getItem = () => null;
        context.Popup.show.confirm.mockReturnValueOnce(popup.promise);
        switchSource('openai');
        context.oai_settings.reverse_proxy = 'https://proxy.example/v1';
        const first = connect();
        await Promise.resolve();

        switchSource('linkapi');
        context.fetch.mockResolvedValueOnce(response(['saved-linkapi-model']));
        await connect();
        popup.resolve(confirmation);
        await first;

        expect(context.fetch).toHaveBeenCalledTimes(1);
        expect(context.online_status).toBe('Valid');
        expect(context.models).toEqual([{ id: 'saved-linkapi-model' }]);
        expect(context.accountStorage.setItem).not.toHaveBeenCalled();
        expect(context.toastr.error).not.toHaveBeenCalled();
    });

    test('a current provider failure remains disconnected', async () => {
        const { context, connect } = createHarness();
        context.fetch.mockRejectedValueOnce(new Error('Connection interrupted'));
        await connect();

        expect(context.online_status).toBe('no_connection');
        expect(context.loading).toBe(false);
    });

    test('an invalid proxy ends the loading state and allows a later reconnect', async () => {
        const { context, connect, switchSource } = createHarness();
        switchSource('openai');
        context.oai_settings.reverse_proxy = 'invalid proxy';

        await expect(connect()).resolves.toBeUndefined();
        expect(context.loading).toBe(false);
        expect(context.online_status).toBe('no_connection');
        expect(context.fetch).not.toHaveBeenCalled();

        context.oai_settings.reverse_proxy = 'https://proxy.example/v1';
        context.fetch.mockResolvedValueOnce(response(['proxy-model']));
        await connect();
        expect(context.online_status).toBe('Valid');
    });
});
