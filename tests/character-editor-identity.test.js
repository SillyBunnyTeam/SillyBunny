import { describe, expect, jest, test } from '@jest/globals';
import vm from 'node:vm';
import { loadDeclarations as load, readClientModule } from './util/load-declarations.js';
import { event_types } from '../public/scripts/events.js';

function findNode(node, predicate) {
    if (!node || typeof node !== 'object') return null;
    if (typeof node.type === 'string' && predicate(node)) return node;
    for (const value of Object.values(node)) {
        for (const child of Array.isArray(value) ? value : [value]) {
            const found = child && typeof child.type === 'string' ? findNode(child, predicate) : null;
            if (found) return found;
        }
    }
    return null;
}

/**
 * Runs a callback that a browser module passes to a call inside another function, such as an event handler
 * that script.js registers in its jQuery ready callback, where loadDeclarations cannot reach it.
 * @param {vm.Context} context Context made with vm.createContext
 * @param {string} file Path relative to public/
 * @param {(call: any) => boolean} matchesCall Picks the call by its callee and first arguments
 */
function loadCallback(context, file, matchesCall) {
    const { source, ast } = readClientModule(file);
    const call = findNode(ast, node => node.type === 'CallExpression' && matchesCall(node));
    if (!call) throw new Error(`Missing callback in ${file}`);
    const callback = call.arguments.at(-1);
    return vm.runInContext(`(${source.slice(callback.start, callback.end)})`, context);
}

const isCall = (node, object, method) => node.callee.type === 'MemberExpression'
    && node.callee.property.name === method
    && (typeof object === 'string' ? node.callee.object.name === object : object(node.callee.object));

function loadDropdownHandler(context) {
    return loadCallback(context, 'script.js', node => isCall(node, object => object.arguments?.[0]?.value === '#char-management-dropdown', 'on')
        && node.arguments[0].value === 'change');
}

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

function createEventSource() {
    const listeners = {};
    return {
        on: (name, listener) => { (listeners[name] ??= []).push(listener); },
        emit: jest.fn(async (name, ...args) => {
            for (const listener of listeners[name] ?? []) await listener(...args);
        }),
    };
}

/** @param {{ thisChid?: string|null, selectedGroup?: string|null }} [options] A null thisChid means that no chat is active. */
function createEditor({ thisChid = String(ACTIVE), selectedGroup = null } = {}) {
    const dom = createDom();
    const context = vm.createContext({
        console,
        $: dom.$,
        document: dom.document,
        HTMLElement: class {},
        characters: createCharacters(),
        this_chid: thisChid ?? undefined,
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
        eventSource: createEventSource(),
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
        POPUP_TYPE: { TEXT: 1, INPUT: 3 },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CUSTOM1: 1001, CUSTOM2: 1002 },
        Popup: class {
            static show = { confirm: jest.fn(async () => 0), input: jest.fn(async () => ''), text: jest.fn(async () => {}) };
            constructor(content, type, inputValue, options) { Object.assign(this, { content, options, dlg: {} }); }
            async show() { this.options.onOpen?.(this); }
        },
        t: (strings, ...values) => String.raw({ raw: strings }, ...values),
        toastr: { error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn() },
        chat_metadata: {},
        flushPendingChatSavesForNavigation: jest.fn(async () => true),
        clearChat: jest.fn(async () => {}),
        getChat: jest.fn(async () => true),
        updateRemoteChatName: jest.fn(async () => {}),
        getOneCharacter: jest.fn(async () => {}),
        processDroppedFiles: jest.fn(async () => {}),
        importFromExternalUrl: jest.fn(async () => {}),
    });
    context.getContext = () => ({ characters: context.characters, characterId: context.this_chid });
    load(context, 'scripts/utils.js', ['compareIgnoreCaseAndAccents', 'equalsIgnoreCaseAndAccents', 'onlyUnique', 'normalizeArray', 'getCharaFilename']);
    load(context, 'scripts/world-info.js', ['charSetAuxWorlds', 'updateAuxBooks']);
    load(context, 'scripts/tags.js', ['getTag', 'getTagKey', 'getInlineListSelector', 'getTagKeyForEntity', 'addTagToMap', 'removeTagFromMap', 'addTagsToEntity', 'removeTagFromEntity', 'selectTag', 'onTagRemoveClick', 'applyTagsOnCharacterSelect']);
    load(context, 'script.js', ['setMenuType', 'setCharacterId', 'getCharacterEditorId', 'select_rm_create', 'select_selected_character', 'openCharacterWorldPopup', 'openCharacterChat', 'unshallowCharacter']);
    return { context, dom };
}

