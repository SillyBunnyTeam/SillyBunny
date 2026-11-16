/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: (text, key) => key || text,
}));
await jest.unstable_mockModule('../../public/script.js', () => ({
    eventSource: { on: jest.fn() }, event_types: { APP_READY: 'app_ready' }, getRequestHeaders: () => ({}), main_api: 'openai',
}));
await jest.unstable_mockModule('../../public/scripts/openai.js', () => ({ promptManager: { serviceSettings: {} } }));
await jest.unstable_mockModule('../../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'test-user' }));
const countTokens = jest.fn(async () => 12);
await jest.unstable_mockModule('../../public/scripts/tokenizers.js', () => ({ getTokenCountAsync: countTokens, getTokenizerModel: () => 'test-tokenizer' }));
const openActionMenu = jest.fn();
const openPopover = jest.fn();
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu, openPopover, closeActionMenu: jest.fn(), isActionMenuOpen: () => false,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({ blockUpstreamDrawerClose: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/dialog.js', () => ({ openDialog: jest.fn() }));
const popupShow = jest.fn();
const popupOptions = [];
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_TYPE: { CONFIRM: 'confirm' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
    Popup: jest.fn().mockImplementation(function (_content, _type, _input, options) {
        popupOptions.push(options);
        this.okButton = document.createElement('button');
        this.show = popupShow;
    }),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateHeightFrom: jest.fn(), animateIn: jest.fn(), animateOut: (_node, _frames, finish) => finish(), play: jest.fn((_node, _frames, options) => options?.onEnd?.()), stopMotion: jest.fn(),
    prefersReducedMotion: () => true, MOTION_EASE_OUT_QUAD: 'linear', MOTION_EASE_OUT_CUBIC: 'linear', MOTION_FAST: 0, MOTION_SURFACE: 0,
    MOTION_SLOW: 0, MOTION_POPOVER_CLOSE: 0, SPRING_DIALOG: {}, SPRING_NAVIGATION: {}, SPRING_SHEET: {},
}));

let promptRecords;
let order;
let counts;
const baseScope = JSON.stringify(['global', undefined, 'Test preset']);
let scope;
let newDrafts;
const permissionsFor = prompt => ({
    edit: !prompt.marker, rename: !prompt.marker, toggle: true, remove: prompt.system_prompt === false,
    delete: prompt.system_prompt === false, reset: prompt.identifier === 'main',
});
const fakeModel = {
    permissions: permissionsFor,
    snapshot: () => ({
        scope, prompts: promptRecords, order, character: null, strategy: 'global', counts, tokens: {}, sources: {}, error: null,
        runtime: { identifier: 'runtimeAgents', name: 'In-Chat Agents', marker: true, runtime: true },
    }),
    newDraft: () => ({ identifier: `new-${++newDrafts}`, name: '', role: 'system', content: '', system_prompt: false, marker: false, injection_position: 0, injection_depth: 4, injection_order: 100, injection_trigger: [], forbid_overrides: false }),
    save: jest.fn((draft) => {
        const index = promptRecords.findIndex(prompt => prompt.identifier === draft.identifier);
        if (index < 0) promptRecords.push(structuredClone(draft));
        else promptRecords[index] = structuredClone(draft);
    }),
    readUtility: () => '',
    canRestoreUtility: () => false,
    preview: draft => draft.content,
    inspect: () => [],
    sendToAgents: jest.fn(),
    resetDraft: draft => ({ ...draft, name: 'Main Prompt', content: 'Default main' }),
    remove: jest.fn(),
    delete: jest.fn(),
    reorder: jest.fn(),
};
await jest.unstable_mockModule('../../public/scripts/sillybunny-prompt-editor-model.js', () => ({
    createPromptEditorModel: () => fakeModel,
    PROMPT_EDITOR_UTILITY_FIELDS: [],
}));
const { initializePromptEditor, promptDraftKey } = await import('../../public/scripts/sillybunny-prompt-editor.js');

let recoveryActions;
let pagehideListeners;
const flush = () => jest.advanceTimersByTimeAsync(0);

function record(identifier, name, overrides = {}) {
    return {
        identifier, name, role: 'system', content: `${name} content`, system_prompt: false, marker: false,
        injection_position: 0, injection_depth: 4, injection_order: 100, injection_trigger: [], forbid_overrides: false, ...overrides,
    };
}

async function mountEditor() {
    const column = document.createElement('div');
    document.body.append(column);
    initializePromptEditor(column);
    await flush();
    await flush();
    return column;
}

async function openPrompt(column, identifier) {
    column.querySelector(`[data-prompt-id="${identifier}"] .sb-prompt-row-name`).click();
    await flush();
    await flush();
    return column.querySelector('.sb-prompt-detail');
}

function typeContent(column, value) {
    const textarea = column.querySelector('#sb-prompt-form_prompt');
    textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return textarea;
}

function stored(entity = 'prompt:first') {
    return JSON.parse(localStorage.getItem(promptDraftKey(entity)));
}

function sectionLabels() {
    const { sections } = openActionMenu.mock.calls.at(-1)[0];
    return sections.map(section => section.items.map(item => item.label));
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    popupOptions.length = 0;
    document.body.replaceChildren();
    localStorage.clear();
    scope = baseScope;
    newDrafts = 0;
    counts = {};
    promptRecords = [
        record('first', 'First'),
        record('main', 'Main Prompt', { system_prompt: true }),
        record('marker', 'Chat History', { marker: true, system_prompt: true, content: undefined }),
    ];
    order = promptRecords.map(prompt => ({ identifier: prompt.identifier, enabled: true }));
    recoveryActions = new Map();
    global.structuredClone ??= value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.CSS = { escape: value => String(value).replace(/["\\]/g, '\\$&') };
    window.SillyBunnyAssets = { loadStylesheetAsync: async () => {} };
    HTMLElement.prototype.scrollTo ??= () => {};
    const handlers = new WeakMap();
    global.$ = target => {
        const api = {
            on(name, handler) {
                handlers.set(target, { type: name.split('.')[0], handler });
                target.addEventListener(name.split('.')[0], handler);
                return api;
            },
        };
        return api;
    };
    global.$.ajaxPrefilter = jest.fn();
    global.$.fn = {};
    global.toastr = { error: jest.fn(), clear: jest.fn(), info: jest.fn(() => ({
        find: selector => ({ on: (_type, handler) => recoveryActions.set(selector, handler) }),
    })) };
    // Each mounted editor listens for pagehide on the window; only the editor under test may answer it.
    pagehideListeners = [];
    const add = window.addEventListener.bind(window);
    jest.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
        if (type === 'pagehide') pagehideListeners.push(listener);
        return add(type, listener, options);
    });
});

afterEach(() => {
    for (const listener of pagehideListeners) window.removeEventListener('pagehide', listener);
    jest.restoreAllMocks();
    jest.useRealTimers();
});

describe('Prompt editor header', () => {
    test('puts the shared controls in the shared order with the shared shapes and tooltips', async () => {
        const column = await mountEditor();
        const detail = await openPrompt(column, 'first');
        const header = detail.querySelector('.sb-prompt-detail-header');
        expect([...header.children].map(node => node.className)).toEqual([
            'sb-editor-icon-button sb-header-icon-button sb-prompt-back',
            'sb-prompt-title',
            'sb-editor-dirty sb-prompt-dirty',
            'sb-editor-tokens sb-prompt-tokens',
            'sb-boolean-radio-group sb-segmented-control--compact sb-prompt-modes',
            'sb-editor-icon-button sb-header-icon-button sb-prompt-mode-toggle',
            'sb-editor-icon-button sb-header-icon-button sb-prompt-more',
            'sb-editor-action sb-editor-action--secondary sb-prompt-cancel',
            'sb-editor-action sb-editor-action--primary sb-prompt-save',
        ]);
        const back = header.querySelector('.sb-prompt-back');
        expect(back.title).toBe('Back');
        expect(back.getAttribute('aria-label')).toBe('Back to prompt list');
        const more = header.querySelector('.sb-prompt-more');
        expect(more.title).toBe('Prompt Actions');
        expect(more.getAttribute('aria-label')).toBe('Prompt Actions');
        expect(more.getAttribute('aria-haspopup')).toBe('menu');
        expect(header.querySelector('.sb-prompt-cancel').title).toBe('Cancel');
        expect(header.querySelector('.sb-prompt-cancel .sb-editor-action__icon')).not.toBeNull();
        expect(header.querySelector('.sb-prompt-save').title).toBe('Save');
        const toggle = header.querySelector('.sb-prompt-mode-toggle');
        expect(toggle.title).toBe('Preview');
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        expect(header.querySelector('.sb-prompt-modes').getAttribute('aria-label')).toBe('Edit / Preview');
        expect(header.querySelector('.sb-prompt-dirty').getAttribute('aria-label')).toBe('Unsaved changes');
        expect(header.querySelector('.sb-prompt-dirty .sb-editor-dirty-dot')).not.toBeNull();
        expect(detail.querySelector('.sb-prompt-actions')).toBeNull();
    });

    test('the dirty mark, Save and Cancel follow the draft', async () => {
        const column = await mountEditor();
        const detail = await openPrompt(column, 'first');
        const dirty = detail.querySelector('.sb-prompt-dirty');
        const save = detail.querySelector('.sb-prompt-save');
        const cancel = detail.querySelector('.sb-prompt-cancel');
        expect([dirty.hidden, save.disabled, cancel.disabled]).toEqual([true, true, true]);
        typeContent(column, 'Changed');
        expect([dirty.hidden, save.disabled, cancel.disabled]).toEqual([false, false, false]);
        cancel.click();
        expect(column.querySelector('#sb-prompt-form_prompt').value).toBe('First content');
        expect(column.querySelector('.sb-prompt-dirty').hidden).toBe(true);
        expect(column.querySelector('.sb-prompt-save').disabled).toBe(true);
    });

    test('a prompt that cannot be edited keeps Save disabled', async () => {
        const column = await mountEditor();
        const detail = await openPrompt(column, 'marker');
        expect(detail.querySelector('.sb-prompt-save').disabled).toBe(true);
        expect(detail.querySelector('.sb-prompt-title').readOnly).toBe(true);
    });

    test('a new prompt can be saved before its first edit', async () => {
        const column = await mountEditor();
        column.querySelector('button[aria-label="Add prompt"]').click();
        const menuItems = openActionMenu.mock.calls.at(-1)[0].sections[0].items;
        menuItems.find(item => item.label === 'New prompt').onSelect();
        await flush();
        await flush();
        const detail = column.querySelector('.sb-prompt-detail');
        expect(detail.querySelector('.sb-prompt-save').disabled).toBe(false);
        expect(detail.querySelector('.sb-prompt-dirty').hidden).toBe(false);
    });
});

describe('Prompt editor item menu', () => {
    test('holds the actions of the prompt in sections, Delete last and in red', async () => {
        const column = await mountEditor();
        const detail = await openPrompt(column, 'first');
        detail.querySelector('.sb-prompt-more').click();
        expect(openActionMenu).toHaveBeenCalledTimes(1);
        expect(openActionMenu.mock.calls[0][0].trigger).toBe(detail.querySelector('.sb-prompt-more'));
        expect(openActionMenu.mock.calls[0][0].title).toBe('First');
        expect(sectionLabels()).toEqual([['Inspect', 'Send to agents'], ['Remove from list', 'Delete']]);
        const items = openActionMenu.mock.calls[0][0].sections.flatMap(section => section.items);
        expect(items.map(item => [item.label, Boolean(item.danger)])).toEqual([
            ['Inspect', false], ['Send to agents', false], ['Remove from list', false], ['Delete', true],
        ]);
        expect(items.every(item => item.icon.startsWith('fa-solid fa-'))).toBe(true);
    });

    test('a built-in prompt offers Reset to default and no Delete', async () => {
        const column = await mountEditor();
        const detail = await openPrompt(column, 'main');
        detail.querySelector('.sb-prompt-more').click();
        expect(sectionLabels()).toEqual([['Inspect', 'Send to agents'], ['Reset to default']]);
        openActionMenu.mock.calls[0][0].sections[1].items[0].onSelect();
        expect(column.querySelector('.sb-prompt-title').value).toBe('Main Prompt');
        expect(column.querySelector('#sb-prompt-form_prompt').value).toBe('Default main');
        expect(column.querySelector('.sb-prompt-dirty').hidden).toBe(false);
    });

    test('Send to agents and Inspect act on the open prompt', async () => {
        const column = await mountEditor();
        const detail = await openPrompt(column, 'first');
        detail.querySelector('.sb-prompt-more').click();
        const [inspect, send] = openActionMenu.mock.calls[0][0].sections[0].items;
        send.onSelect();
        expect(fakeModel.sendToAgents).toHaveBeenCalledWith('first');
        inspect.onSelect();
        await flush();
        expect(column.querySelector('.sb-prompt-textarea')).toBeNull();
        expect(column.querySelector('.sb-prompt-mode-toggle').title).toBe('Edit');
    });

    test('a prompt that is only a marker offers Inspect without Send to agents', async () => {
        const column = await mountEditor();
        const detail = await openPrompt(column, 'marker');
        detail.querySelector('.sb-prompt-more').click();
        expect(sectionLabels()).toEqual([['Inspect']]);
    });

    test('the menu is marked as part of the editor for the preset autosave', async () => {
        const column = await mountEditor();
        const detail = await openPrompt(column, 'first');
        const nodes = ['sb-action-menu', 'sb-action-sheet', 'sb-action-popover'].map(className => {
            const node = document.createElement('div');
            node.className = className;
            document.body.append(node);
            return node;
        });
        detail.querySelector('.sb-prompt-more').click();
        expect(nodes.map(node => node.dataset.sbPromptMenu)).toEqual(['true', 'true', 'true']);
    });
});

describe('Prompt editor token count and Expand', () => {
    test('the count is in the header and, for a phone, beside the property summary; the footer count is gone', async () => {
        const column = await mountEditor();
        const detail = await openPrompt(column, 'first');
        await jest.advanceTimersByTimeAsync(300);
        expect(detail.querySelector('.sb-prompt-detail-header > .sb-prompt-tokens').textContent).toBe('12 Tokens');
        expect(detail.querySelector('.sb-prompt-detail-header > .sb-prompt-tokens').hidden).toBe(false);
        const row = detail.querySelector(':scope > .sb-editor-summary-row');
        expect(row.querySelector(':scope > .sb-prompt-property-summary.sb-editor-summary')).not.toBeNull();
        expect(row.querySelector(':scope > .sb-editor-tokens--row').textContent).toBe('12 Tokens');
        expect(detail.querySelector('.sb-prompt-token-footer')).toBeNull();
        expect(detail.querySelector('.sb-prompt-footer')).toBeNull();
        expect(countTokens).toHaveBeenCalledWith('First content', 0);
    });

    test('the count follows edits and survives a change of mode', async () => {
        const column = await mountEditor();
        await openPrompt(column, 'first');
        await jest.advanceTimersByTimeAsync(300);
        countTokens.mockResolvedValueOnce(40);
        typeContent(column, 'A longer text');
        await jest.advanceTimersByTimeAsync(300);
        expect(column.querySelector('.sb-prompt-tokens').textContent).toBe('40 Tokens');
        column.querySelector('.sb-prompt-mode-toggle').click();
        await flush();
        expect(column.querySelector('.sb-prompt-tokens').textContent).toBe('40 Tokens');
        expect(column.querySelector('.sb-editor-tokens--row').textContent).toBe('40 Tokens');
    });

    test('a prompt without properties keeps the phone row for the count alone', async () => {
        counts = { marker: 7 };
        const column = await mountEditor();
        const detail = await openPrompt(column, 'marker');
        expect(detail.querySelector('.sb-prompt-property-summary')).toBeNull();
        const row = detail.querySelector(':scope > .sb-editor-summary-row');
        expect(row.children).toHaveLength(1);
        expect(row.firstElementChild.textContent).toBe('7 Tokens');
        expect(detail.querySelector('.sb-prompt-tokens').textContent).toBe('7 Tokens');
    });

    test('Expand sits in the label row of the content field while it can be edited', async () => {
        const column = await mountEditor();
        const detail = await openPrompt(column, 'first');
        const field = detail.querySelector('.sb-prompt-content > .sb-prompt-content-field');
        const textarea = field.querySelector('#sb-prompt-form_prompt');
        const labelRow = field.querySelector(':scope > .sb-editor-label-row');
        expect(labelRow.querySelector('label').textContent).toBe('Prompt content');
        expect(labelRow.querySelector('label').htmlFor).toBe(textarea.id);
        const expand = labelRow.querySelector(':scope > .editor_maximize');
        expect(expand.dataset.for).toBe('sb-prompt-form_prompt');
        expect(expand.title).toBe('Expand the editor');
        expect(expand.getAttribute('aria-label')).toBe('Expand the editor');
        expect(detail.querySelector('.sb-prompt-footer .editor_maximize')).toBeNull();
        detail.querySelector('.sb-prompt-mode-toggle').click();
        await flush();
        expect(column.querySelector('.sb-prompt-label-row')).not.toBeNull();
        expect(column.querySelector('.editor_maximize')).toBeNull();
    });
});

function search(column, query) {
    if (column.querySelector('.sb-prompt-search-field').hidden) column.querySelector('button[aria-label="Search prompts"]').click();
    const input = column.querySelector('.sb-prompt-search');
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Prompt list', () => {
    test('is the shared list header and boxed list of entity rows, with the compat classes kept', async () => {
        const column = await mountEditor();
        const header = column.querySelector('.sb-prompt-list-header');
        expect(header.classList.contains('sb-list-header')).toBe(true);
        expect(header.querySelector('.sb-list-header__title').textContent).toBe('Prompts');
        expect([...header.querySelectorAll('button')].map(node => node.getAttribute('aria-label'))).toEqual(['Search prompts', 'Add prompt', 'Prompt list actions']);
        const box = column.querySelector('.sb-prompt-order .sb-prompt-box');
        expect(box.classList.contains('ds-entity-list')).toBe(true);
        const row = box.querySelector('[data-prompt-id="first"]');
        expect(row.classList.contains('ds-entity-row')).toBe(true);
        expect(row.classList.contains('sb-prompt-row')).toBe(true);
        expect(row.querySelector('.ds-entity-row__title.sb-prompt-row-name').textContent).toBe('First');
        expect(row.querySelector('.ds-entity-row__subtitle.sb-prompt-row-subtitle').textContent).toBe('System · Relative');
        expect(row.querySelector('.sb-prompt-grip').getAttribute('aria-label')).toBe('Drag to reorder First');
        expect(row.querySelector('.sb-prompt-switch-target input[role="switch"]').getAttribute('aria-label')).toBe('Enable First');
        const more = row.querySelector('.ds-entity-row__button.sb-prompt-row-menu');
        expect(more.getAttribute('aria-label')).toBe('Actions for First');
        expect(more.classList.contains('menu_button')).toBe(false);
    });

    test('a search with matches hides the groups with no rows and counts the results in the subtitle', async () => {
        const column = await mountEditor();
        search(column, 'First');
        const sections = [...column.querySelectorAll('.sb-prompt-section')];
        expect(sections.filter(section => !section.hidden).map(section => section.querySelector('h3').textContent)).toEqual(['Prompt order']);
        expect(column.querySelector('.sb-list-header__subtitle').textContent).toBe('1 of 4 results');
        expect(column.querySelector('.sb-prompt-list-body > .sb-status-page')).toBeNull();
        search(column, '');
        expect(sections.every(section => !section.hidden || section.querySelectorAll('.sb-prompt-row').length === 0)).toBe(true);
        expect(column.querySelector('.sb-list-header__subtitle').textContent).toMatch(/active/);
    });

    test('a search with no match shows the shared No Results status page and no group heading', async () => {
        const column = await mountEditor();
        search(column, 'zz-no-such-prompt');
        const page = column.querySelector('.sb-prompt-list-body > .sb-status-page');
        expect(page).not.toBeNull();
        expect(page.querySelector('.sb-status-page__title').textContent).toBe('No Results');
        expect([...column.querySelectorAll('.sb-prompt-section')].every(section => section.hidden)).toBe(true);
        expect(column.querySelector('.sb-list-header__subtitle').textContent).toBe('No results');
        search(column, 'First');
        expect(column.querySelector('.sb-prompt-list-body > .sb-status-page')).toBeNull();
    });

    test('the Role menu is a menu of radio items and the Triggers popover has check rows and no Done button', async () => {
        const column = await mountEditor();
        const detail = await openPrompt(column, 'first');
        const role = detail.querySelector('.sb-prompt-properties button[aria-label="Role"]');
        role.click();
        const roleMenu = openActionMenu.mock.calls.at(-1)[0];
        expect(roleMenu.trigger).toBe(role);
        expect(roleMenu.title).toBe('Role');
        expect(roleMenu.sections[0].items.map(item => [item.label, item.kind, item.checked])).toEqual([['System', 'radio', true], ['User', 'radio', false], ['Assistant', 'radio', false]]);
        roleMenu.sections[0].items[2].onSelect();
        expect(role.textContent).toBe('Assistant');
        expect(column.querySelector('.sb-prompt-dirty').hidden).toBe(false);

        const triggers = detail.querySelector('.sb-prompt-properties button[aria-label="Triggers"]');
        triggers.click();
        const popover = openPopover.mock.calls.at(-1)[0];
        expect(popover.trigger).toBe(triggers);
        expect(popover.title).toBe('Generation triggers');
        expect([...popover.content.querySelectorAll('input[type="checkbox"]')].map(box => box.checked)).toEqual([false, false, false, false, false, false]);
        expect(popover.content.querySelector('button')).toBeNull();
        const second = popover.content.querySelectorAll('input[type="checkbox"]')[1];
        second.checked = true;
        second.dispatchEvent(new Event('change', { bubbles: true }));
        expect(triggers.textContent).toBe('Continue');
    });

    test('Select in the list menu starts selection mode; Turn Off switches the chosen prompts off', async () => {
        fakeModel.toggle = jest.fn();
        const column = await mountEditor();
        column.querySelector('button[aria-label="Prompt list actions"]').click();
        const menu = openActionMenu.mock.calls.at(-1)[0];
        const select = menu.sections.flatMap(section => section.items).find(item => item.label === 'Select');
        expect(select).toBeDefined();
        select.onSelect();
        expect(column.querySelector('.sb-prompt-editor').dataset.selectionMode).toBe('true');
        expect(column.querySelector('.sb-prompt-list-header').hidden).toBe(true);
        expect(column.querySelector('[data-prompt-id="runtimeAgents"] .sb-selection-check')).toBeNull();
        column.querySelector('[data-prompt-id="first"]').click();
        await flush();
        expect(column.querySelector('.sb-selection-title').textContent).toBe('1 selected');
        column.querySelector('.sb-selection-action[data-action-id="off"]').click();
        await flush();
        expect(fakeModel.toggle).toHaveBeenCalledWith('first', scope);
    });
});

