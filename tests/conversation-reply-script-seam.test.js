/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest tests, not Playwright. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { readClientModule } from './util/load-declarations.js';
import { importScriptModule } from './util/script-harness.js';

let activeRuntime = null;

afterEach(() => {
    activeRuntime?.cleanup();
    activeRuntime = null;
});

/**
 * Imports the real `public/script.js` module in jsdom and runs its `generateRawData()` and `generateRaw()`
 * against mocked network/resumable seams to verify what a conversation reply does to its commit plan:
 * the plan is registered on the signal that reaches `fetchResumable()`, which is a signal that
 * `generateRawData()` creates itself, and the claim is awaited before the data is returned.
 */
async function makeRuntime({ api = 'novel', settle = async () => 'claimed' } = {}) {
    const calls = [];
    const fetchResumable = jest.fn(async (_url, init) => {
        calls.push(['request', init.signal]);
        return { ok: true, json: async () => ({ output: 'New prose.' }) };
    });
    const registerGenerationCommitPlan = jest.fn((signal, plan) => {
        calls.push(['register', signal, plan]);
    });
    const settleGenerationCommit = jest.fn(async (signal) => {
        calls.push(['settle', signal]);
        return settle(signal);
    });
    const generateHorde = jest.fn(async (_prompt, _data, signal) => {
        calls.push(['request', signal]);
        return { output: 'New prose.' };
    });

    const loaded = await importScriptModule({
        mocks: {
            'scripts/nai-settings.js': {
                nai_settings: { preset_settings_novel: 'preset', model_novel: 'erato', streaming_novel: false },
                novelai_settings: [{}],
                novelai_setting_names: { preset: 0 },
                getNovelGenerationData: jest.fn((prompt, _settings, maxLength) => ({ input: prompt, max_length: maxLength })),
            },
            'scripts/horde.js': {
                generateHorde,
            },
            'scripts/resumable-generation.js': {
                fetchResumable,
                registerGenerationCommitPlan,
                settleGenerationCommit,
            },
        },
    });
    activeRuntime = loaded;

    if (api) {
        loaded.script.setMainApi?.(api);
    }

    return {
        script: loaded.script,
        calls,
        mocks: {
            fetchResumable,
            registerGenerationCommitPlan,
            settleGenerationCommit,
            generateHorde,
        },
    };
}

describe('generateRawData() with the commit plan of a conversation reply', () => {
    test('registers the plan on the signal that the request is made with, before the request, and takes the state of the claim', async () => {
        const { script, calls } = await makeRuntime({ settle: async () => 'committed' });
        const commit = { plan: { kind: 'reply' }, state: null };

        await script.generateRawData({ prompt: 'hello', api: 'novel', commit });

        expect(calls.map(([step]) => step)).toEqual(['register', 'request', 'settle']);
        const [[, registeredOn, plan], [, requestedWith], [, settledOn]] = calls;
        expect(plan).toBe(commit.plan);
        expect(registeredOn).toBe(requestedWith);
        expect(settledOn).toBe(requestedWith);
        expect(commit.state).toBe('committed');
    });

    test('does not use the signal of the caller: its own signal is the one that reaches the request', async () => {
        const { script, calls } = await makeRuntime();
        const callerSignal = new AbortController().signal;

        await script.generateRawData({ prompt: 'hello', api: 'novel', signal: callerSignal, commit: { plan: { kind: 'reply' }, state: null } });

        expect(calls[0][1]).not.toBe(callerSignal);
    });

    test('registers nothing for a request that has no plan, and does not claim', async () => {
        const { script, calls } = await makeRuntime();

        await script.generateRawData({ prompt: 'hello', api: 'novel' });
        await script.generateRawData({ prompt: 'hello', api: 'novel', commit: { plan: null, state: null } });

        expect(calls.filter(([step]) => step === 'settle')).toEqual([]);
        expect(calls.filter(([step]) => step === 'register').every(([, , plan]) => plan === null)).toBe(true);
    });

    test('leaves the state empty for AI Horde, which has no server commit, where the claim answers nothing', async () => {
        const { script } = await makeRuntime({ api: 'koboldhorde', settle: async () => null });
        const commit = { plan: { kind: 'reply' }, state: null };

        await script.generateRawData({ prompt: 'hello', api: 'koboldhorde', commit });

        expect(commit.state).toBeNull();
    });

    test('keeps the state empty when the request fails, and does not hide the failure', async () => {
        const { script, mocks } = await makeRuntime();
        mocks.fetchResumable.mockImplementationOnce(async () => ({ ok: false, json: async () => ({ error: 'provider down' }) }));
        const commit = { plan: { kind: 'reply' }, state: null };

        await expect(script.generateRawData({ prompt: 'hello', api: 'novel', commit })).rejects.toEqual({ error: 'provider down' });

        expect(commit.state).toBeNull();
        expect(mocks.settleGenerationCommit).not.toHaveBeenCalled();
    });
});

describe('generateRaw()', () => {
    test('hands the commit of its caller to generateRawData(), and returns the cleaned message as before', async () => {
        const { script, calls } = await makeRuntime({ settle: async () => 'claimed' });
        const commit = { plan: { kind: 'reply' }, state: null };

        await expect(script.generateRaw({ prompt: 'hello', api: 'novel', commit })).resolves.toBe('New prose.');

        expect(commit.state).toBe('claimed');
        expect(calls.map(([step]) => step)).toEqual(['register', 'request', 'settle']);
    });
});

describe('the seam in public/script.js', () => {
    test('is marked as a SillyBunny change, which the upstream-touch ledger names', () => {
        const { source } = readClientModule('script.js');

        expect(source).toContain('// SillyBunny: a conversation reply registers its commit plan on the signal that reaches fetchResumable()');
    });
});
