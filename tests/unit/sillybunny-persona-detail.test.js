/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const translate = jest.fn((text, key) => key || text);
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate,
}));
await jest.unstable_mockModule('../../public/script.js', () => ({
    characters: [{ name: 'Alice', avatar: 'alice.png' }], default_avatar: '/default.png', default_user_avatar: '/user.png',
    getThumbnailUrl: (type, id) => `/thumbnail/${type}/${id}`,
    getThumbnailUrlForViewport: (type, id) => `/thumbnail/${type}/${id}`,
}));
await jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({
    groups: [{ id: 'group-1', name: 'Test group' }],
    getGroupAvatar: () => [Object.assign(document.createElement('img'), { src: '/group.png', alt: '' })],
}));
await jest.unstable_mockModule('../../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'test-user' }));
const countTokens = jest.fn(async () => 12);
await jest.unstable_mockModule('../../public/scripts/tokenizers.js', () => ({ getTokenCountAsync: countTokens }));
const openWorldInfoEditor = jest.fn();
await jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({ world_names: ['Book A', 'Book B'], openWorldInfoEditor }));
const openActionMenu = jest.fn();
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu, closeActionMenu: jest.fn(), isActionMenuOpen: () => false,
}));
const pickerClose = jest.fn();
const openPicker = jest.fn(() => ({ close: pickerClose }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ openPicker, isPickerOpen: () => false }));
const popupShow = jest.fn();
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_TYPE: { CONFIRM: 'confirm' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
    Popup: jest.fn().mockImplementation(function () {
        this.okButton = document.createElement('button');
        this.show = popupShow;
    }),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateIn: jest.fn(), animateOut: (_node, _frames, finish) => finish(), stopMotion: jest.fn(),
    prefersReducedMotion: () => true, MOTION_EASE_OUT_QUAD: 'linear', MOTION_FAST: 0, SPRING_SHEET: {},
}));

let state;
let activeId;
let defaultId;
let chatLock;
let currentConnection;
let deps;
const getPersonaRecord = jest.fn(id => state.personas[id] === undefined ? null : ({ avatarId: id, name: state.personas[id], descriptor: state.persona_descriptions[id] }));
const getPersonaActiveAppendixIds = jest.fn(id => [...(state.persona_descriptions[id]?.activeAppendices?.['alice.png'] ?? [])]);
const usePersona = jest.fn(async id => { activeId = id; });
const setPersonaDefault = jest.fn(async (id, enabled) => { defaultId = enabled ? id : ''; });
const setPersonaChatLock = jest.fn(async (id, enabled) => { chatLock = enabled ? id : ''; });
const setPersonaCharacterConnection = jest.fn(async (id, enabled) => {
    state.persona_descriptions[id].connections = enabled ? [{ ...currentConnection }] : [];
});
const removePersonaConnection = jest.fn(async (id, connection) => {
    state.persona_descriptions[id].connections = state.persona_descriptions[id].connections.filter(item => item.id !== connection.id);
});
const setPersonaLorebook = jest.fn(async (id, name) => { state.persona_descriptions[id].lorebook = name; });
const setPersonaAppendicesActive = jest.fn(async (id, ids) => { state.persona_descriptions[id].activeAppendices['alice.png'] = ids; });
const createPersonaRecord = jest.fn(async ({ name, title, description }) => {
    const id = 'new.png';
    state.personas[id] = name.trim();
    state.persona_descriptions[id] = descriptor({ title, description });
    return id;
});
const duplicatePersonaRecord = jest.fn(async () => 'duplicate.png');
const deletePersonaRecord = jest.fn(async id => {
    delete state.personas[id];
    delete state.persona_descriptions[id];
    return true;
});
const changePersonaImage = jest.fn();
const convertPersonaToCharacter = jest.fn();
await jest.unstable_mockModule('../../public/scripts/personas.js', () => ({
    getPersonaRecord, getPersonaActiveAppendixIds, getPersonaModelDeps: () => deps,
    getPersonaEditorStates: id => ({ inUse: activeId === id, default: defaultId === id, locked: {
        chat: chatLock === id,
        character: Boolean(currentConnection && state.persona_descriptions[id]?.connections?.some(connection => connection.id === currentConnection.id)),
    } }),
    getPersonaAppendixScope: () => ({ key: 'alice.png', kind: 'character' }),
    getCurrentConnectionObj: () => currentConnection,
    usePersona, setPersonaDefault, setPersonaChatLock, setPersonaCharacterConnection, removePersonaConnection,
    setPersonaLorebook, setPersonaAppendicesActive, createPersonaRecord, duplicatePersonaRecord,
    deletePersonaRecord, changePersonaImage, convertPersonaToCharacter,
}));
const { mountPersonaDetail, personaDraftKey } = await import('../../public/scripts/sillybunny-persona-detail.js');
const { objectNavigation } = await import('../../public/scripts/sillybunny-editor/object-navigation.js');
const { registerEditorNavigation } = await import('../../public/scripts/sillybunny-editor/navigation.js');
const navigate = jest.spyOn(objectNavigation, 'navigate');
const openCharacter = jest.fn(async () => true);
const openGroup = jest.fn(async () => true);
objectNavigation.register('world-info', { open: async target => { openWorldInfoEditor(target.id); return true; } });
objectNavigation.register('character-editor', { open: openCharacter });
objectNavigation.register('group-editor', { open: openGroup });
objectNavigation.register('persona-editor', { open: async () => true });
const model = await import('../../public/scripts/sillybunny-persona-model.js');
const mounted = [];
let recoveryActions;

