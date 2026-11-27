import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
    buildLegacyThreadKey,
    canonicalizeLegacyGroupThread,
    getLegacyThread,
    LEGACY_DEFAULT_SETTINGS,
    LEGACY_GROUP_SETTINGS_KEYS,
    normalizeLegacyGroupRecord,
    normalizeLegacySettings,
    normalizeLegacyStore,
    parseLegacyThreadKey,
} from '../src/conversation-legacy.js';
import {
    BASE,
    branch,
    buildLegacySettingsFixture,
    keyFor,
    lines,
    message,
    PERSONA,
    PERSONA_TWO,
    thread,
} from './util/conversation-legacy-fixture.js';

const NOW = BASE + 10_000 * 60_000;

beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
});

afterEach(() => {
    jest.useRealTimers();
});

function storeWith(characters, extra = {}) {
    return normalizeLegacyStore({ characters, ...extra });
}

describe('legacy thread keys', () => {
    test.each([
        [['Nova.png'], 'Nova.png'],
        [['Nova.png', '', PERSONA], 'persona:user-default.png:Nova.png'],
        [['Nova.png', 'g1'], 'group:g1:Nova.png'],
        [['Nova.png', 'g1', PERSONA], 'persona:user-default.png:group:g1:Nova.png'],
        [['Nova.png', '', 'Persona 25%: one.png'], 'persona:Persona%2025%25%3A%20one.png:Nova.png'],
        [['  Nova.png  ', ' g1 ', ' p.png '], 'persona:p.png:group:g1:Nova.png'],
    ])('builds %j as %s', (args, expected) => {
        expect(buildLegacyThreadKey(...args)).toBe(expected);
    });

    test.each([
        ['an empty avatar', ['']],
        ['an avatar with a colon', ['a:b.png']],
        ['a reserved avatar name', ['constructor']],
        ['a reserved avatar name that sets a prototype', ['__proto__']],
        ['an avatar with a control character', ['Nova\u0000.png']],
        ['an avatar over 512 characters', ['a'.repeat(513)]],
        ['a group id with a colon', ['Nova.png', 'g:1']],
        ['a persona that is not a string', ['Nova.png', '', 7]],
        ['a persona that cannot be URI encoded', ['Nova.png', '', '\uD800']],
    ])('refuses %s', (_name, args) => {
        expect(buildLegacyThreadKey(...args)).toBe('');
    });

    test('does not scope a key that already starts with the persona prefix', () => {
        expect(buildLegacyThreadKey('persona:x', '', PERSONA)).toBe('');
        expect(buildLegacyThreadKey('Nova.png', '', PERSONA)).toBe('persona:user-default.png:Nova.png');
    });

    test.each([
        ['Nova.png', { avatar: 'Nova.png', groupId: '', personaId: '' }],
        ['persona:user-default.png:Nova.png', { avatar: 'Nova.png', groupId: '', personaId: PERSONA }],
        ['group:g1:Nova.png', { avatar: 'Nova.png', groupId: 'g1', personaId: '' }],
        ['persona:user-default.png:group:g1:Nova.png', { avatar: 'Nova.png', groupId: 'g1', personaId: PERSONA }],
        ['persona:Persona%2025%25%3A%20one.png:Nova.png', { avatar: 'Nova.png', groupId: '', personaId: 'Persona 25%: one.png' }],
        ['persona:%E0%A4%A:Nova.png', { avatar: 'Nova.png', groupId: '', personaId: '%E0%A4%A' }],
        ['persona:no-separator', { avatar: '', groupId: '', personaId: '' }],
        ['group:no-separator', { avatar: '', groupId: '', personaId: '' }],
        ['persona:p.png:group:no-separator', { avatar: '', groupId: '', personaId: 'p.png' }],
        ['', { avatar: '', groupId: '', personaId: '' }],
    ])('parses %s', (key, expected) => {
        expect(parseLegacyThreadKey(key)).toEqual(expected);
    });

    test('a built key parses back to its parts', () => {
        const key = buildLegacyThreadKey('Nova 100% alt.png', 'group 50% alpha', 'Persona 25%: one.png');
        expect(parseLegacyThreadKey(key)).toEqual({
            avatar: 'Nova 100% alt.png',
            groupId: 'group 50% alpha',
            personaId: 'Persona 25%: one.png',
        });
    });
});

