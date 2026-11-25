/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (index < values.length ? values[index] : ''), ''),
}));
const {
    DEFAULT_SETTINGS,
    ROW_SOURCES,
    createSaveQueue,
    createServerRequestSettings,
    describeControls,
    describeLocks,
    isPromptCachingOn,
    masterSwitchPatch,
    matchesSource,
    mergePatches,
    normalizeSettings,
    planMasterChange,
} = await import('../../public/scripts/sillybunny-server-request-settings.js');

const GET = '/api/server-admin/config/chat-completions/get';
const SAVE = '/api/server-admin/config/chat-completions/save';
const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

const settings = (claude = {}, gemini = {}) => ({
    claude: { ...DEFAULT_SETTINGS.claude, ...claude },
    gemini: { ...DEFAULT_SETTINGS.gemini, ...gemini },
});

describe('the Prompt Caching switch is a view over three keys', () => {
    test('is off for the defaults', () => {
        expect(isPromptCachingOn(normalizeSettings(null))).toBe(false);
        expect(isPromptCachingOn(normalizeSettings({}))).toBe(false);
    });

    test.each([
        ['the Claude flag', settings({ enableSystemPromptCache: true })],
        ['the Gemini flag', settings({}, { enableSystemPromptCache: true })],
        ['a depth of zero', settings({ cachingAtDepth: 0 })],
        ['a depth above zero', settings({ cachingAtDepth: 4 })],
    ])('is on while %s still places a cache marker', (_name, value) => {
        expect(isPromptCachingOn(value)).toBe(true);
    });

    test('treats a negative depth as -1 and a depth that is not a number as the default', () => {
        expect(normalizeSettings({ claude: { cachingAtDepth: -7 } }).claude.cachingAtDepth).toBe(-1);
        expect(normalizeSettings({ claude: { cachingAtDepth: 'abc' } }).claude.cachingAtDepth).toBe(-1);
        expect(normalizeSettings({ claude: { cachingAtDepth: '3' } }).claude.cachingAtDepth).toBe(3);
    });

    test('keeps every key of the reply and fills the missing ones', () => {
        expect(normalizeSettings({ gemini: { apiVersion: '  v1  ', thoughtSignatures: false } })).toEqual({
            claude: DEFAULT_SETTINGS.claude,
            gemini: { apiVersion: 'v1', thoughtSignatures: false, enableSystemPromptCache: false },
        });
        expect(normalizeSettings({ gemini: { apiVersion: '   ' } }).gemini.apiVersion).toBe('v1beta');
    });
});

describe('what the master switch writes', () => {
    test('turning it off clears both flags and the depth', () => {
        expect(masterSwitchPatch(false)).toEqual({
            claude: { enableSystemPromptCache: false, cachingAtDepth: -1 },
            gemini: { enableSystemPromptCache: false },
        });
    });

    test('turning it on sets the Claude flag and leaves the Gemini flag alone, with depth 0 when there is no depth to write back', () => {
        expect(masterSwitchPatch(true)).toEqual({ claude: { enableSystemPromptCache: true, cachingAtDepth: 0 } });
        expect(masterSwitchPatch(true, -1)).toEqual({ claude: { enableSystemPromptCache: true, cachingAtDepth: 0 } });
    });

    test('turning it on writes back the remembered depth', () => {
        expect(masterSwitchPatch(true, 2)).toEqual({ claude: { enableSystemPromptCache: true, cachingAtDepth: 2 } });
        expect(masterSwitchPatch(true, 0).claude.cachingAtDepth).toBe(0);
    });

    test('turning it off remembers the depth the row shows, and a depth of -1 leaves nothing to remember', () => {
        expect(planMasterChange({ on: false, depthShown: 3, rememberedDepth: null }).rememberedDepth).toBe(3);
        expect(planMasterChange({ on: false, depthShown: -1, rememberedDepth: 3 }).rememberedDepth).toBeNull();
    });

    test('turning it on keeps the remembered depth until the server confirms it', () => {
        const plan = planMasterChange({ on: true, depthShown: 3, rememberedDepth: 3 });
        expect(plan.rememberedDepth).toBe(3);
        expect(plan.patch.claude.cachingAtDepth).toBe(3);
    });

    test('the depth row shows the remembered depth only while the switch is off', () => {
        const off = settings();
        expect(describeControls(off, 2).depth).toBe(2);
        expect(describeControls(off, null).depth).toBe(-1);
        expect(describeControls(settings({ cachingAtDepth: 5 }), 2).depth).toBe(5);
        expect(describeControls(settings({ enableSystemPromptCache: true }), 2).depth).toBe(-1);
    });
});