function descriptor(overrides = {}) {
    return {
        title: 'Original title', description: 'Base description', position: 0, depth: 2, role: 0,
        appendices: [{ id: 'note-1', name: 'Note one', description: 'Note content' }],
        connections: [], lorebook: '', activeAppendices: {}, extension: { preserved: true }, ...overrides,
    };
}

function mount(options = {}) {
    const host = document.createElement('div');
    document.body.append(host);
    const callbacks = { requestClose: jest.fn(), onSaved: jest.fn(), onStateChange: jest.fn() };
    const controller = mountPersonaDetail({ host, avatarId: 'first.png', ...callbacks, ...options });
    const unregister = registerEditorNavigation({
        session: { isOpen: () => true, isDirty: controller.isDirty, save: controller.save, discard: controller.discard, flushDraft: () => {} },
        isActive: () => host.isConnected, close: callbacks.requestClose, escape: false,
    });
    const destroy = controller.destroy;
    controller.destroy = (...args) => { unregister(); destroy(...args); };
    mounted.push(controller);
    return { host, controller, ...callbacks };
}

test('ordinary metadata/state refreshes keep avatar URLs stable; overwrites invalidate once', () => {
    const { host, controller } = mount();
    const image = host.querySelector('img');
    const original = image.getAttribute('src');
    controller.refresh('persona', 'first.png');
    controller.refresh('states');
    expect(image.getAttribute('src')).toBe(original);
    controller.refresh('avatar', 'first.png');
    expect(image.getAttribute('src')).not.toBe(original);
    const overwritten = image.getAttribute('src');
    jest.advanceTimersByTime(1);
    controller.refresh('persona', 'first.png');
    expect(image.getAttribute('src')).toBe(overwritten);
});

function field(host, id) {
    const row = host.querySelector(`[data-sb-editor-field="${id}"]`);
    return row?.matches('input, textarea') ? row : row?.querySelector('input, textarea, select, button');
}

function edit(host, id, value, type = 'input') {
    const control = field(host, id);
    if (control.type === 'checkbox') control.checked = value;
    else control.value = value;
    control.dispatchEvent(new Event(type, { bubbles: true }));
    return control;
}

function choose(host, id, value) {
    host.querySelector(`[data-sb-editor-field="${id}"] button`).click();
    const options = id === 'position' ? model.POSITION_OPTIONS : model.ROLE_OPTIONS;
    const index = options.findIndex(option => Number(option.value) === value);
    document.querySelectorAll('.sb-persona-property-option')[index].click();
}

function keydown(target, key, extra = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(event);
    return event;
}

function stored(id = 'first.png') {
    return JSON.parse(localStorage.getItem(personaDraftKey(id)));
}

function backup() {
    window.dispatchEvent(new Event('pagehide'));
}

async function settle() {
    await jest.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    objectNavigation.clear();
    popupShow.mockReset();
    document.body.replaceChildren();
    localStorage.clear();
    activeId = 'first.png';
    defaultId = '';
    chatLock = '';
    currentConnection = { type: 'character', id: 'alice.png' };
    state = { personas: { 'first.png': 'First', 'other.png': 'Other' }, persona_descriptions: {
        'first.png': descriptor(), 'other.png': descriptor({ description: 'Other base', title: 'Other title' }),
    } };
    deps = { state, isActive: id => activeId === id, project: jest.fn(), setUserName: jest.fn(),
        save: jest.fn(async () => true), emit: jest.fn(async () => {}), events: { PERSONA_UPDATED: 'updated', PERSONA_RENAMED: 'renamed' } };
    recoveryActions = new Map();
    global.structuredClone ??= value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
    const jqueryHandlers = new WeakMap();
    global.$ = target => {
        const api = {
            on(name, handler) {
                const type = name.split('.')[0];
                jqueryHandlers.set(target, { type, handler });
                target.addEventListener(type, handler);
                return api;
            },
            off() {
                const registered = jqueryHandlers.get(target);
                if (registered) target.removeEventListener(registered.type, registered.handler);
                jqueryHandlers.delete(target);
                return api;
            },
            val(value) { target.value = value; return api; },
            trigger(type) {
                const registered = jqueryHandlers.get(target);
                if (registered?.type === type) registered.handler();
                return api;
            },
        };
        return api;
    };
    global.toastr = { error: jest.fn(), clear: jest.fn(), info: jest.fn(() => ({
        find: selector => ({ on: (_type, handler) => recoveryActions.set(selector, handler) }),
    })) };
});

afterEach(() => {
    for (const controller of mounted.splice(0)) controller.destroy();
    jest.useRealTimers();
});