describe('normalizeLegacySettings', () => {
    test('an empty object takes every default', () => {
        const normalized = normalizeLegacySettings({});
        expect(Object.keys(normalized)).toHaveLength(49);
        expect(normalized).toEqual(LEGACY_DEFAULT_SETTINGS);
    });

    test('anything that is not a plain object reads as empty', () => {
        expect(normalizeLegacySettings(undefined)).toEqual(LEGACY_DEFAULT_SETTINGS);
        expect(normalizeLegacySettings(null)).toEqual(LEGACY_DEFAULT_SETTINGS);
        expect(normalizeLegacySettings([1, 2])).toEqual(LEGACY_DEFAULT_SETTINGS);
    });

    test.each([
        [1024, 16000],
        [3, 16000],
        [63, 16000],
        [64, 64],
        [64000, 64000],
        [9_999_999, 64000],
        ['abc', 16000],
        [-5, 16000],
        ['2048', 2048],
    ])('reply_max_tokens %p becomes %p', (stored, expected) => {
        expect(normalizeLegacySettings({ reply_max_tokens: stored }).reply_max_tokens).toBe(expected);
    });

    test('flags become booleans and the rules text falls back to the default', () => {
        const normalized = normalizeLegacySettings({
            selfie_command_enabled: 0,
            schedule_command_enabled: 'yes',
            grounded_dialogue_rules_enabled: 1,
            grounded_dialogue_rules: 5,
        });
        expect(normalized.selfie_command_enabled).toBe(false);
        expect(normalized.schedule_command_enabled).toBe(true);
        expect(normalized.grounded_dialogue_rules_enabled).toBe(true);
        expect(normalized.grounded_dialogue_rules).toBe(LEGACY_DEFAULT_SETTINGS.grounded_dialogue_rules);
    });

    test('stored values and unknown keys are kept', () => {
        const normalized = normalizeLegacySettings({ availability: 'dnd', not_a_setting: 'kept' });
        expect(normalized.availability).toBe('dnd');
        expect(normalized.not_a_setting).toBe('kept');
    });

    test('the defaults are the values builds wrote before the storage move', () => {
        expect(LEGACY_DEFAULT_SETTINGS).toMatchObject({
            availability: 'online',
            idle_limit: 15,
            inactivity_threshold: 120,
            talkativeness: 50,
            reply_delay_multiplier: 100,
            reply_max_tokens: 16000,
            image_gen_prompt_template: 'a photo of {{char}}, {{scene}}',
            selfie_prompt: 'raw photo, selfie of {{char}}',
            lorebooks_enabled: true,
        });
        expect(Object.isFrozen(LEGACY_DEFAULT_SETTINGS)).toBe(true);
        expect(LEGACY_DEFAULT_SETTINGS.geechan_chatroom_prompt.startsWith('{{// The main system prompt')).toBe(true);
    });
});

