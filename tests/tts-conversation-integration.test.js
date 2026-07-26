/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const capabilityRegistryKey = Symbol.for('sillybunny.extensionCapabilities');
const ttsSource = readFileSync(fileURLToPath(new URL('../public/scripts/extensions/tts/index.js', import.meta.url)), 'utf8');

function getFunctionSource(name) {
    const asyncStart = ttsSource.indexOf(`async function ${name}(`);
    const exportedAsyncStart = ttsSource.indexOf(`export async function ${name}(`);
    const exportedStart = ttsSource.indexOf(`export function ${name}(`);
    let start = asyncStart >= 0 ? asyncStart : ttsSource.indexOf(`function ${name}(`);
    if (exportedAsyncStart >= 0) start = ttsSource.indexOf('async function', exportedAsyncStart);
    else if (exportedStart >= 0 && (start < 0 || exportedStart < start)) start = ttsSource.indexOf('function', exportedStart);
    expect(start).toBeGreaterThanOrEqual(0);
    const bodyStart = ttsSource.indexOf('{', ttsSource.indexOf(')', ttsSource.indexOf('(', start)));
    let depth = 0;
    for (let index = bodyStart; index < ttsSource.length; index++) {
        if (ttsSource[index] === '{') depth++;
        if (ttsSource[index] === '}' && --depth === 0) return ttsSource.slice(start, index + 1);
    }
    throw new Error(`Unable to extract ${name}`);
}

function createTtsContext(values = {}) {
    return vm.createContext({ ...values });
}

function evaluateInContext(name, context) {
    const fn = vm.runInContext(`(${getFunctionSource(name)})`, context);
    context[name] = fn;
    return fn;
}

function evaluateFunction(name, values = {}) {
    return evaluateInContext(name, createTtsContext(values));
}

function installCapabilityRegistry(entries) {
    Object.defineProperty(globalThis, capabilityRegistryKey, {
        configurable: true,
        value: new Map(entries),
    });
}

function createEpochAwareAddAudioJob(context, audioJobQueue) {
    // Mirrors the shipped addAudioJob epoch guard: stale-epoch chunks are dropped.
    return async function addAudioJob(response, char, epoch) {
        const current = context.isTtsEpochCurrent(epoch);
        current && audioJobQueue.push({ response, char, epoch });
        return current ? { audioBlob: response, mimeType: '' } : null;
    };
}

async function importConversationTts() {
    jest.resetModules();
    await jest.unstable_mockModule('../public/script.js', () => ({ name1: 'User' }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/thread-store-utils.js', () => ({
        getConversationAttachmentSummary: jest.fn(() => '[Attachment]'),
    }));
    return import('../public/scripts/sillybunny-conversation/tts.js');
}

afterEach(() => {
    delete globalThis[capabilityRegistryKey];
    delete globalThis.toastr;
    jest.restoreAllMocks();
});