describe('Persona detail structure and explicit content edits', () => {
    test('mirrors the header, action classes, section order and unique macro-aware expand target', () => {
        const { host, controller } = mount();
        const header = host.querySelector('.sb-persona-entry-header');
        expect([...header.children].map(node => node.className)).toEqual([
            'menu_button menu_button_icon sb-persona-detail-back', 'sb-persona-entry-name', 'sb-persona-entry-dirty',
            expect.stringContaining('sb-persona-entry-modes'), 'menu_button menu_button_icon sb-persona-entry-mode-toggle',
            'sb-persona-entry-actions', 'sb-editor-action sb-editor-action--secondary sb-persona-entry-cancel',
            'sb-editor-action sb-editor-action--primary sb-persona-entry-save',
        ]);
        expect(controller.focusTarget()).toBe(field(host, 'name'));
        expect([...host.querySelectorAll('[data-sb-section]')].map(node => node.dataset.sbSection)).toEqual(['identity', 'description', 'notes', 'connections', 'lorebook']);
        expect(host.querySelector('.sb-persona-properties').previousElementSibling.className).toContain('property-summary');
        const description = field(host, 'description');
        expect(description.hasAttribute('data-macros')).toBe(true);
        expect(host.querySelector('.editor_maximize').dataset.for).toBe(description.id);
        expect(host.querySelector('.editor_maximize').title).toBe('Expand the editor');
        const other = mount({ avatarId: 'other.png' });
        expect(field(other.host, 'description').id).not.toBe(description.id);
        expect(host.querySelector('.ds-row-expander').open).toBe(false);
        expect(controller.isDirty()).toBe(false);
    });

    test('name/title/description stay detached until Save, and unknown keys survive', async () => {
        const { host, controller, onSaved } = mount();
        edit(host, 'name', 'Changed');
        edit(host, 'title', 'Changed title');
        edit(host, 'description', 'Changed text');
        expect(state.personas['first.png']).toBe('First');
        expect(state.persona_descriptions['first.png'].description).toBe('Base description');
        expect(controller.isDirty()).toBe(true);
        expect(host.querySelector('.sb-persona-entry-dirty').hidden).toBe(false);
        expect(await controller.save()).toBe(true);
        expect(state.personas['first.png']).toBe('Changed');
        expect(state.persona_descriptions['first.png']).toMatchObject({ title: 'Changed title', description: 'Changed text', extension: { preserved: true } });
        expect(deps.save).toHaveBeenCalledTimes(1);
        expect(onSaved).toHaveBeenCalledWith({ avatarId: 'first.png', created: false });
        expect(controller.isDirty()).toBe(false);
    });

    test('empty name is invalid and cannot save; Cancel restores all content', async () => {
        const { host, controller } = mount();
        edit(host, 'name', '   ');
        edit(host, 'description', 'Not saved');
        expect(field(host, 'name').getAttribute('aria-invalid')).toBe('true');
        expect(host.querySelector('.sb-persona-entry-save').disabled).toBe(true);
        expect(await controller.save()).toBe(false);
        host.querySelector('.sb-persona-entry-cancel').click();
        expect(field(host, 'name').value).toBe('First');
        expect(field(host, 'description').value).toBe('Base description');
        expect(controller.isDirty()).toBe(false);
    });

    test('depth and role appear only at depth, and bar values save through model parsing', async () => {
        const { host, controller } = mount();
        expect(host.querySelector('[data-sb-editor-field="depth"]').hidden).toBe(true);
        choose(host, 'position', 4);
        expect(host.querySelector('[data-sb-editor-field="depth"]').hidden).toBe(false);
        expect(host.querySelector('[data-sb-editor-field="role"]').hidden).toBe(false);
        edit(host, 'depth', '7.9');
        choose(host, 'role', 2);
        expect(host.querySelector('.sb-persona-property-summary').textContent).toContain('Depth 7');
        expect(await controller.save()).toBe(true);
        expect(state.persona_descriptions['first.png']).toMatchObject({ position: 4, depth: 7, role: 2 });
        choose(host, 'position', 9);
        expect(host.querySelector('[data-sb-editor-field="role"]').hidden).toBe(true);
    });

    test('properties sheet and dropdown toggle, retain controls, and consume Escape', () => {
        const { host, requestClose } = mount();
        const summary = host.querySelector('.sb-persona-property-summary');
        summary.getClientRects = () => [{}];
        summary.click();
        const sheet = document.querySelector('.sb-persona-property-sheet');
        choose(sheet, 'position', 4);
        const depth = field(sheet, 'depth');
        depth.focus();
        edit(sheet, 'depth', '8');
        expect(field(host, 'depth').value).toBe('8');
        expect(field(sheet, 'depth')).toBe(depth);
        const outer = jest.fn();
        document.body.addEventListener('keydown', outer);
        keydown(depth, 'Escape');
        expect(sheet.hidden).toBe(true);
        expect(outer).not.toHaveBeenCalled();
        expect(requestClose).not.toHaveBeenCalled();
        document.body.removeEventListener('keydown', outer);
        summary.click();
        summary.click();
        expect(sheet.hidden).toBe(true);
        const position = host.querySelector('[data-sb-editor-field="position"] button');
        position.click();
        expect(document.querySelector('.sb-persona-property-popover')).not.toBeNull();
        position.click();
        expect(document.querySelector('.sb-persona-property-popover')).toBeNull();
    });

    test('expanded editor jQuery writeback saves; preview composes active notes as safe text', async () => {
        state.persona_descriptions['first.png'].activeAppendices['alice.png'] = ['note-1'];
        const { host, controller } = mount();
        $(field(host, 'description')).val('<img src=x>').trigger('input');
        host.querySelector('.sb-persona-entry-mode-toggle').click();
        const preview = host.querySelector('.sb-persona-entry-preview');
        expect(preview.textContent).toBe('<img src=x>\n\n(Note one)\nNote content');
        expect(preview.querySelector('img')).toBeNull();
        expect(host.querySelector('.editor_maximize').hidden).toBe(true);
        expect(await controller.save()).toBe(true);
        expect(state.persona_descriptions['first.png'].description).toBe('<img src=x>');
        expect(preview.hidden).toBe(true);
    });
});