describe('normalizeLegacyGroupRecord', () => {
    const valid = { id: 'conversation_1_a', personaId: PERSONA, name: 'Weekend', members: ['Nova.png', 'Orion.png'] };

    test('keeps a group with two members and adds the group marker and timestamps', () => {
        const group = normalizeLegacyGroupRecord({ ...valid, avatar_url: '/user/images/g.png', createdAt: 5 });
        expect(group).toMatchObject({
            id: 'conversation_1_a',
            personaId: PERSONA,
            name: 'Weekend',
            members: ['Nova.png', 'Orion.png'],
            disabled_members: [],
            is_conversation_group: true,
            avatar_url: '/user/images/g.png',
            createdAt: 5,
            updatedAt: 5,
        });
    });

    test.each([
        ['one member', { ...valid, members: ['Nova.png'] }],
        ['the same member twice', { ...valid, members: ['Nova.png', ' Nova.png '] }],
        ['members that cannot be keys', { ...valid, members: ['a:b.png', 'constructor', 42] }],
        ['no id', { ...valid, id: '' }],
        ['an id with a colon', { ...valid, id: 'a:b' }],
        ['no members list', { id: 'x' }],
        ['a value that is not an object', 'group'],
        ['null', null],
    ])('drops a group with %s', (_name, record) => {
        expect(normalizeLegacyGroupRecord(record)).toBeNull();
    });

    test('trims and deduplicates members and keeps only disabled members that are members', () => {
        const group = normalizeLegacyGroupRecord({
            ...valid,
            members: [' Nova.png ', 'Orion.png', 'Nova.png', 'Lyra.png'],
            disabled_members: ['Lyra.png', 'Stranger.png', 'Lyra.png'],
        });
        expect(group.members).toEqual(['Nova.png', 'Orion.png', 'Lyra.png']);
        expect(group.disabled_members).toEqual(['Lyra.png']);
    });

    test.each(['personaId', 'persona', 'personaAvatar', 'userAvatar'])('reads the persona from %s', (field) => {
        const withoutPersona = { id: valid.id, name: valid.name, members: valid.members };
        expect(normalizeLegacyGroupRecord({ ...withoutPersona, [field]: PERSONA_TWO }).personaId).toBe(PERSONA_TWO);
    });

    test('a group with no persona has an empty persona id', () => {
        expect(normalizeLegacyGroupRecord({ id: valid.id, members: valid.members }).personaId).toBe('');
    });

    test('stores only the group settings that were present, normalized', () => {
        const group = normalizeLegacyGroupRecord({
            ...valid,
            conversation_settings: { reply_max_tokens: 1024, proactive_messaging: true, availability: 'dnd', unknown: 1 },
        });
        expect(group.conversation_settings).toEqual({ reply_max_tokens: 16000, proactive_messaging: true });
        expect(Object.keys(group.conversation_settings).every(key => LEGACY_GROUP_SETTINGS_KEYS.includes(key))).toBe(true);
    });

    test('a group with no name is called Conversation Group and the timestamps default to now', () => {
        const group = normalizeLegacyGroupRecord({ ...valid, name: '' });
        expect(group.name).toBe('Conversation Group');
        expect(group.createdAt).toBe(NOW);
        expect(group.updatedAt).toBe(NOW);
    });
});

describe('normalizeLegacyStore', () => {
    test('does not change what it is given and returns a copy', () => {
        const { store } = buildLegacySettingsFixture();
        const snapshot = JSON.stringify(store);
        const normalized = normalizeLegacyStore(store);
        getLegacyThread(normalized, 'Nova.png', '', { personaId: PERSONA });
        expect(JSON.stringify(store)).toBe(snapshot);
        expect(normalized).not.toBe(store);
        expect(normalized.characters).not.toBe(store.characters);
    });

    test.each([undefined, null, 'text', 7, [1, 2]])('reads %p as an empty store', (value) => {
        const normalized = normalizeLegacyStore(value);
        expect(normalized).toMatchObject({
            version: 1,
            localStorageMigrated: false,
            settings: {},
            groups: [],
            reminders: [],
        });
        expect(Object.keys(normalized.characters)).toEqual([]);
        expect(Object.keys(normalized.legacyThreadPersonaAssignments)).toEqual([]);
    });

    test('keeps the fixture shape: 20 thread keys after dropping the reserved one, 5 groups, 8 reminders', () => {
        const { store } = buildLegacySettingsFixture();
        expect(Object.keys(store.characters)).toContain('constructor');
        const normalized = normalizeLegacyStore(store);
        expect(Object.keys(normalized.characters)).toHaveLength(Object.keys(store.characters).length - 1);
        expect(Object.keys(normalized.characters)).not.toContain('constructor');
        expect(Object.getPrototypeOf(normalized.characters)).toBeNull();
        expect(normalized.groups).toHaveLength(5);
        expect(normalized.reminders).toHaveLength(8);
        expect(normalized.localStorageMigrated).toBe(true);
        expect(normalized.userStatus).toBe('online');
        expect(normalized.userPersonaStatus).toBe('working from home');
        expect(normalized.legacyThreadPersonaAssignments).toEqual({ 'Sol.png': PERSONA_TWO });
    });

    test('drops invalid groups and bad top-level values', () => {
        const normalized = normalizeLegacyStore({
            version: 'x',
            localStorageMigrated: 'yes',
            groups: [{ id: 'g', members: ['a.png'] }, { id: 'ok', members: ['a.png', 'b.png'] }, 5],
            reminders: 'none',
            settings: [1],
        });
        expect(normalized.version).toBe(1);
        expect(normalized.localStorageMigrated).toBe(true);
        expect(normalized.groups.map(group => group.id)).toEqual(['ok']);
        expect(normalized.reminders).toEqual([]);
        expect(normalized.settings).toEqual({});
    });

    test('a property named __proto__ in stored JSON is not a thread', () => {
        const stored = JSON.parse('{"characters":{"__proto__":{"branches":{}},"Nova.png":{"branches":{}}}}');
        const normalized = normalizeLegacyStore(stored);
        expect(Object.keys(normalized.characters)).toEqual(['Nova.png']);
    });
});