describe('Prompt editor draft', () => {
    test('keys encode the entity and the user', () => {
        expect(promptDraftKey('prompt:a/b')).toBe('sb-prompt-editor-draft-test-user-prompt%3Aa%2Fb');
    });

    test('is written every five seconds while the draft differs, and on pagehide', async () => {
        const column = await mountEditor();
        await openPrompt(column, 'first');
        await jest.advanceTimersByTimeAsync(5000);
        expect(stored()).toBeNull();
        typeContent(column, 'Backup');
        await jest.advanceTimersByTimeAsync(4999);
        expect(stored()).toBeNull();
        await jest.advanceTimersByTimeAsync(1);
        expect(stored().v).toBe(1);
        expect(stored().snapshot.draft.content).toBe('Backup');
        expect(stored().snapshot.scope).toBe(baseScope);
        expect(stored().snapshot.fingerprint).toBe(JSON.stringify(promptRecords[0]));
        typeContent(column, 'Backup again');
        window.dispatchEvent(new Event('pagehide'));
        expect(stored().snapshot.draft.content).toBe('Backup again');
    });

    test('Save clears it and keeps the saved text', async () => {
        const column = await mountEditor();
        await openPrompt(column, 'first');
        typeContent(column, 'Saved text');
        await jest.advanceTimersByTimeAsync(5000);
        expect(stored()).not.toBeNull();
        column.querySelector('.sb-prompt-save').click();
        expect(fakeModel.save).toHaveBeenCalledTimes(1);
        expect(fakeModel.save.mock.calls[0][0].content).toBe('Saved text');
        expect(stored()).toBeNull();
        await jest.advanceTimersByTimeAsync(5000);
        expect(stored()).toBeNull();
        expect(column.querySelector('.sb-prompt-dirty').hidden).toBe(true);
    });

    test('Cancel clears it', async () => {
        const column = await mountEditor();
        await openPrompt(column, 'first');
        typeContent(column, 'Discarded');
        await jest.advanceTimersByTimeAsync(5000);
        expect(stored()).not.toBeNull();
        column.querySelector('.sb-prompt-cancel').click();
        expect(stored()).toBeNull();
        await jest.advanceTimersByTimeAsync(5000);
        expect(stored()).toBeNull();
    });

    test('leaving asks Cancel, Discard in red and Save; Discard clears the backup and closes the editor', async () => {
        const column = await mountEditor();
        const detail = await openPrompt(column, 'first');
        typeContent(column, 'Leaving');
        await jest.advanceTimersByTimeAsync(5000);
        popupShow.mockResolvedValueOnce(2);
        detail.querySelector('.sb-prompt-back').click();
        await flush();
        await flush();
        expect(popupOptions.at(-1)).toMatchObject({ okButton: 'Save', cancelButton: 'Cancel', customButtons: [{ text: 'Discard', classes: ['sb-editor-discard'] }] });
        expect(stored()).toBeNull();
        expect(column.querySelector('.sb-prompt-editor').dataset.open).toBe('false');
        expect(fakeModel.save).not.toHaveBeenCalled();
    });

    test('keeps the backup when the leave dialog is answered with Cancel', async () => {
        const column = await mountEditor();
        const detail = await openPrompt(column, 'first');
        typeContent(column, 'Staying');
        await jest.advanceTimersByTimeAsync(5000);
        popupShow.mockResolvedValueOnce(0);
        detail.querySelector('.sb-prompt-back').click();
        await flush();
        await flush();
        expect(column.querySelector('.sb-prompt-editor').dataset.open).toBe('true');
        expect(stored().snapshot.draft.content).toBe('Staying');
    });

    test('a reload offers it over the same prompt; Restore brings the edits back and leaves them unsaved', async () => {
        const first = await mountEditor();
        await openPrompt(first, 'first');
        typeContent(first, 'Recovered');
        first.querySelector('.sb-prompt-title').value = 'Recovered name';
        first.querySelector('.sb-prompt-title').dispatchEvent(new Event('input', { bubbles: true }));
        window.dispatchEvent(new Event('pagehide'));
        expect(stored()).not.toBeNull();
        document.body.replaceChildren();
        global.toastr.info.mockClear();

        const second = await mountEditor();
        const detail = await openPrompt(second, 'first');
        expect(global.toastr.info).toHaveBeenCalledTimes(1);
        expect(detail.querySelector('#sb-prompt-form_prompt').value).toBe('First content');
        recoveryActions.get('#sb_draft_restore_btn')();
        await flush();
        expect(second.querySelector('#sb-prompt-form_prompt').value).toBe('Recovered');
        expect(second.querySelector('.sb-prompt-title').value).toBe('Recovered name');
        expect(second.querySelector('.sb-prompt-dirty').hidden).toBe(false);
        expect(second.querySelector('.sb-prompt-save').disabled).toBe(false);
        second.querySelector('.sb-prompt-save').click();
        expect(fakeModel.save.mock.calls.at(-1)[0]).toMatchObject({ name: 'Recovered name', content: 'Recovered' });
        expect(stored()).toBeNull();
    });

    test('Discard on the recovery prompt drops the backup and keeps what was typed since', async () => {
        const first = await mountEditor();
        await openPrompt(first, 'first');
        typeContent(first, 'Old backup');
        window.dispatchEvent(new Event('pagehide'));
        document.body.replaceChildren();

        const second = await mountEditor();
        await openPrompt(second, 'first');
        typeContent(second, 'Current edit');
        recoveryActions.get('#sb_draft_discard_btn')();
        expect(second.querySelector('#sb-prompt-form_prompt').value).toBe('Current edit');
        expect(stored()).toBeNull();
    });

    test('is dropped, and not offered, when the saved prompt changed since or the scope differs', async () => {
        const first = await mountEditor();
        await openPrompt(first, 'first');
        typeContent(first, 'Stale');
        window.dispatchEvent(new Event('pagehide'));
        document.body.replaceChildren();

        promptRecords[0].content = 'Changed elsewhere';
        global.toastr.info.mockClear();
        const second = await mountEditor();
        await openPrompt(second, 'first');
        expect(global.toastr.info).not.toHaveBeenCalled();
        expect(stored()).toBeNull();

        typeContent(second, 'Other scope');
        window.dispatchEvent(new Event('pagehide'));
        document.body.replaceChildren();
        scope = JSON.stringify(['global', undefined, 'Another preset']);
        const third = await mountEditor();
        await openPrompt(third, 'first');
        expect(global.toastr.info).not.toHaveBeenCalled();
        expect(stored()).toBeNull();
    });

    test('a malformed backup is dropped without an offer', async () => {
        localStorage.setItem(promptDraftKey('prompt:first'), JSON.stringify({ v: 1, ts: Date.now(), snapshot: { scope: baseScope, fingerprint: JSON.stringify(promptRecords[0]), draft: { identifier: 'first', name: 5 } } }));
        const column = await mountEditor();
        await openPrompt(column, 'first');
        expect(global.toastr.info).not.toHaveBeenCalled();
        expect(stored()).toBeNull();
    });

    test('a new prompt keeps one backup under its own entity and clears it on Save', async () => {
        const first = await mountEditor();
        first.querySelector('button[aria-label="Add prompt"]').click();
        openActionMenu.mock.calls.at(-1)[0].sections[0].items.find(item => item.label === 'New prompt').onSelect();
        await flush();
        await flush();
        const name = first.querySelector('.sb-prompt-title');
        name.value = 'Brand new';
        name.dispatchEvent(new Event('input', { bubbles: true }));
        typeContent(first, 'New content');
        await jest.advanceTimersByTimeAsync(5000);
        expect(stored('prompt:new').snapshot.draft).toMatchObject({ name: 'Brand new', content: 'New content' });
        expect(stored('prompt:new').snapshot.fingerprint).toBe('');
        window.dispatchEvent(new Event('pagehide'));
        document.body.replaceChildren();

        global.toastr.info.mockClear();
        const second = await mountEditor();
        second.querySelector('button[aria-label="Add prompt"]').click();
        openActionMenu.mock.calls.at(-1)[0].sections[0].items.find(item => item.label === 'New prompt').onSelect();
        await flush();
        await flush();
        expect(global.toastr.info).toHaveBeenCalledTimes(1);
        recoveryActions.get('#sb_draft_restore_btn')();
        await flush();
        expect(second.querySelector('.sb-prompt-title').value).toBe('Brand new');
        second.querySelector('.sb-prompt-save').click();
        expect(fakeModel.save.mock.calls.at(-1)[0]).toMatchObject({ name: 'Brand new', content: 'New content' });
        expect(stored('prompt:new')).toBeNull();
    });
});