describe('Scenario notes and immediate state', () => {
    test('blank note names disable Save and mark only the offending input invalid immediately', async () => {
        const { host, controller } = mount();
        host.querySelector('[data-sb-editor-field="appendix-add"]').click();
        const notes = host.querySelectorAll('[data-sb-editor-field="appendix"]');
        edit(notes[1], 'appendix-name', '  ');
        expect(field(notes[1], 'appendix-name').getAttribute('aria-invalid')).toBe('true');
        expect(field(notes[0], 'appendix-name').getAttribute('aria-invalid')).toBe('false');
        expect(field(host, 'name').getAttribute('aria-invalid')).toBe('false');
        expect(host.querySelector('.sb-persona-entry-save').disabled).toBe(true);
        expect(await controller.save()).toBe(false);
        expect(deps.save).not.toHaveBeenCalled();
        edit(notes[1], 'appendix-name', ' Named ');
        expect(field(notes[1], 'appendix-name').getAttribute('aria-invalid')).toBe('false');
        expect(host.querySelector('.sb-persona-entry-save').disabled).toBe(false);
        expect(await controller.save()).toBe(true);
        expect(state.persona_descriptions['first.png'].appendices[1].name).toBe('Named');
    });

    test('note content add/edit/delete is draft-only and Cancel restores the library', async () => {
        const { host, controller } = mount();
        host.querySelector('[data-sb-editor-field="appendix-add"]').click();
        const notes = host.querySelectorAll('[data-sb-editor-field="appendix"]');
        expect(notes).toHaveLength(2);
        edit(notes[1], 'appendix-name', 'New note');
        edit(notes[1], 'appendix-description', 'New content');
        expect(state.persona_descriptions['first.png'].appendices).toHaveLength(1);
        expect(controller.isDirty()).toBe(true);
        notes[0].querySelector('[data-sb-editor-field="appendix-delete"]').click();
        expect(await controller.save()).toBe(true);
        expect(state.persona_descriptions['first.png'].appendices).toEqual([{ id: expect.any(String), name: 'New note', description: 'New content' }]);
        host.querySelector('[data-sb-editor-field="appendix-add"]').click();
        controller.discard();
        expect(host.querySelectorAll('[data-sb-editor-field="appendix"]')).toHaveLength(1);
    });

    test('note activation is immediate, new notes wait for Save, and inactive personas have no switches', async () => {
        const { host, controller } = mount();
        edit(host, 'appendix-active', true, 'change');
        await settle();
        expect(setPersonaAppendicesActive).toHaveBeenCalledWith('first.png', ['note-1']);
        expect(controller.isDirty()).toBe(false);
        host.querySelector('[data-sb-editor-field="appendix-add"]').click();
        const added = host.querySelectorAll('[data-sb-editor-field="appendix-active"]')[1];
        expect(added.querySelector('input').disabled).toBe(true);
        await controller.save();
        expect(host.querySelectorAll('[data-sb-editor-field="appendix-active"]')[1].querySelector('input').disabled).toBe(false);
        activeId = 'other.png';
        controller.refresh('states');
        expect([...host.querySelectorAll('[data-sb-editor-field="appendix-active"]')].every(node => node.hidden)).toBe(true);
    });

    test('Import uses the shared picker and copies only the source base description', () => {
        const { host, controller } = mount();
        host.querySelector('[data-sb-editor-field="appendix-import"]').click();
        const options = openPicker.mock.calls.at(-1)[0];
        expect(options.items).toEqual([{ value: 'other.png', label: 'Other', subtitle: 'Other title' }]);
        options.onSelect('other.png');
        const note = host.querySelectorAll('[data-sb-editor-field="appendix"]')[1];
        expect(field(note, 'appendix-name').value).toBe('Other');
        expect(field(note, 'appendix-description').value).toBe('Other base');
        expect(state.persona_descriptions['first.png'].appendices).toHaveLength(1);
        expect(controller.isDirty()).toBe(true);
    });

    test('note IDs stay unique after remove/add and Save retains expanded controls and focus', async () => {
        const { host, controller } = mount();
        host.querySelector('[data-sb-editor-field="appendix-add"]').click();
        host.querySelector('[data-sb-editor-field="appendix-add"]').click();
        host.querySelector('[data-sb-editor-field="appendix-delete"]').click();
        host.querySelector('[data-sb-editor-field="appendix-add"]').click();
        const textareas = [...host.querySelectorAll('.sb-persona-note-textarea')];
        expect(new Set(textareas.map(node => node.id)).size).toBe(textareas.length);
        const note = host.querySelector('[data-sb-editor-field="appendix"]');
        note.open = true;
        const input = field(note, 'appendix-name');
        input.focus();
        edit(note, 'appendix-name', 'Kept open');
        expect(await controller.save()).toBe(true);
        expect(field(note, 'appendix-name')).toBe(input);
        expect(document.activeElement).toBe(input);
        expect(note.open).toBe(true);
    });

    test('default, chat lock, character links, and remove apply immediately without consuming draft edits', async () => {
        const { host, controller } = mount();
        edit(host, 'description', 'Unsaved');
        edit(host, 'default', true, 'change');
        await settle();
        edit(host, 'chatLock', true, 'change');
        await settle();
        edit(host, 'characterConnection', true, 'change');
        await settle();
        expect(setPersonaDefault).toHaveBeenCalledWith('first.png', true);
        expect(setPersonaChatLock).toHaveBeenCalledWith('first.png', true);
        expect(setPersonaCharacterConnection).toHaveBeenCalledWith('first.png', true);
        expect(host.querySelector('.sb-persona-connections').textContent).toContain('Alice');
        host.querySelector('.sb-persona-connection-remove').click();
        await settle();
        expect(removePersonaConnection).toHaveBeenCalledWith('first.png', currentConnection);
        expect(navigate).not.toHaveBeenCalled();
        expect(controller.isDirty()).toBe(true);
        controller.discard();
        expect(defaultId).toBe('first.png');
        expect(chatLock).toBe('first.png');
        expect(field(host, 'description').value).toBe('Base description');
        expect(deps.save).not.toHaveBeenCalled();
    });

    test('inactive persona Use is immediate; chat lock and absent current connection are insensitive', async () => {
        activeId = 'other.png';
        currentConnection = null;
        const { host, controller } = mount();
        expect(field(host, 'chatLock').disabled).toBe(true);
        expect(field(host, 'characterConnection').disabled).toBe(true);
        host.querySelector('[data-sb-editor-field="use"]').click();
        await settle();
        expect(usePersona).toHaveBeenCalledWith('first.png');
        expect(field(host, 'chatLock').disabled).toBe(false);
        expect(controller.isDirty()).toBe(false);
    });

    test('lorebook picker lists None and books, links immediately and opens World Info', async () => {
        const { host, controller } = mount();
        host.querySelector('.sb-persona-lorebook-picker').click();
        const options = openPicker.mock.calls.at(-1)[0];
        expect(options.items.map(item => item.value)).toEqual(['', 'Book A', 'Book B']);
        options.onSelect('Book B');
        await settle();
        expect(setPersonaLorebook).toHaveBeenCalledWith('first.png', 'Book B');
        expect(controller.isDirty()).toBe(false);
        host.querySelector('[data-sb-editor-field="lorebook-open"]').click();
        await settle();
        expect(openWorldInfoEditor).toHaveBeenCalledWith('Book B');
        expect(navigate).toHaveBeenCalledWith({ kind: 'world-info', id: 'Book B' }, {
            from: { kind: 'persona-editor', id: 'first.png', section: 'lorebook' },
        });
    });

    test.each([
        ['Cancel', 0, false], ['Discard', 2, true], ['Save', 1, true],
    ])('opening a lorebook runs the shared dirty guard: %s', async (_choice, result, leaves) => {
        state.persona_descriptions['first.png'].lorebook = 'Book A';
        popupShow.mockResolvedValueOnce(result);
        const { host, controller, requestClose } = mount();
        edit(host, 'description', 'Unsaved changes');
        host.querySelector('[data-sb-editor-field="lorebook-open"]').click();
        await settle();
        expect(popupShow).toHaveBeenCalledTimes(1);
        expect(openWorldInfoEditor).toHaveBeenCalledTimes(Number(leaves));
        expect(controller.isDirty()).toBe(!leaves);
        expect(requestClose).not.toHaveBeenCalled();
        expect(deps.save).toHaveBeenCalledTimes(Number(result === 1));
        expect(state.persona_descriptions['first.png'].description).toBe(result === 1 ? 'Unsaved changes' : 'Base description');
    });

    test('a failed guard Save does not open the lorebook', async () => {
        state.persona_descriptions['first.png'].lorebook = 'Book A';
        popupShow.mockResolvedValueOnce(1);
        deps.save.mockResolvedValueOnce(false);
        const { host, controller } = mount();
        edit(host, 'description', 'Unsaved changes');
        host.querySelector('[data-sb-editor-field="lorebook-open"]').click();
        await settle();
        expect(openWorldInfoEditor).not.toHaveBeenCalled();
        expect(controller.isDirty()).toBe(true);
    });

    test.each(['click', 'Enter', ' '])('character connection %s navigates with a chat-switch notice and stable origin', async activation => {
        state.persona_descriptions['first.png'].connections = [{ type: 'character', id: 'alice.png' }];
        const { host } = mount();
        const row = host.querySelector('[data-sb-editor-field="connection"]');
        expect(row.querySelector('.ds-entity-row__subtitle').textContent).toBe('lorum ipsum');
        expect(row.querySelector('.ds-entity-row__chevron')).not.toBeNull();
        if (activation === 'click') row.querySelector('.ds-entity-row__title').click();
        else keydown(row, activation);
        await settle();
        expect(navigate).toHaveBeenCalledWith({ kind: 'character-editor', id: 'alice.png', via: 'persona' }, {
            from: { kind: 'persona-editor', id: 'first.png', section: 'connections' },
        });
        expect(openCharacter).toHaveBeenCalledTimes(1);
        expect(removePersonaConnection).not.toHaveBeenCalled();
    });

    test('group connection routes without a chat-switch notice; remove key events never navigate', async () => {
        state.persona_descriptions['first.png'].connections = [{ type: 'group', id: 'group-1' }];
        const { host, controller } = mount();
        const row = host.querySelector('[data-sb-editor-field="connection"]');
        expect(row.querySelector('.ds-entity-row__subtitle')).toBeNull();
        keydown(row.querySelector('button'), 'Enter');
        keydown(row.querySelector('button'), ' ');
        expect(navigate).not.toHaveBeenCalled();
        row.click();
        await settle();
        expect(navigate).toHaveBeenCalledWith({ kind: 'group-editor', id: 'group-1' }, {
            from: { kind: 'persona-editor', id: 'first.png', section: 'connections' },
        });
        controller.refresh('states');
        expect(host.querySelector('[data-sb-editor-field="connection"]')).toBe(row);
    });

    test('connection navigation uses the shared leave guard and Cancel keeps the draft and origin', async () => {
        state.persona_descriptions['first.png'].connections = [{ type: 'character', id: 'alice.png' }];
        popupShow.mockResolvedValueOnce(0);
        const { host, controller } = mount();
        edit(host, 'description', 'Unsaved changes');
        host.querySelector('[data-sb-editor-field="connection"]').click();
        await settle();
        expect(popupShow).toHaveBeenCalledTimes(1);
        expect(openCharacter).not.toHaveBeenCalled();
        expect(controller.isDirty()).toBe(true);
        expect(objectNavigation.depth).toBe(0);
    });

    test('detail menu matches rare actions, hides Sync when inactive, and confirmed Delete closes cleanly', async () => {
        const { host, controller, requestClose } = mount();
        edit(host, 'description', 'Unsaved');
        host.querySelector('.sb-persona-entry-more').click();
        const items = openActionMenu.mock.calls.at(-1)[0].sections[0].items;
        expect(items.map(item => item.label)).toEqual(['lorum ipsum', 'Change Persona Image', 'Create Character Card from Persona', 'Click to set user name for all messages', 'Duplicate Persona', 'Delete Persona']);
        expect(items[0].disabled).toBe(true);
        expect(items.at(-1).danger).toBe(true);
        items[1].onSelect();
        expect(changePersonaImage).toHaveBeenCalledWith('first.png');
        activeId = 'other.png';
        controller.refresh('states');
        host.querySelector('.sb-persona-entry-more').setAttribute('aria-expanded', 'false');
        host.querySelector('.sb-persona-entry-more').click();
        expect(openActionMenu.mock.calls.at(-1)[0].sections[0].items).toHaveLength(5);
        items.at(-1).onSelect();
        await settle();
        expect(deletePersonaRecord).toHaveBeenCalledWith('first.png');
        expect(controller.isDirty()).toBe(false);
        expect(requestClose).toHaveBeenCalledTimes(1);
    });
});

