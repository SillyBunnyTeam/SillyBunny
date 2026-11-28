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
const accountItems = new Map();
await jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({
    accountStorage: { getItem: key => accountItems.get(key) ?? null, setItem: (key, value) => accountItems.set(key, String(value)) },
}));
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

async function mountEditor(options) {
    const column = document.createElement('div');
    document.body.append(column);
    initializePromptEditor(column, options);
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
    accountItems.clear();
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
        expect(back.getAttribute('aria-label')).toBe('Back to Prompt List');
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
        expect(header.querySelector('.sb-prompt-dirty').getAttribute('aria-label')).toBe('Unsaved Changes');
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
        // A name that cannot change is the page's title, not a locked field.
        const title = detail.querySelector('.sb-prompt-title');
        expect(title.tagName).toBe('SPAN');
        expect(title.classList.contains('sb-editor-title')).toBe(true);
        expect(title.textContent).toBe('Chat History');
        expect(title.id).toBe('sb-prompt-form_name');
    });

    test('a new prompt can be saved before its first edit', async () => {
        const column = await mountEditor();
        column.querySelector('button[aria-label="Add Prompt"]').click();
        const menuItems = openActionMenu.mock.calls.at(-1)[0].sections[0].items;
        menuItems.find(item => item.label === 'New Prompt').onSelect();
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
        expect(sectionLabels()).toEqual([['Inspect', 'Send to Agents'], ['Remove From List', 'Delete']]);
        const items = openActionMenu.mock.calls[0][0].sections.flatMap(section => section.items);
        expect(items.map(item => [item.label, Boolean(item.danger)])).toEqual([
            ['Inspect', false], ['Send to Agents', false], ['Remove From List', false], ['Delete', true],
        ]);
        expect(items.every(item => item.icon.startsWith('fa-solid fa-'))).toBe(true);
    });

    test('a built-in prompt offers Reset to default and no Delete', async () => {
        const column = await mountEditor();
        const detail = await openPrompt(column, 'main');
        detail.querySelector('.sb-prompt-more').click();
        expect(sectionLabels()).toEqual([['Inspect', 'Send to Agents'], ['Reset to Default']]);
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
        expect(labelRow.querySelector('label').textContent).toBe('Prompt Content');
        expect(labelRow.querySelector('label').htmlFor).toBe(textarea.id);
        const expand = labelRow.querySelector(':scope > .editor_maximize');
        expect(expand.dataset.for).toBe('sb-prompt-form_prompt');
        expect(expand.title).toBe('Expand the Editor');
        expect(expand.getAttribute('aria-label')).toBe('Expand the Editor');
        expect(detail.querySelector('.sb-prompt-footer .editor_maximize')).toBeNull();
        detail.querySelector('.sb-prompt-mode-toggle').click();
        await flush();
        expect(column.querySelector('.sb-prompt-label-row')).not.toBeNull();
        expect(column.querySelector('.editor_maximize')).toBeNull();
    });
});

function search(column, query) {
    if (column.querySelector('.sb-prompt-search-field').hidden) column.querySelector('button[aria-label="Search Prompts"]').click();
    const input = column.querySelector('.sb-prompt-search');
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    jest.advanceTimersByTime(150);
}

