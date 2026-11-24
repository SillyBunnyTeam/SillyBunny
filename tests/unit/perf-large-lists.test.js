/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const countTokens = jest.fn(async text => String(text ?? '').length);
const bgImages = [];
const createThumbnail = jest.fn(({ filename }) => {
    const cell = document.createElement('div');
    cell.className = 'bg_example';
    cell.setAttribute('bgfile', filename);
    return cell;
});
const activateLazyLoader = jest.fn();
const refreshHighlights = jest.fn();
let galleryHost = null;

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((acc, s, i) => acc + s + (values[i] ?? ''), ''),
    translate: text => text,
}));
await jest.unstable_mockModule('../../public/script.js', () => ({
    characters: [],
    eventSource: { on: jest.fn(), off: jest.fn(), emit: jest.fn() },
    event_types: { APP_READY: 'app_ready', WORLDINFO_RENAMED: 'wi_renamed', WORLDINFO_DELETED: 'wi_deleted', CHAT_CHANGED: 'chat_changed', CHAT_LOADED: 'chat_loaded', GROUP_UPDATED: 'group_updated' },
    getRequestHeaders: () => ({}),
    main_api: 'openai',
    saveSettingsDebounced: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/events.js', () => ({
    eventSource: { on: jest.fn(), off: jest.fn(), emit: jest.fn() },
    event_types: { APP_READY: 'app_ready', WORLDINFO_RENAMED: 'wi_renamed', WORLDINFO_DELETED: 'wi_deleted', CHAT_CHANGED: 'chat_changed', CHAT_LOADED: 'chat_loaded', GROUP_UPDATED: 'group_updated' },
}));
await jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
    power_user: { personas: {}, persona_descriptions: {} },
}));
await jest.unstable_mockModule('../../public/scripts/filters.js', () => ({
    FILTER_TYPES: { WORLD_INFO_SEARCH: 'world_info_search' },
}));
await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    navigation_option: { none: 0, previous: 1, last: 2 },
}));
await jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({
    accountStorage: { getItem: () => null, setItem: jest.fn(), removeItem: jest.fn() },
}));
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: jest.fn(),
    POPUP_TYPE: { CONFIRM: 1 },
    POPUP_RESULT: { AFFIRMATIVE: 1 },
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-delete-confirm.js', () => ({
    confirmVerb: () => ({}),
    confirmDestructiveAction: jest.fn(async () => true),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu: jest.fn(),
    openPopover: jest.fn(),
    closeActionMenu: jest.fn(),
    isActionMenuOpen: () => false,
}));
const motion = await import('../../public/scripts/sillybunny-motion.js');
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    ...motion,
    animateListChange: (_container, update) => update(),
    play: (_el, _kf, options) => { options?.onEnd?.(); },
    prefersReducedMotion: () => true,
    stopMotion: jest.fn(),
    MOTION_FAST: 0,
    MOTION_SLOW: 0,
}));
await jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    createWorldInfoEntry: jest.fn(),
    deleteWIOriginalDataValue: jest.fn(),
    deleteWorldInfoEntry: jest.fn(),
    duplicateWorldInfoEntry: jest.fn(),
    getWorldInfoDisplayEntries: jest.fn(() => []),
    getWorldInfoEditorState: jest.fn(() => ({ name: '', data: null })),
    moveWorldInfoEntry: jest.fn(),
    refreshWorldInfoEditor: jest.fn(),
    saveWorldInfo: jest.fn(),
    setWIOriginalDataValue: jest.fn(),
    setWorldInfoEditorAdapter: jest.fn(),
    SORT_ORDER_KEY: 'wi_sort',
    worldInfoFilter: { setFilterData: jest.fn() },
    world_names: [],
    world_info: { charLore: [] },
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-world-info-settings.js', () => ({
    mountWorldInfoSettings: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-world-info-entry.js', () => ({
    mountWorldInfoEntry: jest.fn(),
    worldInfoDraftKey: () => 'draft',
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/tag-filter-menu.js', () => ({
    attachTagFilterMenu: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({
    openPicker: jest.fn(),
    closePicker: jest.fn(),
    isPickerOpen: () => false,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-auto-load.js', () => ({
    rememberOpenedEntity: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/object-navigation.js', () => ({
    objectNavigation: { navigate: jest.fn(), back: jest.fn() },
}));
await jest.unstable_mockModule('../../public/scripts/backgrounds.js', () => ({
    attachBackgroundGallery: host => {
        galleryHost = host;
        return {
            getImages: () => bgImages,
            getFolderIndex: () => ({ folders: [], imageFolderMap: {} }),
            sortFiles: files => [...files].sort(),
            createThumbnail,
            activateLazyLoader,
            refreshHighlights,
            isVideo: file => file.endsWith('.mp4'),
            getThumbnailUrl: file => `/thumbnail/bg/${file}`,
            getActiveTab: () => 'global',
            getTabs: () => ({ GLOBAL: 'global' }),
            selectBackground: jest.fn(),
            isLocked: () => false,
            lockBackground: jest.fn(),
            unlockBackground: jest.fn(),
            renameBackground: jest.fn(),
            deleteBackgroundWithConfirmation: jest.fn(),
            deleteBackgrounds: jest.fn(async () => ({ failed: [] })),
            getRequestHeaders: () => ({}),
            reload: jest.fn(),
        };
    },
}));
await jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
    promptManager: { serviceSettings: {} },
}));
await jest.unstable_mockModule('../../public/scripts/user.js', () => ({
    getCurrentUserHandle: () => 'test-user',
}));
await jest.unstable_mockModule('../../public/scripts/tokenizers.js', () => ({
    getTokenCountAsync: countTokens,
    getTokenizerModel: () => 'test-tokenizer',
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/dialog.js', () => ({
    openDialog: jest.fn(),
}));