describe('patches, locks and sources', () => {
    test('a later patch wins and every key of every patch stays', () => {
        expect(mergePatches(null, { claude: { cachingAtDepth: 1 } }, { claude: { extendedTTL: true }, gemini: { apiVersion: 'v1' } }, { claude: { cachingAtDepth: 2 } }))
            .toEqual({ claude: { cachingAtDepth: 2, extendedTTL: true }, gemini: { apiVersion: 'v1' } });
        expect(mergePatches()).toEqual({});
    });

    test('a missing envManaged list locks nothing', () => {
        expect(Object.values(describeLocks(undefined)).some(Boolean)).toBe(false);
        expect(Object.values(describeLocks('claude.extendedTTL')).some(Boolean)).toBe(false);
    });

    test('a key that an environment variable sets locks its row, whatever its case', () => {
        expect(describeLocks(['claude.extendedTTL'])).toMatchObject({ extendedTtl: true, depth: false, caching: false });
        expect(describeLocks(['GEMINI.APIVERSION'])).toMatchObject({ apiVersion: true });
    });

    test.each(['claude.enableSystemPromptCache', 'gemini.enableSystemPromptCache', 'claude.cachingAtDepth'])('%s locks the master switch', key => {
        expect(describeLocks([key]).caching).toBe(true);
    });

    test('a row shows for the sources that read its key, and a borrowed form matches the source it borrows', () => {
        expect(matchesSource(ROW_SOURCES.adaptiveThinking, 'claude')).toBe(true);
        expect(matchesSource(ROW_SOURCES.adaptiveThinking, 'openrouter')).toBe(false);
        expect(matchesSource(ROW_SOURCES.apiVersion, 'vertexai')).toBe(false);
        expect(matchesSource(ROW_SOURCES.thoughtSignatures, 'openrouter')).toBe(true);
        expect(matchesSource('openai', 'openai_responses')).toBe(true);
        expect(matchesSource('makersuite', 'gemini_interactions')).toBe(true);
    });
});

describe('the save queue', () => {
    function deferred() {
        let resolve;
        let reject;
        const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
        return { promise, resolve, reject };
    }

    test('never runs two saves at once and joins the changes made meanwhile', async () => {
        const first = deferred();
        const send = jest.fn()
            .mockImplementationOnce(() => first.promise)
            .mockResolvedValue({ settings: {} });
        const onSaved = jest.fn();
        const queue = createSaveQueue({ send, onSaved, onFailed: jest.fn() });
        queue.push({ claude: { cachingAtDepth: 1 } });
        queue.push({ claude: { extendedTTL: true } });
        queue.push({ claude: { cachingAtDepth: 4 } });
        expect(send).toHaveBeenCalledTimes(1);
        expect(queue.busy).toBe(true);
        first.resolve({ settings: {} });
        await settle();
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenLastCalledWith({ claude: { cachingAtDepth: 4, extendedTTL: true } });
        expect(onSaved.mock.calls.map(call => call[1].queued)).toEqual([true, false]);
        expect(queue.busy).toBe(false);
    });

    test('a failed save drops the changes that wait and reports once', async () => {
        const first = deferred();
        const send = jest.fn(() => first.promise);
        const onFailed = jest.fn();
        const queue = createSaveQueue({ send, onSaved: jest.fn(), onFailed });
        queue.push({ claude: { cachingAtDepth: 1 } });
        queue.push({ claude: { extendedTTL: true } });
        first.reject(new Error('refused'));
        await settle();
        expect(send).toHaveBeenCalledTimes(1);
        expect(onFailed).toHaveBeenCalledTimes(1);
        expect(onFailed.mock.calls[0][0].message).toBe('refused');
        expect(queue.busy).toBe(false);
        queue.push({ claude: { extendedTTL: false } });
        expect(send).toHaveBeenCalledTimes(2);
    });
});

