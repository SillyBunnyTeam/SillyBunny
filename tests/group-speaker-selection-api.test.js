import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, test } from '@jest/globals';
import { EventEmitter } from '../public/lib/eventemitter.js';
import { event_types } from '../public/scripts/events.js';

const groupChatsSource = readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');
const groupChatsAst = parse(groupChatsSource, { ecmaVersion: 'latest', sourceType: 'module' });
const speakerStateNames = [
    'GROUP_SPEAKER_CONTROLS_HIDDEN_KEY',
    'selectedGroupSpeakerAvatar',
    'groupSpeakerControlsInitialized',
    'activeGroupTypingName',
    'groupSpeakerAvatarRenderKey',
];
const generationStateNames = [
    'is_group_generating',
    'group_generation_id',
    'groupChatQueueOrder',
    'group_activation_strategy',
    'GROUP_MEMBER_MODELS_KEY',
];

function getTopLevelDeclarations() {
    return groupChatsAst.body.map(node => node.declaration ?? node);
}

function getExportedNames(ast) {
    return ast.body
        .filter(node => node.type === 'ExportNamedDeclaration')
        .flatMap(node => [
            ...node.specifiers.map(specifier => specifier.exported.name),
            ...(node.declaration?.id ? [node.declaration.id.name] : []),
            ...(node.declaration?.declarations ?? []).map(declaration => declaration.id.name),
        ]);
}

/**
 * A minimal jQuery stand-in for the speaker bar: it keeps the rendered avatar buttons and which of them is highlighted.
 */
function createSpeakerBar(handlers) {
    let items = [];
    const wrap = item => ({
        length: 1,
        data: key => key === 'avatar' ? item.avatar : undefined,
        attr(name, value) {
            if (name === 'data-avatar') item.avatar = value;
            return this;
        },
        toggleClass(name, enabled) {
            if (name === 'selected') item.selected = Boolean(enabled);
            return this;
        },
        append() { return this; },
    });
    const container = {
        length: 1,
        on: (event, selector, handler) => { handlers[`${event} ${selector}`] = handler; },
        toggleClass() { return this; },
        find: selector => selector === '.group_speaker_list'
            ? { empty: () => { items = []; return { append: button => items.push(button.item) }; } }
            : { each: callback => items.forEach(item => callback.call(item)) },
    };
    const $ = target => {
        if (target === '#group_speaker_controls') {
            return container;
        }
        if (target === '#group_speaker_controls .group_speaker_avatar') {
            return { removeClass: () => items.forEach(item => { item.selected = false; }) };
        }
        if (target === '<button type="button" class="group_speaker_avatar"></button>') {
            const item = { avatar: '', selected: false };
            return { ...wrap(item), item };
        }
        if (typeof target === 'string' && target.startsWith('<')) {
            return { attr() { return this; }, text() { return this; } };
        }
        if (target && typeof target === 'object' && 'avatar' in target) {
            return wrap(target);
        }
        return { length: 0, on() { return this; }, val: () => '' };
    };
    return { $, highlighted: () => items.filter(item => item.selected).map(item => item.avatar) };
}

/**
 * Loads group-chats.js's real functions and speaker state into a sandbox with an open group and its speaker bar.
 * Bob wrote the last message; Generate records which member each group reply was asked of.
 */