describe('getLegacyThread', () => {
    // The unscoped Orion thread merges into whichever persona reads first, so the second persona's thread is read
    // after the first persona has taken it.
    function readSecondPersonaOrion() {
        const normalized = normalizeLegacyStore(buildLegacySettingsFixture().store);
        getLegacyThread(normalized, 'Orion.png', '', { personaId: PERSONA });
        return getLegacyThread(normalized, 'Orion.png', '', { personaId: PERSONA_TWO });
    }

    test('moves an unscoped thread to the persona key and returns it with its branches', () => {
        const { store } = buildLegacySettingsFixture();
        const normalized = normalizeLegacyStore(store);

        const nova = getLegacyThread(normalized, 'Nova.png', '', { personaId: PERSONA });

        expect(Object.keys(normalized.characters)).not.toContain('Nova.png');
        expect(normalized.characters[keyFor(PERSONA, 'Nova.png')]).toBe(nova);
        expect(nova.threadAvatar).toBe('Nova.png');
        expect(nova.groupId).toBe('');
        expect(Object.keys(nova.branches)).toEqual(['main', 'br_1700000500000_aaa111']);
        expect(nova.branches.main.messages).toHaveLength(8);
        expect(nova.branches.br_1700000500000_aaa111.messages).toHaveLength(4);
        expect(nova.branches.main.unread).toBe(1);
    });

    test('reads the unscoped thread itself when no persona is given', () => {
        const normalized = normalizeLegacyStore(buildLegacySettingsFixture().store);
        const lyra = getLegacyThread(normalized, 'Lyra.png', '');
        expect(lyra.branches.main.messages.map(item => item.mes)).toEqual(['old text', 'lyra-old 0', 'lyra-old 1']);
        expect(Object.keys(normalized.characters)).toContain('Lyra.png');
    });

    test('a complete merge into the persona thread removes the unscoped one', () => {
        const normalized = normalizeLegacyStore(buildLegacySettingsFixture().store);

        const orion = getLegacyThread(normalized, 'Orion.png', '', { personaId: PERSONA });

        expect(Object.keys(normalized.characters)).not.toContain('Orion.png');
        expect(orion.branches.main.messages.map(item => item.mes)).toEqual([
            'orion-shared 0', 'orion-shared 1', 'orion-shared 2', 'orion-shared 3', 'only in the scoped copy',
        ]);
    });

    test('a merge that would lose a message keeps the unscoped thread and remembers the persona', () => {
        const normalized = normalizeLegacyStore(buildLegacySettingsFixture().store);

        const lyra = getLegacyThread(normalized, 'Lyra.png', '', { personaId: PERSONA });

        expect(Object.keys(normalized.characters)).toContain('Lyra.png');
        expect(normalized.legacyThreadPersonaAssignments['Lyra.png']).toBe(PERSONA);
        expect(lyra.branches.main.messages.map(item => item.mes)).toEqual([
            'lyra-old 0', 'lyra-old 1', 'new text', 'lyra-new 0', 'lyra-new 1',
        ]);
        expect(normalized.characters['Lyra.png'].branches.main.messages).toHaveLength(3);
    });

    test('an unscoped thread assigned to another persona stays where it is', () => {
        const normalized = normalizeLegacyStore(buildLegacySettingsFixture().store);

        expect(getLegacyThread(normalized, 'Sol.png', '', { personaId: PERSONA })).toBeNull();
        expect(Object.keys(normalized.characters)).toContain('Sol.png');
        expect(normalized.legacyThreadPersonaAssignments).toEqual({ 'Sol.png': PERSONA_TWO });

        const sol = getLegacyThread(normalized, 'Sol.png', '', { personaId: PERSONA_TWO });
        expect(sol.branches.main.messages).toHaveLength(3);
        expect(Object.keys(normalized.characters)).not.toContain('Sol.png');
        expect(normalized.legacyThreadPersonaAssignments).toEqual({});
    });

    test.each([
        ['a thread that does not exist', ['Nobody.png', '', PERSONA]],
        ['an avatar that cannot be a key', ['a:b.png', '', PERSONA]],
        ['a reserved name', ['constructor', '', PERSONA]],
    ])('returns null for %s', (_name, [avatar, groupId, personaId]) => {
        const normalized = normalizeLegacyStore(buildLegacySettingsFixture().store);
        expect(getLegacyThread(normalized, avatar, groupId, { personaId })).toBeNull();
    });

    test('drops messages with no content and keeps files and old attachment lists', () => {
        const orion = readSecondPersonaOrion();

        const messages = orion.branches.main.messages;
        expect(messages.map(item => item.mes)).toEqual([
            'kept', 'no id here', 'dup a', 'dup b', 'unsafe id', 'replying', 'with files', 'old attachments',
        ]);
        expect(messages[6].extra.files).toEqual([{ url: '/user/files/a.txt', name: 'a.txt', size: 10 }]);
        expect(messages[7].extra.media).toEqual([{ url: '/user/images/b.png', type: 'image' }]);
        expect(messages[7].extra.files).toEqual([{ url: '/user/files/c.pdf', type: 'file' }]);
        expect(messages[7].extra.attachments).toBeUndefined();
    });

    test('gives a message with no id an id from its timestamp and its place', () => {
        const orion = readSecondPersonaOrion();
        const noId = orion.branches.main.messages[1];
        expect(noId.id).toBe(`legacy-${BASE + 3000 * 60_000}-1`);
        expect(noId.created_at).toBe(BASE + 3000 * 60_000);
    });

    test('a repeated id gets a new one, and an unsafe id is replaced with the reply reference following it', () => {
        const orion = readSecondPersonaOrion();
        const [, , dupA, dupB, unsafe, reply] = orion.branches.main.messages;

        expect(dupA.id).toBe('dup-1');
        expect(dupB.id).toBe(`legacy-${dupB.created_at}-3`);
        expect(unsafe.id).toBe(`legacy-${unsafe.created_at}-4`);
        expect(reply.extra.conversation_reply_to.messageId).toBe(unsafe.id);
        expect(new Set(orion.branches.main.messages.map(item => item.id)).size).toBe(8);
    });

    test('a thread whose active chat is missing gets an empty one, and a reserved chat id falls back to main', () => {
        const stored = {
            [keyFor(PERSONA, 'Nova.png')]: { branches: { constructor: branch('constructor', 'x', lines(1)) }, activeBranchId: 'gone' },
            [keyFor(PERSONA, 'Orion.png')]: { branches: {}, activeBranchId: '__proto__' },
        };
        const normalized = storeWith(stored);

        const nova = getLegacyThread(normalized, 'Nova.png', '', { personaId: PERSONA });
        expect(Object.keys(nova.branches)).toEqual(['gone']);
        expect(nova.branches.gone).toMatchObject({ id: 'gone', name: 'Conversation', messages: [], preview: 'Conversation ready', unread: 0 });

        const orion = getLegacyThread(normalized, 'Orion.png', '', { personaId: PERSONA });
        expect(orion.activeBranchId).toBe('main');
        expect(orion.branches.main).toMatchObject({ id: 'main', name: 'Main', messages: [] });
    });

    test('fills the counters and markers of a bare chat', () => {
        const normalized = storeWith({
            [keyFor(PERSONA, 'Nova.png')]: { activeBranchId: 'main', branches: { main: { messages: lines(2), unread: -3, lastActivity: 'x' } } },
        });

        const nova = getLegacyThread(normalized, 'Nova.png', '', { personaId: PERSONA });

        expect(nova.branches.main).toMatchObject({
            unread: 0,
            lastActivity: NOW,
            followupCount: 0,
            lastAutoMessageAt: 0,
            memorySummary: '',
            memoryMessageCount: 0,
            createdAt: NOW,
            updatedAt: NOW,
        });
        expect(nova.branches.main.scheduleTriggers).toEqual({});
        expect(nova.branches.main.sessionMarkers).toEqual({});
    });
});

