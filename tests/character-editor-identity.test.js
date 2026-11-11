import { describe, expect, jest, test } from '@jest/globals';
import vm from 'node:vm';
import { loadDeclarations as load } from './util/load-declarations.js';
import { event_types } from '../public/scripts/events.js';

const ACTIVE = 0;
const OTHER = 1;
const MEMBER = 2;

function createCharacters() {
    return [
        { name: 'Active', avatar: 'Active.png', chat: 'Active - chat', data: { extensions: {} } },
        { name: 'Other', avatar: 'Other.png', chat: 'Other - chat', data: { extensions: {} } },
        { name: 'Member', avatar: 'Member.png', chat: 'Member - chat', data: { extensions: {} } },
    ];
}

/**
 * A jQuery stand-in with one node per selector, so that a test can read back what the editor code wrote.
 * The real DOM shows a node that nothing has hidden, so `shown` stays undefined until a call sets it.
 */
function createDom() {
    const nodes = new Map();
    const node = selector => {
        if (!nodes.has(selector)) nodes.set(selector, createNode(selector));
        return nodes.get(selector);
    };
    function createNode(selector) {
        const state = { selector, shown: undefined, value: undefined, text: undefined, attrs: {}, data: {}, props: {}, handlers: {} };
        const read = (store, key, value) => {
            if (value === undefined) return store[key];
            store[key] = value;
            return self;
        };
        const self = {
            state,
            length: 1,
            toggle: show => { state.shown = Boolean(show); return self; },
            show: () => { state.shown = true; return self; },
            hide: () => { state.shown = false; return self; },
            css: (name, value) => {
                if (name === 'display' && value !== undefined) state.shown = value !== 'none';
                return self;
            },
            attr: (name, value) => read(state.attrs, name, value),
            data: (key, value) => read(state.data, key, value),
            prop: (name, value) => read(state.props, name, value),
            val: value => read(state, 'value', value),
            text: value => read(state, 'text', value),
            on: (event, handler) => { state.handlers[event] = handler; return self; },
            off: () => { state.handlers = {}; return self; },
            find: inner => node(`${selector} ${inner}`),
            children: inner => node(`${selector} > ${inner}`),
            closest: outer => node(outer),
            clone: () => self,
            get: () => undefined,
        };
        for (const name of ['html', 'addClass', 'removeClass', 'toggleClass', 'trigger', 'empty', 'remove', 'append', 'select2']) {
            self[name] = () => self;
        }
        return self;
    }
    const $ = target => target?.state ? target : node(target);
    const document = {
        getElementById: id => {
            const element = node(`#${id}`);
            return { getAttribute: name => element.state.attrs[name] ?? null, get value() { return element.state.value; } };
        },
    };
    return { $, node, document, isShown: selector => node(selector).state.shown !== false };
}