describe('TTS Conversation integration', () => {
    test('uses only the activated TTS capability while preserving manual narration', async () => {
        const conversationTts = await importConversationTts();
        await expect(conversationTts.narrateConversationMessage({ role: 'character', name: 'Mona', mes: 'Hello' })).resolves.toBe(false);

        const narrateTtsMessage = jest.fn(async () => true);
        installCapabilityRegistry([['tts', { narrateTtsMessage }]]);
        const message = { role: 'partner', name: 'Mona', mes: 'Hello', extra: { partner_avatar: 'mona.png' } };

        await expect(conversationTts.narrateConversationMessage(message)).resolves.toBe(true);
        expect(narrateTtsMessage).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Mona',
            mes: 'Hello',
            is_user: false,
        }), expect.objectContaining({
            manual: false,
            force: false,
            isStillVisible: null,
            propagateErrors: true,
            unrestrictedVoiceMap: true,
        }));

        await expect(conversationTts.narrateConversationMessage(message, { manual: true, force: true })).resolves.toBe(true);
        expect(narrateTtsMessage).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({
            manual: true,
            force: true,
            unrestrictedVoiceMap: true,
        }));
    });

    test('Conversation reports capability failures instead of silently succeeding', async () => {
        const conversationTts = await importConversationTts();
        const narrateTtsMessage = jest.fn(async () => { throw new Error('provider offline'); });
        installCapabilityRegistry([['tts', { narrateTtsMessage }]]);
        globalThis.toastr = { warning: jest.fn(), info: jest.fn() };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        await expect(conversationTts.narrateConversationMessage(
            { role: 'character', name: 'Mona', mes: 'Hello' },
            { manual: true },
        )).resolves.toBe(false);
        expect(warn).toHaveBeenCalled();
        expect(globalThis.toastr.warning).toHaveBeenCalled();
        expect(narrateTtsMessage).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ propagateErrors: true }));
    });

    test('auto narration only runs for the exact visible persona, group, and branch', async () => {
        jest.resetModules();
        const branches = new Map();
        const narrateConversationMessage = jest.fn(async () => true);
        const scheduleTimelineRender = jest.fn();
        const isConversationActiveThread = jest.fn((avatar, groupId, { branchId, personaId }) => (
            avatar === 'speaker.png'
            && groupId === 'group-a'
            && branchId === 'branch-a'
            && personaId === 'persona-a'
        ));
        const getActiveConversationBranch = jest.fn((_avatar, options = {}) => {
            const id = options.branchId || 'main';
            const key = `${options.personaId}|${options.groupId}|${id}`;
            if (!branches.has(key)) {
                branches.set(key, { id, messages: [], preview: '', updatedAt: 0 });
            }
            return branches.get(key);
        });

        await jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({
            getMessageTimeStamp: jest.fn(() => 'now'),
        }));
        await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/constants.js', () => ({
            DEFAULT_BRANCH_ID: 'main',
            MAX_THREAD_MESSAGES: 100,
            SAFE_TOAST_OPTIONS: {},
        }));
        await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
            getActiveConversationBranch,
            getConversationGroupIdForAvatar: jest.fn(() => 'group-a'),
            getConversationPersonaId: jest.fn(() => 'persona-a'),
            getConversationStore: jest.fn(() => ({ reminders: [] })),
            getConversationThreadStore: jest.fn(() => ({ activeBranchId: 'branch-a' })),
            getCurrentCharAvatar: jest.fn(() => 'speaker.png'),
            getCurrentCharName: jest.fn(() => 'Speaker'),
            parsePositiveInt: jest.fn(value => Number(value) || 0),
            persistConversationStore: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/notifications.js', () => ({
            isConversationActiveThread,
        }));
        await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({
            scheduleTimelineRender,
        }));
        await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
            getConversationSessionMarker: jest.fn(() => 0),
            resetFollowupCount: jest.fn(),
            setConversationSessionMarker: jest.fn(),
            setLastUserActivity: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({
            stripPreviewText: jest.fn(value => String(value || '').trim()),
        }));
        await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/thread-store-utils.js', () => ({
            getConversationAttachmentLabels: jest.fn(() => []),
            getConversationAttachmentSummary: jest.fn(() => ''),
            getConversationFileAttachments: jest.fn(() => []),
            getConversationMediaAttachments: jest.fn(() => []),
            getConversationMediaDisplay: jest.fn(() => ''),
            getConversationMediaIndex: jest.fn(() => 0),
            getConversationPromptMediaAttachments: jest.fn(() => []),
            hasConversationMessageContent: jest.fn(() => true),
            normalizeConversationStoredMessage: jest.fn(message => message),
            resolveConversationReminderBranchId: jest.fn(() => 'branch-a'),
            safeParseThread: jest.fn(messages => messages),
        }));
        await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/tts.js', () => ({
            narrateConversationMessage,
        }));

        const { appendConversationThreadMessage } = await import('../public/scripts/sillybunny-conversation/thread-store.js');
        appendConversationThreadMessage('speaker.png', { mes: 'other persona', role: 'character' }, {
            branchId: 'branch-a',
            groupId: 'group-a',
            personaId: 'persona-b',
        });
        appendConversationThreadMessage('speaker.png', { mes: 'other group', role: 'character' }, {
            branchId: 'branch-a',
            groupId: 'group-b',
            personaId: 'persona-a',
        });
        appendConversationThreadMessage('speaker.png', { mes: 'other branch', role: 'character' }, {
            branchId: 'branch-b',
            groupId: 'group-a',
            personaId: 'persona-a',
        });

        const visibleMessage = appendConversationThreadMessage('speaker.png', { mes: 'visible', role: 'character' }, {
            branchId: 'branch-a',
            groupId: 'group-a',
            personaId: 'persona-a',
        });
        expect(narrateConversationMessage).toHaveBeenCalledTimes(1);
        expect(narrateConversationMessage).toHaveBeenCalledWith(visibleMessage, { isStillVisible: expect.any(Function) });
        expect(scheduleTimelineRender).toHaveBeenCalledTimes(1);

        // The revalidation callback tracks live thread identity, not a stale value.
        const { isStillVisible } = narrateConversationMessage.mock.calls[0][1];
        expect(isStillVisible()).toBe(true);
        isConversationActiveThread.mockReturnValue(false);
        expect(isStillVisible()).toBe(false);
    });

    test('narrate revalidates visibility immediately before enqueue; manual Speak is unaffected', async () => {
        const context = createTtsContext({
            DEFAULT_VOICE_MARKER: '[Default Voice]',
            console: { warn: jest.fn() },
            ensureTtsProviderLoaded: jest.fn(async () => {}),
            extension_settings: { tts: { enabled: true, auto_generation: true, narrate_user: true } },
            hasVoiceMapForSpeaker: jest.fn(() => true),
            initVoiceMap: jest.fn(async () => {}),
            processAndQueueTtsMessage: jest.fn(),
            resetTtsPlayback: jest.fn(),
            toastr: { info: jest.fn(), warning: jest.fn() },
            ttsShellInitializationPromise: Promise.resolve(),
            window: { _ttsExtensionInitialized: true },
            wrapper: { update: jest.fn(async () => {}) },
        });
        const narrateTtsMessage = evaluateInContext('narrateTtsMessage', context);
        const message = { name: 'Mona', mes: 'Hello' };

        let visible = true;
        context.initVoiceMap.mockImplementationOnce(async () => { visible = false; });
        await expect(narrateTtsMessage(message, { isStillVisible: () => visible })).resolves.toBe(false);
        expect(context.processAndQueueTtsMessage).not.toHaveBeenCalled();

        // Manual Speak ignores visibility revalidation entirely.
        await expect(narrateTtsMessage(message, { manual: true, isStillVisible: () => false })).resolves.toBe(true);
        expect(context.resetTtsPlayback).toHaveBeenCalledTimes(1);
        expect(context.processAndQueueTtsMessage).toHaveBeenCalledTimes(1);

        await expect(narrateTtsMessage(message, { isStillVisible: () => true })).resolves.toBe(true);
        expect(context.processAndQueueTtsMessage).toHaveBeenCalledTimes(2);
        // Auto narration retried provider readiness on each call instead of failing permanently.
        expect(context.ensureTtsProviderLoaded).toHaveBeenCalledTimes(3);
    });

    test('provider loads run in order and A -> B -> A ends on A without reusing the stale A promise', async () => {
        const createQueue = evaluateFunction('createTtsProviderLoadQueue');
        const releases = [];
        const events = [];
        const queue = createQueue(async provider => {
            events.push(`start:${provider}`);
            await new Promise(resolve => releases.push(resolve));
            events.push(`end:${provider}`);
            return provider;
        });

        const firstA = queue('A');
        expect(queue('A')).toBe(firstA);
        const b = queue('B');
        const secondA = queue('A');
        expect(secondA).not.toBe(firstA);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(events).toEqual(['start:A']);

        releases.shift()();
        await firstA;
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(events).toEqual(['start:A', 'end:A', 'start:B']);
        releases.shift()();
        await b;
        await new Promise(resolve => setTimeout(resolve, 0));
        releases.shift()();
        await secondA;
        expect(events).toEqual(['start:A', 'end:A', 'start:B', 'end:B', 'start:A', 'end:A']);
    });

    test('serialized provider queue continues after a failed load', async () => {
        const createQueue = evaluateFunction('createTtsProviderLoadQueue');
        const queue = createQueue(async provider => {
            if (provider === 'broken') throw new Error('broken');
            return provider;
        });

        await expect(queue('broken')).rejects.toThrow('broken');
        await expect(queue('working')).resolves.toBe('working');
    });

    test('voice-map requests coalesce unrestricted and speaker flags without dropping either', async () => {
        const createInitializer = evaluateFunction('createTtsVoiceMapInitializer', { Set, Array, String, Boolean });
        let releaseFirst;
        const firstGate = new Promise(resolve => { releaseFirst = resolve; });
        const calls = [];
        const request = createInitializer(async (unrestricted, speakers) => {
            calls.push([unrestricted, [...speakers].sort()]);
            if (calls.length === 1) await firstGate;
        });

        const restricted = request(false, ['Mona']);
        expect(request(true, ['Rin'])).toBe(restricted);
        await Promise.resolve();
        expect(calls).toEqual([[false, ['Mona']]]);
        releaseFirst();
        await restricted;
        expect(calls).toEqual([[false, ['Mona']], [true, ['Rin']]]);

        const failingRequest = createInitializer(async () => { throw new Error('voices failed'); });
        await expect(failingRequest(false)).rejects.toThrow('voices failed');
    });

    test('unrestricted voice maps include the persona and requested speakers with multivoice expansion', () => {
        const context = createTtsContext({
            DEFAULT_VOICE_MARKER: '[Default Voice]',
            extension_settings: { tts: { multi_voice_enabled: true } },
            getContext: () => ({
                characters: [{ name: 'Roleplay' }],
                groupId: null,
                name1: 'Traveler',
                name2: 'Roleplay',
            }),
            onlyUnique: (value, index, array) => array.indexOf(value) === index,
        });
        evaluateInContext('expandCharactersForMultiVoice', context);
        const getCharacters = evaluateInContext('getCharacters', context);

        const names = getCharacters(true, ['Mona']);
        expect(names).toContain('[Default Voice]');
        expect(names).toContain('Traveler ("Quotes")');
        expect(names).toContain('Mona ("Quotes")');
        expect(names).toContain('Mona (*Text inside asterisks*)');
        expect(names).toContain('Mona (Other text)');

        context.extension_settings.tts.multi_voice_enabled = false;
        const plain = getCharacters(true, ['Mona']);
        expect(plain).toEqual(expect.arrayContaining(['[Default Voice]', 'Roleplay', 'Traveler', 'Mona']));
    });

    test('speaker mapping resolves expanded multivoice keys and gates enqueue', () => {
        const context = createTtsContext({
            DEFAULT_VOICE_MARKER: '[Default Voice]',
            DISABLED_VOICE_MARKER: 'disabled',
            extension_settings: { tts: { multi_voice_enabled: false } },
            voiceMap: {},
        });
        evaluateInContext('resolveSpeakerVoiceMapEntry', context);
        const hasVoiceMapForSpeaker = evaluateInContext('hasVoiceMapForSpeaker', context);

        expect(hasVoiceMapForSpeaker('Mona')).toBe(false);
        context.voiceMap.Mona = '[Default Voice]';
        expect(hasVoiceMapForSpeaker('Mona')).toBe(false);
        context.voiceMap['[Default Voice]'] = 'voice-default';
        expect(hasVoiceMapForSpeaker('Mona')).toBe(true);

        context.extension_settings.tts.multi_voice_enabled = true;
        expect(hasVoiceMapForSpeaker('Rin')).toBe(false);
        context.voiceMap['Rin ("Quotes")'] = 'voice-dialogue';
        context.voiceMap['Rin (*Text inside asterisks*)'] = 'voice-action';
        context.voiceMap['Rin (Other text)'] = 'voice-other';
        expect(hasVoiceMapForSpeaker('Rin')).toBe(true);
        // Plain-name lookups (e.g. /speak) resolve through the expanded key.
        expect(context.resolveSpeakerVoiceMapEntry('Rin')).toBe('voice-other');
    });

    function createMutexQueueScenario(SimpleMutex) {
        // Mirrors processTtsQueue(): each worker pass drains one job, then must
        // wake itself up again while SimpleMutex is still marked busy.
        return async function runScenario(scheduleWakeupFactory) {
            const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
            const processed = [];
            const ttsJobQueue = ['job1', 'job2'];
            let scheduleWakeup;
            const wrapper = new SimpleMutex(async () => {
                const job = ttsJobQueue.shift();
                await Promise.resolve();
                job && processed.push(job);
                ttsJobQueue.length > 0 && scheduleWakeup();
            });
            scheduleWakeup = scheduleWakeupFactory(wrapper);
            await wrapper.update();
            await delay(15);
            return processed;
        };
    }

    test('queue wakeup survives real SimpleMutex release timing where a microtask is swallowed', async () => {
        const { SimpleMutex } = await import('../public/scripts/util/SimpleMutex.js');
        const runScenario = createMutexQueueScenario(SimpleMutex);

        // A microtask wakeup runs before SimpleMutex clears isBusy and is dropped.
        const microtaskResult = await runScenario(wrapper => () => queueMicrotask(() => void wrapper.update()));
        expect(microtaskResult).toEqual(['job1']);

        // The shipped macrotask wakeup observes the released mutex and drains the queue.
        const macrotaskResult = await runScenario(wrapper => {
            const context = createTtsContext({ setTimeout, wrapper });
            return evaluateInContext('scheduleTtsQueueWakeup', context);
        });
        expect(macrotaskResult).toEqual(['job1', 'job2']);
    });

    test('epoch guards discard late chunks and every started job gets one terminal event', async () => {
        const emitted = [];
        const audioJobQueue = [];
        const context = createTtsContext({
            AbortController,
            AbortSignal,
            Promise,
            Symbol,
            addAudioJob: undefined,
            audioJobQueue,
            completeTtsJob: jest.fn(),
            currentTtsJob: { id: 7 },
            eventSource: { emit: jest.fn(async (event, payload) => { emitted.push([event, payload]); }) },
            event_types: { TTS_JOB_STARTED: 'started', TTS_AUDIO_READY: 'ready', TTS_JOB_COMPLETE: 'complete' },
            extension_settings: { rvc: { enabled: false } },
            isTtsProcessing: () => false,
            processAudioJobQueue: jest.fn(async () => {}),
            ttsGenerationAbortController: null,
            ttsPlaybackEpoch: 1,
            ttsProvider: null,
        });
        context.globalThis = context;
        evaluateInContext('isTtsEpochCurrent', context);
        context.addAudioJob = createEpochAwareAddAudioJob(context, audioJobQueue);
        evaluateInContext('pumpAsyncTtsResponses', context);
        const tts = evaluateInContext('tts', context);

        // Success path: single response, terminal success, provider got an abort signal.
        let providerSignal = null;
        context.ttsProvider = {
            generateTts: jest.fn(async (_text, _voice, _key, signal) => {
                providerSignal = signal;
                return 'chunk';
            }),
        };
        await tts('hello', 'voice-1', 'Mona');
        expect(providerSignal).toBeInstanceOf(AbortSignal);
        expect(audioJobQueue).toHaveLength(1);
        expect(context.completeTtsJob).toHaveBeenCalledTimes(1);
        expect(emitted.filter(([event]) => event === 'complete')).toEqual([
            ['complete', expect.objectContaining({ status: 'success' })],
        ]);

        // Cancellation path: reset (epoch bump) between generator chunks.
        emitted.length = 0;
        audioJobQueue.length = 0;
        context.completeTtsJob.mockClear();
        let releaseSecond;
        const secondGate = new Promise(resolve => { releaseSecond = resolve; });
        async function* chunks() {
            yield 'first';
            await secondGate;
            yield 'second';
        }
        context.ttsProvider = { generateTts: jest.fn(async () => chunks()) };
        const cancelled = tts('hello again', 'voice-1', 'Mona');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(audioJobQueue).toHaveLength(1);
        context.ttsPlaybackEpoch = 2;
        context.ttsGenerationAbortController?.abort();
        releaseSecond();
        await cancelled;

        expect(audioJobQueue).toHaveLength(1);
        expect(context.completeTtsJob).not.toHaveBeenCalled();
        expect(emitted.filter(([event]) => event === 'complete')).toEqual([
            ['complete', expect.objectContaining({ status: 'cancelled' })],
        ]);
    });

    test('a failed provider job still emits exactly one terminal failure event', async () => {
        const emitted = [];
        const context = createTtsContext({
            AbortController,
            AbortSignal,
            Promise,
            Symbol,
            addAudioJob: async () => null,
            completeTtsJob: jest.fn(),
            currentTtsJob: { id: 3 },
            eventSource: { emit: jest.fn(async (event, payload) => { emitted.push([event, payload]); }) },
            event_types: { TTS_JOB_STARTED: 'started', TTS_AUDIO_READY: 'ready', TTS_JOB_COMPLETE: 'complete' },
            extension_settings: { rvc: { enabled: false } },
            ttsGenerationAbortController: null,
            ttsPlaybackEpoch: 1,
            ttsProvider: { generateTts: jest.fn(async () => { throw new Error('provider exploded'); }) },
        });
        context.globalThis = context;
        evaluateInContext('isTtsEpochCurrent', context);
        evaluateInContext('pumpAsyncTtsResponses', context);
        const tts = evaluateInContext('tts', context);

        await expect(tts('text', 'voice', 'Mona')).rejects.toThrow('provider exploded');
        expect(emitted.filter(([event]) => event === 'complete')).toEqual([
            ['complete', expect.objectContaining({ status: 'error' })],
        ]);
        expect(context.completeTtsJob).not.toHaveBeenCalled();
    });

    test('capability registration happens at activation start, before shell/provider work finishes', () => {
        const initStart = ttsSource.indexOf('export function init()');
        const registerCallIndex = ttsSource.indexOf('registerTtsCapability();', initStart);
        const shellAssignIndex = ttsSource.indexOf('ttsShellInitializationPromise = initializeTtsExtension()', initStart);
        expect(registerCallIndex).toBeGreaterThan(initStart);
        expect(shellAssignIndex).toBeGreaterThan(registerCallIndex);
        // Provider load failures are non-fatal for shell initialization.
        expect(ttsSource).toContain('ttsProviderReadinessPromise = loadTtsProvider(extension_settings.tts.currentProvider);');
        expect(ttsSource).toContain('void ttsProviderReadinessPromise.catch(');
        // Direct import of the QIG entrypoint stays banned in the shared registry world.
        expect(ttsSource).toContain('registerExtensionCapability(\'tts\'');
    });
});