describe('Save receipts, creation, backups and concurrency', () => {
    test.each(['discard', 'cancel', 'back'])('failed creation followed by %s silently deletes the provisional persona', async action => {
        const { host, controller, requestClose } = mount({ mode: 'create', avatarId: null });
        edit(host, 'name', 'Created');
        deps.save.mockResolvedValueOnce(false);
        expect(await controller.save()).toBe(false);
        expect(state.personas['new.png']).toBe('Created');
        if (action === 'discard') controller.discard();
        if (action === 'cancel') host.querySelector('.sb-persona-entry-cancel').click();
        if (action === 'back') {
            requestClose.mockImplementation(() => { controller.discard(); controller.destroy(); });
            host.querySelector('.sb-persona-detail-back').click();
        }
        await settle();
        expect(deletePersonaRecord).toHaveBeenCalledWith('new.png', { silent: true });
        expect(state.personas).not.toHaveProperty('new.png');
        expect(state.persona_descriptions).not.toHaveProperty('new.png');
        expect(stored(null)).toBeNull();
    });

    test.each([undefined, { keepDraft: true }])('failed creation survives destroy (%j) and restore retries the same provisional id', async options => {
        const first = mount({ mode: 'create', avatarId: null });
        edit(first.host, 'name', 'Created');
        choose(first.host, 'position', 4);
        deps.save.mockResolvedValueOnce(false);
        expect(await first.controller.save()).toBe(false);
        expect(stored(null).snapshot.provisionalId).toBe('new.png');
        first.controller.destroy(options);
        expect(deletePersonaRecord).not.toHaveBeenCalled();
        expect(stored(null).snapshot.provisionalId).toBe('new.png');
        const second = mount({ mode: 'create', avatarId: null });
        recoveryActions.get('#sb_draft_restore_btn')();
        expect(field(second.host, 'name').value).toBe('Created');
        expect(await second.controller.save()).toBe(true);
        expect(createPersonaRecord).toHaveBeenCalledTimes(1);
        expect(state.persona_descriptions['new.png'].position).toBe(4);
        expect(stored(null)).toBeNull();
    });

    test('discarding a recovered create draft deletes its provisional record even before Restore', async () => {
        const first = mount({ mode: 'create', avatarId: null });
        edit(first.host, 'name', 'Created');
        deps.save.mockResolvedValueOnce(false);
        expect(await first.controller.save()).toBe(false);
        first.controller.destroy();
        mount({ mode: 'create', avatarId: null });
        recoveryActions.get('#sb_draft_discard_btn')();
        await settle();
        expect(deletePersonaRecord).toHaveBeenCalledWith('new.png', { silent: true });
        expect(state.personas).not.toHaveProperty('new.png');
        expect(stored(null)).toBeNull();
    });

    test('recovery creates a replacement only when the provisional record no longer exists', async () => {
        const first = mount({ mode: 'create', avatarId: null });
        edit(first.host, 'name', 'Created');
        deps.save.mockResolvedValueOnce(false);
        expect(await first.controller.save()).toBe(false);
        first.controller.destroy();
        delete state.personas['new.png'];
        delete state.persona_descriptions['new.png'];
        const second = mount({ mode: 'create', avatarId: null });
        recoveryActions.get('#sb_draft_restore_btn')();
        expect(await second.controller.save()).toBe(true);
        expect(createPersonaRecord).toHaveBeenCalledTimes(2);
        expect(stored(null)).toBeNull();
    });

    test('navigation during avatar creation preserves ownership for recovery instead of creating twice', async () => {
        let finishUpload;
        createPersonaRecord.mockImplementationOnce(({ name }) => new Promise(resolve => {
            finishUpload = () => {
                state.personas['pending.png'] = name;
                state.persona_descriptions['pending.png'] = descriptor();
                resolve('pending.png');
            };
        }));
        const first = mount({ mode: 'create', avatarId: null });
        edit(first.host, 'name', 'Created');
        const pending = first.controller.save();
        await Promise.resolve();
        first.controller.destroy({ keepDraft: true });
        finishUpload();
        await pending;
        expect(stored(null).snapshot.provisionalId).toBe('pending.png');
        const second = mount({ mode: 'create', avatarId: null });
        recoveryActions.get('#sb_draft_restore_btn')();
        expect(await second.controller.save()).toBe(true);
        expect(createPersonaRecord).toHaveBeenCalledTimes(1);
        expect(state.personas['pending.png']).toBe('Created');
    });

    test('create starts empty with disabled image/state actions and acknowledges even default-only creation', async () => {
        const { host, controller, onSaved } = mount({ mode: 'create', avatarId: null });
        expect(field(host, 'name').value).toBe('');
        expect(host.querySelector('.sb-persona-change-image').disabled).toBe(true);
        expect(host.querySelector('.sb-persona-entry-save').disabled).toBe(true);
        edit(host, 'name', 'Created');
        edit(host, 'description', 'Created body');
        backup();
        expect(stored(null)).not.toBeNull();
        expect(await controller.save()).toBe(true);
        expect(createPersonaRecord).toHaveBeenCalledWith({ name: 'Created', title: '', description: 'Created body' });
        expect(deps.save).toHaveBeenCalledTimes(1);
        expect(onSaved).toHaveBeenCalledWith({ avatarId: 'new.png', created: true });
        expect(stored(null)).toBeNull();
        expect(controller.isDirty()).toBe(false);
        expect(host.querySelector('.sb-persona-change-image').disabled).toBe(false);
    });

    test('create commits position/depth/role/notes and retry reuses a provisional record', async () => {
        const { host, controller } = mount({ mode: 'create', avatarId: null });
        edit(host, 'name', 'Created');
        choose(host, 'position', 4);
        edit(host, 'depth', '5');
        choose(host, 'role', 1);
        host.querySelector('[data-sb-editor-field="appendix-add"]').click();
        deps.save.mockResolvedValueOnce(false);
        expect(await controller.save()).toBe(false);
        expect(controller.isDirty()).toBe(true);
        expect(await controller.save()).toBe(true);
        expect(createPersonaRecord).toHaveBeenCalledTimes(1);
        expect(state.persona_descriptions['new.png']).toMatchObject({ position: 4, depth: 5, role: 1, appendices: [expect.any(Object)] });
    });

    test('failed acknowledged save rolls back content and stays dirty', async () => {
        const { host, controller } = mount();
        deps.save.mockResolvedValueOnce(false);
        edit(host, 'description', 'Mine');
        expect(await controller.save()).toBe(false);
        expect(controller.isDirty()).toBe(true);
        expect(state.persona_descriptions['first.png'].description).toBe('Base description');
        expect(global.toastr.error).toHaveBeenCalledWith('lorum ipsum');
    });

    test('later edits during coalesced saves stay dirty against the submitted snapshot', async () => {
        let finish;
        deps.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const { host, controller } = mount();
        edit(host, 'description', 'Submitted');
        const saving = controller.save();
        expect(controller.save()).toBe(saving);
        await Promise.resolve();
        edit(host, 'description', 'Later edit');
        finish(true);
        expect(await saving).toBe(false);
        expect(field(host, 'description').value).toBe('Later edit');
        expect(stored().snapshot.draft.description).toBe('Later edit');
        controller.discard();
        expect(field(host, 'description').value).toBe('Submitted');
    });

    test('draft keys encode IDs and backups occur every five seconds and on pagehide', async () => {
        expect(personaDraftKey('A / %.png')).toBe('sb-persona-editor-draft-test-user-A%20%2F%20%25.png');
        expect(personaDraftKey(null)).toBe('sb-persona-editor-draft-test-user-new-persona');
        const { host, controller } = mount();
        edit(host, 'description', 'Backup');
        await jest.advanceTimersByTimeAsync(4999);
        expect(stored()).toBeNull();
        await jest.advanceTimersByTimeAsync(1);
        expect(stored().snapshot.draft.description).toBe('Backup');
        expect(stored().snapshot.fingerprint).toBe(model.fingerprint(model.personaToDraft(getPersonaRecord('first.png'))));
        controller.discard();
        expect(stored()).toBeNull();
    });

    test('matching fingerprints offer restore; changed baseline and malformed draft are discarded', () => {
        const first = mount();
        edit(first.host, 'description', 'Recovered');
        first.controller.destroy({ keepDraft: true });
        const second = mount();
        recoveryActions.get('#sb_draft_restore_btn')();
        expect(field(second.host, 'description').value).toBe('Recovered');
        expect(second.controller.isDirty()).toBe(true);
        second.controller.destroy({ keepDraft: true });
        state.persona_descriptions['first.png'].description = 'External';
        global.toastr.info.mockClear();
        mount();
        expect(global.toastr.info).not.toHaveBeenCalled();
        expect(stored()).toBeNull();
        localStorage.setItem(personaDraftKey('first.png'), JSON.stringify({ v: 1, ts: Date.now(), snapshot: { fingerprint: model.fingerprint(model.personaToDraft(getPersonaRecord('first.png'))), draft: { name: 'Broken' } } }));
        mount();
        expect(stored()).toBeNull();
    });

    test('rejecting a stored recovery draft preserves edits made since opening the detail', () => {
        const first = mount();
        edit(first.host, 'description', 'Old backup');
        first.controller.destroy({ keepDraft: true });
        const second = mount();
        edit(second.host, 'description', 'Current edit');
        recoveryActions.get('#sb_draft_discard_btn')();
        expect(field(second.host, 'description').value).toBe('Current edit');
        expect(second.controller.isDirty()).toBe(true);
        expect(stored()).toBeNull();
        expect(deletePersonaRecord).not.toHaveBeenCalled();
    });

    test('clean external changes are adopted, states refresh never overwrites dirty content', () => {
        const { host, controller } = mount();
        state.persona_descriptions['first.png'].description = 'External';
        controller.refresh('persona', 'first.png');
        expect(field(host, 'description').value).toBe('External');
        edit(host, 'description', 'Mine');
        controller.refresh('states');
        expect(field(host, 'description').value).toBe('Mine');
        expect(controller.isDirty()).toBe(true);
        expect(host.querySelector('.sb-persona-entry-banner').hidden).toBe(true);
    });

    test('dirty external changes offer Reload or Keep mine with three-way merge', async () => {
        const { host, controller } = mount();
        edit(host, 'description', 'Mine');
        state.persona_descriptions['first.png'].description = 'External';
        state.persona_descriptions['first.png'].title = 'External title';
        controller.refresh('persona', 'first.png');
        expect(host.querySelector('.sb-persona-entry-banner').hidden).toBe(false);
        host.querySelector('.sb-persona-entry-keep-mine').click();
        expect(field(host, 'description').value).toBe('Mine');
        expect(field(host, 'title').value).toBe('External title');
        expect(await controller.save()).toBe(true);
        edit(host, 'description', 'Mine again');
        state.persona_descriptions['first.png'].description = 'Reloaded';
        controller.refresh('persona', 'first.png');
        host.querySelector('.sb-persona-entry-reload').click();
        expect(field(host, 'description').value).toBe('Reloaded');
        expect(controller.isDirty()).toBe(false);
    });

    test('deleted persona drops backups, disables Save, and preserves draft through Save as new', async () => {
        const { host, controller, onSaved } = mount();
        edit(host, 'description', 'Rescue me');
        backup();
        delete state.personas['first.png'];
        delete state.persona_descriptions['first.png'];
        controller.refresh('persona', 'first.png');
        backup();
        expect(stored()).toBeNull();
        expect(host.querySelector('.sb-persona-entry-save').disabled).toBe(true);
        expect(await controller.save()).toBe(false);
        host.querySelector('.sb-persona-entry-save-as-new').click();
        await settle();
        expect(state.persona_descriptions['new.png'].description).toBe('Rescue me');
        expect(onSaved).toHaveBeenCalledWith({ avatarId: 'new.png', created: true });
        expect(controller.isDirty()).toBe(false);
    });
});

