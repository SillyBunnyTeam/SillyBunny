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
 * Loads group-chats.js's real functions and speaker state into a sandbox with an open group.
 * The bar container reports no DOM, so rendering is skipped and only the pick and its events are observed.
 */
function createSpeakerRuntime() {
    const handlers = {};
    const $ = target => {
        if (target === '#group_speaker_controls') {
            return { length: 0, on: (event, selector, handler) => { handlers[`${event} ${selector}`] = handler; } };
        }
        if (target && typeof target === 'object' && 'avatar' in target) {
            return { data: key => key === 'avatar' ? target.avatar : undefined };
        }
        return { length: 0, on() { return this; }, removeClass() { return this; } };
    };
    const eventSource = new EventEmitter();
    const changes = [];
    eventSource.on(event_types.GROUP_SPEAKER_SELECTION_CHANGED, avatar => changes.push(avatar));
    const runtime = vm.createContext({
        $,
        document: {},
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
    });
    const declarations = getTopLevelDeclarations();
    const state = declarations.filter(node => node.type === 'VariableDeclaration'
        && node.declarations.some(declaration => speakerStateNames.includes(declaration.id.name)));
    const functions = declarations.filter(node => node.type === 'FunctionDeclaration');
    vm.runInContext([...state, ...functions].map(node => groupChatsSource.slice(node.start, node.end)).join('\n'), runtime);
    return { runtime, changes, handlers };
}

describe('group speaker bar selection API', () => {
    test('picks an enabled member of the open group and announces the change', () => {
        const { runtime, changes } = createSpeakerRuntime();

        expect(typeof runtime.setSelectedGroupSpeakerAvatar).toBe('function');
        expect(runtime.setSelectedGroupSpeakerAvatar('bob.png')).toBe(true);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('bob.png');
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
        const { runtime, changes } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');

        expect(runtime.setSelectedGroupSpeakerAvatar('')).toBe(true);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
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