const promptSnapshot = {
    type: 'chat-completions',
    scope: '["openai","chat","Default"]',
    strategy: 'global',
    character: null,
    prompts: [
        { identifier: 'p1', name: 'Main Prompt', role: 'system', content: 'Long system prompt content', marker: false, injection_position: 0, injection_depth: 4, injection_order: 100 },
        { identifier: 'p2', name: 'Secondary Prompt', role: 'user', content: 'More content to tokenize', marker: false, injection_position: 0, injection_depth: 4, injection_order: 100 },
    ],
    order: [
        { identifier: 'p1', enabled: true },
        { identifier: 'p2', enabled: true },
    ],
    counts: {},
    sources: {},
    error: '',
    runtime: { identifier: 'runtimeAgents', name: 'Agents', runtime: true, role: 'system', content: '' },
};
await jest.unstable_mockModule('../../public/scripts/sillybunny-prompt-editor-model.js', () => ({
    createPromptEditorModel: () => ({
        snapshot: () => promptSnapshot,
        snapshotTextCompletions: () => null,
        permissions: () => ({ toggle: true, rename: true, delete: true, edit: true }),
        readUtility: () => '',
        canRestoreUtility: () => false,
        toggle: jest.fn(),
        insert: jest.fn(),
        reorder: jest.fn(),
    }),
    PROMPT_EDITOR_UTILITY_FIELDS: [],
}));

const { worldInfoRowSignature } = await import('../../public/scripts/sillybunny-world-info-editor.js');
const { characterRowPresentationKey, indexCharacters, groupRowData } = await import('../../public/scripts/sillybunny-character-list.js');
const { createEntityRow, limitTagChips } = await import('../../public/scripts/sillybunny-editor/entity-row.js');
const { indexBackgroundImages, createBackgroundFolderAdapter, initBackgroundGallery } = await import('../../public/scripts/sillybunny-background-gallery.js');
const {
    setSearchContextAccessor,
    resetSearchContextAccessor,
    collectEntitySearchEntries,
    getCachedEntitySearchText,
} = await import('../../public/scripts/sillybunny-search-entities.js');
const { initializePromptEditor } = await import('../../public/scripts/sillybunny-prompt-editor.js');

