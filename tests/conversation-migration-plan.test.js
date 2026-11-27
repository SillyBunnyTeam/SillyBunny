/**
 * The plan of the conversation storage migration, one test per row of the resolution table of Phase 1, task 1U
 * (the 26 findings of the Phase 0 dry run). The plan is a pure function, so these tests write no file.
 */
import { describe, expect, test } from '@jest/globals';

import { LEGACY_DEFAULT_SETTINGS } from '../src/conversation-legacy-defaults.js';
import { isChatId, isConversationId } from '../src/conversation-paths.js';
import { parseLegacyThreadKey } from '../src/conversation-legacy.js';
import { planMigration, SKIP } from '../src/conversation-migration-plan.js';
import { applyCharacterPatch, MAX_GROUP_MEMBERS, parseCreateInput } from '../src/conversation-schema.js';
import {
    BASE,
    branch,
    buildLegacySettingsFixture,
    CHARACTER_FILES,
    keyFor,
    lines,
    message,
    MISSING_CHARACTER,
    NON_DEFAULT_REMOVED_SETTINGS,
    PERSONA,
    PERSONA_GONE,
    PERSONA_TWO,
    reminder,
    thread,
} from './util/conversation-legacy-fixture.js';

const NOW = BASE + 10_000 * 60_000;
const ROLEPLAY_GROUP = { id: 'rp-group-1', name: 'Roleplay Group One', members: ['Nova.png', 'Orion.png'], disabled_members: [] };

function createInputs(overrides = {}) {
    const characters = new Set(CHARACTER_FILES);
    const personas = new Set([PERSONA, PERSONA_TWO]);
    let counter = 0;
    return {
        activePersona: PERSONA,
        characterExists: avatar => characters.has(avatar),
        personaExists: personaId => personas.has(personaId),
        readRoleplayGroup: id => (id === ROLEPLAY_GROUP.id ? structuredClone(ROLEPLAY_GROUP) : null),
        pinnedChats: {},
        now: NOW,
        createId: time => `conv_${time}_${String(++counter).padStart(6, '0')}`,
        ...overrides,
    };
}

function planOf(store, overrides) {
    return planMigration(structuredClone(store), createInputs(overrides));
}

function storeOf(entries = [], extra = {}) {
    return {
        version: 1,
        localStorageMigrated: false,
        settings: {},
        characters: Object.fromEntries(entries),
        groups: [],
        reminders: [],
        ...extra,
    };
}

/** A scoped direct thread, listed (`enabled`) unless the overrides say otherwise. */
function directEntry(avatar, branches, { persona = PERSONA, settings = {}, ...options } = {}) {
    return [keyFor(persona, avatar), thread('solo', branches, { avatar, settings: { enabled: true, ...settings }, ...options })];
}

function groupRecord(id, members, overrides = {}) {
    return {
        id,
        personaId: PERSONA,
        name: `Group ${id}`,
        members,
        avatar_url: 'img/ai4.png',
        disabled_members: [],
        conversation_settings: {},
        createdAt: BASE + 2000 * 60_000,
        updatedAt: BASE + 2100 * 60_000,
        is_conversation_group: true,
        ...overrides,
    };
}

function groupEntry(groupId, avatar, branches, { persona = PERSONA, settings = {}, ...options } = {}) {
    return [keyFor(persona, avatar, groupId), thread('group', branches, { avatar, groupId, settings: { enabled: false, ...settings }, ...options })];
}

const main = (messages, overrides) => branch('main', 'Main', messages, overrides);
const byKey = (plan, key) => plan.conversations.find(item => item.legacyKey === key);
const groupNamed = (plan, name) => plan.conversations.find(item => item.input.kind === 'group' && item.input.name === name);
const chatOf = (item, id) => item.input.chats.find(chat => chat.id === id);
const messagesOf = chat => chat.records.slice(1);
const skippedTotals = plan => Object.values(plan.report.skipped).reduce((sum, entry) => ({
    threads: sum.threads + entry.threads, chats: sum.chats + entry.chats, messages: sum.messages + entry.messages,
}), { threads: 0, chats: 0, messages: 0 });