describe('Keyboard and disposal', () => {
    test.each([{ ctrlKey: true }, { metaKey: true }])('Ctrl/Cmd+S saves without bubbling (%j)', async modifier => {
        const { host } = mount();
        edit(host, 'description', 'Shortcut');
        const outer = jest.fn();
        document.body.addEventListener('keydown', outer);
        const event = keydown(field(host, 'description'), 's', modifier);
        await settle();
        expect(event.defaultPrevented).toBe(true);
        expect(outer).not.toHaveBeenCalled();
        expect(deps.save).toHaveBeenCalledTimes(1);
        document.body.removeEventListener('keydown', outer);
    });

    test('Escape in fields blurs; outside fields requests guarded close; neither bubbles', () => {
        const { host, requestClose } = mount();
        const outer = jest.fn();
        document.body.addEventListener('keydown', outer);
        const input = field(host, 'description');
        input.focus();
        keydown(input, 'Escape');
        expect(document.activeElement).not.toBe(input);
        expect(requestClose).not.toHaveBeenCalled();
        keydown(host.querySelector('.sb-persona-entry'), 'Escape');
        expect(requestClose).toHaveBeenCalledTimes(1);
        expect(outer).not.toHaveBeenCalled();
        document.body.removeEventListener('keydown', outer);
    });

    test('destroy removes body-mounted surfaces, listeners and timers; optional backup remains', () => {
        const { host, controller } = mount();
        edit(host, 'description', 'Keep me');
        host.querySelector('.sb-persona-property-summary').click();
        host.querySelector('.sb-persona-lorebook-picker').click();
        controller.destroy({ keepDraft: true });
        expect(stored().snapshot.draft.description).toBe('Keep me');
        expect(host.children).toHaveLength(0);
        expect(document.querySelector('.sb-persona-property-sheet')).toBeNull();
        expect(document.querySelector('.sb-persona-sheet-backdrop')).toBeNull();
        expect(pickerClose).toHaveBeenCalled();
        expect(controller.focusTarget()).toBeNull();
    });
});