/** Picks an entry of the character management dropdown in the editor. */
async function chooseDropdownEntry(context, dom, id) {
    const selectedOptions = {};
    dom.node(selectedOptions).attr('id', id);
    await loadDropdownHandler(context)({ target: { selectedOptions } });
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
        const { context } = createEditor({ thisChid: null });
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
        const { context, dom } = createEditor({ thisChid: null, selectedGroup: 'group-1' });
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

/**
 * Stands in for processDroppedFiles() and importFromExternalUrl(). After a replace, importCharactersTags() reloads
 * the roster, where getCharacters() renders this_chid in the editor, and selectImportedChar() opens the chat of the
 * replaced card. That last step does nothing when a pending chat save fails.
 * @param {'selected'|'not selected'|'failed'} outcome
 * @param {{ lazy?: boolean }} [options] With lazy, the reloaded roster holds shallow cards, as with performance.lazyLoadCharacters.
 */
function importReplacement(context, replacedId, outcome, { lazy = false } = {}) {
    return jest.fn(async () => {
        if (outcome === 'failed') return;
        const stored = context.characters.map(character => ({ ...character }));
        stored[replacedId].description = 'Replaced';
        context.characters = lazy ? stored.map(({ name, avatar, chat }) => ({ name, avatar, chat, shallow: true })) : stored;
        context.getOneCharacter = jest.fn(async avatar => {
            const index = context.characters.findIndex(character => character.avatar === avatar);
            context.characters[index] = { ...stored[index] };
        });
        if (context.this_chid !== undefined) context.select_selected_character(context.this_chid, { switchMenu: false });
        if (outcome === 'selected') {
            context.setCharacterId(replacedId);
            context.select_selected_character(replacedId);
        }
    });
}

async function replaceWithFile(context, dom, file) {
    context.Popup.show.confirm.mockResolvedValueOnce(context.POPUP_RESULT.CUSTOM2);
    await chooseDropdownEntry(context, dom, 'replace_update');
    await dom.node('#character_replace_file').state.handlers.change({ target: { files: [file] } });
}

async function replaceFromUrl(context, dom, url) {
    context.Popup.show.confirm.mockResolvedValueOnce(context.POPUP_RESULT.CUSTOM1);
    context.Popup.show.input.mockResolvedValueOnce(url);
    await chooseDropdownEntry(context, dom, 'replace_update');
}

describe('Replace / Update from the editor', () => {
    const file = { name: 'card.png' };

    test('reloads the chat of the active chat\'s character after it is replaced', async () => {
        const { context, dom } = createEditor();
        context.select_selected_character(ACTIVE);
        context.processDroppedFiles = importReplacement(context, ACTIVE, 'selected');

        await replaceWithFile(context, dom, file);
        expect(context.processDroppedFiles.mock.calls[0][1].get(file)).toBe('Active.png');
        expect(context.getChat).toHaveBeenCalledTimes(1);
        expect(context.characters[ACTIVE].chat).toBe('Active - chat');
        expect(context.updateRemoteChatName).not.toHaveBeenCalled();
    });

    test('reloads the chat of a card that is not active once the import has opened it', async () => {
        const { context, dom } = createEditor();
        context.select_selected_character(OTHER);
        context.processDroppedFiles = importReplacement(context, OTHER, 'selected');

        await replaceWithFile(context, dom, file);
        expect(context.processDroppedFiles.mock.calls[0][1].get(file)).toBe('Other.png');
        expect(context.this_chid).toBe(String(OTHER));
        expect(context.getChat).toHaveBeenCalledTimes(1);
        expect(context.characters.map(character => character.chat)).toEqual(['Active - chat', 'Other - chat', 'Member - chat']);
        expect(context.updateRemoteChatName).not.toHaveBeenCalled();
    });

    test('keeps the active chat and shows the replaced card when the import did not open it', async () => {
        const { context, dom } = createEditor();
        context.select_selected_character(OTHER);
        context.processDroppedFiles = importReplacement(context, OTHER, 'not selected');

        await replaceWithFile(context, dom, file);
        expect(context.this_chid).toBe(String(ACTIVE));
        expect(context.getChat).not.toHaveBeenCalled();
        expect(context.characters[ACTIVE].chat).toBe('Active - chat');
        expect(context.updateRemoteChatName).not.toHaveBeenCalled();
        expect(dom.node('#avatar_url_pole').val()).toBe('Other.png');
        expect(dom.node('#description_textarea').val()).toBe('Replaced');
        expect(context.toastr.error).not.toHaveBeenCalled();
    });

    test('loads a shallow card before the editor shows it again', async () => {
        const { context, dom } = createEditor();
        context.select_selected_character(OTHER);
        context.processDroppedFiles = importReplacement(context, OTHER, 'not selected', { lazy: true });

        await replaceWithFile(context, dom, file);
        expect(context.getOneCharacter).toHaveBeenCalledWith('Other.png');
        expect(dom.node('#avatar_url_pole').val()).toBe('Other.png');
        expect(dom.node('#description_textarea').val()).toBe('Replaced');
    });

    test('reports no failure of its own for a file when no chat is active', async () => {
        const { context, dom } = createEditor({ thisChid: null });
        context.select_selected_character(OTHER);
        context.processDroppedFiles = importReplacement(context, OTHER, 'failed');

        await replaceWithFile(context, dom, file);
        expect(context.toastr.error).not.toHaveBeenCalled();
        expect(context.clearChat).not.toHaveBeenCalled();
        expect(dom.node('#avatar_url_pole').val()).toBe('Other.png');
    });

    test('finishes a URL replace and resets the dropdown when no chat is active', async () => {
        const { context, dom } = createEditor({ thisChid: null });
        context.select_selected_character(OTHER);
        context.importFromExternalUrl = importReplacement(context, OTHER, 'failed');
        dom.node('#char-management-dropdown').prop('selectedIndex', 5);

        await expect(replaceFromUrl(context, dom, 'https://example.invalid/card.png')).resolves.toBeUndefined();
        expect(context.importFromExternalUrl).toHaveBeenCalledWith('https://example.invalid/card.png', { preserveFileName: 'Other.png' });
        expect(context.clearChat).not.toHaveBeenCalled();
        expect(dom.node('#char-management-dropdown').prop('selectedIndex')).toBe(0);
    });
});