describe('planMigration on the shared fixture', () => {
    const { store, groupIds } = buildLegacySettingsFixture();
    const plan = planOf(store);

    test('writes valid ids, and only the conversations that the rules below keep', () => {
        expect(plan.conversations.length).toBeGreaterThan(10);
        for (const { id, input } of plan.conversations) {
            expect(isConversationId(id)).toBe(true);
            expect(input.id).toBe(id);
            for (const chat of input.chats) {
                expect(isChatId(chat.id)).toBe(true);
            }
        }
        expect(new Set(plan.conversations.map(item => item.id)).size).toBe(plan.conversations.length);
    });

    test('row 14: every message of the normalised store is written or accounted for, and the raw counts are reported apart', () => {
        const { raw, normalised, migrated } = plan.report;
        expect(normalised.messages).toBe(migrated.messages + skippedTotals(plan).messages);
        // The fixture has a thread named "constructor", an empty message, a message that is not an object, and merged aliases.
        expect(raw.threads).toBeGreaterThan(normalised.threads);
        expect(raw.messages).not.toBe(normalised.messages);
        expect(raw.groups).toBe(store.groups.length);
        expect(raw.reminders).toBe(store.reminders.length);
    });

    test('the report names no character, persona, group or message text', () => {
        const text = JSON.stringify(plan.report);
        for (const secret of ['Nova', 'Fixture Group', 'user-default', 'line 0', groupIds.owned]) {
            expect(text).not.toContain(secret);
        }
    });

    test('row 1, R5-21: a direct thread is written if it is listed or has messages, and a hidden empty one stays in the backup', () => {
        const listedEmpty = planOf(storeOf([directEntry('Nova.png', [main([])])]));
        const hiddenWithMessages = planOf(storeOf([directEntry('Nova.png', [main(lines(2))], { settings: { enabled: false } })]));
        const hiddenEmpty = planOf(storeOf([directEntry('Nova.png', [main([])], { settings: { enabled: false } })]));

        expect(listedEmpty.report.migrated.conversations).toBe(1);
        expect(hiddenWithMessages.report.migrated.conversations).toBe(1);
        expect(hiddenEmpty.report.migrated.conversations).toBe(0);
        expect(hiddenEmpty.report.skipped[SKIP.hiddenAndEmpty]).toMatchObject({ threads: 1, chats: 1, messages: 0 });
        expect(plan.report.skipped[SKIP.hiddenAndEmpty].threads).toBe(1);
    });

    test('row 1: a group is written whatever its `enabled` says', () => {
        const group = groupNamed(plan, 'Fixture Group One');
        expect(group.input.kind).toBe('group');
        for (const key of Object.keys(store.characters).filter(item => item.includes(groupIds.owned))) {
            expect(store.characters[key].settings.enabled).toBe(false);
        }
    });

    test('rows 2 and 12: a thread of a roleplay group is resolved from its group file, and one with no file stays in the backup', () => {
        const resolved = groupNamed(plan, ROLEPLAY_GROUP.name);
        expect(resolved.input).toMatchObject({ kind: 'group', characters: ['Nova.png', 'Orion.png'], name: ROLEPLAY_GROUP.name });
        expect(resolved.input.chats.reduce((sum, chat) => sum + messagesOf(chat).length, 0)).toBe(6);
        expect(plan.report.skipped[SKIP.groupUnresolved]).toMatchObject({ threads: 1, messages: 2 });
    });

    test('row 3: the lines of the anchor member of a group are stamped, and `partner` becomes `member`', () => {
        const group = groupNamed(plan, 'Fixture Group One');
        const records = messagesOf(group.input.chats[0]);
        const roles = records.map(record => record.role);

        expect(roles).not.toContain('partner');
        expect(roles).not.toContain('assistant');
        // After the aliases are merged, the lines of a member that carry no avatar belong to the anchor of the thread.
        const anchor = parseLegacyThreadKey(group.legacyKey).avatar;
        expect(records.find(record => record.mes === 'nova again').extra.member_avatar).toBe(anchor);
        const orionLine = records.find(record => record.mes === 'orion here');
        expect(orionLine).toMatchObject({ role: 'member', extra: { member_avatar: 'Orion.png' } });
        expect(orionLine.extra).not.toHaveProperty('partner_avatar');
        expect(orionLine.extra.conversation_reply_to.role).toBe('member');
        expect(records.find(record => record.mes === 'a REST-written line').role).toBe('character');
        expect(records.find(record => record.mes === 'hello group')).toMatchObject({ role: 'user', is_user: true });
    });

    test('rows 4 and 5: a message keeps its `created_at`, and no header carries an integrity slug', () => {
        const aria = byKey(plan, keyFor(PERSONA, 'Aria.png'));
        const [header, first] = chatOf(aria, 'main').records;

        expect(first.created_at).toBe(store.characters[keyFor(PERSONA, 'Aria.png')].branches.main.messages[0].created_at);
        expect(header.chat_metadata).not.toHaveProperty('integrity');
        expect(Object.keys(first).toSorted()).toEqual(['created_at', 'extra', 'id', 'is_system', 'is_user', 'mes', 'name', 'role', 'send_date']);
    });

    test('row 6: a chat keeps its worker state and markers, and drops the weekly triggers', () => {
        const aria = byKey(plan, keyFor(PERSONA, 'Aria.png'));
        const mainChat = chatOf(aria, 'main');
        const trip = chatOf(aria, 'br_1700000600000_bbb222');

        expect(mainChat).toMatchObject({ followupCount: 2, lastAutoMessageAt: BASE + 705 * 60_000 });
        expect(mainChat.sessionMarkers).toEqual({ seen_at: BASE + 700 * 60_000, auto_chat_at: BASE + 710 * 60_000 });
        expect(trip).not.toHaveProperty('scheduleTriggers');
        expect(JSON.stringify(aria.input)).not.toContain('slot-1');
        expect(plan.report.dropped.scheduleTriggers).toBe(1);
    });

    test('row 7: the read marker is the message before the unread tail, and a count larger than the chat clamps to nothing read', () => {
        const nova = planOf(storeOf([directEntry('Nova.png', [main(lines(6), { unread: 2 })])])).conversations[0];
        const novaMessages = messagesOf(chatOf(nova, 'main'));
        expect(chatOf(nova, 'main').readThrough).toBe(novaMessages[3].id);

        const allRead = planOf(storeOf([directEntry('Nova.png', [main(lines(3), { unread: 0 })])])).conversations[0];
        expect(chatOf(allRead, 'main').readThrough).toBe(messagesOf(chatOf(allRead, 'main'))[2].id);

        const aria = byKey(plan, keyFor(PERSONA, 'Aria.png'));
        expect(chatOf(aria, 'main').readThrough).toBe('');
        expect(plan.report.unreadClamped).toBeGreaterThan(0);

        const empty = planOf(storeOf([directEntry('Nova.png', [main([])])])).conversations[0];
        expect(chatOf(empty, 'main').readThrough).toBe('');
    });

    test('row 8: settings are stored sparse, and the system prompt keeps its new name', () => {
        const quiet = planOf(storeOf([directEntry('Nova.png', [main(lines(2))])]));
        expect(quiet.conversations[0].input.settings).toEqual({});

        const kitchen = byKey(plan, keyFor(PERSONA_TWO, 'Cass.png'));
        expect(kitchen.input.settings).toMatchObject({
            proactive_messaging: true,
            inactivity_threshold: 90,
            max_followups: 2,
            notifications_muted: true,
            offline_message: 'brb',
            system_prompt: 'A custom system prompt for {{char}}.',
            authors_note: 'Stay in character.',
            lorebook_override: 'My Book',
            image_gen_cooldown: 3,
        });
        expect(kitchen.input.settings).not.toHaveProperty('geechan_chatroom_prompt');
        for (const key of Object.keys(NON_DEFAULT_REMOVED_SETTINGS)) {
            expect(kitchen.input.settings).not.toHaveProperty(key);
        }
        for (const item of plan.conversations) {
            expect(JSON.stringify(item.input.settings)).not.toContain('Role Preamble');
        }
    });

    test('row 9: the placeholder group avatar counts as no avatar, and an uploaded one is kept for the copy', () => {
        expect(groupNamed(plan, 'Fixture Group One').groupAvatarUrl).toBe('');
        expect(groupNamed(plan, 'Fixture Group Four').groupAvatarUrl).toBe('/user/images/group-four.png');
    });

    test('row 10: a chat has one memory summary: its own, else the thread\'s for the active chat only', () => {
        const aria = byKey(plan, keyFor(PERSONA, 'Aria.png'));
        const ownSummary = chatOf(aria, 'main').records[0].chat_metadata.sb_conversation;
        const activeChat = chatOf(aria, 'br_1700000600000_bbb222').records[0].chat_metadata.sb_conversation;

        expect(ownSummary).toEqual({ memory_summary: 'A different branch-level summary.', memory_message_count: 8, memory_updated_at: BASE + 800 * 60_000 });
        expect(activeChat).toEqual({ memory_summary: 'Thread-level summary of the chat so far.', memory_message_count: 12, memory_updated_at: BASE + 900 * 60_000 });
        expect(aria.input.activeChatId).toBe('br_1700000600000_bbb222');
        expect(chatOf(aria, 'main').records[0].chat_metadata.sb_conversation.memory_summary).not.toBe('Thread-level summary of the chat so far.');
    });

    test('row 11: a chat id that is not an id gets a new one, and the old one, the reminders and the markers follow', () => {
        const aria = byKey(plan, keyFor(PERSONA, 'Aria.png'));
        const renamed = aria.input.chats.find(chat => chat.legacyId === 'main-merged-Vega.png');

        expect(renamed).toBeDefined();
        expect(isChatId(renamed.id)).toBe(true);
        expect(renamed.id).not.toBe('main-merged-Vega.png');
        expect(aria.input.reminders.map(item => item.chatId)).toEqual(['br_1700000600000_bbb222']);
    });

    test('row 12: an unscoped key belongs to the assigned persona, else the active one', () => {
        expect(byKey(plan, keyFor(PERSONA_TWO, 'Sol.png'))).toBeDefined();
        expect(byKey(plan, keyFor(PERSONA, 'Nova.png'))).toBeDefined();
        expect(byKey(plan, 'Sol.png')).toBeUndefined();
    });

    test('row 12: a legacy copy that the merge could not take in becomes extra chats of its conversation', () => {
        const lyra = byKey(plan, keyFor(PERSONA, 'Lyra.png'));

        expect(lyra.input.chats).toHaveLength(2);
        expect(lyra.input.chats[1]).toMatchObject({ name: 'Main (earlier copy)' });
        expect(messagesOf(lyra.input.chats[1])).toHaveLength(3);
        expect(lyra.input.activeChatId).toBe('main');
    });

    test('row 12: with no persona to give an unscoped key to, it stays in the backup', () => {
        const noPersona = planOf(storeOf([['Nova.png', thread('solo', [main(lines(2))], { settings: { enabled: true } })]]), { activePersona: '' });

        expect(noPersona.report.migrated.conversations).toBe(0);
        expect(noPersona.report.skipped[SKIP.legacyNoPersona]).toMatchObject({ threads: 1, messages: 2 });
    });

    test('row 16: a group with one usable member adds its chats, named after the group, to that character\'s direct conversation', () => {
        const record = groupRecord('g1', ['Nova.png', 'Orion.png', MISSING_CHARACTER], { disabled_members: ['Orion.png'], name: 'Trio' });
        const store = storeOf([
            directEntry('Nova.png', [main(lines(2, { prefix: 'solo' }))]),
            groupEntry('g1', 'Nova.png', [main(lines(3, { prefix: 'group' })), branch('side', 'Side', lines(1, { prefix: 'side' }), { createdAt: BASE + 5 })]),
        ], { groups: [record] });

        const converted = planOf(store);

        expect(converted.report.migrated).toMatchObject({ conversations: 1, direct: 1, group: 0, convertedGroups: 1, chats: 3, messages: 6 });
        const direct = converted.conversations[0];
        expect(direct.input.chats.map(chat => chat.name)).toEqual(['Main', 'Trio', 'Trio - Side']);
        expect(direct.input.activeChatId).toBe('main');
        expect(new Set(direct.input.chats.map(chat => chat.id)).size).toBe(3);
    });

    test('row 16: with no direct conversation to join, the converted group makes one, and a group with no usable member stays in the backup', () => {
        const converted = byKey(plan, keyFor(PERSONA, 'Sol.png', groupIds.belowTwo));
        expect(converted.input).toMatchObject({ kind: 'direct', personaId: PERSONA, characters: ['Sol.png'], name: '' });
        expect(converted.input.chats[0].name).toBe('Fixture Group Two');
        expect(plan.report.migrated.convertedGroups).toBe(1);

        const none = planOf(storeOf([groupEntry('g9', MISSING_CHARACTER, [main(lines(2))])], { groups: [groupRecord('g9', [MISSING_CHARACTER, 'Gone.png'])] }));
        expect(none.report.migrated.conversations).toBe(0);
        expect(none.report.skipped[SKIP.groupNoUsableMember]).toMatchObject({ threads: 1, messages: 2 });
    });

    test('rows 17 and R5-22: an empty chat that is not the active one stays in the backup, and the active chat is kept even when empty', () => {
        const listed = planOf(storeOf([directEntry('Nova.png', [
            main(lines(2)),
            branch('empty-side', 'Side', [], { createdAt: BASE + 10 }),
            branch('empty-active', 'Active', [], { createdAt: BASE + 20 }),
        ], { activeBranchId: 'empty-active' })]));
        const conversation = listed.conversations[0];

        expect(conversation.input.chats.map(chat => chat.id)).toEqual(['main', 'empty-active']);
        expect(conversation.input.activeChatId).toBe('empty-active');
        expect(listed.report.emptyChatsSkipped).toBe(1);
    });

    test('row 18: a Home pin is keyed by the conversation and the chat, and a pin of a chat that stays in the backup is dropped', () => {
        const aria = [directEntry('Aria.png', [main(lines(2)), branch('empty', 'Empty', [], { createdAt: BASE + 9 })])];
        const pins = {
            'conversation_char_Aria.png_branch_main': { avatar: 'Aria.png', file_name: 'Main', is_conversation: true, conversation_branch_id: 'main' },
            'conversation_char_Aria.png_branch_empty': { avatar: 'Aria.png', file_name: 'Empty', is_conversation: true, conversation_branch_id: 'empty' },
            'conversation_char_Gone.png_branch_main': { avatar: 'Gone.png', is_conversation: true, conversation_branch_id: 'main' },
            'char_Aria.png_roleplay chat': { avatar: 'Aria.png', file_name: 'roleplay chat' },
        };

        const pinned = planOf(storeOf(aria), { pinnedChats: pins });
        const [{ id }] = pinned.conversations;

        expect(Object.keys(pinned.pins.pins).toSorted()).toEqual([`conversation_${id}_main`, 'char_Aria.png_roleplay chat'].toSorted());
        expect(pinned.pins.pins[`conversation_${id}_main`]).toEqual({
            avatar: 'Aria.png', file_name: 'Main', is_conversation: true, conversation_id: id, conversation_chat_id: 'main',
        });
        expect(pinned.pins).toMatchObject({ rekeyed: 1, dropped: 2, changed: true });
        expect(planOf(storeOf(aria)).pins.changed).toBe(false);
    });

    test('row 19: the extras of a direct conversation are `multi_char_names` and the authors of `partner` lines', () => {
        const aria = byKey(plan, keyFor(PERSONA, 'Aria.png'));

        expect(aria.input.extras).toEqual(['Vega.png', 'Cass.png', MISSING_CHARACTER]);
        expect(aria.input.settings).not.toHaveProperty('multi_char_names');

        const authorsOnly = planOf(storeOf([directEntry('Nova.png', [main([
            message('character', 'hi'),
            message('partner', 'from orion', { extra: { partner_avatar: 'Orion.png' } }),
            message('partner', 'again', { extra: { partner_avatar: 'Orion.png' } }),
        ])])])).conversations[0];
        expect(authorsOnly.input.extras).toEqual(['Orion.png']);
        const member = messagesOf(chatOf(authorsOnly, 'main')).find(record => record.mes === 'from orion');
        expect(member).toMatchObject({ role: 'member', extra: { member_avatar: 'Orion.png' } });
    });

    test('rows 20 and R5-23: a status that is not online becomes the character\'s override, and offline wins a conflict', () => {
        expect(plan.characterState['Cass.png']).toEqual({ statusOverride: 'offline' });
        const store = storeOf([
            directEntry('Nova.png', [main(lines(2))], { settings: { availability: 'dnd' } }),
            directEntry('Nova.png', [main(lines(2))], { persona: PERSONA_TWO, settings: { availability: 'offline' } }),
            directEntry('Orion.png', [main(lines(2))], { settings: { availability: 'idle' } }),
            directEntry('Lyra.png', [main(lines(2))], { settings: { availability: 'online' } }),
        ]);

        const state = planOf(store).characterState;

        expect(state['Nova.png']).toEqual({ statusOverride: 'offline' });
        expect(state['Orion.png']).toEqual({ statusOverride: 'idle' });
        expect(state).not.toHaveProperty('Lyra.png');
    });

    test('row 20: a character with a routine takes no override, because the routine wins today', () => {
        const schedule = { days: { 1: [{ time: '09:00-17:00', activity: 'work', status: 'dnd' }] }, generatedAt: BASE + 5 };
        const state = planOf(storeOf([directEntry('Nova.png', [main(lines(2))], { settings: { availability: 'offline' }, schedule })])).characterState;

        expect(state['Nova.png']).not.toHaveProperty('statusOverride');
        expect(state['Nova.png'].routine.enabled).toBe(true);
    });

    test('row 21: an existing group has messaging first off, whatever it stored', () => {
        const group = groupNamed(plan, 'Fixture Group One');

        expect(store.groups[0].conversation_settings.proactive_messaging).toBe(true);
        expect(group.input.settings).not.toHaveProperty('proactive_messaging');
    });

    test('rows 22 and O-4: with a global idle toggle on, direct conversations get messaging first on, with their own patience, and groups do not', () => {
        const withToggle = planOf(structuredClone({ ...store, settings: { ...store.settings, idle_followup: true } }));
        const withoutToggle = planOf(structuredClone({ ...store, settings: { ...store.settings, idle_followup: false, idle_spontaneous: false, idle_action: 'disabled' } }));
        const patient = storeOf([directEntry('Nova.png', [main(lines(2))], { settings: { inactivity_threshold: 45 } })], { settings: { idle_action: 'both' } });

        const isOwnDirect = item => item.input.kind === 'direct' && !parseLegacyThreadKey(item.legacyKey).groupId;
        for (const item of withToggle.conversations) {
            expect(item.input.settings.proactive_messaging === true).toBe(isOwnDirect(item));
        }
        expect(withoutToggle.conversations.find(item => item.input.kind === 'direct' && item.legacyKey === keyFor(PERSONA, 'Nova.png')).input.settings).not.toHaveProperty('proactive_messaging');
        expect(planOf(patient).conversations[0].input.settings).toEqual({ proactive_messaging: true, inactivity_threshold: 45 });
        expect(plan.globalSettings).not.toHaveProperty('idle_followup');
        expect(plan.globalSettings).not.toHaveProperty('idle_action');
    });

    test('row 23: a custom selfie prompt becomes the image prompt when that is at its default, with the scene appended', () => {
        const withScene = byKey(plan, keyFor(PERSONA_TWO, 'Cass.png'));
        const withoutScene = byKey(plan, keyFor(PERSONA_TWO, 'Vega.png'));

        expect(withoutScene.input.settings.image_gen_prompt_template).toBe('selfie only {{char}}, {{scene}}');
        expect(withScene.input.settings.image_gen_prompt_template).toBe('custom {{char}} {{scene}}');
        const selfieWithScene = planOf(storeOf([directEntry('Nova.png', [main(lines(2))], { settings: { selfie_prompt: 'close up of {{char}}, {{scene}}' } })]));
        expect(selfieWithScene.conversations[0].input.settings.image_gen_prompt_template).toBe('close up of {{char}}, {{scene}}');
        const notCustom = planOf(storeOf([directEntry('Nova.png', [main(lines(2))], { settings: { selfie_prompt: LEGACY_DEFAULT_SETTINGS.selfie_prompt } })]));
        expect(notCustom.conversations[0].input.settings).toEqual({});
    });

    test('row 24: the quiet hours of the conversation that was updated last become the mode-wide window', () => {
        expect(plan.globalSettings).toMatchObject({ quiet_hours_start: '21:30', quiet_hours_end: '06:30' });
        const noWindow = planOf(storeOf([directEntry('Nova.png', [main(lines(2))])]));
        expect(noWindow.globalSettings).not.toHaveProperty('quiet_hours_start');
        const invalid = planOf(storeOf([directEntry('Nova.png', [main(lines(2))], { settings: { quiet_hours_start: '25:00', quiet_hours_end: '07:00' } })]));
        expect(invalid.globalSettings).not.toHaveProperty('quiet_hours_start');
    });

    test('row 25: "Simulate reply delay" is off only if every conversation had a multiplier of 0', () => {
        const zero = { reply_delay_multiplier: 0 };
        const allZero = planOf(storeOf([directEntry('Nova.png', [main(lines(2))], { settings: zero }), directEntry('Orion.png', [main(lines(2))], { settings: zero })]));
        const oneZero = planOf(storeOf([directEntry('Nova.png', [main(lines(2))], { settings: zero }), directEntry('Orion.png', [main(lines(2))])]));
        const nothing = planOf(storeOf());

        expect(allZero.globalSettings.simulate_reply_delay).toBe(false);
        expect(oneZero.globalSettings.simulate_reply_delay).toBe(true);
        expect(nothing.globalSettings.simulate_reply_delay).toBe(true);
    });

    test('row 26: a character\'s routine is its generated schedule; the weekly slots and the text schedule stay in the backup', () => {
        const aria = plan.characterState['Aria.png'];

        expect(aria.routine).toEqual({ enabled: true, text: expect.any(String), generatedAt: BASE + 100 * 60_000 });
        expect(JSON.parse(aria.routine.text).days['1'][0].activity).toBe('work');
        const kitchen = byKey(plan, keyFor(PERSONA_TWO, 'Cass.png'));
        expect(JSON.stringify(kitchen.input)).not.toContain('Mon: work');
        expect(JSON.stringify(plan.characterState)).not.toContain('good morning');
    });

    test('keeps the mode-wide settings and adds the two new ones', () => {
        expect(plan.globalSettings).toMatchObject({ custom_instructions: 'Be brief.', grounded_dialogue_rules_enabled: true, connection_profile: 'profile-1', lorebooks_enabled: false, simulate_reply_delay: true });
    });

    test('reminders follow their conversation and chat, and the ones with no conversation are counted', () => {
        expect(plan.report.migrated.reminders).toBe(6);
        expect(plan.report.dropped.remindersUnplaced).toBe(2);
        const nova = byKey(plan, keyFor(PERSONA, 'Nova.png'));
        expect(nova.input.reminders).toHaveLength(3);
        expect(nova.input.reminders.every(item => !('branchId' in item) && !('personaId' in item) && !('groupId' in item))).toBe(true);
        const orphan = nova.input.reminders.find(item => item.invalidAt);
        expect(orphan.chatId).toBe('');
    });

    test('a group that was made and never written to is a group with one empty chat', () => {
        const group = groupNamed(plan, 'Fixture Group Three');

        expect(group.input).toMatchObject({ kind: 'group', characters: ['Orion.png', 'Aria.png'], activeChatId: 'main' });
        expect(group.input.chats).toHaveLength(1);
        expect(messagesOf(group.input.chats[0])).toHaveLength(0);
    });

    test('a thread whose persona or character no longer exists stays in the backup, with its reminders unplaced', () => {
        expect(plan.report.skipped[SKIP.personaMissing]).toMatchObject({ threads: 1 });
        expect(plan.report.skipped[SKIP.characterMissing]).toMatchObject({ threads: 1, messages: 4 });
        expect(byKey(plan, keyFor(PERSONA_GONE, 'Nova.png'))).toBeUndefined();
    });

    test('is deterministic, and does not change the object it was given', () => {
        const source = structuredClone(store);
        const first = planMigration(source, createInputs());
        const second = planMigration(source, createInputs());

        expect(second).toEqual(first);
        expect(source).toEqual(store);
    });
});