describe('Prompt list', () => {
    test('the header carries the way back to Presets, the state badges and the context line', async () => {
        const openPresets = jest.fn();
        const column = await mountEditor({ openPresets });
        const header = column.querySelector('.sb-prompt-list-header');
        const buttons = [...header.querySelectorAll('button')];
        expect(buttons.map(node => node.getAttribute('aria-label'))).toEqual(['Presets', 'Search Prompts', 'Add Prompt', 'Prompt List Actions']);
        expect(buttons[0].title).toBe('Presets');
        expect(buttons[0].hasAttribute('data-sb-editor-presets')).toBe(true);
        buttons[0].click();
        expect(openPresets).toHaveBeenCalledTimes(1);

        const row = header.querySelector('.sb-list-header__lead');
        expect([...row.querySelectorAll('[hidden]')].map(node => node.textContent)).toEqual(['Read-only', 'Autosave off']);
        expect(row.querySelector('[data-sb-editor-autosave]')).not.toBeNull();
        expect(row.querySelector('[data-sb-editor-read-only]')).not.toBeNull();

        const line = header.querySelector('.sb-list-header__subtitle');
        header.querySelector('[data-sb-editor-preset]').textContent = 'Default';
        header.querySelector('[data-sb-editor-mode]').textContent = 'Chat Completions';
        await flush();
        expect(line.title).toBe(`Default · Chat Completions · ${line.querySelector('.sb-prompt-context--counts').textContent.replace(/active/, 'Active').replace(/tokens/, 'Tokens')}`);
    });

    test('is the shared list header and boxed list of entity rows, with the compat classes kept', async () => {
        const column = await mountEditor();
        const header = column.querySelector('.sb-prompt-list-header');
        expect(header.classList.contains('sb-list-header')).toBe(true);
        expect(header.querySelector('.sb-list-header__title').textContent).toBe('Prompts');
        expect([...header.querySelectorAll('button')].map(node => node.getAttribute('aria-label'))).toEqual(['Search Prompts', 'Add Prompt', 'Prompt List Actions']);
        const box = column.querySelector('.sb-prompt-order .sb-prompt-box');
        expect(box.classList.contains('ds-entity-list')).toBe(true);
        const row = box.querySelector('[data-prompt-id="first"]');
        expect(row.classList.contains('ds-entity-row')).toBe(true);
        expect(row.classList.contains('sb-prompt-row')).toBe(true);
        expect(row.querySelector('.ds-entity-row__title.sb-prompt-row-name').textContent).toBe('First');
        expect(row.querySelector('.ds-entity-row__subtitle.sb-prompt-row-subtitle').textContent).toBe('System · Relative');
        const grip = row.querySelector('.sb-prompt-grip');
        expect(grip.title).toBe('Drag to Reorder First');
        expect(grip.getAttribute('role')).toBeNull();
        expect(grip.getAttribute('aria-label')).toBeNull();
        expect(grip.getAttribute('aria-hidden')).toBe('true');
        expect(row.querySelector('.sb-prompt-switch-target input[role="switch"]').getAttribute('aria-label')).toBe('Enable First');
        const more = row.querySelector('.ds-entity-row__button.sb-prompt-row-menu');
        expect(more.getAttribute('aria-label')).toBe('Actions for First');
        expect(more.classList.contains('menu_button')).toBe(false);
    });

    test('a search with matches hides the groups with no rows and counts the results in the subtitle', async () => {
        const column = await mountEditor();
        search(column, 'First');
        const sections = [...column.querySelectorAll('.sb-prompt-section')];
        expect(sections.filter(section => !section.hidden).map(section => section.querySelector('h3').textContent)).toEqual(['Prompt Order']);
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
        expect(page.querySelector('.sb-status-page__title').textContent).toBe('No Results Found');
        expect([...column.querySelectorAll('.sb-prompt-section')].every(section => section.hidden)).toBe(true);
        expect(column.querySelector('.sb-list-header__subtitle').textContent).toBe('No results');
        search(column, 'First');
        expect(column.querySelector('.sb-prompt-list-body > .sb-status-page')).toBeNull();
    });

    test('the Role menu is a menu of radio items and the Triggers popover has check rows and no Done button', async () => {
        const column = await mountEditor();
        const detail = await openPrompt(column, 'first');
        const role = detail.querySelector('.sb-prompt-properties button[aria-label^="Role:"]');
        role.click();
        const roleMenu = openActionMenu.mock.calls.at(-1)[0];
        expect(roleMenu.trigger).toBe(role);
        expect(roleMenu.title).toBe('Role');
        expect(roleMenu.sections[0].items.map(item => [item.label, item.kind, item.checked])).toEqual([['System', 'radio', true], ['User', 'radio', false], ['Assistant', 'radio', false]]);
        roleMenu.sections[0].items[2].onSelect();
        expect(role.textContent).toBe('Assistant');
        expect(column.querySelector('.sb-prompt-dirty').hidden).toBe(false);

        const triggers = detail.querySelector('.sb-prompt-properties button[aria-label^="Triggers:"]');
        triggers.click();
        const popover = openPopover.mock.calls.at(-1)[0];
        expect(popover.trigger).toBe(triggers);
        expect(popover.title).toBe('Generation Triggers');
        // Select All comes first, then the six triggers.
        const boxes = () => [...popover.content.querySelectorAll('input[type="checkbox"]')];
        expect(boxes().map(box => box.checked)).toEqual([false, false, false, false, false, false, false]);
        expect(boxes()[0].dataset.sbSelectAll).toBe('true');
        expect(popover.content.querySelector('button')).toBeNull();
        const second = boxes()[2];
        second.checked = true;
        second.dispatchEvent(new Event('change', { bubbles: true }));
        expect(triggers.textContent).toBe('Continue');
        expect(boxes()[0]).toMatchObject({ checked: false, indeterminate: true });

        boxes()[0].checked = true;
        boxes()[0].dispatchEvent(new Event('change', { bubbles: true }));
        expect(boxes().map(box => box.checked)).toEqual(Array(7).fill(true));
        expect(boxes()[0].indeterminate).toBe(false);
        expect(triggers.textContent).toBe('Normal, Continue, Impersonate, Swipe, Regenerate, Quiet');

        boxes()[0].checked = false;
        boxes()[0].dispatchEvent(new Event('change', { bubbles: true }));
        expect(boxes().map(box => box.checked)).toEqual(Array(7).fill(false));
        expect(triggers.textContent).toBe('All Triggers');
    });

    test('Select in the list menu starts selection mode; Turn Off switches the chosen prompts off', async () => {
        fakeModel.toggle = jest.fn();
        const column = await mountEditor();
        column.querySelector('button[aria-label="Prompt List Actions"]').click();
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

describe('Prompt list sort', () => {
    // The stored order is main, first, zeta, a marker and Alpha, which has no count until its content is counted.
    function useSortFixture() {
        promptRecords = [
            record('main', 'Main Prompt', { system_prompt: true }),
            record('first', 'First'),
            record('zeta', 'Zeta'),
            record('marker', 'Chat History', { marker: true, system_prompt: true, content: undefined }),
            record('alpha', 'Alpha'),
            record('spare', 'Beta spare'),
        ];
        // Beta spare is a prompt that is not in the order, so it sits in the Available group.
        order = ['main', 'first', 'zeta', 'marker', 'alpha'].map(identifier => ({ identifier, enabled: true }));
        counts = { main: 10, first: 30, zeta: 20, spare: 5 };
    }
    const ids = (column, group = 'sb-prompt-order') => [...column.querySelectorAll(`.${group} .sb-prompt-row`)].map(row => row.dataset.promptId);
    const sortButton = column => column.querySelector('.sb-prompt-search-field .sb-prompt-sort-button');

    function chooseSort(column, label) {
        sortButton(column).click();
        const menu = openActionMenu.mock.calls.at(-1)[0];
        menu.sections[0].items.find(item => item.label === label).onSelect();
    }

    function rowMenuLabels(column, id) {
        column.querySelector(`[data-prompt-id="${id}"] .sb-prompt-row-menu`).click();
        return openActionMenu.mock.calls.at(-1)[0].sections.flatMap(section => section.items.map(item => item.label));
    }

    test('ends the search bar, with the list header keeping its three buttons', async () => {
        const column = await mountEditor();
        const field = column.querySelector('.sb-prompt-search-field');
        expect(field.classList.contains('sb-list-search-bar')).toBe(true);
        expect(field.firstElementChild.classList.contains('sb-search-entry')).toBe(true);
        expect(field.lastElementChild).toBe(sortButton(column));
        expect(column.querySelector('.sb-prompt-list-header .sb-prompt-sort-button')).toBeNull();
        const sort = sortButton(column);
        expect([sort.title, sort.getAttribute('aria-label'), sort.getAttribute('aria-haspopup'), sort.getAttribute('aria-pressed')]).toEqual(['Sort', 'Sort', 'menu', 'false']);
        expect(column.querySelector('button[aria-label="Search Prompts"]').getAttribute('aria-pressed')).toBe('false');
    });

    test('opens a Sort By section of radio items with the prompt order checked first', async () => {
        const column = await mountEditor();
        sortButton(column).click();
        const menu = openActionMenu.mock.calls.at(-1)[0];
        expect(menu.trigger).toBe(sortButton(column));
        expect(menu.sections).toHaveLength(1);
        expect(menu.sections[0].title).toBe('Sort By');
        expect(menu.sections[0].items.map(item => [item.label, item.kind, item.checked])).toEqual([
            ['Prompt Order', 'radio', true], ['Title A-Z', 'radio', false], ['Title Z-A', 'radio', false], ['Tokens ↗', 'radio', false], ['Tokens ↘', 'radio', false],
        ]);
    });

    test('Title A-Z shows the prompts by name, keeps the stored order and the Agents row last, and presses both buttons', async () => {
        useSortFixture();
        const column = await mountEditor();
        expect(ids(column)).toEqual(['main', 'first', 'zeta', 'marker', 'alpha', 'runtimeAgents']);
        chooseSort(column, 'Title A-Z');
        expect(ids(column)).toEqual(['alpha', 'marker', 'first', 'main', 'zeta', 'runtimeAgents']);
        expect(ids(column, 'sb-prompt-available')).toEqual(['spare']);
        expect(order.map(entry => entry.identifier)).toEqual(['main', 'first', 'zeta', 'marker', 'alpha']);
        expect(fakeModel.reorder).not.toHaveBeenCalled();
        expect(accountItems.get('PromptList_SortOrder')).toBe('name-asc');
        expect(sortButton(column).getAttribute('aria-pressed')).toBe('true');
        expect(column.querySelector('button[aria-label="Search Prompts"]').getAttribute('aria-pressed')).toBe('true');
        chooseSort(column, 'Title Z-A');
        expect(ids(column)).toEqual(['zeta', 'main', 'first', 'marker', 'alpha', 'runtimeAgents']);
    });

    test('the order group is headed Main prompts while a sort is on and Prompt order in the prompt order', async () => {
        useSortFixture();
        const column = await mountEditor();
        const heading = () => column.querySelector('.sb-prompt-order > h3');
        const headingNode = heading();
        expect(headingNode.textContent).toBe('Prompt Order');
        chooseSort(column, 'Tokens ↗');
        expect(heading()).toBe(headingNode);
        expect(headingNode.textContent).toBe('Main Prompts');
        chooseSort(column, 'Title A-Z');
        expect(headingNode.textContent).toBe('Main Prompts');
        expect(column.querySelector('.sb-prompt-available > h3').textContent).toBe('Available');
        chooseSort(column, 'Prompt Order');
        expect(headingNode.textContent).toBe('Prompt Order');
    });

    test('while a sort is on the grips are disabled and the row menus and Alt+Arrow offer no move', async () => {
        useSortFixture();
        const column = await mountEditor();
        expect(rowMenuLabels(column, 'first')).toEqual(expect.arrayContaining(['Move Up', 'Move Down']));
        const altDown = () => column.querySelector('[data-prompt-id="first"] .sb-prompt-grip').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
        altDown();
        expect(fakeModel.reorder).toHaveBeenCalledTimes(1);
        fakeModel.reorder.mockClear();
        chooseSort(column, 'Title A-Z');
        for (const grip of column.querySelectorAll('.sb-prompt-order .sb-prompt-grip')) expect(grip.getAttribute('aria-disabled')).toBe('true');
        expect(rowMenuLabels(column, 'first').filter(label => label.startsWith('Move'))).toEqual([]);
        altDown();
        expect(fakeModel.reorder).not.toHaveBeenCalled();
        chooseSort(column, 'Prompt Order');
        expect(ids(column)).toEqual(['main', 'first', 'zeta', 'marker', 'alpha', 'runtimeAgents']);
        for (const grip of column.querySelectorAll('.sb-prompt-order .sb-prompt-grip[title^="Drag"]')) expect(grip.getAttribute('aria-disabled')).toBe('false');
        expect(rowMenuLabels(column, 'first')).toEqual(expect.arrayContaining(['Move Up', 'Move Down']));
        expect(sortButton(column).getAttribute('aria-pressed')).toBe('false');
        expect(column.querySelector('button[aria-label="Search Prompts"]').getAttribute('aria-pressed')).toBe('false');
        expect(accountItems.get('PromptList_SortOrder')).toBe('order');
    });

    test('Tokens ↘ puts the largest count first and the rows with no count last, then places a count that arrives later', async () => {
        useSortFixture();
        const column = await mountEditor();
        chooseSort(column, 'Tokens ↘');
        expect(ids(column)).toEqual(['first', 'zeta', 'main', 'marker', 'alpha', 'runtimeAgents']);
        await jest.advanceTimersByTimeAsync(300);
        expect(column.querySelector('[data-prompt-id="alpha"] .sb-prompt-token').textContent).toBe('12');
        expect(ids(column)).toEqual(['first', 'zeta', 'alpha', 'main', 'marker', 'runtimeAgents']);
        expect(ids(column, 'sb-prompt-available')).toEqual(['spare']);
        chooseSort(column, 'Tokens ↗');
        expect(ids(column)).toEqual(['main', 'alpha', 'zeta', 'first', 'marker', 'runtimeAgents']);
    });

    test('the Available group follows the sort', async () => {
        useSortFixture();
        promptRecords.push(record('gamma', 'Gamma'));
        counts.gamma = 50;
        const column = await mountEditor();
        expect(ids(column, 'sb-prompt-available')).toEqual(['spare', 'gamma']);
        chooseSort(column, 'Tokens ↘');
        expect(ids(column, 'sb-prompt-available')).toEqual(['gamma', 'spare']);
        chooseSort(column, 'Title A-Z');
        expect(ids(column, 'sb-prompt-available')).toEqual(['spare', 'gamma']);
    });

    test('a search shows its matches in the chosen sort', async () => {
        useSortFixture();
        const column = await mountEditor();
        chooseSort(column, 'Title Z-A');
        search(column, 'a');
        expect(ids(column)).toEqual(['zeta', 'main', 'marker', 'alpha', 'runtimeAgents']);
    });

    test('the choice is read from the account storage when the editor opens', async () => {
        useSortFixture();
        accountItems.set('PromptList_SortOrder', 'tokens-asc');
        const column = await mountEditor();
        expect(ids(column)).toEqual(['main', 'zeta', 'first', 'marker', 'alpha', 'runtimeAgents']);
        expect(sortButton(column).getAttribute('aria-pressed')).toBe('true');
        sortButton(column).click();
        expect(openActionMenu.mock.calls.at(-1)[0].sections[0].items.filter(item => item.checked).map(item => item.label)).toEqual(['Tokens ↗']);
    });

    test('a stored value that is not a sort is the prompt order', async () => {
        useSortFixture();
        accountItems.set('PromptList_SortOrder', 'by-colour');
        const column = await mountEditor();
        expect(ids(column)).toEqual(['main', 'first', 'zeta', 'marker', 'alpha', 'runtimeAgents']);
        expect(sortButton(column).getAttribute('aria-pressed')).toBe('false');
        expect(column.querySelector('.sb-prompt-order .sb-prompt-grip').getAttribute('aria-disabled')).toBe('false');
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
        first.querySelector('button[aria-label="Add Prompt"]').click();
        openActionMenu.mock.calls.at(-1)[0].sections[0].items.find(item => item.label === 'New Prompt').onSelect();
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
        second.querySelector('button[aria-label="Add Prompt"]').click();
        openActionMenu.mock.calls.at(-1)[0].sections[0].items.find(item => item.label === 'New Prompt').onSelect();
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