afterEach(() => {
    resetSearchContextAccessor();
    document.body.replaceChildren();
    jest.restoreAllMocks();
    jest.useRealTimers();
});

describe('World Info row signature', () => {
    test('ignores content and disable while reacting to every rendered field', () => {
        const base = {
            uid: 1,
            comment: 'Lore Entry',
            key: ['alpha', 'beta'],
            content: 'A'.repeat(20_000),
            disable: false,
            constant: false,
            vectorized: false,
            position: 4,
            depth: 2,
            order: 100,
        };
        const sig = worldInfoRowSignature(base, true);
        expect(worldInfoRowSignature({ ...base, content: 'B'.repeat(40_000), disable: true }, true)).toBe(sig);
        expect(worldInfoRowSignature({ ...base, comment: 'Renamed' }, true)).not.toBe(sig);
        expect(worldInfoRowSignature({ ...base, key: ['gamma'] }, true)).not.toBe(sig);
        expect(worldInfoRowSignature({ ...base, constant: true }, true)).not.toBe(sig);
        expect(worldInfoRowSignature({ ...base, vectorized: true }, true)).not.toBe(sig);
        expect(worldInfoRowSignature({ ...base, position: 0 }, true)).not.toBe(sig);
        expect(worldInfoRowSignature({ ...base, depth: 5 }, true)).not.toBe(sig);
        expect(worldInfoRowSignature({ ...base, order: 200 }, true)).not.toBe(sig);
        expect(worldInfoRowSignature(base, false)).not.toBe(sig);
    });
});

describe('Character list presentation key and O(C+G*M) group index', () => {
    test('builds a compact primitive key that ignores active state and fingerprints long creatorNotes', () => {
        const longNotes = 'Long creator notes '.repeat(1000);
        const makeEntry = (overrides = {}) => ({
            kind: 'character',
            label: 'Alice',
            favorite: false,
            active: false,
            entity: { id: 0 },
            item: { name: 'Alice', avatar: 'alice.png' },
            avatar: { src: '/thumb/alice.png', alt: 'Alice' },
            data: {
                chid: 0,
                name: 'Alice',
                avatar: 'alice.png',
                avatarTitle: '[Character] Alice',
                nameTitle: '[Character] Alice',
                auxFieldValue: 'v1',
                creatorNotes: longNotes,
                active: false,
                isActive: false,
                ...overrides,
            },
        });
        const key1 = characterRowPresentationKey(makeEntry(), [{ id: 't1', name: 'RPG', filter_state: 'IN' }], ['Edit', 'Actions for Alice']);
        const key2 = characterRowPresentationKey(makeEntry({ active: true, isActive: true }), [{ id: 't1', name: 'RPG', filter_state: 'OUT' }], ['Edit', 'Actions for Alice']);
        const key3 = characterRowPresentationKey(makeEntry({ creatorNotes: `${longNotes}!` }), [{ id: 't1', name: 'RPG' }], ['Edit', 'Actions for Alice']);

        expect(key1).toBe(key2);
        expect(key1.length).toBeLessThan(300);
        expect(key3).not.toBe(key1);
    });

    test('resolves group members via per-render Map index without scanning characters', () => {
        const characters = [
            { name: 'Alice', avatar: 'alice.png' },
            { name: 'Bob', avatar: 'none' },
            { name: 'Charlie', avatar: 'charlie.png' },
            { name: 'Alice Duplicate', avatar: 'alice2.png' },
        ];
        const script = {
            getGroupRowData: jest.fn(group => ({
                id: group.id,
                name: group.name,
                active: true,
                isActive: true,
                avatarInfo: { custom: false, memberAvatars: [] },
            })),
        };
        const index = indexCharacters(characters);
        const data = groupRowData(script, { id: 'g1', name: 'Party', members: ['alice.png', 'Bob', 'missing.png', 'charlie.png'] }, index);

        expect(script.getGroupRowData).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1', members: [] }));
        expect(data.memberNames).toEqual(['Alice', 'Bob', 'Charlie']);
        expect(data.memberNamesText).toBe('Alice, Bob, Charlie');
        expect(data.memberCount).toBe(3);
        expect(data.memberCountText).toBe('3 characters');
        expect(data.avatarInfo.memberAvatars).toEqual(['alice.png', 'charlie.png']);
    });
});