describe('canonicalizeLegacyGroupThread', () => {
    function groupOf(members, extra = {}) {
        return normalizeLegacyGroupRecord({ id: 'g1', personaId: PERSONA, members, ...extra });
    }

    test('merges the alias threads of one group into the most recently updated one', () => {
        const { store, groupIds } = buildLegacySettingsFixture();
        const normalized = normalizeLegacyStore(store);
        const group = normalized.groups.find(item => item.id === groupIds.owned);
        const aliasKeys = () => Object.keys(normalized.characters).filter(key => parseLegacyThreadKey(key).groupId === groupIds.owned);
        expect(aliasKeys()).toHaveLength(3);

        const anchor = canonicalizeLegacyGroupThread(normalized, group, group.id, PERSONA);

        expect(anchor).toEqual({ avatar: 'Lyra.png', threadKey: keyFor(PERSONA, 'Lyra.png', groupIds.owned) });
        expect(aliasKeys()).toEqual([anchor.threadKey]);
        const merged = normalized.characters[anchor.threadKey];
        expect(merged.threadAvatar).toBe('Lyra.png');
        expect(merged.groupId).toBe(groupIds.owned);
        expect(merged.branches.main.messages.map(item => item.mes)).toEqual([
            'shared line in two aliases',
            'hello group',
            'orion here',
            'nova again',
            'a REST-written line',
            'orion alias only',
            'lyra via unscoped alias',
        ]);
        expect(merged.branches.main.unread).toBe(3);
    });

    test('a line that two aliases hold is kept once', () => {
        const shared = message('character', 'both have it', { id: 'shared-1', minute: 1 });
        const normalized = storeWith({
            [keyFor(PERSONA, 'Nova.png', 'g1')]: thread('group', [branch('main', 'Main', [shared, message('user', 'only nova', { minute: 2 })])]),
            [keyFor(PERSONA, 'Orion.png', 'g1')]: thread('group', [branch('main', 'Main', [structuredClone(shared), message('character', 'only orion', { minute: 3 })])]),
        });

        const anchor = canonicalizeLegacyGroupThread(normalized, groupOf(['Nova.png', 'Orion.png']), 'g1', PERSONA);

        const mes = normalized.characters[anchor.threadKey].branches.main.messages.map(item => item.mes);
        expect(mes).toEqual(['both have it', 'only nova', 'only orion']);
    });

    test('the alias with history wins over a newer empty one, then the newer one wins, then the first member', () => {
        const withHistory = thread('group', [branch('main', 'Main', lines(2, { prefix: 'old', firstMinute: 1 }))]);
        const emptyAndNewer = thread('group', [branch('main', 'Main', [], { updatedAt: BASE + 9_000_000, lastActivity: BASE + 9_000_000 })]);
        let normalized = storeWith({
            [keyFor(PERSONA, 'Nova.png', 'g1')]: emptyAndNewer,
            [keyFor(PERSONA, 'Orion.png', 'g1')]: withHistory,
        });
        expect(canonicalizeLegacyGroupThread(normalized, groupOf(['Nova.png', 'Orion.png']), 'g1', PERSONA).avatar).toBe('Orion.png');

        normalized = storeWith({
            [keyFor(PERSONA, 'Nova.png', 'g1')]: thread('group', [branch('main', 'Main', lines(2, { firstMinute: 1 }))]),
            [keyFor(PERSONA, 'Orion.png', 'g1')]: thread('group', [branch('main', 'Main', lines(2, { firstMinute: 50 }))]),
        });
        expect(canonicalizeLegacyGroupThread(normalized, groupOf(['Nova.png', 'Orion.png']), 'g1', PERSONA).avatar).toBe('Orion.png');

        normalized = storeWith({});
        expect(canonicalizeLegacyGroupThread(normalized, groupOf(['Nova.png', 'Orion.png']), 'g1', PERSONA).avatar).toBe('Nova.png');
    });

    test('a group with no thread yields its first member and creates nothing', () => {
        const normalized = storeWith({});
        const anchor = canonicalizeLegacyGroupThread(normalized, groupOf(['Orion.png', 'Aria.png']), 'g1', PERSONA);
        expect(anchor).toEqual({ avatar: 'Orion.png', threadKey: keyFor(PERSONA, 'Orion.png', 'g1') });
        expect(Object.keys(normalized.characters)).toEqual([]);
    });

    test('a disabled member holds no anchor and its alias thread is left alone', () => {
        const normalized = storeWith({
            [keyFor(PERSONA, 'Sol.png', 'g1')]: thread('group', [branch('main', 'Main', lines(3))]),
            [keyFor(PERSONA, 'Vega.png', 'g1')]: thread('group', [branch('main', 'Main', lines(2, { prefix: 'disabled' }))]),
        });
        const group = groupOf(['Sol.png', 'Vega.png', 'Ghost.png'], { disabled_members: ['Vega.png'] });

        const anchor = canonicalizeLegacyGroupThread(normalized, group, 'g1', PERSONA);

        expect(anchor.avatar).toBe('Sol.png');
        expect(Object.keys(normalized.characters)).toContain(keyFor(PERSONA, 'Vega.png', 'g1'));
    });

    test.each([
        ['no group id', [{ members: ['a.png', 'b.png'] }, '']],
        ['no members list', [{ id: 'g1' }, 'g1']],
        ['only disabled members', [{ id: 'g1', members: ['a.png'], disabled_members: ['a.png'] }, 'g1']],
        ['members that cannot be keys', [{ id: 'g1', members: ['a:b.png'] }, 'g1']],
    ])('returns null for %s', (_name, [group, groupId]) => {
        expect(canonicalizeLegacyGroupThread(storeWith({}), group, groupId, PERSONA)).toBeNull();
    });

    test('merges a member alias that still has an unscoped key by moving it to the persona first', () => {
        const normalized = storeWith({
            [keyFor('', 'Lyra.png', 'g1')]: thread('group', [branch('main', 'Main', lines(2, { prefix: 'unscoped', firstMinute: 70 }))]),
            [keyFor(PERSONA, 'Nova.png', 'g1')]: thread('group', [branch('main', 'Main', lines(2, { prefix: 'scoped', firstMinute: 1 }))]),
        });

        const anchor = canonicalizeLegacyGroupThread(normalized, groupOf(['Nova.png', 'Lyra.png']), 'g1', PERSONA);

        expect(Object.keys(normalized.characters)).toEqual([anchor.threadKey]);
        expect(normalized.characters[anchor.threadKey].branches.main.messages).toHaveLength(4);
    });

    test('keeps overflow as a separate chat when the merged chat would pass 250 messages', () => {
        const first = lines(130, { prefix: 'first', firstMinute: 1 });
        const second = lines(130, { prefix: 'second', firstMinute: 200 });
        const normalized = storeWith({
            [keyFor(PERSONA, 'Nova.png', 'g1')]: thread('group', [branch('main', 'Main', first)]),
            [keyFor(PERSONA, 'Orion.png', 'g1')]: thread('group', [branch('main', 'Main', second)]),
        });

        const anchor = canonicalizeLegacyGroupThread(normalized, groupOf(['Nova.png', 'Orion.png']), 'g1', PERSONA);

        const anchored = normalized.characters[anchor.threadKey];
        const loser = anchor.avatar === 'Nova.png' ? 'Orion.png' : 'Nova.png';
        expect(Object.keys(anchored.branches)).toEqual(['main', `main-merged-${loser}`]);
        expect(anchored.branches.main.messages).toHaveLength(130);
        expect(anchored.branches[`main-merged-${loser}`].messages).toHaveLength(130);
        expect(anchored.branches[`main-merged-${loser}`].id).toBe(`main-merged-${loser}`);
    });
});