function createEditor({ thisChid = String(ACTIVE), selectedGroup = null } = {}) {
    const dom = createDom();
    const context = vm.createContext({
        console,
        $: dom.$,
        document: dom.document,
        HTMLElement: class {},
        characters: createCharacters(),
        this_chid: thisChid,
        selected_group: selectedGroup,
        menu_type: 'characters',
        selected_button: '',
        create_save: { name: '', avatar: '', world: '', extra_books: [] },
        default_avatar: 'img/ai4.png',
        depth_prompt_depth_default: 4,
        depth_prompt_role_default: 'system',
        talkativeness_default: 0.5,
        tags: [{ id: 'tag-knight', name: 'Knight' }],
        tag_map: {},
        world_names: ['Castle', 'Forest'],
        world_info: { charLore: [{ name: 'Active', extraBooks: ['Castle'] }] },
        event_types,
        eventSource: { emit: jest.fn(async () => {}) },
        saveSettingsDebounced: jest.fn(),
        printCharactersDebounced: jest.fn(),
        printTagList: jest.fn(),
        applyCharacterTagsToMessageDivs: jest.fn(),
        selectRightMenuWithAnimation: jest.fn(),
        focusUiSurface: jest.fn(),
        read_avatar_load: jest.fn(),
        formatCreatorNotes: value => value,
        timestampToMoment: () => ({ toISOString: () => '2026-11-11T00:00:00.000Z' }),
        updateFavButtonState: jest.fn(),
        getThumbnailUrl: (type, file) => `/thumbnail?type=${type}&file=${file}`,
        setWorldInfoButtonClass: jest.fn(),
        checkEmbeddedWorld: jest.fn(),
        syncAlternateGreetingsEditor: jest.fn(),
        isExternalMediaAllowed: () => true,
        getCharacterSource: () => '',
        charUpdatePrimaryWorld: jest.fn(),
        isMobile: () => true,
        Option: class { constructor(text, value, defaultSelected, selected) { Object.assign(this, { text, value, defaultSelected, selected }); } },
        POPUP_TYPE: { TEXT: 1 },
        Popup: class {
            constructor(content, type, inputValue, options) { Object.assign(this, { content, options, dlg: {} }); }
            async show() { this.options.onOpen?.(this); }
        },
        t: (strings, ...values) => String.raw({ raw: strings }, ...values),
        toastr: { error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn() },
    });
    context.getContext = () => ({ characters: context.characters, characterId: context.this_chid });
    load(context, 'scripts/utils.js', ['compareIgnoreCaseAndAccents', 'equalsIgnoreCaseAndAccents', 'onlyUnique', 'normalizeArray', 'getCharaFilename']);
    load(context, 'scripts/world-info.js', ['charSetAuxWorlds', 'updateAuxBooks']);
    load(context, 'scripts/tags.js', ['getTag', 'getTagKey', 'getInlineListSelector', 'getTagKeyForEntity', 'addTagToMap', 'removeTagFromMap', 'addTagsToEntity', 'removeTagFromEntity', 'selectTag', 'onTagRemoveClick', 'applyTagsOnCharacterSelect']);
    load(context, 'script.js', ['setMenuType', 'setCharacterId', 'getCharacterEditorId', 'select_rm_create', 'select_selected_character', 'openCharacterWorldPopup']);
    return { context, dom };
}

/** Types a known tag into the editor's tag input, as the autocomplete select does. */
function addTagInEditor(context, tagName) {
    const event = { target: { closest: () => null } };
    context.selectTag(event, { item: { value: tagName } }, '#tagList');
}

/** Clicks the remove icon of a tag in the editor's tag list. */
function removeTagInEditor(context, dom, tagId) {
    const tagElement = dom.node(`#tagList .tag#${tagId}`).attr('id', tagId);
    const removeIcon = { state: {}, closest: selector => selector === '.tag' ? tagElement : { length: 0 } };
    context.onTagRemoveClick.call(removeIcon, { stopPropagation: () => {}, target: { closest: () => null } });
}

/** Opens the auxiliary lorebook list from "Link to World Info" and selects the given books. */
async function selectAuxiliaryBooks(context, dom, books) {
    await context.openCharacterWorldPopup();
    const extras = dom.node('#character_world_template .character_world .character_extra_world_info_selector');
    extras.val(books.map(book => String(context.world_names.indexOf(book))));
    extras.state.handlers.change({ currentTarget: extras });
}

function lastPrintedTagListEntity(context, dom) {
    const call = context.printTagList.mock.calls.filter(([element]) => element === dom.node('#tagList')).at(-1);
    return call?.[1]?.forEntityOrKey;
}

const CURRENT_CHAT_CONTROLS = ['.form_create_bottom_buttons_block .chat_lorebook_button', '#creators_note_styles_button', '.rm_stats_button'];