describe('entity-row limitTagChips probe reuse and observedStrips cleanup', () => {
    let onResize;
    const observed = new Set();
    const observe = jest.fn(el => observed.add(el));
    const unobserve = jest.fn(el => observed.delete(el));
    const ResizeObserverMock = jest.fn(function (cb) {
        onResize = cb;
        this.observe = observe;
        this.unobserve = unobserve;
    });

    beforeEach(() => {
        observe.mockClear();
        unobserve.mockClear();
        global.ResizeObserver = ResizeObserverMock;
    });

    afterEach(() => {
        for (const el of [...observed]) el.closest('.ds-entity-row')?.remove();
        if (onResize) onResize([...observed].map(target => ({ target, contentRect: { width: 0 } })));
        delete global.ResizeObserver;
    });

    function makeTagStrip(tagNames, width) {
        const { row, slots } = createEntityRow({ key: `character:${Math.random()}`, label: 'Card', tags: true });
        slots.tags.style.columnGap = '6px';
        for (const name of tagNames) {
            const chip = document.createElement('span');
            chip.className = 'tag';
            const label = document.createElement('span');
            label.className = 'tag_name';
            label.textContent = name;
            chip.append(label);
            slots.tags.append(chip);
        }
        document.body.append(row);
        return { row, container: slots.tags, width };
    }

    test('measures each overflow label once and appends zero probe nodes for subsequent rows', () => {
        const frames = [];
        jest.spyOn(global, 'requestAnimationFrame').mockImplementation(cb => frames.push(cb));
        jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
            const width = this.matches('.sb-tag-overflow--measure') ? 28 : 40;
            return { width, height: 24, top: 0, left: 0, right: width, bottom: 24 };
        });

        const first = makeTagStrip(['One', 'Two', 'Three', 'Four', 'Five'], 130);
        const second = makeTagStrip(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'], 130);
        const third = makeTagStrip(['A', 'B', 'C', 'D', 'E'], 130);

        const appendedProbes = [];
        const origAppend = Element.prototype.append;
        jest.spyOn(Element.prototype, 'append').mockImplementation(function (...nodes) {
            for (const node of nodes) {
                if (node instanceof HTMLElement && node.classList.contains('sb-tag-overflow--measure')) {
                    appendedProbes.push({ host: this, text: node.textContent });
                }
            }
            return origAppend.apply(this, nodes);
        });

        limitTagChips(first.container);
        limitTagChips(second.container);
        limitTagChips(third.container);
        frames.splice(0).forEach(cb => cb());

        onResize([
            { target: first.container, contentRect: { width: first.width } },
            { target: second.container, contentRect: { width: second.width } },
            { target: third.container, contentRect: { width: third.width } },
        ]);

        // Only the first strip should have appended probes (+5, +4, +3, +2); second and third reuse the shared cache.
        expect(appendedProbes.filter(item => item.host === second.container)).toHaveLength(0);
        expect(appendedProbes.filter(item => item.host === third.container)).toHaveLength(0);
        expect(second.container.querySelector('.sb-tag-overflow').textContent).toBe('+3');
        expect(third.container.querySelector('.sb-tag-overflow').textContent).toBe('+3');

        // A later resize pass for a new strip with the same tag count appends 0 probes at all.
        appendedProbes.length = 0;
        const fourth = makeTagStrip(['W', 'X', 'Y', 'Z', 'Q'], 130);
        limitTagChips(fourth.container);
        frames.splice(0).forEach(cb => cb());
        onResize([{ target: fourth.container, contentRect: { width: fourth.width } }]);
        expect(appendedProbes).toHaveLength(0);
        expect(fourth.container.querySelector('.sb-tag-overflow').textContent).toBe('+3');
    });

    test('prunes detached strips from observedStrips and unobserves them on the next frame', () => {
        const frames = [];
        jest.spyOn(global, 'requestAnimationFrame').mockImplementation(cb => frames.push(cb));

        const detached = makeTagStrip(['TagA', 'TagB', 'TagC', 'TagD'], 120);
        limitTagChips(detached.container);
        detached.row.remove();
        // Trigger prune frame even when ResizeObserver never fires for the detached node.
        frames.splice(0).forEach(cb => cb());

        expect(unobserve).toHaveBeenCalledWith(detached.container);
        expect(observed.has(detached.container)).toBe(false);
    });
});