describe('the rows of Presets', () => {
    let requests;
    let routes;
    let notify;
    let controller;
    let shown;
    let source;
    let admin;

    const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
    const fakeFetch = async (url, init) => {
        const body = JSON.parse(init.body);
        requests.push({ url, body, method: init.method });
        return routes[url](body);
    };
    const row = id => document.getElementById(id).closest('.ds-row');
    const control = id => document.getElementById(id);

    function build(options = {}) {
        document.body.innerHTML = `<div id="range">
            <section id="sb-openai-request"><div class="sb-prompting-group-body">
                <div class="ds-row" data-sb-editor-field="openai_reasoning_effort"></div>
                <div class="ds-row" data-sb-editor-field="openai_verbosity"></div>
            </div></section>
            <section id="sb-openai-reasoning-tags" data-sb-request-set></section>
        </div>`;
        const request = document.getElementById('sb-openai-request');
        controller = createServerRequestSettings({
            request,
            body: request.querySelector('.sb-prompting-group-body'),
            createGroup: ({ id, title }) => {
                const section = document.createElement('section');
                section.id = id;
                const body = document.createElement('div');
                body.className = 'sb-prompting-group-body';
                section.append(body);
                section.dataset.title = title;
                return { section, body };
            },
            fetch: fakeFetch,
            getHeaders: async () => ({}),
            notify,
            getSource: () => source,
            isShown: () => shown,
            isAdmin: async () => admin,
            ...options,
        });
    }

    async function ready(serverSettings = settings(), extra = {}) {
        routes[GET] = () => reply({ settings: serverSettings, lastModifiedMs: 1, ...extra });
        routes[SAVE] = body => reply({ settings: mergePatches(serverSettings, body.settings), lastModifiedMs: 2, ...extra });
        build();
        await settle();
    }

    beforeEach(() => {
        requests = [];
        routes = {};
        notify = jest.fn();
        shown = true;
        source = 'claude';
        admin = true;
    });

    test('waits for the page to show before the first read, and reads again when the page is shown', async () => {
        shown = false;
        routes[GET] = () => reply({ settings: settings() });
        build();
        await settle();
        expect(requests).toHaveLength(0);
        expect(document.getElementById('sb-openai-prompt-caching')).toBeNull();
        document.dispatchEvent(new CustomEvent('sb:shell-tab-activated', { detail: { shellKey: 'left', tabId: 'sampling' } }));
        await settle();
        expect(requests).toHaveLength(0);
        document.dispatchEvent(new CustomEvent('sb:shell-tab-activated', { detail: { shellKey: 'left', tabId: 'prompting' } }));
        await settle();
        expect(requests.map(call => call.url)).toEqual([GET]);
        expect(document.getElementById('sb-openai-prompt-caching')).not.toBeNull();
        document.dispatchEvent(new CustomEvent('sb:shell-tab-activated', { detail: { shellKey: 'left', tabId: 'prompting' } }));
        await settle();
        expect(requests.map(call => call.url)).toEqual([GET, GET]);
        controller.destroy();
    });

    test('places the group after the last request set and the three rows in Request Options', async () => {
        await ready();
        const order = [...document.getElementById('range').children].map(node => node.id);
        expect(order).toEqual(['sb-openai-request', 'sb-openai-reasoning-tags', 'sb-openai-prompt-caching']);
        const group = document.getElementById('sb-openai-prompt-caching');
        expect(group.hasAttribute('data-sb-request-set')).toBe(true);
        expect(group.querySelector('.sb-prompting-group-body').dataset.sbEnabledBy).toBe('#sb-config-prompt-caching-enabled');
        expect([...group.querySelectorAll('.ds-row')].map(node => node.querySelector('input').id)).toEqual([
            'sb-config-prompt-caching-enabled', 'sb-config-claude-caching-depth', 'sb-config-claude-extended-ttl',
        ]);
        const body = document.querySelector('#sb-openai-request .sb-prompting-group-body');
        expect([...body.children].map(node => node.querySelector('input')?.id ?? node.dataset.sbEditorField)).toEqual([
            'openai_reasoning_effort', 'sb-config-claude-adaptive-thinking', 'openai_verbosity', 'sb-config-gemini-api-version', 'sb-config-gemini-thought-signatures',
        ]);
        expect(group.querySelector('h3, .ds-row-label')).not.toBeNull();
        controller.destroy();
    });

    test('shows each control with the settings of the reply', async () => {
        await ready(settings({ enableSystemPromptCache: true, cachingAtDepth: 2, extendedTTL: true, enableAdaptiveThinking: false }, { apiVersion: 'v1', thoughtSignatures: false }));
        expect(control('sb-config-prompt-caching-enabled').checked).toBe(true);
        expect(control('sb-config-claude-caching-depth').value).toBe('2');
        expect(control('sb-config-claude-extended-ttl').checked).toBe(true);
        expect(control('sb-config-claude-adaptive-thinking').checked).toBe(false);
        expect(control('sb-config-gemini-api-version').value).toBe('v1');
        expect(control('sb-config-gemini-thought-signatures').checked).toBe(false);
        controller.destroy();
    });

    test('holds the depth and Extended Cache TTL insensitive while the switch is off', async () => {
        await ready();
        expect(control('sb-config-claude-caching-depth').disabled).toBe(true);
        expect(control('sb-config-claude-extended-ttl').disabled).toBe(true);
        expect(row('sb-config-claude-caching-depth').classList.contains('is-insensitive')).toBe(true);
        expect(control('sb-config-claude-adaptive-thinking').disabled).toBe(false);
        control('sb-config-prompt-caching-enabled').click();
        expect(control('sb-config-claude-caching-depth').disabled).toBe(false);
        expect(control('sb-config-claude-extended-ttl').disabled).toBe(false);
        await settle();
        controller.destroy();
    });

    test('marks the two dependent rows as owned, so the dependent-set binder leaves them to the module', async () => {
        await ready();
        expect(row('sb-config-claude-caching-depth').hasAttribute('data-sb-sensitivity-owned')).toBe(true);
        expect(row('sb-config-claude-extended-ttl').hasAttribute('data-sb-sensitivity-owned')).toBe(true);
        controller.destroy();
    });

    test('a first enable saves the Claude flag and depth 0 and nothing else, with no restart', async () => {
        await ready();
        control('sb-config-prompt-caching-enabled').click();
        expect(control('sb-config-claude-caching-depth').value).toBe('0');
        await settle();
        expect(requests.filter(call => call.url === SAVE)).toEqual([{
            url: SAVE,
            method: 'POST',
            body: { settings: { claude: { enableSystemPromptCache: true, cachingAtDepth: 0 } } },
        }]);
        expect(control('sb-config-claude-caching-depth').value).toBe('0');
        controller.destroy();
    });

    test('turning the switch off keeps the depth in view and turning it on writes it back', async () => {
        await ready(settings({ enableSystemPromptCache: true, cachingAtDepth: 2 }, { enableSystemPromptCache: true }));
        control('sb-config-prompt-caching-enabled').click();
        await settle();
        expect(requests.at(-1).body).toEqual({ settings: { claude: { enableSystemPromptCache: false, cachingAtDepth: -1 }, gemini: { enableSystemPromptCache: false } } });
        expect(control('sb-config-prompt-caching-enabled').checked).toBe(false);
        expect(control('sb-config-claude-caching-depth').value).toBe('2');
        expect(control('sb-config-claude-caching-depth').disabled).toBe(true);
        control('sb-config-prompt-caching-enabled').click();
        await settle();
        expect(requests.at(-1).body).toEqual({ settings: { claude: { enableSystemPromptCache: true, cachingAtDepth: 2 } } });
        expect(control('sb-config-claude-caching-depth').value).toBe('2');
        controller.destroy();
    });

    test('shows the switch on while only the depth still places a marker', async () => {
        await ready(settings({ cachingAtDepth: 3 }));
        expect(control('sb-config-prompt-caching-enabled').checked).toBe(true);
        expect(control('sb-config-claude-caching-depth').disabled).toBe(false);
        controller.destroy();
    });

    test.each([
        ['the depth', 'sb-config-claude-caching-depth', input => { input.value = '4'; }, { claude: { cachingAtDepth: 4 } }, settings({ enableSystemPromptCache: true })],
        ['Extended Cache TTL', 'sb-config-claude-extended-ttl', input => input.click(), { claude: { extendedTTL: true } }, settings({ enableSystemPromptCache: true })],
        ['Adaptive Thinking', 'sb-config-claude-adaptive-thinking', input => input.click(), { claude: { enableAdaptiveThinking: false } }, settings()],
        ['the API version', 'sb-config-gemini-api-version', input => { input.value = ' v1 '; }, { gemini: { apiVersion: 'v1' } }, settings()],
        ['Thought Signatures', 'sb-config-gemini-thought-signatures', input => input.click(), { gemini: { thoughtSignatures: false } }, settings()],
    ])('%s saves only its own key', async (_name, id, edit, patch, initial) => {
        await ready(initial);
        const input = control(id);
        edit(input);
        if (input.type !== 'checkbox') input.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(requests.filter(call => call.url === SAVE).map(call => call.body)).toEqual([{ settings: patch }]);
        controller.destroy();
    });

    test('rounds a depth that is not a whole number and cannot go under -1', async () => {
        await ready(settings({ enableSystemPromptCache: true }));
        const input = control('sb-config-claude-caching-depth');
        input.value = '2.6';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(requests.at(-1).body).toEqual({ settings: { claude: { cachingAtDepth: 3 } } });
        input.value = '-9';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(requests.at(-1).body).toEqual({ settings: { claude: { cachingAtDepth: -1 } } });
        controller.destroy();
    });

    test('does not save an API version that did not change', async () => {
        await ready();
        const input = control('sb-config-gemini-api-version');
        input.value = 'v1beta ';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(requests.filter(call => call.url === SAVE)).toHaveLength(0);
        controller.destroy();
    });

    test('queues the changes made while a save runs and sends them as one', async () => {
        await ready(settings({ enableSystemPromptCache: true }));
        let server = settings({ enableSystemPromptCache: true });
        let release;
        routes[SAVE] = body => new Promise(resolve => {
            server = mergePatches(server, body.settings);
            release = () => resolve(reply({ settings: server }));
        });
        control('sb-config-claude-extended-ttl').click();
        control('sb-config-claude-adaptive-thinking').click();
        control('sb-config-gemini-thought-signatures').click();
        await settle();
        expect(requests.filter(call => call.url === SAVE)).toHaveLength(1);
        release();
        await settle();
        release();
        await settle();
        const saves = requests.filter(call => call.url === SAVE).map(call => call.body.settings);
        expect(saves).toEqual([
            { claude: { extendedTTL: true } },
            { claude: { enableAdaptiveThinking: false }, gemini: { thoughtSignatures: false } },
        ]);
        expect(control('sb-config-claude-extended-ttl').checked).toBe(true);
        expect(control('sb-config-claude-adaptive-thinking').checked).toBe(false);
        expect(control('sb-config-gemini-thought-signatures').checked).toBe(false);
        controller.destroy();
    });

    test('restores the controls from the last known settings and shows one toast when a save fails', async () => {
        await ready(settings({ enableSystemPromptCache: true }));
        routes[SAVE] = () => reply({ error: 'config.yaml is read-only' }, 500);
        control('sb-config-claude-extended-ttl').click();
        control('sb-config-gemini-thought-signatures').click();
        await settle();
        expect(control('sb-config-claude-extended-ttl').checked).toBe(false);
        expect(control('sb-config-gemini-thought-signatures').checked).toBe(true);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith('config.yaml is read-only', 'Server config');
        expect(requests.filter(call => call.url === SAVE)).toHaveLength(1);
        controller.destroy();
    });

    test('does not draw a reply over a change that waits behind it', async () => {
        await ready(settings({ enableSystemPromptCache: true }));
        const finished = [];
        routes[SAVE] = body => new Promise(resolve => finished.push(() => resolve(reply({ settings: mergePatches(settings({ enableSystemPromptCache: true }), body.settings) }))));
        control('sb-config-claude-extended-ttl').click();
        await settle();
        control('sb-config-claude-extended-ttl').click();
        await settle();
        finished.shift()();
        await settle();
        expect(control('sb-config-claude-extended-ttl').checked).toBe(false);
        finished.shift()();
        await settle();
        expect(control('sb-config-claude-extended-ttl').checked).toBe(false);
        expect(requests.filter(call => call.url === SAVE).map(call => call.body.settings)).toEqual([{ claude: { extendedTTL: true } }, { claude: { extendedTTL: false } }]);
        controller.destroy();
    });

    test('shows none of the rows when the read is refused, and no error', async () => {
        routes[GET] = () => reply({ error: 'Forbidden' }, 403);
        build();
        await settle();
        expect(document.getElementById('sb-openai-prompt-caching')).toBeNull();
        expect(document.querySelectorAll('[data-source]')).toHaveLength(0);
        expect(document.getElementById('sb-config-claude-adaptive-thinking')).toBeNull();
        expect(notify).not.toHaveBeenCalled();
        controller.destroy();
    });

    test('asks the server nothing and shows none of the rows for a user who is not an admin', async () => {
        admin = false;
        routes[GET] = () => reply({ settings: settings() });
        build();
        await settle();
        expect(requests).toHaveLength(0);
        expect(document.getElementById('sb-openai-prompt-caching')).toBeNull();
        expect(document.getElementById('sb-config-claude-adaptive-thinking')).toBeNull();
        expect(notify).not.toHaveBeenCalled();
        controller.destroy();
    });

    test('takes the rows out when a later read is refused', async () => {
        await ready();
        expect(document.getElementById('sb-openai-prompt-caching')).not.toBeNull();
        routes[GET] = () => reply({ error: 'Forbidden' }, 403);
        await controller.refresh();
        expect(document.getElementById('sb-openai-prompt-caching')).toBeNull();
        expect(document.getElementById('sb-config-gemini-api-version')).toBeNull();
        controller.destroy();
    });

    test('hides the rows and shows one toast for a failed read that is not a refusal', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        routes[GET] = () => reply({ error: 'Failed to read config.yaml' }, 500);
        build();
        await settle();
        await controller.refresh();
        expect(document.getElementById('sb-openai-prompt-caching')).toBeNull();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith('Failed to read config.yaml', 'Server config');
        warn.mockRestore();
        controller.destroy();
    });

    test('locks a row whose key an environment variable sets', async () => {
        await ready(settings({ enableSystemPromptCache: true, extendedTTL: true }), { envManaged: ['claude.extendedTTL', 'gemini.thoughtSignatures'] });
        expect(control('sb-config-claude-extended-ttl').disabled).toBe(true);
        expect(row('sb-config-claude-extended-ttl').classList.contains('is-insensitive')).toBe(true);
        expect(control('sb-config-gemini-thought-signatures').disabled).toBe(true);
        expect(control('sb-config-claude-caching-depth').disabled).toBe(false);
        expect(control('sb-config-prompt-caching-enabled').disabled).toBe(false);
        controller.destroy();
    });

    test('locks the master switch when one of its keys is set by the environment, and keeps the depth row sensitive', async () => {
        await ready(settings({ enableSystemPromptCache: true }), { envManaged: ['gemini.enableSystemPromptCache'] });
        expect(control('sb-config-prompt-caching-enabled').disabled).toBe(true);
        expect(control('sb-config-claude-caching-depth').disabled).toBe(false);
        controller.destroy();
    });

    test('lifts a lock that a later reply no longer reports', async () => {
        await ready(settings({ enableSystemPromptCache: true }), { envManaged: ['claude.extendedTTL'] });
        expect(control('sb-config-claude-extended-ttl').disabled).toBe(true);
        routes[GET] = () => reply({ settings: settings({ enableSystemPromptCache: true }), envManaged: [] });
        await controller.refresh();
        expect(control('sb-config-claude-extended-ttl').disabled).toBe(false);
        controller.destroy();
    });

    test('shows the three rows for the sources that read their keys', async () => {
        source = 'openrouter';
        await ready();
        const display = id => row(id).style.display;
        expect([display('sb-config-claude-adaptive-thinking'), display('sb-config-gemini-api-version'), display('sb-config-gemini-thought-signatures')]).toEqual(['none', 'none', '']);
        source = 'claude';
        controller.applySourceVisibility();
        expect([display('sb-config-claude-adaptive-thinking'), display('sb-config-gemini-api-version'), display('sb-config-gemini-thought-signatures')]).toEqual(['', 'none', 'none']);
        source = 'makersuite';
        controller.applySourceVisibility();
        expect([display('sb-config-claude-adaptive-thinking'), display('sb-config-gemini-api-version'), display('sb-config-gemini-thought-signatures')]).toEqual(['none', '', '']);
        controller.destroy();
    });

    test('does not touch the page again when a read finds everything in place', async () => {
        await ready();
        const observer = new MutationObserver(() => {});
        observer.observe(document.getElementById('range'), { childList: true, subtree: true, attributes: true });
        routes[GET] = () => reply({ settings: settings() });
        await controller.refresh();
        expect(observer.takeRecords().filter(record => record.type === 'childList')).toEqual([]);
        observer.disconnect();
        controller.destroy();
    });
});