function createSpeakerRuntime() {
    const handlers = {};
    const bar = createSpeakerBar(handlers);
    const eventSource = new EventEmitter();
    const changes = [];
    const generations = [];
    eventSource.on(event_types.GROUP_SPEAKER_SELECTION_CHANGED, avatar => changes.push(avatar));
    const noop = () => {};
    const runtime = vm.createContext({
        $: bar.$,
        document: { body: { classList: { toggle: noop } } },
        accountStorage: { getItem: () => null },
        getThumbnailUrl: (type, file) => file,
        eventSource,
        event_types,
        selected_group: 'group-1',
        groups: [{ id: 'group-1', members: ['alice.png', 'bob.png', 'carol.png', 'ghost.png'], disabled_members: ['carol.png'] }],
        characters: [
            { name: 'Alice', avatar: 'alice.png' },
            { name: 'Bob', avatar: 'bob.png' },
            { name: 'Carol', avatar: 'carol.png' },
            { name: 'Dave', avatar: 'dave.png' },
        ],
        chat: [{ name: 'Bob', original_avatar: 'bob.png', mes: 'Hello there.', is_user: false }],
        online_status: 'connected',
        menu_type: 'group_edit',
        power_user: {},
        system_message_types: { NARRATOR: 'narrator' },
        AbortSignal,
        Generate: async type => { generations.push({ type, avatar: runtime.characters[runtime.this_chid]?.avatar }); },
        setCharacterId: chid => { runtime.this_chid = chid; },
        setCharacterName: noop,
        setSendButtonState: noop,
        hideSwipeButtons: noop,
        showSwipeButtons: noop,
        activateSendButtons: noop,
        deactivateSendButtons: noop,
        unshallowCharacter: async () => {},
    });
    const declarations = getTopLevelDeclarations();
    const stateNames = [...speakerStateNames, ...generationStateNames];
    const state = declarations.filter(node => node.type === 'VariableDeclaration'
        && node.declarations.some(declaration => stateNames.includes(declaration.id.name)));
    const functions = declarations.filter(node => node.type === 'FunctionDeclaration');
    vm.runInContext([...state, ...functions].map(node => groupChatsSource.slice(node.start, node.end)).join('\n'), runtime);
    return { runtime, changes, handlers, generations, eventSource, bar };
}

describe('group speaker bar selection API', () => {
    test('picks an enabled member of the open group and announces the change', () => {
        const { runtime, changes, bar } = createSpeakerRuntime();

        expect(typeof runtime.setSelectedGroupSpeakerAvatar).toBe('function');
        expect(runtime.setSelectedGroupSpeakerAvatar('bob.png')).toBe(true);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('bob.png');
        expect(bar.highlighted()).toEqual(['bob.png']);
        expect(changes).toEqual(['bob.png']);
    });

    test('refuses muted members, outsiders and malformed input without touching the pick', () => {
        const { runtime, changes } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');

        for (const avatar of ['carol.png', 'dave.png', 'ghost.png', 'ALICE.PNG', 7, null, undefined, {}]) {
            expect(runtime.setSelectedGroupSpeakerAvatar(avatar)).toBe(false);
        }

        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('alice.png');
        expect(changes).toEqual(['alice.png']);
    });

    test('refuses a pick outside a group chat', () => {
        const { runtime, changes } = createSpeakerRuntime();
        runtime.selected_group = null;

        expect(runtime.setSelectedGroupSpeakerAvatar('alice.png')).toBe(false);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual([]);
    });

    test('clears the pick with an empty string', () => {
        const { runtime, changes, bar } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');

        expect(runtime.setSelectedGroupSpeakerAvatar('')).toBe(true);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(bar.highlighted()).toEqual([]);
        expect(changes).toEqual(['alice.png', '']);
    });

    test('announces picks made in the bar and the clear after a reply', async () => {
        const { runtime, changes, handlers } = createSpeakerRuntime();
        runtime.initGroupSpeakerControls();
        const clickAvatar = handlers['click .group_speaker_avatar'];

        await clickAvatar.call({ avatar: 'bob.png' }, { shiftKey: false });
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('bob.png');
        await clickAvatar.call({ avatar: 'bob.png' }, { shiftKey: false });
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        await clickAvatar.call({ avatar: 'alice.png' }, { shiftKey: false });
        runtime.clearSelectedGroupSpeaker();

        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual(['bob.png', '', 'alice.png', '']);
    });

    test('exposes the pick to extensions through getContext()', () => {
        const contextSource = readFileSync(new URL('../public/scripts/st-context.js', import.meta.url), 'utf8');
        const contextAst = parse(contextSource, { ecmaVersion: 'latest', sourceType: 'module' });
        const groupChatsImport = contextAst.body.find(node => node.type === 'ImportDeclaration' && node.source.value === './group-chats.js');
        const importedNames = groupChatsImport.specifiers.map(specifier => specifier.imported.name);
        const getContextNode = contextAst.body.map(node => node.declaration ?? node).find(node => node.id?.name === 'getContext');
        const returned = getContextNode.body.body.find(node => node.type === 'ReturnStatement').argument;
        const contextKeys = returned.properties.map(property => property.key.name);

        for (const name of ['getSelectedGroupSpeakerAvatar', 'setSelectedGroupSpeakerAvatar']) {
            expect(getExportedNames(groupChatsAst)).toContain(name);
            expect(importedNames).toContain(name);
            expect(contextKeys).toContain(name);
        }
    });
});