describe('Background gallery Map lookup, lazy adapter avatar, and flat-grid reuse', () => {
    beforeEach(() => {
        bgImages.length = 0;
        createThumbnail.mockClear();
        activateLazyLoader.mockClear();
        refreshHighlights.mockClear();
    });

    test('indexBackgroundImages provides O(1) first-match Map lookup', () => {
        const first = { filename: 'forest.jpg', isAnimated: false, mediaType: 'image' };
        const duplicate = { filename: 'forest.jpg', isAnimated: true, mediaType: 'video' };
        const video = { filename: 'rain.mp4', isAnimated: true, mediaType: 'video' };
        const map = indexBackgroundImages([first, duplicate, video]);

        expect(map).toBeInstanceOf(Map);
        expect(map.get('forest.jpg')).toBe(first);
        expect(map.get('rain.mp4')).toBe(video);
        expect(map.get('missing.png')).toBeUndefined();
    });

    test('sets loading="lazy" and decoding="async" on adapter avatars and reuses keyed flat-grid nodes', async () => {
        document.body.innerHTML = `
            <div id="Backgrounds">
                <div id="bg-header-fixed"><div class="bg-header-row-2"></div></div>
                <input id="bg-filter" type="search">
                <select id="bg-sort"><option value="az">A-Z</option></select>
                <div id="bg_tabs">
                    <div class="heading-controls"></div>
                    <div class="bg_tab_panel"><div id="bg_menu_content"></div></div>
                </div>
            </div>
        `;
        bgImages.push(
            { filename: 'alpha.jpg', isAnimated: false, mediaType: 'image' },
            { filename: 'beta.jpg', isAnimated: false, mediaType: 'image' },
        );
        await initBackgroundGallery();

        const avatar = createBackgroundFolderAdapter().getAvatar('alpha.jpg');
        expect(avatar.getAttribute('loading')).toBe('lazy');
        expect(avatar.getAttribute('decoding')).toBe('async');

        const container = document.getElementById('bg_menu_content');
        const initialAlpha = container.querySelector('[bgfile="alpha.jpg"]');
        expect(initialAlpha).not.toBeNull();
        expect(createThumbnail).toHaveBeenCalledTimes(2);

        // Filtering and clearing reuses the existing DOM node instead of rebuilding it.
        galleryHost.setQuery('alpha');
        await Promise.resolve();
        expect(container.children).toHaveLength(1);
        expect(container.firstElementChild).toBe(initialAlpha);
        expect(createThumbnail).toHaveBeenCalledTimes(2);

        galleryHost.setQuery('');
        await Promise.resolve();
        expect(container.children).toHaveLength(2);
        expect(container.querySelector('[bgfile="alpha.jpg"]')).toBe(initialAlpha);
        expect(createThumbnail).toHaveBeenCalledTimes(2);
    });
});

