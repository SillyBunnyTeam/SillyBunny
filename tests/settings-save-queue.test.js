/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';
import { createSettingsSync as realCreateSettingsSync } from '../public/scripts/sillybunny-settings-sync.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
});

async function createSettingsRuntime({
    realSettingsSync = false,
    bootReady = true,
    initialVersion = 1,
} = {}) {
    let persistedSettings = null;
    let saveHandler = async (_url, request) => {
        persistedSettings = JSON.parse(request.body);
        return {
            ok: true,
            status: 200,
            json: async () => ({ version: persistedSettings._version + 1 }),
        };
    };

    const fetchMock = jest.fn(async (url, init) => {
        if (url === '/api/settings/get') {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    settings: JSON.stringify({ _version: initialVersion, username: 'Initial' }),
                }),
            };
        }
        if (url === '/api/settings/save') {
            return saveHandler(url, init);
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({}),
        };
    });

    const compressRequest = jest.fn(async req => req);
    const promptConfirm = jest.fn(async () => 0);

    const mocks = {
        'scripts/request-compression.js': {
            compressRequest,
        },
        'scripts/popup.js': {
            Popup: {
                show: {
                    confirm: promptConfirm,
                    input: jest.fn(async () => ''),
                },
            },
        },
        'scripts/sillybunny-settings-sync.js': {
            createSettingsSync: realSettingsSync
                ? realCreateSettingsSync
                : () => ({
                    getFingerprint: json => json,
                    remember() {},
                    isSynced: () => false,
                }),
        },
    };

    loaded = await importScriptModule({
        fetch: fetchMock,
        mocks,
    });

    if (bootReady) {
        await loaded.runReady();
        // Flush any startup save queued by runReady, then reset mocks cleanly.
        await loaded.script.saveSettings(0, { returnResult: true });
        // Restore version to 1 cleanly if boot incremented it, by reading actual last sent version.
    }

    const getSaveCalls = () => fetchMock.mock.calls.filter(([url]) => url === '/api/settings/save');
    const clearSaveTracking = () => {
        fetchMock.mockClear();
        compressRequest.mockClear();
        promptConfirm.mockClear();
        loaded.toastr.error.mockClear();
    };

    return {
        ...loaded,
        fetchMock,
        compressRequest,
        promptConfirm,
        getSaveCalls,
        clearSaveTracking,
        persisted: () => persistedSettings,
        setSaveHandler: fn => { saveHandler = fn; },
    };
}

