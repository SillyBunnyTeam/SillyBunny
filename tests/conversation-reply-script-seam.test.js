/* eslint-disable playwright/no-standalone-expect -- Jest tests, not Playwright. */
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';

import { event_types } from '../public/scripts/events.js';
import { loadDeclarations, readClientModule } from './util/load-declarations.js';

/**
 * Runs the real `generateRawData()` and `generateRaw()` of public/script.js with everything around them stubbed, to see
 * what a conversation reply does to its commit plan: the plan is registered on the signal that reaches fetchResumable(),
 * which is a signal that generateRawData() makes itself, and the claim is awaited before the data is returned.
 */
function makeRuntime({ api = 'novel', settle = async () => 'claimed' } = {}) {
    const calls = [];
    const eventSource = new EventEmitter();
    eventSource.emit = jest.fn(async () => {});
    const context = vm.createContext({
        AbortController, AbortSignal, Error, console,
        main_api: api, amount_gen: 100, max_context: 4096,
        nai_settings: { preset_settings_novel: 'preset', model_novel: 'erato' },
        novelai_settings: [{}], novelai_setting_names: { preset: 0 },
        kai_settings: { preset_settings: 'gui' }, horde_settings: {}, koboldai_settings: {}, koboldai_setting_names: [],
        getKoboldGenerationData: prompt => ({ prompt }),
        eventSource, event_types,
        createRawPrompt: prompt => prompt,
        getNovelGenerationData: (prompt, settings, maxLength) => ({ input: prompt, max_length: maxLength }),
        applyGenerationRequestControls: data => data,
        getGeneratingModel: () => 'erato',
        getGenerateUrl: () => '/api/novelai/generate',
        getRequestHeaders: () => ({}),
        extractMessageFromData: data => data.output,
        cleanUpMessage: ({ getMessage }) => getMessage,
        registerGenerationCommitPlan: jest.fn((signal, plan) => calls.push(['register', signal, plan])),
        settleGenerationCommit: jest.fn(async (signal) => {
            calls.push(['settle', signal]);
            return settle(signal);
        }),
        fetchResumable: jest.fn(async (url, init) => {
            calls.push(['request', init.signal]);
            return { ok: true, json: async () => ({ output: 'New prose.' }) };
        }),
        generateHorde: jest.fn(async (prompt, data, signal) => {
            calls.push(['request', signal]);
            return { output: 'New prose.' };
        }),
    });
    loadDeclarations(context, 'script.js', ['generateRawData', 'generateRaw']);
    return { context, calls };
}

describe('generateRawData() with the commit plan of a conversation reply', () => {
    test('registers the plan on the signal that the request is made with, before the request, and takes the state of the claim', async () => {
        const { context, calls } = makeRuntime({ settle: async () => 'committed' });
        const commit = { plan: { kind: 'reply' }, state: null };

        await context.generateRawData({ prompt: 'hello', api: 'novel', commit });

        expect(calls.map(([step]) => step)).toEqual(['register', 'request', 'settle']);
        const [[, registeredOn, plan], [, requestedWith], [, settledOn]] = calls;
        expect(plan).toBe(commit.plan);
        expect(registeredOn).toBe(requestedWith);
        expect(settledOn).toBe(requestedWith);
        expect(commit.state).toBe('committed');
    });

    test('does not use the signal of the caller: its own signal is the one that reaches the request', async () => {
        const { context, calls } = makeRuntime();
        const callerSignal = new AbortController().signal;

        await context.generateRawData({ prompt: 'hello', api: 'novel', signal: callerSignal, commit: { plan: { kind: 'reply' }, state: null } });

        expect(calls[0][1]).not.toBe(callerSignal);
    });

    test('registers nothing for a request that has no plan, and does not claim', async () => {
        const { context, calls } = makeRuntime();

        await context.generateRawData({ prompt: 'hello', api: 'novel' });
        await context.generateRawData({ prompt: 'hello', api: 'novel', commit: { plan: null, state: null } });

        expect(calls.filter(([step]) => step === 'settle')).toEqual([]);
        expect(calls.filter(([step]) => step === 'register').every(([, , plan]) => plan === null)).toBe(true);
    });

    test('leaves the state empty for AI Horde, which has no server commit, where the claim answers nothing', async () => {
        const { context } = makeRuntime({ api: 'koboldhorde', settle: async () => null });
        const commit = { plan: { kind: 'reply' }, state: null };

        await context.generateRawData({ prompt: 'hello', api: 'koboldhorde', commit });

        expect(commit.state).toBeNull();
    });

    test('keeps the state empty when the request fails, and does not hide the failure', async () => {
        const { context } = makeRuntime();
        context.fetchResumable = jest.fn(async () => ({ ok: false, json: async () => ({ error: 'provider down' }) }));
        const commit = { plan: { kind: 'reply' }, state: null };

        await expect(context.generateRawData({ prompt: 'hello', api: 'novel', commit })).rejects.toEqual({ error: 'provider down' });

        expect(commit.state).toBeNull();
        expect(context.settleGenerationCommit).not.toHaveBeenCalled();
    });
});

describe('generateRaw()', () => {
    test('hands the commit of its caller to generateRawData(), and returns the cleaned message as before', async () => {
        const { context, calls } = makeRuntime({ settle: async () => 'claimed' });
        const commit = { plan: { kind: 'reply' }, state: null };

        await expect(context.generateRaw({ prompt: 'hello', api: 'novel', commit })).resolves.toBe('New prose.');

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