describe('group replies and the speaker bar pick', () => {
    test('the picked member answers the next reply, which uses up the pick', async () => {
        const { runtime, changes, generations } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');

        await runtime.generateGroupWrapper(false, 'normal', {});

        expect(generations).toEqual([{ type: 'normal', avatar: 'alice.png' }]);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual(['alice.png', '']);
    });

    test('a background quiet generation leaves the pick for the next reply', async () => {
        const { runtime, changes, generations } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');

        await runtime.generateGroupWrapper(false, 'quiet', { quiet_prompt: 'Summarize the chat so far.' });

        expect(generations).toEqual([{ type: 'quiet', avatar: 'bob.png' }]);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('alice.png');
        expect(changes).toEqual(['alice.png']);
    });

    for (const type of ['swipe', 'continue']) {
        test(`a ${type} stays with the author of the last message and keeps the pick`, async () => {
            const { runtime, changes, generations } = createSpeakerRuntime();
            runtime.setSelectedGroupSpeakerAvatar('alice.png');

            await runtime.generateGroupWrapper(false, type, {});

            expect(generations).toEqual([{ type, avatar: 'bob.png' }]);
            expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('alice.png');
            expect(changes).toEqual(['alice.png']);
        });
    }

    test('impersonating the user leaves the pick for the reply after it', async () => {
        const { runtime, changes, generations } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');
        // Impersonation borrows a random member's card; fix it to the first so the generation always runs.
        vm.runInContext('Math.random = () => 0;', runtime);

        await runtime.generateGroupWrapper(false, 'impersonate', {});

        expect(generations).toEqual([{ type: 'impersonate', avatar: 'alice.png' }]);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('alice.png');
        expect(changes).toEqual(['alice.png']);
    });

    test('a regenerated reply is answered by the picked member', async () => {
        const { runtime, changes, generations } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');

        await runtime.generateGroupWrapper(false, 'regenerate', {});

        expect(generations).toEqual([{ type: 'normal', avatar: 'alice.png' }]);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual(['alice.png', '']);
    });
});

describe('keeping the speaker bar pick valid', () => {
    test('drops a pick that is not a member of the newly opened group', () => {
        const { runtime, changes } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');
        runtime.groups.push({ id: 'group-2', members: ['bob.png'], disabled_members: [] });
        runtime.selected_group = 'group-2';

        runtime.updateGroupSpeakerControls();

        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual(['alice.png', '']);
    });

    test('drops a pick of a member who was muted after being picked', () => {
        const { runtime, changes } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('bob.png');
        runtime.groups[0].disabled_members.push('bob.png');

        runtime.updateGroupSpeakerControls();

        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual(['bob.png', '']);
    });

    test('keeps a pick made while the previous reply was still being written', async () => {
        const { runtime, changes, generations } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');
        const generate = runtime.Generate;
        runtime.Generate = async (...args) => {
            await generate(...args);
            runtime.setSelectedGroupSpeakerAvatar('bob.png');
        };

        await runtime.generateGroupWrapper(false, 'normal', {});

        expect(generations).toEqual([{ type: 'normal', avatar: 'alice.png' }]);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('bob.png');
        expect(changes).toEqual(['alice.png', 'bob.png']);
    });

    test('keeps the bar in step with a pick made by the first listener as the old pick clears', () => {
        const { runtime, eventSource, bar } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');
        eventSource.makeFirst(event_types.GROUP_SPEAKER_SELECTION_CHANGED, avatar => {
            if (avatar === '') runtime.setSelectedGroupSpeakerAvatar('bob.png');
        });

        runtime.clearSelectedGroupSpeaker();

        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('bob.png');
        expect(bar.highlighted()).toEqual(['bob.png']);
    });
});