describe('planMigration edge cases', () => {
    test('a store with nothing in it plans nothing', () => {
        const plan = planOf(storeOf());

        expect(plan.conversations).toEqual([]);
        expect(plan.characterState).toEqual({});
        expect(plan.report.migrated).toMatchObject({ conversations: 0, chats: 0, messages: 0 });
    });

    test.each([
        ['an array', []],
        ['a string', 'text'],
        ['null', null],
    ])('%s reads as an empty store', (_name, rawStore) => {
        expect(planMigration(rawStore, createInputs()).conversations).toEqual([]);
    });

    test('drops a session marker that the new store would refuse, instead of failing the migration', () => {
        const tooLong = 'sb_conv_last_chime_session_'.padEnd(80, 'x');
        const plan = planOf(storeOf([directEntry('Nova.png', [main(lines(2), { sessionMarkers: { seen_at: 5, [tooLong]: 1 } })])]));

        expect(chatOf(plan.conversations[0], 'main').sessionMarkers).toEqual({ seen_at: 5 });
        expect(plan.report.dropped.markers).toBe(1);
    });

    test('leaves a thread under a key that the legacy reader cannot rebuild in the backup, without failing the others', () => {
        const odd = thread('solo', [main(lines(2))], { settings: { enabled: true } });
        const plan = planOf(storeOf([
            directEntry('Nova.png', [main(lines(2))]),
            [`persona:${PERSONA}:a:b.png`, odd],
            ['persona:broken-key', odd],
        ]));

        expect(plan.report.migrated.conversations).toBe(1);
        expect(plan.report.skipped[SKIP.unparseableKey]).toMatchObject({ threads: 2, messages: 4 });
    });

    test('drops a name that is not a safe file name before it reaches a path', () => {
        const plan = planOf(storeOf([[keyFor(PERSONA, 'sub/Nova.png'), thread('solo', [main(lines(2))], { settings: { enabled: true } })]]));

        expect(plan.report.migrated.conversations).toBe(0);
        expect(plan.report.skipped[SKIP.unsafeName]).toMatchObject({ threads: 1 });
    });

    test('cuts a group name that is longer than the store allows, and removes a NUL character from it', () => {
        const record = groupRecord('g1', ['Nova.png', 'Orion.png'], { name: `a\0${'n'.repeat(300)}` });
        const plan = planOf(storeOf([groupEntry('g1', 'Nova.png', [main(lines(2))])], { groups: [record] }));

        expect(plan.conversations[0].input.name).toHaveLength(200);
        expect(plan.conversations[0].input.name).not.toContain('\0');
    });

    test('two reminders with one id keep the first, and a reminder with an unknown field keeps the known ones', () => {
        const first = reminder({ id: 'rem_dup', text: 'first' });
        const second = reminder({ id: 'rem_dup', text: 'second', surprise: 'field' });
        const plan = planOf(storeOf([directEntry('Nova.png', [main(lines(2))])], { reminders: [first, second] }));

        expect(plan.conversations[0].input.reminders).toHaveLength(1);
        expect(plan.conversations[0].input.reminders[0]).not.toHaveProperty('surprise');
    });

    test('two groups that fall to one member join the same direct conversation', () => {
        const store = storeOf([
            groupEntry('g1', 'Nova.png', [main(lines(2, { prefix: 'one' }))]),
            groupEntry('g2', 'Nova.png', [main(lines(2, { prefix: 'two' }))]),
        ], { groups: [groupRecord('g1', ['Nova.png', MISSING_CHARACTER], { name: 'One' }), groupRecord('g2', ['Nova.png', MISSING_CHARACTER], { name: 'Two' })] });

        const plan = planOf(store);

        expect(plan.conversations).toHaveLength(1);
        expect(plan.conversations[0].input.chats.map(chat => chat.name).toSorted()).toEqual(['One', 'Two']);
    });

    test('filters invalid per-conversation settings out of input.settings and reports the exact dropped count', () => {
        const store = storeOf([
            directEntry('Nova.png', [main(lines(2))], {
                settings: {
                    authors_note: 'valid\u0000nul',
                    offline_message: 'x'.repeat(70_000),
                    inactivity_threshold: Number.POSITIVE_INFINITY,
                    lorebook_override: 'Kept Book',
                },
            }),
        ]);

        const plan = planOf(store);
        const [{ input }] = plan.conversations;

        expect(input.settings).toEqual({ lorebook_override: 'Kept Book' });
        expect(plan.report.dropped.settings).toBe(3);
        expect(() => parseCreateInput(input, { now: NOW })).not.toThrow();
    });

    test('normalizes invalid routine generatedAt timestamps so character state updates never fail validation', () => {
        const days = { 1: [{ time: '09:00-17:00', activity: 'work', status: 'dnd' }] };
        const store = storeOf([
            directEntry('Nova.png', [main(lines(2))], { schedule: { days, generatedAt: 1700000000000.75 } }),
            directEntry('Orion.png', [main(lines(2))], { schedule: { days, generatedAt: -50 }, settings: { schedule_generated_at: 1700000000123 } }),
            directEntry('Lyra.png', [main(lines(2))], { schedule: { days, generatedAt: 9e15 }, settings: { schedule_generated_at: Number.NaN } }),
            directEntry('Aria.png', [main(lines(2))], { schedule: { days, generatedAt: Number.POSITIVE_INFINITY }, settings: { schedule_generated_at: -1 } }),
        ]);

        const { characterState } = planOf(store);

        expect(characterState['Nova.png'].routine.generatedAt).toBe(1700000000000);
        expect(characterState['Orion.png'].routine.generatedAt).toBe(1700000000123);
        expect(characterState['Lyra.png'].routine.generatedAt).toBe(0);
        expect(characterState['Aria.png'].routine.generatedAt).toBe(0);
        for (const state of Object.values(characterState)) {
            expect(() => applyCharacterPatch({}, state)).not.toThrow();
        }
    });

    test('caps usable group members at MAX_GROUP_MEMBERS and deduplicates them', () => {
        const members = Array.from({ length: MAX_GROUP_MEMBERS + 8 }, (_, index) => `Member${index}.png`);
        const record = groupRecord('g-huge', [members[0], ...members], { name: 'Huge Group' });
        const store = storeOf(
            [groupEntry('g-huge', members[0], [main(lines(2))])],
            { groups: [record] },
        );

        const plan = planOf(store, { characterExists: () => true });
        const [{ input }] = plan.conversations;

        expect(input.characters).toHaveLength(MAX_GROUP_MEMBERS);
        expect(new Set(input.characters).size).toBe(MAX_GROUP_MEMBERS);
        expect(() => parseCreateInput(input, { now: NOW })).not.toThrow();
    });
});
