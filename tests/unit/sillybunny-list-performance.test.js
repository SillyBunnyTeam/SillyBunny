/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, afterEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

await import('../../public/lib/jquery-3.5.1.min.js');
const $ = window.jQuery;

function load(path, names, dependencies) {
    const source = readFileSync(new URL(`../../public/${path}`, import.meta.url), 'utf8');
    const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.map(node => node.declaration ?? node);
    const functions = names.map(name => {
        const declaration = declarations.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
        if (!declaration) throw new Error(`Missing function: ${name}`);
        return source.slice(declaration.start, declaration.end);
    });
    const context = vm.createContext({ document, HTMLElement, window, CustomEvent, $, ...dependencies });
    vm.runInContext(`${functions.join('\n')}\nthis.api = { ${names.join(', ')} };`, context);
    return context;
}

describe('chat navigation acceptance boundary', () => {
    function setup(kind, same = false) {
        const order = [];
        const flush = jest.fn(async () => { order.push('flush'); return true; });
        const fetch = jest.fn(async () => { order.push('fetch'); return true; });
        const context = load(kind === 'character' ? 'script.js' : 'scripts/group-chats.js', [kind === 'character' ? 'selectCharacterById' : 'openGroupById'], {
            characters: [{ avatar: 'a.png' }, { avatar: 'b.png' }], groups: [{ id: 'a' }, { id: 'b' }],
            this_chid: same ? 1 : 0, selected_group: kind === 'group' ? same ? 'b' : 'a' : null,
            is_send_press: false, is_group_generating: false,
            flushPendingChatSavesForNavigation: flush,
            cancelCharacterSaveDebounced: jest.fn(), setCharacterId: () => order.push('mutate'), setCharacterName: jest.fn(),
            resetSelectedGroup: jest.fn(), clearChat: jest.fn(async () => {}), cancelTtsPlay: jest.fn(),
            getChat: fetch, getGroupChat: fetch, syncCharacterMenuActiveEntity: jest.fn(),
            unshallowCharacter: fetch, select_selected_character: jest.fn(), select_group_chats: jest.fn(),
            setEditedMessageId: jest.fn(), updateChatMetadata: jest.fn(),
        });
        return { context, order, flush, fetch, select: kind === 'character' ? context.api.selectCharacterById : context.api.openGroupById, id: kind === 'character' ? 1 : 'b' };
    }

    test.each(['character', 'group'])('%s accepts once, after flush and before any selection mutation or fetch', async kind => {
        const { select, id, flush, order } = setup(kind);
        let finish;
        flush.mockImplementationOnce(() => new Promise(resolve => { finish = () => { order.push('flush'); resolve(true); }; }));
        const accepted = jest.fn(() => order.push('accepted'));
        const pending = select(id, { switchMenu: false, onAccepted: accepted });
        expect(accepted).not.toHaveBeenCalled();
        expect(order).toEqual([]);
        finish();
        expect(await pending).toBe(true);
        expect(accepted).toHaveBeenCalledTimes(1);
        expect(order.slice(0, 3)).toEqual(['flush', 'accepted', 'mutate']);
        expect(order.at(-1)).toBe('fetch');
    });

    test.each(['character', 'group'])('%s current-chat acceptance also flushes, but default callers retain the upstream path', async kind => {
        const { select, id, flush, order } = setup(kind, true);
        const accepted = jest.fn(() => order.push('accepted'));
        expect(await select(id, { switchMenu: false, onAccepted: accepted })).toBe(true);
        expect(accepted).toHaveBeenCalledTimes(1);
        expect(order.slice(0, 2)).toEqual(['flush', 'accepted']);
        flush.mockClear();
        expect(await select(id, { switchMenu: false })).toBe(true);
        expect(flush).not.toHaveBeenCalled();
    });

    test.each(['character', 'group'])('%s never accepts a missing, generating, send-blocked or failed-flush selection', async kind => {
        const { context, select, id, flush } = setup(kind);
        const accepted = jest.fn();
        if (kind === 'character') context.characters[1] = undefined;
        else context.groups.length = 0;
        context.console = { log: jest.fn() };
        expect(await select(id, { onAccepted: accepted })).toBe(false);
        context.characters[1] = { avatar: 'b.png' };
        context.groups.push({ id: 'b' });
        context.selected_group = 'a';
        context.is_group_generating = true;
        expect(await select(id, { onAccepted: accepted })).toBe(false);
        context.is_group_generating = false;
        context.is_send_press = true;
        expect(await select(id, { onAccepted: accepted })).toBe(false);
        context.is_send_press = false;
        flush.mockResolvedValue(false);
        expect(await select(id, { onAccepted: accepted })).toBe(false);
        expect(accepted).not.toHaveBeenCalled();
    });
});

