import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
    PROFILE_CONNECTION_COMMANDS, PROFILE_SNAPSHOT_NAMES, PROFILE_SWITCH_COPY, PROFILE_WATCH_LIST, SAMPLER_GROUP_BY_API,
    countSamplerChanges, createBusyHintTracker, diffProfileSnapshots, formatProfileChange, getAppliedCommands, getAppliedOverrideCommands,
    getProfileCommandList, getWatchEntriesForApi, isAppliedOnSwitch, normalizeStopStrings, regexPresetMatchesLive, resolveRegexPresetName,
    resolveReportBaseline, waitForProfileSettle,
} from '../../public/scripts/extensions/connection-manager/profile-change-model.js';

// Fixtures: verbatim copies of the command tables in connection-manager/index.js; a test below holds them equal to it.
const ALLOW_EMPTY = [
    'stop-strings',
    'start-reply-with',
    'request-image-resolution',
    'request-image-aspect-ratio',
    'custom-reasoning-param-name',
    'custom-reasoning-enabled-value',
    'custom-reasoning-disabled-value',
    'custom-include-body',
    'custom-exclude-body',
    'custom-include-headers',
];

const CC_COMMANDS = [
    'api',
    'preset',
    // Do not fix; CC needs to set the API twice because it could be overridden by the preset
    'api',
    'secret-id',
    // SillyBunny: re-select the Custom endpoint profile by name after the secret (secret ids are shared between
    // endpoint profiles) and before the URL/model so the recorded values win over the endpoint profile's.
    'custom-endpoint-profile',
    'api-url',
    'model',
    'service-tier',
    'proxy',
    'stop-strings',
    'start-reply-with',
    'reasoning-template',
    // SillyBunny: persist Chat Completion reasoning and request behavior in connection profiles.
    'request-reasoning',
    'reasoning-effort',
    'verbosity',
    'enable-web-search',
    'request-images',
    'request-image-resolution',
    'request-image-aspect-ratio',
    'custom-reasoning-preset',
    'custom-reasoning-param-format',
    'custom-reasoning-param-name',
    'custom-reasoning-enabled-value',
    'custom-reasoning-disabled-value',
    'custom-include-body',
    'custom-exclude-body',
    'custom-include-headers',
    'prompt-post-processing',
    'regex-preset',
];

const TC_COMMANDS = [
    'api',
    'preset',
    'api-url',
    'model',
    'service-tier',
    'sysprompt',
    'sysprompt-state',
    'instruct',
    'context',
    'instruct-state',
    'tokenizer',
    'stop-strings',
    'start-reply-with',
    'reasoning-template',
    'secret-id',
    'regex-preset',
];

// The command ids a switch applies outside the connection fields: what the card line lists. A command added to either
// table must be added here or to PROFILE_CONNECTION_COMMANDS.
const EXPECTED_OVERRIDES = [
    'preset',
    'stop-strings',
    'start-reply-with',
    'reasoning-template',
    'request-reasoning',
    'reasoning-effort',
    'verbosity',
    'enable-web-search',
    'request-images',
    'request-image-resolution',
    'request-image-aspect-ratio',
    'regex-preset',
    'sysprompt',
    'sysprompt-state',
    'instruct',
    'instruct-state',
    'context',
    'tokenizer',
];

