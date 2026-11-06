/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

// Boots the real Quick Image Gen module against a simulated host. The browser profile
// (localStorage) and the server's settings persist across boots; everything else is
// fresh for each boot, as on a page reload.
const QIG_MODULE = '../public/scripts/extensions/quick-image-gen/index.js';
const LEGACY_QUESTION = 'legacy browser-only settings';
const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 };
const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
const EVENT_TYPES = { SETTINGS_UPDATED: 'settings_updated', MESSAGE_RECEIVED: 'message_received', CHAT_CHANGED: 'chat_changed' };
const HOST_STUB_MODULES = ['world-info.js', 'openai.js', 'utils.js', 'RossAscends-mods.js'];
const CACHE_ID_KEY = 'qig_sync_cache_id';
const CLAIM_KEY = 'qig_sync_cache_id_unconfirmed';
const SYNCHRONIZED_STORE_CACHE_KEYS = ['qig_char_settings', 'qig_char_ref_images', 'qig_configurations', 'qig_contextual_filters',
    'qig_filter_pools', 'qig_active_pool_ids_global', 'qig_active_pool_ids_by_card', 'qig_active_pool_ids_by_char',
    'qig_context_media'];
const LEGACY_CHAR_SETTINGS = JSON.stringify({ 'legacy.png': { prompt: 'legacy character prompt' } });
const LEGACY_GEN_PRESETS = JSON.stringify([{ id: 'legacy-preset', name: 'Legacy preset', provider: 'pollinations', prompt: 'legacy prompt' }]);