describe('deferred chat autofocus', () => {
    afterEach(() => {
        delete document.documentElement.dataset.sbSettingsOpen;
        document.body.replaceChildren();
    });

    test.each([[true, false], [false, false], [false, true]])('shell open=%s and existing text focus=%s preserve the correct focus owner', async (shellOpen, textFocused) => {
        document.body.innerHTML = '<div id="row" tabindex="0"></div><textarea id="send_textarea"></textarea><input id="search">';
        const row = document.getElementById('row');
        const input = document.getElementById('search');
        input.getClientRects = () => [{}];
        let finishDelay;
        const context = load('script.js', ['getChat'], {
            incrementChatGeneration: jest.fn(), unshallowCharacter: jest.fn(async () => {}),
            resolveCharacterChatForLoad: jest.fn(async () => ({ chatName: 'chat', created: false })),
            fetch: jest.fn(async () => ({ ok: true, json: async () => [{ chat_metadata: {} }, { mes: 'hello' }] })),
            getRequestHeaders: () => ({}), characters: [{ name: 'Character' }], this_chid: 0,
            chat: [], ensureMessageMediaIsArray: jest.fn(), getChatResult: jest.fn(async () => {}),
            eventSource: { emit: jest.fn() }, event_types: { CHAT_LOADED: 'chat-loaded' },
            delay: () => new Promise(resolve => { finishDelay = resolve; }), debounce_timeout: { short: 200 },
        });
        expect(await context.api.getChat()).toBe(true);
        document.documentElement.dataset.sbSettingsOpen = String(shellOpen);
        const focusOwner = textFocused ? input : row;
        focusOwner.focus();
        finishDelay();
        await Promise.resolve();
        expect(document.activeElement).toBe(shellOpen || textFocused ? focusOwner : document.getElementById('send_textarea'));
    });
});

describe('filter context presentation caching', () => {
    test('unchanged contexts do not rebuild, while changed filter state rebuilds only its root', () => {
        document.body.innerHTML = ['characters', 'members', 'candidates'].map(id => `<div class="rm_tag_controls"><div id="${id}"></div><div class="rm_tag_bogus_drilldown"></div><button class="showTagList"></button></div>`).join('');
        const filters = new Map();
        const helpers = new Map(['characters', 'members', 'candidates'].map(id => [id, { getFilterData: type => filters.get(`${id}:${type}`) }]));
        const printTagList = jest.fn(container => container.append('<span class="tag"></span>'));
        const context = load('scripts/tags.js', ['printTagFilters'], {
            filterPresentations: new WeakMap(), refreshTagManager: jest.fn(), removeMissingTagFilters: jest.fn(),
            tag_filter_type: { character: 0, group_members_list: 1, group_candidates_list: 2 },
            CHARACTER_FILTER_SELECTOR: '#characters', GROUP_MEMBERS_FILTER_SELECTOR: '#members', GROUP_FILTER_SELECTOR: '#candidates',
            getFilterHelper: root => helpers.get(root[0].id),
            tags: [{ id: 'a', name: 'A' }], tag_map: { 'a.png': ['a'] }, mainListFilterStoragePrefix: 'CharacterList', power_user: {}, selected_group: null, groups: [],
            getTagFilterVisibility: () => true, FILTER_TYPES: { TAG: 'tag', SEARCH: 'search', FAV: 'fav', FOLDER: 'folder', GROUP: 'group' }, isGroupContext: type => type !== 0,
            getVisibleAvatarsForGroupContext: () => [], ACTIONABLE_TAGS: { FOLDER: {} }, InListActionable: {},
            filterActionableTagsForGroupContext: tags => tags, printTagList,
            getOpenBogusFolders: () => [], compareTagsForSort: () => 0, updateTagFilterIndicator: jest.fn(),
        });
        for (const type of [0, 1, 2]) context.api.printTagFilters(type);
        expect(printTagList).toHaveBeenCalledTimes(9);
        printTagList.mockClear();
        for (const type of [0, 1, 2]) context.api.printTagFilters(type);
        expect(printTagList).not.toHaveBeenCalled();
        filters.set('characters:search', 'new query');
        context.tags[0].filter_state = 'SELECTED';
        for (const type of [0, 1, 2]) context.api.printTagFilters(type);
        expect(printTagList).not.toHaveBeenCalled();
        filters.set('members:tag', { selected: ['a'], excluded: [] });
        for (const type of [0, 1, 2]) context.api.printTagFilters(type);
        expect(printTagList).toHaveBeenCalledTimes(3);
        expect(printTagList.mock.calls.every(([root]) => root[0].id === 'members')).toBe(true);
    });
});
