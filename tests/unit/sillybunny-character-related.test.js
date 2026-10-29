/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, test, expect, beforeEach, afterEach } from '@jest/globals';

const characters = [];
const groups = [];
const power_user = { personas: {}, persona_descriptions: {} };
const world_info = { charLore: [] };
const listeners = new Map();
const event_types = Object.fromEntries([
    'CHARACTER_EDITED', 'CHARACTER_PAGE_LOADED', 'WORLDINFO_SETTINGS_UPDATED', 'SETTINGS_UPDATED',
    'GROUP_UPDATED', 'GROUP_CHAT_CREATED', 'GROUP_CHAT_DELETED',
    'PERSONA_UPDATED', 'PERSONA_CREATED', 'PERSONA_DELETED', 'PERSONA_RENAMED',
].map(type => [type, type]));
await jest.unstable_mockModule('../../public/script.js', () => ({
    characters, this_chid: 0, create_save: {}, createOrEditCharacter: jest.fn(), converter: {},
}));
await jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({ groups }));
await jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({ power_user, setCharacterEditorQuickEdit: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({ world_info, world_names: ['Primary', 'Extra'] }));
await jest.unstable_mockModule('../../public/scripts/events.js', () => ({
    event_types,
    eventSource: { on: (type, handler) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(handler);
    } },
}));
await jest.unstable_mockModule('../../public/scripts/chats.js', () => ({ formatCreatorNotes: jest.fn(), getCurrentEntityId: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({ Popup: jest.fn(), POPUP_TYPE: {}, POPUP_RESULT: {} }));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: strings => strings.join(''), translate: value => value }));
await jest.unstable_mockModule('../../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'related-test' }));
await jest.unstable_mockModule('../../public/lib.js', () => ({ DOMPurify: {} }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-characters-navigation.js', () => ({}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/navigation.js', () => ({
    registerEditorNavigation: jest.fn(), confirmEditorLeave: jest.fn(async () => true), discardEditorChanges: jest.fn(),
    confirmActiveEditorLeave: async () => true,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/chrome.js', () => ({
    mountEditorChrome: jest.fn(), showDraftRecoveryToast: jest.fn(), dismissDraftRecoveryToast: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/preview.js', () => ({ mountEditorPreviews: () => ({ reset: jest.fn() }) }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateHeightFrom: jest.fn(), animateIn: jest.fn(), animateListChange: (_node, render) => render(),
    MOTION_EASE_OUT_QUAD: '', MOTION_FAST: 0, MOTION_SLOW: 0, prefersReducedMotion: () => true,
}));
const { createObjectNavigation } = await import('../../public/scripts/sillybunny-editor/object-navigation.js');
const navigation = createObjectNavigation({ confirmLeave: async () => true });
const navigate = jest.fn(navigation.navigate);
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/object-navigation.js', () => ({ objectNavigation: { ...navigation, navigate } }));
const editor = await import('../../public/scripts/sillybunny-character-editor.js');
const openBook = jest.fn(async () => true);
const openPersona = jest.fn(async () => true);
const openGroup = jest.fn(async () => true);
navigation.register('world-info', { open: openBook });
navigation.register('persona-editor', { open: openPersona });
navigation.register('group-editor', { open: openGroup });

const rows = () => [...document.querySelectorAll('#sb_character_related_rows > .ds-row')];
const emit = type => { for (const handler of listeners.get(type) ?? []) handler(); };

beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    listeners.clear();
    navigation.clear();
    localStorage.clear();
    characters.splice(0, characters.length,
        { avatar: 'Alice.png', name: 'Alice', data: { extensions: { world: 'Primary' } } },
        { avatar: 'Bob.png', name: 'Bob', data: {} });
    groups.splice(0, groups.length, { id: 42, name: 'Team', members: ['Alice.png'] }, { id: 'other', name: 'Other', members: ['Bob.png'] });
    world_info.charLore = [{ name: 'Alice', extraBooks: ['Primary', 'Extra', 'Extra'] }];
    power_user.personas = { 'persona.png': 'Reader' };
    power_user.persona_descriptions = {
        'persona.png': { connections: [{ type: 'character', id: 'Alice.png' }] },
        'missing.png': { connections: [{ type: 'character', id: 'Alice.png' }] },
    };
    document.body.innerHTML = `<div id="right-nav-panel" class="openDrawer" data-menu-type="character_edit"><form id="form_create">
        <input id="character_name_pole"><div id="sb_character_related" hidden>
        <h3 id="sb_character_section_related"></h3><div id="sb_character_related_rows"></div></div>
        <button type="button" id="world_button"></button>
        <select id="char-management-dropdown"><option id="set_character_world" value="world">Link</option></select>
    </form></div>`;
    global.$ = target => {
        const node = typeof target === 'string' ? document.querySelector(target) : target;
        return {
            on: (type, handler) => node?.addEventListener(type, handler),
            trigger: type => node?.dispatchEvent(new Event(type, { bubbles: true })),
        };
    };
    editor.initCharacterEditor();
    editor.openCharacterEditorSession(0);
});