class MemoryStorage {
    #items = new Map();
    writes = [];
    get length() { return this.#items.size; }
    key(index) { return [...this.#items.keys()][index] ?? null; }
    getItem(key) { return this.#items.has(String(key)) ? this.#items.get(String(key)) : null; }
    setItem(key, value) {
        this.writes.push(String(key));
        this.#items.set(String(key), String(value));
    }
    removeItem(key) { this.#items.delete(String(key)); }
    clear() { this.#items.clear(); }
}

// Like the host's event emitter, emit() awaits each listener in turn.
function createEventSource() {
    const listeners = new Map();
    return {
        on(type, listener) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
        removeListener(type, listener) { listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== listener)); },
        async emit(type) {
            for (const listener of listeners.get(type) ?? []) await listener();
        },
    };
}

function createServer() {
    return { settings: { firstRun: true, extension_settings: {} } };
}

function serverQig(server) {
    return server.settings.extension_settings['quick-image-gen'];
}

// The old key layout from before server sync: browser stores without any ownership marker.
function seedLegacyProfile(profile) {
    profile.setItem('qig_char_settings', LEGACY_CHAR_SETTINGS);
    profile.setItem('qig_gen_presets', LEGACY_GEN_PRESETS);
}

/**
 * One page load. With `settingsReady` false the host's Welcome prompt is unanswered: the
 * host skips every settings save, and its saveSettings() still resolves undefined. A save
 * that goes through stores the settings and then emits SETTINGS_UPDATED, as the host does.
 * `inSession` runs after QIG's initialization, for host actions later in the same page load.
 */
async function boot(profile, server, { settingsReady = false, legacyAnswer = 'cancel', userHandle = 'default-user', inSession = null } = {}) {
    jest.resetModules();
    const extensionSettings = JSON.parse(JSON.stringify(server.settings.extension_settings));
    const eventSource = createEventSource();
    let hostReady = settingsReady;
    const questions = [];
    const ready = [];
    globalThis.localStorage = profile;
    globalThis.jQuery = callback => { ready.push(callback); };
    globalThis.fetch = jest.fn(async (url) => url === '/api/settings/get'
        ? Response.json({ settings: JSON.stringify(server.settings) })
        : new Response('', { status: 404 }));

    const saveSettings = jest.fn(async () => {
        if (!hostReady) return;
        server.settings = { ...server.settings, extension_settings: JSON.parse(JSON.stringify(extensionSettings)) };
        await eventSource.emit(EVENT_TYPES.SETTINGS_UPDATED);
    });
    jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
        extension_settings: extensionSettings,
        getContext: () => ({}),
    }));
    jest.unstable_mockModule('../public/script.js', () => ({
        saveSettings,
        saveSettingsDebounced: jest.fn(),
        generateQuietPrompt: jest.fn(),
        generateRaw: jest.fn(),
        generateRawData: jest.fn(),
        createRawPrompt: jest.fn(),
        substituteParams: value => value,
        getRequestHeaders: () => ({}),
        eventSource,
        event_types: EVENT_TYPES,
    }));
    jest.unstable_mockModule('../public/scripts/popup.js', () => ({
        POPUP_TYPE,
        POPUP_RESULT,
        callGenericPopup: jest.fn(async (content) => {
            if (!String(content).includes(LEGACY_QUESTION)) return POPUP_RESULT.NEGATIVE;
            questions.push(String(content));
            return legacyAnswer === 'import' ? POPUP_RESULT.AFFIRMATIVE : POPUP_RESULT.NEGATIVE;
        }),
    }));
    jest.unstable_mockModule('../public/scripts/user.js', () => ({
        getCurrentUserHandle: () => userHandle,
    }));
    for (const name of HOST_STUB_MODULES) {
        jest.unstable_mockModule(`../public/scripts/${name}`, () => ({}));
    }

    const qig = await import(QIG_MODULE);
    for (const callback of ready) callback();
    // Initialization stops at the UI, which this host does not provide. The settings
    // load and its first synchronization have finished by then.
    await qig.ensureQuickImageGenReady(0).catch(() => {});
    await inSession?.({
        save: saveSettings,
        answerWelcome: () => {
            hostReady = true;
            return saveSettings();
        },
        emitSettingsUpdated: () => eventSource.emit(EVENT_TYPES.SETTINGS_UPDATED),
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    qig.deactivate();
    return { questions: questions.length, settings: extensionSettings['quick-image-gen'] };
}

describe('Quick Image Gen legacy import question', () => {
    beforeEach(() => {
        globalThis.window = globalThis;
        globalThis.addEventListener = () => {};
        globalThis.removeEventListener = () => {};
        globalThis.document = {
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {},
            removeEventListener: () => {},
        };
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        for (const name of ['window', 'addEventListener', 'removeEventListener', 'document', 'localStorage', 'jQuery', 'fetch']) {
            delete globalThis[name];
        }
    });

    test('keeps its own caches without asking while the Welcome prompt stays unanswered', async () => {
        const profile = new MemoryStorage();
        const server = createServer();
        const first = await boot(profile, server);
        const ownConfigurations = profile.getItem('qig_configurations');
        expect(JSON.parse(ownConfigurations)).toHaveLength(3);
        expect(serverQig(server)).toBeUndefined();
        expect(profile.getItem(CACHE_ID_KEY)).toBeNull();

        const asked = [first.questions];
        const cacheIds = new Set([first.settings._syncCacheId]);
        for (let index = 0; index < 3; index++) {
            const { questions, settings } = await boot(profile, server);
            asked.push(questions);
            cacheIds.add(settings._syncCacheId);
        }
        expect(asked).toEqual([0, 0, 0, 0]);
        expect([...cacheIds]).toEqual([first.settings._syncCacheId]);
        expect(profile.getItem('qig_configurations')).toBe(ownConfigurations);

        const answered = await boot(profile, server, { settingsReady: true });
        expect(answered.questions).toBe(0);
        expect(serverQig(server)._syncCacheId).toBe(first.settings._syncCacheId);
        expect(serverQig(server)._backupConfigurations).toEqual(JSON.parse(ownConfigurations));
        expect(profile.getItem(CACHE_ID_KEY)).toBe(first.settings._syncCacheId);
        expect((await boot(profile, server, { settingsReady: true })).questions).toBe(0);
        expect(profile.getItem(CLAIM_KEY)).toBeNull();
    });

    test('still asks about real legacy data on every boot until it is answered', async () => {
        const profile = new MemoryStorage();
        const server = createServer();
        seedLegacyProfile(profile);
        const asked = [];
        for (let index = 0; index < 3; index++) {
            asked.push((await boot(profile, server)).questions);
        }
        expect(asked).toEqual([1, 1, 1]);
        expect(profile.getItem('qig_char_settings')).toBe(LEGACY_CHAR_SETTINGS);
        expect(profile.getItem('qig_gen_presets')).toBe(LEGACY_GEN_PRESETS);
    });

    test('imports approved legacy data into the current server user', async () => {
        const profile = new MemoryStorage();
        const server = createServer();
        seedLegacyProfile(profile);
        const { questions } = await boot(profile, server, { settingsReady: true, legacyAnswer: 'import' });
        expect(questions).toBe(1);
        expect(serverQig(server)._backupCharSettings).toEqual(JSON.parse(LEGACY_CHAR_SETTINGS));
        expect(serverQig(server)._backupConfigurations.map(record => record.name)).toContain('Legacy preset');
        expect(profile.getItem(CACHE_ID_KEY)).toBe(serverQig(server)._syncCacheId);
        expect((await boot(profile, server, { settingsReady: true })).questions).toBe(0);
    });

    test('does not ask again about an approved import while saves keep failing', async () => {
        const profile = new MemoryStorage();
        const server = createServer();
        seedLegacyProfile(profile);
        expect((await boot(profile, server, { legacyAnswer: 'import' })).questions).toBe(1);
        const { questions, settings } = await boot(profile, server);
        expect(questions).toBe(0);
        expect(settings._backupCharSettings).toEqual(JSON.parse(LEGACY_CHAR_SETTINGS));
    });

    test('quarantines declined legacy data', async () => {
        const profile = new MemoryStorage();
        const server = createServer();
        seedLegacyProfile(profile);
        const { questions } = await boot(profile, server, { settingsReady: true, legacyAnswer: 'cancel' });
        expect(questions).toBe(1);
        expect(serverQig(server)._backupCharSettings).toEqual({});
        expect(serverQig(server)._backupConfigurations.map(record => record.name)).not.toContain('Legacy preset');
        expect(profile.getItem('qig_char_settings')).toBe(LEGACY_CHAR_SETTINGS);
        expect(profile.getItem('qig_gen_presets')).toBe(LEGACY_GEN_PRESETS);
        expect(profile.getItem(CACHE_ID_KEY)).toBeNull();
        expect(profile.getItem(CLAIM_KEY)).toBeNull();
    });

    test('asks another server user about caches written for the first one', async () => {
        const profile = new MemoryStorage();
        const alice = createServer();
        expect((await boot(profile, alice, { userHandle: 'alice' })).questions).toBe(0);
        expect((await boot(profile, createServer(), { userHandle: 'bob' })).questions).toBe(1);
        // The other user's boot rewrites the caches, so the first user's claim ends there.
        expect((await boot(profile, alice, { userHandle: 'alice' })).questions).toBe(1);
    });

    test('asks again when the server lost settings that this browser had confirmed', async () => {
        const profile = new MemoryStorage();
        const server = createServer();
        expect((await boot(profile, server, { settingsReady: true })).questions).toBe(0);
        expect(profile.getItem(CACHE_ID_KEY)).toBe(serverQig(server)._syncCacheId);
        server.settings = createServer().settings;
        expect((await boot(profile, server, { settingsReady: true })).questions).toBe(1);
    });

    test('asks again when the server lost settings that this browser had confirmed, despite a leftover claim', async () => {
        const profile = new MemoryStorage();
        const server = createServer();
        const first = await boot(profile, server, { settingsReady: true });
        expect(profile.getItem(CACHE_ID_KEY)).toBe(first.settings._syncCacheId);
        // A failed readback after the host save keeps the claim, while QIG's own confirmation writes the marker.
        profile.setItem(CLAIM_KEY, JSON.stringify({ id: first.settings._syncCacheId, user: 'default-user' }));
        server.settings = createServer().settings;
        expect((await boot(profile, server, { settingsReady: true })).questions).toBe(1);
    });

    test('removes the claim once a host save in the same session stores the claimed id', async () => {
        const profile = new MemoryStorage();
        const server = createServer();
        const first = await boot(profile, server, { inSession: host => host.answerWelcome() });
        expect(first.questions).toBe(0);
        expect(serverQig(server)._syncCacheId).toBe(first.settings._syncCacheId);
        expect(profile.getItem(CLAIM_KEY)).toBeNull();

        const next = await boot(profile, server, { settingsReady: true });
        expect(next.questions).toBe(0);
        expect(next.settings._syncCacheId).toBe(first.settings._syncCacheId);
        expect(profile.getItem(CACHE_ID_KEY)).toBe(first.settings._syncCacheId);
    });

    test('stops reading the settings back once the server holds the claimed id', async () => {
        let readbacksAfterRemoval = null;
        await boot(new MemoryStorage(), createServer(), {
            inSession: async (host) => {
                await host.answerWelcome();
                await new Promise(resolve => setTimeout(resolve, 0));
                const readbacks = globalThis.fetch.mock.calls.length;
                await host.save();
                await new Promise(resolve => setTimeout(resolve, 0));
                readbacksAfterRemoval = globalThis.fetch.mock.calls.length - readbacks;
            },
        });
        expect(readbacksAfterRemoval).toBe(0);
    });

    test('checks again on the next settings save when the claim could not be removed', async () => {
        const profile = new MemoryStorage();
        const removeItem = profile.removeItem.bind(profile);
        let failClaimRemoval = false;
        profile.removeItem = (key) => {
            if (key === CLAIM_KEY && failClaimRemoval) {
                failClaimRemoval = false;
                throw new Error('storage is unavailable');
            }
            removeItem(key);
        };
        await boot(profile, createServer(), {
            inSession: async (host) => {
                failClaimRemoval = true;
                await host.answerWelcome();
                await new Promise(resolve => setTimeout(resolve, 0));
                expect(profile.getItem(CLAIM_KEY)).not.toBeNull();
                await host.save();
            },
        });
        expect(profile.getItem(CLAIM_KEY)).toBeNull();
    });

    test('leaves a claim that another page load on this origin wrote in the meantime', async () => {
        const profile = new MemoryStorage();
        const otherClaim = JSON.stringify({ id: 'claim-of-another-page-load', user: 'bob' });
        await boot(profile, createServer(), {
            inSession: async (host) => {
                profile.setItem(CLAIM_KEY, otherClaim);
                await host.answerWelcome();
            },
        });
        expect(profile.getItem(CLAIM_KEY)).toBe(otherClaim);
    });

    test('keeps the claim when a settings save did not store the claimed id', async () => {
        const profile = new MemoryStorage();
        const server = createServer();
        const first = await boot(profile, server, { inSession: host => host.emitSettingsUpdated() });
        expect(JSON.parse(profile.getItem(CLAIM_KEY)).id).toBe(first.settings._syncCacheId);

        const next = await boot(profile, server);
        expect(next.questions).toBe(0);
        expect(next.settings._syncCacheId).toBe(first.settings._syncCacheId);
    });

    test.each([
        ['another server with the same user handle', () => createServer()],
        ['the same server after it lost its settings', (server) => {
            server.settings = createServer().settings;
            return server;
        }],
    ])('asks about the browser data on %s once a host save stored the claimed id', async (_, nextServer) => {
        const profile = new MemoryStorage();
        const server = createServer();
        const first = await boot(profile, server, { inSession: host => host.answerWelcome() });
        const { questions, settings } = await boot(profile, nextServer(server));
        expect(questions).toBe(1);
        expect(settings._syncCacheId).not.toBe(first.settings._syncCacheId);
    });

    test('lets the server win over a stale claim once the server has another sync id', async () => {
        const profile = new MemoryStorage();
        const server = createServer();
        const first = await boot(profile, server);
        const otherDevice = await boot(new MemoryStorage(), server, { settingsReady: true, inSession: host => host.save() });
        expect(otherDevice.settings._syncCacheId).not.toBe(first.settings._syncCacheId);
        const serverConfigurations = serverQig(server)._backupConfigurations;

        const { questions, settings } = await boot(profile, server, { settingsReady: true });
        expect(questions).toBe(0);
        expect(settings._syncCacheId).toBe(otherDevice.settings._syncCacheId);
        expect(serverQig(server)._backupConfigurations).toEqual(serverConfigurations);
        expect(JSON.parse(profile.getItem('qig_configurations'))).toEqual(serverConfigurations);
        expect(profile.getItem(CLAIM_KEY)).toBeNull();
    });

    test('writes the claim before the caches, so that a page closed mid-boot leaves no unclaimed caches', async () => {
        const profile = new MemoryStorage();
        await boot(profile, createServer());
        const claimWrite = profile.writes.indexOf(CLAIM_KEY);
        expect(claimWrite).toBeGreaterThanOrEqual(0);
        expect(profile.writes.findIndex(key => SYNCHRONIZED_STORE_CACHE_KEYS.includes(key))).toBeGreaterThan(claimWrite);
    });
});