describe('Queued settings save acknowledgement', () => {
    test.each([false, true])('preserves the default result and optionally confirms success: %s', async (returnResult) => {
        const runtime = await createSettingsRuntime();
        runtime.clearSaveTracking();
        const updates = [];
        runtime.eventSource.on(runtime.script.event_types.SETTINGS_UPDATED, () => updates.push(true));

        const prevVersion = runtime.persisted()._version + 1;
        expect(await runtime.script.saveSettings(0, { returnResult })).toBe(returnResult ? true : undefined);
        expect(runtime.persisted()._version).toBe(prevVersion);
        expect(updates).toHaveLength(1);
        expect(await runtime.script.saveSettings()).toBeUndefined();
    });

    test.each([
        ['HTTP', runtime => runtime.setSaveHandler(async () => ({ ok: false, status: 500, statusText: 'Error' }))],
        ['network', runtime => runtime.setSaveHandler(async () => { throw new Error('Network failure'); })],
        ['compression', runtime => runtime.compressRequest.mockRejectedValue(new Error('Compression failure'))],
        ...[undefined, 0, 1, 'invalid', 1.5].map(version => [
            `version ${version}`,
            runtime => runtime.setSaveHandler(async () => ({ ok: true, status: 200, json: async () => ({ version }) })),
        ]),
        ['invalid JSON', runtime => runtime.setSaveHandler(async () => ({ ok: true, status: 200, json: async () => { throw new Error('Invalid JSON'); } }))],
        ['409', runtime => runtime.setSaveHandler(async () => ({ ok: false, status: 409, json: async () => ({ version: 5 }) }))],
    ])('returns false only when opted in on %s', async (_label, fail) => {
        for (const returnResult of [false, true]) {
            const runtime = await createSettingsRuntime();
            runtime.clearSaveTracking();
            const updates = [];
            runtime.eventSource.on(runtime.script.event_types.SETTINGS_UPDATED, () => updates.push(true));
            fail(runtime);

            expect(await runtime.script.saveSettings(0, { returnResult })).toBe(returnResult ? false : undefined);
            expect(updates).toEqual([]);
            runtime.cleanup();
            loaded = null;
        }
    });

    test('waits for the completed settings update before confirming success', async () => {
        const runtime = await createSettingsRuntime();
        runtime.clearSaveTracking();
        let finishUpdate;
        runtime.eventSource.on(runtime.script.event_types.SETTINGS_UPDATED, () => new Promise(resolve => { finishUpdate = resolve; }));

        const completed = jest.fn();
        const saving = runtime.script.saveSettings(0, { returnResult: true }).then(completed);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(completed).not.toHaveBeenCalled();

        finishUpdate();
        await saving;
        expect(completed).toHaveBeenCalledWith(true);
    });

    test('does not confirm success when the settings update event fails', async () => {
        const runtime = await createSettingsRuntime();
        runtime.clearSaveTracking();
        jest.spyOn(runtime.eventSource, 'emit').mockRejectedValueOnce(new Error('Update failed'));

        expect(await runtime.script.saveSettings(0, { returnResult: true })).toBe(false);
        expect(runtime.toastr.error).toHaveBeenCalledTimes(1);
        expect(await runtime.script.saveSettings(0, { returnResult: true })).toBe(true);
    });

    test('keeps the queue usable after a failed attempt and advances subsequent request versions', async () => {
        const runtime = await createSettingsRuntime();
        runtime.clearSaveTracking();
        const startVersion = runtime.persisted()._version + 1;
        let failSave;
        let firstCall = true;
        runtime.setSaveHandler((_url, req) => {
            if (firstCall) {
                firstCall = false;
                return new Promise((_, reject) => { failSave = reject; });
            }
            const body = JSON.parse(req.body);
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ version: body._version + 1 }) });
        });

        const first = runtime.script.saveSettings(0, { returnResult: true });
        const second = runtime.script.saveSettings(0, { returnResult: true });
        const third = runtime.script.saveSettings(0, { returnResult: true });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(runtime.getSaveCalls()).toHaveLength(1);
        failSave(new Error('Network failure'));
        expect(await Promise.all([first, second, third])).toEqual([false, true, true]);
        expect(runtime.getSaveCalls().map(([, request]) => JSON.parse(request.body)._version)).toEqual([
            startVersion,
            startVersion,
            startVersion + 1,
        ]);
        expect(runtime.toastr.error).toHaveBeenCalledTimes(1);
    });

    test('accepts unchanged saves at equal or newer versions and refuses an older version', async () => {
        const runtime = await createSettingsRuntime();
        runtime.clearSaveTracking();
        const currentVersion = runtime.persisted()._version + 1;

        // Equal version with unchanged: true succeeds and keeps the version.
        runtime.setSaveHandler(async () => ({ ok: true, status: 200, json: async () => ({ version: currentVersion, unchanged: true }) }));
        expect(await runtime.script.saveSettings(0, { returnResult: true })).toBe(true);

        // Newer version with unchanged: true advances the stored version.
        runtime.setSaveHandler(async () => ({ ok: true, status: 200, json: async () => ({ version: currentVersion + 3, unchanged: true }) }));
        expect(await runtime.script.saveSettings(0, { returnResult: true })).toBe(true);

        // Older version with unchanged: true is refused.
        const updates = [];
        runtime.eventSource.on(runtime.script.event_types.SETTINGS_UPDATED, () => updates.push(true));
        runtime.setSaveHandler(async () => ({ ok: true, status: 200, json: async () => ({ version: currentVersion, unchanged: true }) }));
        expect(await runtime.script.saveSettings(0, { returnResult: true })).toBe(false);
        expect(updates).toEqual([]);
    });

    test('deduplicates unchanged saves with real settingsSync, saves after changes, and forgets failed or 409 saves', async () => {
        const runtime = await createSettingsRuntime({ realSettingsSync: true });
        runtime.clearSaveTracking();
        const updates = [];
        runtime.eventSource.on(runtime.script.event_types.SETTINGS_UPDATED, () => updates.push(true));

        // First save establishes a synced fingerprint; repeating immediately sends no request yet emits SETTINGS_UPDATED.
        expect(await runtime.script.saveSettings(0, { returnResult: true })).toBe(true);
        const afterFirst = runtime.getSaveCalls().length;
        expect(await runtime.script.saveSettings(0, { returnResult: true })).toBe(true);
        expect(runtime.getSaveCalls()).toHaveLength(afterFirst);
        expect(updates).toHaveLength(2);

        // Mutating a setting triggers a real request; repeating with the same value does not.
        runtime.state.oai_settings.openai_max_tokens = 999;
        expect(await runtime.script.saveSettings(0, { returnResult: true })).toBe(true);
        expect(runtime.getSaveCalls()).toHaveLength(afterFirst + 1);
        expect(await runtime.script.saveSettings(0, { returnResult: true })).toBe(true);
        expect(runtime.getSaveCalls()).toHaveLength(afterFirst + 1);

        // Failed save is not remembered so the next attempt retries.
        runtime.state.oai_settings.openai_max_tokens = 1111;
        let failOnce = true;
        runtime.setSaveHandler(async (_url, req) => {
            if (failOnce) {
                failOnce = false;
                throw new Error('Network failure');
            }
            const body = JSON.parse(req.body);
            return { ok: true, status: 200, json: async () => ({ version: body._version + 1 }) };
        });
        expect(await runtime.script.saveSettings(0, { returnResult: true })).toBe(false);
        expect(await runtime.script.saveSettings(0, { returnResult: true })).toBe(true);
        expect(runtime.getSaveCalls()).toHaveLength(afterFirst + 3);
    });

    test('preserves 409 conflict state and blocks subsequent writes with the reload prompt', async () => {
        const runtime = await createSettingsRuntime();
        runtime.clearSaveTracking();
        runtime.setSaveHandler(async () => ({ ok: false, status: 409, json: async () => ({ version: 5 }) }));

        expect(await runtime.script.saveSettings(0, { returnResult: true })).toBe(false);
        expect(await runtime.script.saveSettings(0, { returnResult: true })).toBe(false);
        expect(runtime.getSaveCalls()).toHaveLength(1);
        expect(runtime.promptConfirm).toHaveBeenCalledTimes(1);
        expect(runtime.toastr.error).not.toHaveBeenCalled();
    });

    test('defers saves before settingsReady until boot completes', async () => {
        const runtime = await createSettingsRuntime({ bootReady: false });
        expect(await runtime.script.saveSettings(0, { returnResult: true })).toBe(false);
        expect(runtime.getSaveCalls()).toHaveLength(0);

        await runtime.runReady();
        expect(await runtime.script.saveSettings(0, { returnResult: true })).toBe(true);
        expect(runtime.getSaveCalls().length).toBeGreaterThanOrEqual(1);
    });

    test('defers while TempResponseLength is active and restores at the retry limit', async () => {
        const runtime = await createSettingsRuntime();
        runtime.$('#main_api').val('openai').trigger('change');
        runtime.clearSaveTracking();

        let reachPrompt;
        let releasePrompt;
        const reached = new Promise(resolve => { reachPrompt = resolve; });
        const gate = new Promise(resolve => { releasePrompt = resolve; });
        runtime.eventSource.on(runtime.script.event_types.CHAT_COMPLETION_PROMPT_READY, async () => {
            reachPrompt();
            await gate;
        });

        const rawPromise = runtime.script.generateRaw({ prompt: 'hold', responseLength: 100 });
        await reached;

        // Attempts 0, 1, 2 defer without sending /api/settings/save.
        for (let attempt = 0; attempt < 3; attempt++) {
            expect(await runtime.script.saveSettings(attempt, { returnResult: true })).toBe(false);
        }
        expect(runtime.getSaveCalls()).toHaveLength(0);

        // Attempt 3 hits MAX_RETRIES, restores TempResponseLength, and saves successfully.
        expect(await runtime.script.saveSettings(3, { returnResult: true })).toBe(true);
        expect(runtime.getSaveCalls()).toHaveLength(1);
        expect(JSON.parse(runtime.getSaveCalls()[0][1].body).oai_settings.openai_max_tokens).toBe(300);

        releasePrompt();
        await rawPromise.catch(() => {});
    });
});