afterEach(() => {
    editor.discardCharacterEditorForEntity('Alice.png');
    editor.discardCharacterEditorForEntity('Bob.png');
    jest.useRealTimers();
});

test('Related shows deduplicated primary/extra lorebooks, containing groups and connected existing personas', () => {
    expect(document.getElementById('sb_character_related').hidden).toBe(false);
    expect(rows().map(row => [row.dataset.relatedKind, row.dataset.targetId, row.querySelector('.ds-row-label').textContent])).toEqual([
        ['world-info', 'Primary', 'Primary'], ['world-info', 'Extra', 'Extra'],
        ['group-editor', '42', 'Team'], ['persona-editor', 'persona.png', 'Reader'],
    ]);
    expect(rows().map(row => row.querySelector('.ds-row-subtitle').textContent)).toEqual(['Primary Lorebook', 'Additional Lorebooks', 'Groups', 'Persona']);
    expect(rows().every(row => row.tagName === 'BUTTON' && row.type === 'button' && row.querySelector('.ds-row__chevron'))).toBe(true);
});

test.each([
    ['world-info', 'Extra', openBook], ['group-editor', '42', openGroup], ['persona-editor', 'persona.png', openPersona],
])('%s routes with stable target and character origin', async (kind, id, opened) => {
    rows().find(row => row.dataset.relatedKind === kind && row.dataset.targetId === id).click();
    await jest.advanceTimersByTimeAsync(0);
    expect(navigate).toHaveBeenCalledWith({ kind, id }, { from: { kind: 'character-editor', id: 'Alice.png' } });
    expect(opened).toHaveBeenCalledTimes(1);
});

test('character switch produces one actionable lorebook-link empty state and no unrelated entities', () => {
    editor.openCharacterEditorSession(1);
    expect(rows().map(row => row.dataset.relatedKind)).toEqual(['link-lorebook', 'group-editor']);
    const change = jest.fn();
    document.getElementById('char-management-dropdown').addEventListener('change', change);
    rows()[0].click();
    expect(change).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
});

test('create mode hides Related and clears its old rows', () => {
    editor.openCharacterEditorCreateSession();
    expect(document.getElementById('sb_character_related').hidden).toBe(true);
    expect(rows()).toHaveLength(0);
});

test.each(['WORLDINFO_SETTINGS_UPDATED', 'SETTINGS_UPDATED', 'CHARACTER_EDITED', 'CHARACTER_PAGE_LOADED', 'GROUP_UPDATED', 'GROUP_CHAT_CREATED', 'GROUP_CHAT_DELETED', 'PERSONA_UPDATED', 'PERSONA_CREATED', 'PERSONA_DELETED', 'PERSONA_RENAMED'])('%s reconciles relations without replacing unchanged rows', type => {
    const primary = rows()[0];
    groups[0].name = 'Renamed team';
    power_user.personas['persona.png'] = 'Renamed reader';
    emit(type);
    expect(rows()[0]).toBe(primary);
    expect(rows()[2].textContent).toContain('Renamed team');
    expect(rows()[3].textContent).toContain('Renamed reader');
});

test('relation changes remove stale links, support full-avatar charLore keys and update primary classification', () => {
    const extra = rows()[1];
    characters[0].data.extensions.world = 'Extra';
    world_info.charLore = [{ name: 'Alice.png', extraBooks: ['Extra'] }];
    groups[0].members = [];
    power_user.persona_descriptions['persona.png'].connections = [];
    emit('SETTINGS_UPDATED');
    expect(rows()).toEqual([extra]);
    expect(extra.querySelector('.ds-row-subtitle').textContent).toBe('Primary Lorebook');
});

test('plain toolbar lorebook action routes with origin; modifier clicks retain upstream linking', () => {
    const upstream = jest.fn();
    const button = document.getElementById('world_button');
    button.addEventListener('click', upstream);
    button.click();
    expect(navigate).toHaveBeenCalledWith({ kind: 'world-info', id: 'Primary' }, { from: { kind: 'character-editor', id: 'Alice.png' } });
    expect(upstream).not.toHaveBeenCalled();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(upstream).toHaveBeenCalledTimes(1);
});