describe('classic editor opened for a card that is not the active chat\'s', () => {
    test('adds and removes a tag on the card in the editor', () => {
        const { context, dom } = createEditor();
        context.select_selected_character(OTHER);

        addTagInEditor(context, 'Knight');
        expect(context.tag_map['Other.png']).toEqual(['tag-knight']);
        expect(context.tag_map['Active.png'] ?? []).toEqual([]);

        removeTagInEditor(context, dom, 'tag-knight');
        expect(context.tag_map['Other.png']).toEqual([]);
    });

    test('adds a tag to the card in the editor when no chat is active', () => {
        const { context } = createEditor({ thisChid: undefined });
        context.select_selected_character(OTHER);

        addTagInEditor(context, 'Knight');
        expect(context.tag_map['Other.png']).toEqual(['tag-knight']);
    });

    test('prints the tags of the card in the editor, also when the character list reprints them', () => {
        const { context, dom } = createEditor();
        context.select_selected_character(OTHER);
        expect(lastPrintedTagListEntity(context, dom)).toBe(OTHER);

        context.applyTagsOnCharacterSelect();
        expect(lastPrintedTagListEntity(context, dom)).toBe(OTHER);
        expect(context.getInlineListSelector()).toBe(`.character_select[chid="${OTHER}"] .tags`);
    });

    test('links auxiliary lorebooks to the card in the editor', async () => {
        const { context, dom } = createEditor();
        context.select_selected_character(OTHER);

        await selectAuxiliaryBooks(context, dom, ['Forest']);
        expect(context.world_info.charLore).toEqual([
            { name: 'Active', extraBooks: ['Castle'] },
            { name: 'Other', extraBooks: ['Forest'] },
        ]);
    });

    test('hides the controls that act on the current chat', () => {
        const { context, dom } = createEditor();
        context.select_selected_character(OTHER);

        for (const selector of CURRENT_CHAT_CONTROLS) expect([selector, dom.isShown(selector)]).toEqual([selector, false]);
        expect(dom.isShown('#char_connections_button')).toBe(false);
        expect(dom.isShown('#set_chat_character_settings')).toBe(false);
        expect(dom.isShown('#character_open_media_overrides')).toBe(false);
    });
});

describe('classic editor opened for the active chat\'s character', () => {
    test('keeps tags, lorebook links and current-chat controls on that character', async () => {
        const { context, dom } = createEditor();
        context.select_selected_character(OTHER);
        context.select_selected_character(ACTIVE);

        for (const selector of CURRENT_CHAT_CONTROLS) expect([selector, dom.isShown(selector)]).toEqual([selector, true]);
        expect(dom.isShown('#char_connections_button')).toBe(true);
        expect(lastPrintedTagListEntity(context, dom)).toBe(ACTIVE);

        addTagInEditor(context, 'Knight');
        expect(context.tag_map['Active.png']).toEqual(['tag-knight']);
        expect(context.tag_map['Other.png'] ?? []).toEqual([]);

        await selectAuxiliaryBooks(context, dom, ['Forest']);
        expect(context.world_info.charLore).toEqual([{ name: 'Active', extraBooks: ['Forest'] }]);
    });
});

describe('group member peek', () => {
    test('keeps the member as the editor card and the group chat controls as before', async () => {
        const { context, dom } = createEditor({ thisChid: undefined, selectedGroup: 'group-1' });
        // The calls of openCharacterDefinition() in public/scripts/group-chats.js, in its order.
        context.setCharacterId(String(MEMBER));
        context.select_selected_character(String(MEMBER));
        context.applyTagsOnCharacterSelect();

        for (const selector of CURRENT_CHAT_CONTROLS) expect([selector, dom.isShown(selector)]).toEqual([selector, true]);
        expect(dom.isShown('#char_connections_button')).toBe(false);
        expect(lastPrintedTagListEntity(context, dom)).toBe(MEMBER);

        addTagInEditor(context, 'Knight');
        expect(context.tag_map['Member.png']).toEqual(['tag-knight']);

        await selectAuxiliaryBooks(context, dom, ['Forest']);
        expect(context.world_info.charLore).toContainEqual({ name: 'Member', extraBooks: ['Forest'] });
    });
});

describe('create mode after an editor card that is not active', () => {
    test('writes no tag to a saved card and keeps the upstream create controls', async () => {
        const { context, dom } = createEditor();
        context.select_selected_character(OTHER);
        context.select_rm_create();

        expect(context.menu_type).toBe('create');
        expect(context.getTagKey()).toBeNull();
        addTagInEditor(context, 'Knight');
        expect(context.tag_map).toEqual({});

        expect(dom.isShown('#creators_note_styles_button')).toBe(true);
        expect(dom.isShown('.rm_stats_button')).toBe(true);
        expect(dom.isShown('.form_create_bottom_buttons_block .chat_lorebook_button')).toBe(false);

        await selectAuxiliaryBooks(context, dom, ['Forest']);
        expect(context.create_save.extra_books).toEqual(['Forest']);
        expect(context.world_info.charLore).toEqual([{ name: 'Active', extraBooks: ['Castle'] }]);
    });
});