const CM_INDEX_SOURCE = readFileSync(new URL('../../public/scripts/extensions/connection-manager/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/**
 * Reads the ids of one `const NAME = [ ... ];` table from the source of cm/index.js. Only lines that hold one quoted
 * id and a comma count, so the comment lines inside a table are skipped.
 * @param {string} name Table name
 * @returns {string[]} Ids in source order, duplicates kept
 */
function readSourceTable(name) {
    const start = CM_INDEX_SOURCE.indexOf(`const ${name} = [`);
    const block = CM_INDEX_SOURCE.slice(start, CM_INDEX_SOURCE.indexOf('];', start));
    return [...block.matchAll(/^\s*'([^']+)',$/gm)].map(match => match[1]);
}

// Every id in either table with the mode that owns it, computed here so the test body has no conditionals.
const ALL_IDS = [...new Set([...CC_COMMANDS, ...TC_COMMANDS])].map(id => ({ id, mode: CC_COMMANDS.includes(id) ? 'cc' : 'tc' }));
const TABLES = { ccCommands: CC_COMMANDS, tcCommands: TC_COMMANDS, allowEmpty: ALLOW_EMPTY };
const ccProfile = { mode: 'cc', api: 'openai', preset: 'Default', model: 'gpt', 'stop-strings': '[]', 'start-reply-with': '', 'reasoning-template': 'DeepSeek', 'request-reasoning': 'true', 'reasoning-effort': 'low', verbosity: 'auto', 'enable-web-search': 'false', 'request-images': 'false', 'request-image-resolution': '', 'request-image-aspect-ratio': '', 'custom-reasoning-preset': 'x', 'regex-preset': 'r1', exclude: [] };
const tcProfile = { mode: 'tc', api: 'ooba', preset: 'Default', 'sysprompt-state': 'true', sysprompt: 'Neutral', instruct: 'Alpaca', context: 'Alpaca', 'instruct-state': 'false', tokenizer: 'best', 'stop-strings': '', 'start-reply-with': '', 'reasoning-template': 'DeepSeek', exclude: [] };

describe('command classification', () => {
    test('the fixture tables equal the command tables in cm/index.js', () => {
        expect(CM_INDEX_SOURCE).toContain('const CC_COMMANDS = [');
        expect(CC_COMMANDS).toEqual(readSourceTable('CC_COMMANDS'));
        expect(TC_COMMANDS).toEqual(readSourceTable('TC_COMMANDS'));
        expect(ALLOW_EMPTY).toEqual(readSourceTable('ALLOW_EMPTY'));
    });
    test('every CC and TC id is classified as a connection field or an expected override', () => {
        const sourceIds = new Set([...readSourceTable('CC_COMMANDS'), ...readSourceTable('TC_COMMANDS')]);
        expect(new Set(EXPECTED_OVERRIDES).size).toBe(18);
        expect(EXPECTED_OVERRIDES.filter(id => PROFILE_CONNECTION_COMMANDS.has(id))).toEqual([]);
        expect([...sourceIds].sort()).toEqual([...PROFILE_CONNECTION_COMMANDS, ...EXPECTED_OVERRIDES].sort());
    });
    test('a profile that sets one id applies it, and lists it as an override only when it is one', () => {
        for (const { id, mode } of ALL_IDS) {
            const profile = { mode, [id]: 'x' };
            expect(getAppliedCommands(profile, { ...TABLES, serviceTierApplied: true })).toContain(id);
            expect(getAppliedOverrideCommands(profile, TABLES).includes(id)).toBe(EXPECTED_OVERRIDES.includes(id));
        }
    });
    test('CC profile yields the override ids in apply order', () => {
        expect(getAppliedOverrideCommands(ccProfile, TABLES)).toEqual(['preset', 'stop-strings', 'start-reply-with', 'reasoning-template', 'request-reasoning', 'reasoning-effort', 'verbosity', 'enable-web-search', 'request-images', 'request-image-resolution', 'request-image-aspect-ratio', 'regex-preset']);
        const withoutRegex = { ...ccProfile };
        delete withoutRegex['regex-preset'];
        expect(getAppliedOverrideCommands(withoutRegex, TABLES)).toHaveLength(11);
    });
    test('TC profile with instruct off lists instruct-state but not instruct', () => {
        const ids = getAppliedOverrideCommands({ ...tcProfile, instruct: '' }, TABLES);
        expect(ids).toContain('instruct-state');
        expect(ids).not.toContain('instruct');
    });
    test('empty values apply only for ALLOW_EMPTY ids', () => {
        expect(isAppliedOnSwitch({ 'stop-strings': '' }, 'stop-strings', TABLES)).toBe(true);
        expect(isAppliedOnSwitch({ sysprompt: '' }, 'sysprompt', TABLES)).toBe(false);
    });
    test('undefined mode means TC and the duplicate api is removed', () => {
        expect(getProfileCommandList({}, TABLES)).toEqual(TC_COMMANDS);
        expect(getProfileCommandList({ mode: 'cc' }, TABLES).filter(id => id === 'api')).toHaveLength(1);
    });
    test('proxy counts as applied unless excluded, service tier only when computed', () => {
        expect(getAppliedCommands({ mode: 'cc' }, TABLES)).toContain('proxy');
        expect(getAppliedCommands({ mode: 'cc', exclude: ['proxy'] }, TABLES)).not.toContain('proxy');
        expect(getAppliedCommands({ mode: 'cc' }, { ...TABLES, serviceTierApplied: true })).toContain('service-tier');
        expect(getAppliedCommands({ mode: 'cc' }, TABLES)).not.toContain('service-tier');
    });
    test('a key with a matching exclude entry is still reported as applied', () => {
        expect(getAppliedOverrideCommands({ mode: 'tc', tokenizer: 'best', exclude: ['tokenizer'] }, TABLES)).toContain('tokenizer');
    });
    test('snapshot labels and copy constants', () => {
        expect(Object.keys(PROFILE_SNAPSHOT_NAMES)).toEqual(['active-agents', 'samplers', 'instruct-template', 'context-template', 'system-prompt', 'world-info-active-count']);
        expect(PROFILE_SWITCH_COPY).toEqual({
            alsoSets: 'Also sets:',
            contentReloaded: '(content reloaded)',
            samplersChanged: 'changed',
            snapshotHeading: 'Saved snapshot (not applied)',
        });
    });
    test('the connection field set is pinned in brief order', () => {
        expect([...PROFILE_CONNECTION_COMMANDS]).toEqual(['api', 'api-url', 'model', 'secret-id', 'proxy', 'service-tier', 'custom-endpoint-profile', 'custom-include-body', 'custom-exclude-body', 'custom-include-headers', 'prompt-post-processing', 'custom-reasoning-preset', 'custom-reasoning-param-format', 'custom-reasoning-param-name', 'custom-reasoning-enabled-value', 'custom-reasoning-disabled-value']);
    });
    test('FANCY_NAMES labels are unique and the snapshot labels moved out', () => {
        const source = readFileSync(new URL('../../public/scripts/extensions/connection-manager/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
        const start = source.indexOf('const FANCY_NAMES = {');
        const block = source.slice(start, source.indexOf('};', start));
        const labels = [...block.matchAll(/: '([^']+)',/g)].map(m => m[1]);
        expect(new Set(labels).size).toBe(labels.length);
        expect(block).not.toContain('\'instruct-template\'');
        expect(block).toContain('\'secret-id\': \'Secret\',');
    });
});

const snap = (mainApi, values) => ({ mainApi, values });

describe('snapshot diff', () => {
    test('reports one line per changed value and nothing when equal', () => {
        const before = snap('openai', { 'preset.openai': 'A', 'gen.openai_max_context': 4096, 'request.verbosity': 'auto' });
        expect(diffProfileSnapshots(before, snap('openai', { ...before.values }))).toEqual([]);
        expect(diffProfileSnapshots(before, snap('openai', { ...before.values, 'gen.openai_max_context': 8192 }))).toEqual([{ id: 'gen.openai_max_context', kind: 'value', from: 4096, to: 8192 }]);
    });
    test('diffs the destination backend\'s entries across a backend change', () => {
        const before = snap('textgenerationwebui', { 'preset.textgenerationwebui': 'T', 'fmt.tokenizer': 1, 'preset.openai': 'A', 'request.verbosity': 'auto', 'prefill.user_prompt_bias': '' });
        const after = snap('openai', { 'preset.textgenerationwebui': 'T2', 'fmt.tokenizer': 2, 'preset.openai': 'C', 'request.verbosity': 'low', 'prefill.user_prompt_bias': 'Sure' });
        expect(diffProfileSnapshots(before, after)).toEqual([
            { id: 'preset.openai', kind: 'name', from: 'A', to: 'C' },
            { id: 'request.verbosity', kind: 'value', from: 'auto', to: 'low' },
            { id: 'prefill.user_prompt_bias', kind: 'value', from: '', to: 'Sure' },
        ]);
    });
    test('content reloaded only when the paired name is unchanged', () => {
        const base = { 'sysprompt.name': 'N', 'sysprompt.content': { content: 'a', post_history: '' } };
        expect(diffProfileSnapshots(snap('novel', base), snap('novel', { ...base, 'sysprompt.content': { content: 'b', post_history: '' } }))).toEqual([{ id: 'sysprompt.content', kind: 'content', from: base['sysprompt.content'], to: { content: 'b', post_history: '' } }]);
        expect(diffProfileSnapshots(snap('novel', base), snap('novel', { 'sysprompt.name': 'M', 'sysprompt.content': { content: 'b', post_history: '' } }))).toEqual([{ id: 'sysprompt.name', kind: 'name', from: 'N', to: 'M' }]);
    });
    test('regex preset-scope scripts count only while the completion preset is unchanged', () => {
        const before = snap('openai', { 'preset.openai': 'A', 'regex.preset': 'r', 'regex.content': { global: ['g'], scoped: [], preset: ['p1'] } });
        expect(diffProfileSnapshots(before, snap('openai', { 'preset.openai': 'A', 'regex.preset': 'r', 'regex.content': { global: ['g'], scoped: [], preset: ['p2'] } }))).toHaveLength(1);
        expect(diffProfileSnapshots(before, snap('openai', { 'preset.openai': 'B', 'regex.preset': 'r', 'regex.content': { global: ['g'], scoped: [], preset: ['p2'] } }))).toEqual([{ id: 'preset.openai', kind: 'name', from: 'A', to: 'B' }]);
        // Across a backend change the preset-scope ids are not compared, even with the destination preset unchanged.
        const fromText = snap('textgenerationwebui', { ...before.values, 'preset.textgenerationwebui': 'A' });
        expect(diffProfileSnapshots(fromText, snap('openai', { 'preset.openai': 'A', 'regex.preset': 'r', 'regex.content': { global: ['g'], scoped: [], preset: ['p2'] } }))).toEqual([]);
    });
    test('samplers collapse to a count', () => {
        const change = diffProfileSnapshots(snap('openai', { samplers: { openai: { temp: 1, top_p: 1, seed: -1 } } }), snap('openai', { samplers: { openai: { temp: 0.7, top_p: 0.9, seed: -1, logit: undefined } } }))[0];
        expect(change).toMatchObject({ id: 'samplers', kind: 'samplers', count: 2 });
        expect(countSamplerChanges(undefined, { a: 1 })).toBe(1);
    });
    test('stop strings compare as lists and legacy text as trimmed text', () => {
        expect(normalizeStopStrings('["a", "b "]')).toEqual({ list: ['a', 'b '], text: '["a", "b "]' });
        expect(normalizeStopStrings('not json ')).toEqual({ list: null, text: 'not json' });
        expect(diffProfileSnapshots(snap('openai', { 'fmt.custom_stopping_strings': '["a","b"]' }), snap('openai', { 'fmt.custom_stopping_strings': '["a", "b"]' }))).toEqual([]);
    });
    test('stop string items are compared untrimmed', () => {
        const stop = value => snap('openai', { 'fmt.custom_stopping_strings': value });
        expect(diffProfileSnapshots(stop('["\\nUser:"]'), stop('["User:"]'))).toEqual([{ id: 'fmt.custom_stopping_strings', kind: 'value', from: '["\\nUser:"]', to: '["User:"]' }]);
        expect(diffProfileSnapshots(stop('["\\n"]'), stop('["\\n\\n"]'))).toHaveLength(1);
    });
    test('an empty stop strings value is the empty list, equal to []', () => {
        expect(normalizeStopStrings('')).toEqual({ list: [], text: '' });
        expect(normalizeStopStrings('  ')).toEqual({ list: [], text: '' });
        expect(diffProfileSnapshots(snap('openai', { 'fmt.custom_stopping_strings': '' }), snap('openai', { 'fmt.custom_stopping_strings': '[]' }))).toEqual([]);
    });
    test('an entry present with an undefined value is still compared', () => {
        const change = diffProfileSnapshots(snap('openai', { 'request.verbosity': undefined }), snap('openai', { 'request.verbosity': 'low' }));
        expect(change).toHaveLength(1);
        expect(change[0]).toMatchObject({ id: 'request.verbosity', kind: 'value', from: undefined, to: 'low' });
        expect(diffProfileSnapshots(snap('openai', {}), snap('openai', { 'request.verbosity': 'low' }))).toEqual([]);
    });
    test('samplers are compared for the destination backend\'s group', () => {
        const groups = (openai, textgenerationwebui) => ({ samplers: { openai, textgenerationwebui } });
        const before = snap('textgenerationwebui', groups({ temp: 1, top_p: 1 }, { temp: 1, top_k: 40 }));
        const after = snap('openai', groups({ temp: 0.7, top_p: 1 }, { temp: 0.5, top_k: 20 }));
        expect(diffProfileSnapshots(before, after)).toEqual([{ id: 'samplers', kind: 'samplers', from: { temp: 1, top_p: 1 }, to: { temp: 0.7, top_p: 1 }, count: 1 }]);
        expect(diffProfileSnapshots(before, snap('textgenerationwebui', groups({ temp: 1, top_p: 1 }, { temp: 0.7, top_k: 40 })))).toMatchObject([{ id: 'samplers', count: 1 }]);
        expect(SAMPLER_GROUP_BY_API).toEqual({ openai: 'openai', textgenerationwebui: 'textgenerationwebui', kobold: 'kobold', koboldhorde: 'kobold', novel: 'novel' });
    });
    test('only the stop strings row uses the stopStrings display', () => {
        expect(PROFILE_WATCH_LIST.filter(entry => entry.display === 'stopStrings').map(entry => entry.id)).toEqual(['fmt.custom_stopping_strings']);
        expect(PROFILE_WATCH_LIST.find(entry => entry.id === 'samplers').display).toBe('raw');
    });
    test('resolveRegexPresetName tolerates a missing regex extension', () => {
        expect(resolveRegexPresetName(undefined, 'x')).toBe('');
        expect(resolveRegexPresetName([{ id: 'x', name: 'Mine' }], 'x')).toBe('Mine');
    });
    test('getWatchEntriesForApi filters by mode and the list has 39 entries', () => {
        expect(PROFILE_WATCH_LIST).toHaveLength(39);
        expect(getWatchEntriesForApi('openai').map(e => e.id)).not.toContain('fmt.tokenizer');
        expect(getWatchEntriesForApi('koboldhorde').map(e => e.id)).toContain('preset.kobold');
    });
});

describe('change formatting', () => {
    const helpers = { translate: (t, k) => `T(${k ?? t})`, fancyName: id => `F(${id})`, snapshotName: id => `S(${id})`, optionText: (sel, v) => `${sel}=${v}`, enabledText: 'On', disabledText: 'Off', noneText: '<None>', emptyText: '<Empty>', truncate: s => s.slice(0, 5) };
    test('labels resolve through the right helper and toggles use the enabled strings', () => {
        expect(formatProfileChange({ id: 'gen.stream_openai', kind: 'toggle', from: false, to: true }, helpers)).toEqual({ label: 'T(Streaming)', from: 'Off', to: 'On', placeholder: false });
        expect(formatProfileChange({ id: 'preset.textgenerationwebui', kind: 'name', from: 'A', to: '' }, helpers)).toEqual({ label: 'F(preset)', from: 'A', to: '<Empty>', placeholder: false });
        expect(formatProfileChange({ id: 'request.verbosity', kind: 'value', from: 'auto', to: 'low' }, helpers).to).toBe('#openai_verbosity=low');
        expect(formatProfileChange({ id: 'samplers', kind: 'samplers', from: {}, to: {}, count: 3 }, helpers)).toMatchObject({ label: 'S(samplers)', count: 3, placeholder: true });
        expect(formatProfileChange({ id: 'prefill.user_prompt_bias', kind: 'value', from: '', to: 'Sure thing' }, helpers).to).toBe('Sure ');
    });
    test('stop strings show a count, or truncated text when they are not a list', () => {
        expect(formatProfileChange({ id: 'fmt.custom_stopping_strings', kind: 'value', from: '["a","b"]', to: 'legacy text' }, helpers)).toEqual({ label: 'T(Custom Stopping Strings)', from: '2', to: 'legac', placeholder: false });
        expect(formatProfileChange({ id: 'fmt.custom_stopping_strings', kind: 'value', from: '', to: '["a"]' }, helpers)).toMatchObject({ from: '0', to: '1' });
    });
});

/**
 * A manual clock for the settle tests. `advance` runs due callbacks in time order, including ones that a callback
 * schedules while the clock is still inside the advance window.
 * @returns {{ now: () => number, schedule: (fn: () => void, ms: number) => object, cancel: (handle: object) => void, advance: (ms: number) => void, pending: () => number }} The clock
 */
function makeClock() {
    let t = 0;
    let queue = [];
    const nextDue = limit => queue.filter(item => item.at <= limit).sort((a, b) => a.at - b.at)[0];
    return {
        now: () => t,
        schedule: (fn, ms) => {
            const item = { at: t + ms, fn };
            queue.push(item);
            return item;
        },
        cancel: handle => {
            queue = queue.filter(item => item !== handle);
        },
        advance: ms => {
            const limit = t + ms;
            for (let item = nextDue(limit); item; item = nextDue(limit)) {
                queue = queue.filter(other => other !== item);
                t = item.at;
                item.fn();
            }
            t = limit;
        },
        pending: () => queue.length,
    };
}

describe('settle', () => {
    function run(overrides) {
        const clock = makeClock();
        let activity = () => {};
        const options = {
            isCurrent: () => true,
            readFingerprint: () => 'f',
            isBusy: () => false,
            subscribe: fn => {
                activity = fn;
                return () => {
                    activity = () => {};
                };
            },
            now: clock.now,
            schedule: clock.schedule,
            cancel: clock.cancel,
            ...overrides,
        };
        const promise = waitForProfileSettle(options);
        return { clock, promise, fire: () => activity() };
    }
    async function isPending(promise) {
        let done = false;
        promise.then(() => {
            done = true;
        });
        await Promise.resolve();
        return !done;
    }
    test('settles after the quiet window', async () => {
        const r = run();
        r.clock.advance(750);
        await expect(r.promise).resolves.toEqual({ settled: true, reason: 'quiet' });
    });
    test('activity at quietMs - 1 resets the window', async () => {
        const r = run();
        r.clock.advance(749);
        r.fire();
        r.clock.advance(749);
        expect(await isPending(r.promise)).toBe(true);
        r.clock.advance(150);
        await expect(r.promise).resolves.toMatchObject({ reason: 'quiet' });
    });
    test('a hint already on at start is ignored', async () => {
        const r = run({ isBusy: () => true });
        r.clock.advance(750);
        await expect(r.promise).resolves.toMatchObject({ reason: 'quiet' });
    });
    test('a hint on at settle start but off at begin is honoured', async () => {
        const r = run({ isBusy: () => true, initialNotBusy: true });
        r.clock.advance(750);
        expect(await isPending(r.promise)).toBe(true);
        r.clock.advance(2250);
        expect(await isPending(r.promise)).toBe(true);
        r.clock.advance(150);
        await expect(r.promise).resolves.toEqual({ settled: true, reason: 'quiet' });
    });
    test('a hint that turns on later is honoured for at most busyGraceMs', async () => {
        let busy = false;
        const r = run({ isBusy: () => busy });
        r.clock.advance(150);
        busy = true;
        r.clock.advance(3000);
        expect(await isPending(r.promise)).toBe(true);
        r.clock.advance(900);
        await expect(r.promise).resolves.toMatchObject({ reason: 'quiet' });
    });
    test('a hint that drops and rises again starts a new grace window', async () => {
        let busy = false;
        const r = run({ isBusy: () => busy });
        r.clock.advance(150);
        busy = true;
        r.clock.advance(450);
        busy = false;
        r.clock.advance(300);
        busy = true;
        r.clock.advance(3000);
        expect(await isPending(r.promise)).toBe(true);
        r.clock.advance(900);
        await expect(r.promise).resolves.toMatchObject({ reason: 'quiet' });
    });
    test('a fingerprint change is activity', async () => {
        let fp = 'a';
        const r = run({ readFingerprint: () => fp });
        r.clock.advance(600);
        fp = 'b';
        r.clock.advance(600);
        expect(await isPending(r.promise)).toBe(true);
    });
    test('supersede resolves unsettled', async () => {
        let current = true;
        const r = run({ isCurrent: () => current });
        current = false;
        r.clock.advance(150);
        await expect(r.promise).resolves.toEqual({ settled: false, reason: 'superseded' });
    });
    test('the cap delivers', async () => {
        let fp = 0;
        const r = run({ readFingerprint: () => String(fp++) });
        r.clock.advance(8000);
        await expect(r.promise).resolves.toEqual({ settled: true, reason: 'cap' });
    });
    test('every exit unsubscribes once and leaves no tick queued', async () => {
        let unsubscribed = 0;
        const subscribe = () => () => {
            unsubscribed++;
        };
        const quiet = run({ subscribe });
        quiet.clock.advance(750);
        await quiet.promise;
        let fp = 0;
        const capped = run({ subscribe, readFingerprint: () => String(fp++) });
        capped.clock.advance(8000);
        await capped.promise;
        const superseded = run({ subscribe, isCurrent: () => false });
        superseded.clock.advance(150);
        await superseded.promise;
        expect(unsubscribed).toBe(3);
        expect([quiet, capped, superseded].map(r => r.clock.pending())).toEqual([0, 0, 0]);
    });
    test('a throwing reader rejects and still unsubscribes', async () => {
        let unsubscribed = 0;
        const r = run({
            subscribe: () => () => {
                unsubscribed++;
            },
            isCurrent: () => {
                throw new Error('boom');
            },
        });
        r.clock.advance(150);
        await expect(r.promise).rejects.toThrow('boom');
        expect(unsubscribed).toBe(1);
        expect(r.clock.pending()).toBe(0);
    });
});

describe('regex preset match', () => {
    /**
     * Builds a live state from the script ids of each type; ids in `disabled` are present but not enabled.
     * @param {{ global?: string[], scoped?: string[], preset?: string[] }} ids Script ids per type
     * @param {string[]} [disabled] Ids that are disabled live
     */
    const live = (ids, disabled = []) => Object.fromEntries(['global', 'scoped', 'preset'].map(type => {
        const all = ids[type] ?? [];
        return [type, { all, enabled: all.filter(id => !disabled.includes(id)) }];
    }));
    const preset = lists => ({ id: 'p', name: 'P', isSelected: true, global: [], scoped: [], preset: [], ...lists });

    test('equal enabled sequences match', () => {
        expect(regexPresetMatchesLive(preset({ global: [{ id: 'g1' }], scoped: [{ id: 's1' }], preset: [{ id: 'p1' }] }), live({ global: ['g1'], scoped: ['s1'], preset: ['p1'] }))).toBe(true);
    });
    test('a scoped id listed but disabled live is a mismatch', () => {
        expect(regexPresetMatchesLive(preset({ scoped: [{ id: 's1' }] }), live({ scoped: ['s1'] }, ['s1']))).toBe(false);
    });
    test('an enabled live id the preset does not list is a mismatch', () => {
        expect(regexPresetMatchesLive(preset({ global: [{ id: 'g1' }] }), live({ global: ['g1', 'g2'] }))).toBe(false);
    });
    test('an id listed but absent from all is ignored', () => {
        expect(regexPresetMatchesLive(preset({ scoped: [{ id: 's1' }, { id: 'gone' }] }), live({ scoped: ['s1'] }))).toBe(true);
    });
    test('a null preset matches only an all-empty live state', () => {
        expect(regexPresetMatchesLive(null, live({ global: ['g1'], scoped: ['s1'] }, ['g1', 's1']))).toBe(true);
        expect(regexPresetMatchesLive(null, live({ scoped: ['s1'] }))).toBe(false);
    });
    test('a missing list leaves its type unconstrained, as the Regex extension leaves it untouched', () => {
        const withoutPresetList = { id: 'p', name: 'P', isSelected: true, global: [], scoped: [] };
        expect(regexPresetMatchesLive(withoutPresetList, live({ preset: ['p1'] }))).toBe(true);
        expect(regexPresetMatchesLive(preset({ preset: null }), live({ preset: ['p1', 'p2'] }, ['p2']))).toBe(true);
        expect(regexPresetMatchesLive(withoutPresetList, live({ global: ['g1'], preset: ['p1'] }))).toBe(false);
    });
    test('an empty list means nothing of its type is enabled', () => {
        expect(regexPresetMatchesLive(preset({ global: [] }), live({ global: ['g1'] }))).toBe(false);
        expect(regexPresetMatchesLive(preset({ global: [] }), live({ global: ['g1'] }, ['g1']))).toBe(true);
    });
    for (const type of ['global', 'scoped', 'preset']) {
        test(`${type} scripts must follow the preset order`, () => {
            const ordered = preset({ [type]: [{ id: 'b' }, { id: 'gone' }, { id: 'a' }] });
            expect(regexPresetMatchesLive(ordered, live({ [type]: ['a', 'b', 'c'] }, ['c']))).toBe(false);
            expect(regexPresetMatchesLive(ordered, live({ [type]: ['c', 'b', 'a'] }, ['c']))).toBe(true);
        });
    }
    test('repeated preset ids use their first position', () => {
        const repeated = preset({ scoped: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] });
        expect(regexPresetMatchesLive(repeated, live({ scoped: ['b', 'a'] }))).toBe(true);
        expect(regexPresetMatchesLive(repeated, live({ scoped: ['a', 'b'] }))).toBe(false);
    });
    test('all live copies of a listed id must be enabled in preset order', () => {
        const repeated = preset({ scoped: [{ id: 'b' }, { id: 'a' }] });
        expect(regexPresetMatchesLive(repeated, live({ scoped: ['b', 'b', 'a'] }))).toBe(true);
        expect(regexPresetMatchesLive(repeated, {
            scoped: { all: ['b', 'b', 'a'], enabled: ['b', 'a'] },
        })).toBe(false);
    });
    test('a report waits for a native order-only reapply across a delayed save', async () => {
        const source = readFileSync(new URL('../../public/scripts/extensions/regex/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
        const engine = readFileSync(new URL('../../public/scripts/extensions/regex/engine.js', import.meta.url), 'utf8');
        const classStart = source.indexOf('class RegexPresetManager {');
        const classEnd = source.indexOf('\nconst presetManager =', classStart);
        const scriptTypes = engine.match(/export const SCRIPT_TYPES = \{[\s\S]*?\n\};/);
        expect(classStart).toBeGreaterThanOrEqual(0);
        expect(classEnd).toBeGreaterThan(classStart);
        expect(scriptTypes).not.toBeNull();

        const selected = preset({ scoped: [{ id: 'a' }, { id: 'b' }] });
        const scoped = [{ id: 'b', disabled: false }, { id: 'a', disabled: false }];
        const scripts = new Map();
        let releaseSave;
        let markSaveStarted;
        const saveStarted = new Promise(resolve => { markSaveStarted = resolve; });
        const saved = new Promise(resolve => { releaseSave = resolve; });
        const { manager, types } = runInNewContext(`${scriptTypes[0].replace('export ', '')}\n${source.slice(classStart, classEnd)}\n({ manager: new RegexPresetManager(), types: SCRIPT_TYPES })`, {
            extension_settings: { regex_presets: [selected] },
            getScriptsByType: type => scripts.get(type),
            saveScriptsByType: (list, type) => {
                if (type === types.PRESET) {
                    markSaveStarted();
                    return saved;
                }
                return Promise.resolve();
            },
            loadRegexScripts: async () => {},
            reloadCurrentChat: async () => {},
        });
        scripts.set(types.GLOBAL, []);
        scripts.set(types.PRESET, []);
        scripts.set(types.SCOPED, scoped);
        const readLive = () => live({ scoped: scoped.filter(script => !script.disabled).map(script => script.id) });
        const snapshot = () => ({ mainApi: 'openai', values: { 'regex.preset': selected.name, 'regex.content': { global: [], preset: [], scoped: readLive().scoped.enabled } } });
        const before = snapshot();
        const applying = manager.applyPreset(selected.id);
        await saveStarted;
        const clock = makeClock();
        let finished = false;
        const reporting = waitForProfileSettle({
            isCurrent: () => true,
            readFingerprint: () => JSON.stringify(snapshot().values),
            isBusy: () => !regexPresetMatchesLive(selected, readLive()),
            subscribe: () => () => {},
            initialNotBusy: true,
            now: clock.now,
            schedule: clock.schedule,
            cancel: clock.cancel,
        }).then(() => {
            finished = true;
            return diffProfileSnapshots(before, snapshot());
        });
        try {
            clock.advance(1800);
            await Promise.resolve();
            expect(finished).toBe(false);
        } finally {
            releaseSave();
            await applying;
        }
        expect(scoped.map(script => script.id)).toEqual(['a', 'b']);
        clock.advance(900);
        await expect(reporting).resolves.toEqual([expect.objectContaining({ id: 'regex.content', kind: 'content' })]);
        expect(clock.pending()).toBe(0);
    });
});

describe('busy hint tracker', () => {
    test('a hint on from the first reading and never off reads false', () => {
        const tracker = createBusyHintTracker(['api', 'offline']);
        const readings = Array.from({ length: 5 }, () => tracker.read({ api: false, offline: true }));
        expect(readings).toEqual([false, false, false, false, false]);
    });
    test('off then on reads true', () => {
        const tracker = createBusyHintTracker(['regex']);
        expect([tracker.read({ regex: false }), tracker.read({ regex: true })]).toEqual([false, true]);
    });
    test('on, off, on reads true again', () => {
        const tracker = createBusyHintTracker(['regex']);
        expect([tracker.read({ regex: true }), tracker.read({ regex: false }), tracker.read({ regex: true })]).toEqual([false, false, true]);
    });
    test('a stuck hint does not hide another hint that turns on', () => {
        const tracker = createBusyHintTracker(['api', 'offline', 'regex']);
        const readings = [
            tracker.read({ api: false, offline: true, regex: false }),
            tracker.read({ api: false, offline: true, regex: true }),
            tracker.read({ api: false, offline: true, regex: false }),
        ];
        expect(readings).toEqual([false, true, false]);
    });
    test('unknown names in the states are ignored', () => {
        const tracker = createBusyHintTracker(['api']);
        expect([tracker.read({ api: true, other: false }), tracker.read({ api: true, other: true })]).toEqual([false, false]);
    });
});

describe('carry-forward', () => {
    test('reuses the previous BEFORE only for the immediate successor', () => {
        const a = { applySequence: 1, finished: false, before: snap('openai', { x: 1 }) };
        expect(resolveReportBaseline({ openReport: a, applySequence: 2, freshBefore: snap('openai', { x: 2 }) })).toEqual({ before: a.before, reused: true });
        expect(resolveReportBaseline({ openReport: a, applySequence: 3, freshBefore: snap('openai', { x: 2 }) })).toMatchObject({ reused: false });
        expect(resolveReportBaseline({ openReport: { ...a, finished: true }, applySequence: 2, freshBefore: snap('openai', {}) })).toMatchObject({ reused: false });
        expect(resolveReportBaseline({ openReport: null, applySequence: 2, freshBefore: snap('openai', {}) })).toMatchObject({ reused: false });
    });
    test('a non-reused result returns the fresh snapshot itself', () => {
        const fresh = snap('openai', { x: 2 });
        const a = { applySequence: 1, finished: true, before: snap('openai', { x: 1 }) };
        expect(resolveReportBaseline({ openReport: a, applySequence: 2, freshBefore: fresh })).toEqual({ before: fresh, reused: false });
    });
});