describe('Entity search WeakMap cache', () => {
    test('caches normalized search text per entity object and invalidates on field changes', () => {
        const compute = jest.fn(() => '  Alice   Creator   Notes  ');
        const persona = { id: 'p1', name: 'Alice' };

        expect(getCachedEntitySearchText(persona, 'fp-1', compute)).toBe('alice creator notes');
        expect(getCachedEntitySearchText(persona, 'fp-1', compute)).toBe('alice creator notes');
        expect(compute).toHaveBeenCalledTimes(1);

        expect(getCachedEntitySearchText(persona, 'fp-2', compute)).toBe('alice creator notes');
        expect(compute).toHaveBeenCalledTimes(2);
    });

    test('collectEntitySearchEntries hits cache for unchanged characters and invalidates on creator_notes edits', () => {
        const character = {
            name: 'Aria',
            avatar: 'aria.png',
            data: { creator: 'Dev', tags: ['fantasy'], creator_notes: 'Ancient library keeper' },
        };
        setSearchContextAccessor(() => ({ characters: [character], groups: [], getWorldInfoNames: () => [] }));

        const first = collectEntitySearchEntries('library');
        expect(first).toHaveLength(1);
        expect(first[0].displayText).toBe('Aria');

        // Same-length creator_notes replacement must invalidate the WeakMap cache entry.
        character.data.creator_notes = 'Modern  starship pilot';
        expect(collectEntitySearchEntries('library')).toHaveLength(0);
        expect(collectEntitySearchEntries('starship')).toHaveLength(1);
    });
});

describe('Prompt editor visibility gating, ordered class, and search debounce', () => {
    test('defers synchronize and token counting while hidden, catches up on reveal, marks ordered rows, and debounces search 150ms', async () => {
        jest.useFakeTimers();
        countTokens.mockClear();
        window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
        window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
        window.CSS = { escape: value => String(value) };
        window.SillyBunnyAssets = { loadStylesheetAsync: async () => {} };
        global.$ = () => ({ on() { return this; } });
        global.$.ajaxPrefilter = jest.fn();
        global.$.fn = {};
        global.toastr = { error: jest.fn(), clear: jest.fn(), info: jest.fn() };

        const panel = document.createElement('section');
        panel.className = 'sb-shell-panel';
        panel.setAttribute('aria-hidden', 'true');
        const column = document.createElement('div');
        panel.append(column);
        document.body.append(panel);

        initializePromptEditor(column);
        await jest.advanceTimersByTimeAsync(1000);

        // Hidden panel: neither rows nor background token requests should have run.
        expect(column.querySelectorAll('.sb-prompt-row')).toHaveLength(0);
        expect(countTokens).not.toHaveBeenCalled();

        // Reveal the panel: catch-up sync renders rows and schedules token counting.
        panel.setAttribute('aria-hidden', 'false');
        document.dispatchEvent(new CustomEvent('sb:shell-tab-activated', { detail: { tabId: 'editor' } }));
        await jest.advanceTimersByTimeAsync(0);

        const orderedRows = column.querySelectorAll('.sb-prompt-row--ordered');
        expect(orderedRows).toHaveLength(2);
        expect(column.querySelector('[data-prompt-id="runtimeAgents"]').classList.contains('sb-prompt-row--ordered')).toBe(false);

        await jest.advanceTimersByTimeAsync(350);
        expect(countTokens).toHaveBeenCalled();

        // Search input is debounced by 150ms.
        column.querySelector('button[aria-label="Search Prompts"]').click();
        const searchInput = column.querySelector('.sb-prompt-search');
        searchInput.value = 'Secondary';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));

        jest.advanceTimersByTime(100);
        expect(column.querySelectorAll('.sb-prompt-row--ordered')).toHaveLength(2);

        jest.advanceTimersByTime(60);
        expect(column.querySelectorAll('.sb-prompt-row--ordered')).toHaveLength(1);
    });
});