describe('the whole fixture, read the way the migration reads it', () => {
    function readAll() {
        const { store, groupIds } = buildLegacySettingsFixture();
        const normalized = normalizeLegacyStore(store);
        for (const key of Object.keys(normalized.characters)) {
            const parsed = parseLegacyThreadKey(key);
            if (parsed.personaId) {
                continue;
            }
            const persona = String(normalized.legacyThreadPersonaAssignments[key] || PERSONA);
            getLegacyThread(normalized, parsed.avatar, parsed.groupId, { personaId: persona });
        }
        for (const group of normalized.groups) {
            canonicalizeLegacyGroupThread(normalized, group, group.id, group.personaId || PERSONA);
        }
        for (const key of Object.keys(normalized.characters)) {
            const parsed = parseLegacyThreadKey(key);
            if (parsed.personaId) {
                getLegacyThread(normalized, parsed.avatar, parsed.groupId, { personaId: parsed.personaId });
            }
        }
        return { normalized, groupIds };
    }

    test('ends with the thread keys and message counts the old server code produced', () => {
        const { normalized, groupIds } = readAll();

        const summary = Object.fromEntries(Object.entries(normalized.characters).map(([key, entry]) => [
            key,
            Object.fromEntries(Object.entries(entry.branches).map(([id, item]) => [id, item.messages.length])),
        ]));

        expect(summary).toEqual({
            [keyFor(PERSONA, 'Orion.png')]: { main: 5 },
            'Lyra.png': { main: 3 },
            [keyFor(PERSONA, 'Lyra.png')]: { main: 5 },
            [keyFor(PERSONA, 'Aria.png')]: { main: 10, br_1700000600000_bbb222: 4, 'main-merged-Vega.png': 2 },
            [keyFor(PERSONA, 'Cass.png')]: { main: 0 },
            [keyFor(PERSONA, 'Vega.png')]: { main: 3 },
            [keyFor(PERSONA, 'Ghost.png')]: { main: 4 },
            [keyFor('persona-gone.png', 'Nova.png')]: { main: 3 },
            [keyFor(PERSONA_TWO, 'Cass.png')]: { main: 3 },
            [keyFor(PERSONA_TWO, 'Vega.png')]: { main: 2 },
            [keyFor(PERSONA, 'Sol.png', groupIds.belowTwo)]: { main: 3 },
            [keyFor(PERSONA_TWO, 'Nova.png', groupIds.uploaded)]: { main: 4 },
            [keyFor(PERSONA, 'Nova.png', groupIds.roleplay)]: { main: 3 },
            [keyFor(PERSONA, 'Orion.png', groupIds.roleplay)]: { main: 3 },
            [keyFor(PERSONA, 'Nova.png', groupIds.roleplayMissing)]: { main: 2 },
            [keyFor(PERSONA_TWO, 'Orion.png')]: { main: 8 },
            [keyFor(PERSONA, 'Nova.png')]: { main: 8, br_1700000500000_aaa111: 4 },
            [keyFor(PERSONA_TWO, 'Sol.png')]: { main: 3 },
            [keyFor(PERSONA, 'Lyra.png', groupIds.owned)]: { main: 7 },
            [keyFor(PERSONA, 'Lyra.png', groupIds.noPersona)]: { main: 2 },
        });
        expect(normalized.legacyThreadPersonaAssignments).toEqual({ 'Lyra.png': PERSONA });
    });

    test('never changes the stored object', () => {
        const { settings } = buildLegacySettingsFixture();
        const before = JSON.stringify(settings);
        const normalized = normalizeLegacyStore(settings.extension_settings.sillybunny_conversation);
        getLegacyThread(normalized, 'Nova.png', '', { personaId: PERSONA });
        expect(JSON.stringify(settings)).toBe(before);
    });
});
