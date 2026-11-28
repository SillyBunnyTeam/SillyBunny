/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: (text, key) => key || text,
}));
await jest.unstable_mockModule('../../public/script.js', () => ({
    eventSource: { on: jest.fn() }, event_types: { APP_READY: 'app_ready' }, getRequestHeaders: () => ({}), main_api: 'textgenerationwebui',
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
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu, openPopover: jest.fn(), closeActionMenu: jest.fn(), isActionMenuOpen: () => false,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({ blockUpstreamDrawerClose: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/dialog.js', () => ({ openDialog: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_TYPE: { CONFIRM: 'confirm' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
    Popup: jest.fn().mockImplementation(function () {
        this.okButton = document.createElement('button');
        this.show = jest.fn();
    }),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateHeightFrom: jest.fn(), animateIn: jest.fn(), animateOut: (_node, _frames, finish) => finish(), play: jest.fn((_node, _frames, options) => options?.onEnd?.()), stopMotion: jest.fn(),
    prefersReducedMotion: () => true, MOTION_EASE_OUT_QUAD: 'linear', MOTION_EASE_OUT_CUBIC: 'linear', MOTION_FAST: 0, MOTION_SURFACE: 0,
    MOTION_SLOW: 0, MOTION_POPOVER_CLOSE: 0, SPRING_DIALOG: {}, SPRING_NAVIGATION: {}, SPRING_SHEET: {},
}));

const entry = (id, name, section, fields, extra = {}) => ({
    id, identifier: id, name, section, fields: fields.map(([fieldId, fieldName]) => ({ id: fieldId, name: fieldName })),
    properties: [], values: {}, propertyValues: {}, disabled: false, ...extra,
});
let entries;
const fakeModel = {
    snapshotTextCompletions: () => ({ type: 'text-completions', scope: JSON.stringify(['textgenerationwebui', 'a', 'b', 'c']), textCompletionEntries: entries }),
    readTextCompletionEntry: identifier => structuredClone(entries.find(candidate => candidate.id === identifier)),
    saveTextCompletion: jest.fn(),
    permissions: () => ({}),
    // The real model substitutes the macros of a prompt draft; this stand-in knows one of them.
    preview: draft => String(draft.content ?? '').replaceAll('{{user}}', 'Bunny'),
};
await jest.unstable_mockModule('../../public/scripts/sillybunny-prompt-editor-model.js', () => ({
    createPromptEditorModel: () => fakeModel,
    PROMPT_EDITOR_UTILITY_FIELDS: [],
}));
const { initializePromptEditor } = await import('../../public/scripts/sillybunny-prompt-editor.js');

const flush = () => jest.advanceTimersByTimeAsync(0);

async function mountEditor() {
    const column = document.createElement('div');
    document.body.append(column);
    initializePromptEditor(column);
    await flush();
    await flush();
    return column;
}

async function openTemplate(column, id, rowMenuItem = null) {
    if (rowMenuItem) {
        column.querySelector(`[data-prompt-id="${id}"] .sb-prompt-row-menu`).click();
        openActionMenu.mock.calls.at(-1)[0].sections[0].items.find(item => item.label === rowMenuItem).onSelect();
    } else column.querySelector(`[data-prompt-id="${id}"] .sb-prompt-row-name`).click();
    await flush();
    await flush();
    return column.querySelector('.sb-prompt-detail');
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    document.body.replaceChildren();
    localStorage.clear();
    accountItems.clear();
    const legacy = document.createElement('textarea');
    legacy.id = 'sysprompt_content';
    const position = document.createElement('select');
    position.id = 'context_story_string_position';
    position.innerHTML = '<option value="0">Default (top of context)</option><option value="1">In-chat @ Depth</option>';
    const role = document.createElement('select');
    role.id = 'context_story_string_role';
    role.innerHTML = '<option value="0">System</option><option value="1">User</option>';
    document.body.append(legacy, position, role);
    entries = [
        entry('sysprompt_content', 'System prompt', 'System prompt', [['sysprompt_content', 'System prompt']], { values: { sysprompt_content: 'Write a reply.' } }),
        entry('context_story_string', 'Story string', 'Context', [['context_story_string', 'Story string']], {
            values: { context_story_string: '{{description}}' },
            properties: [{ id: 'context_story_string_position', name: 'Position' }, { id: 'context_story_string_depth', name: 'Depth' }, { id: 'context_story_string_role', name: 'Role' }],
            propertyValues: { context_story_string_position: '0', context_story_string_depth: 1, context_story_string_role: '0' },
        }),
        entry('tc-user', 'User', 'Instruct', [['instruct_input_sequence', 'User Message Prefix'], ['instruct_input_suffix', 'User Message Suffix']], {
            values: { instruct_input_sequence: '### Instruction:', instruct_input_suffix: '' }, disabled: true,
        }),
        entry('tc-system', 'System', 'Instruct', [['instruct_system_sequence', 'System Message Prefix'], ['instruct_system_suffix', 'System Message Suffix'], ['instruct_system_same_as_user', 'System same as User']], {
            values: { instruct_system_sequence: '### Input:', instruct_system_suffix: '', instruct_system_same_as_user: false },
        }),
    ];
    global.structuredClone ??= value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.CSS = { escape: value => String(value).replace(/["\\]/g, '\\$&') };
    window.SillyBunnyAssets = { loadStylesheetAsync: async () => {} };
    HTMLElement.prototype.scrollTo ??= () => {};
    global.$ = target => {
        const api = {
            on(name, handler) {
                target.addEventListener(name.split('.')[0], handler);
                return api;
            },
        };
        return api;
    };
    global.$.ajaxPrefilter = jest.fn();
    global.$.fn = {};
    global.toastr = { error: jest.fn(), clear: jest.fn(), info: jest.fn(() => ({ find: () => ({ on: jest.fn() }) })) };
});

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
});

describe('Text Completion template list', () => {
    test('rows are the shared entity rows with a count, one menu and no reorder or switch controls', async () => {
        const column = await mountEditor();
        expect(column.querySelector('.sb-list-header__title').textContent).toBe('Prompt templates');
        expect([...column.querySelectorAll('.sb-prompt-list-header button')].filter(node => !node.hidden).map(node => node.getAttribute('aria-label'))).toEqual(['Search Prompts']);
        const row = column.querySelector('[data-prompt-id="tc-user"]');
        expect(row.classList.contains('ds-entity-row')).toBe(true);
        expect(row.classList.contains('sb-prompt-row--template')).toBe(true);
        expect(row.querySelector('.sb-prompt-grip, .sb-prompt-switch-target')).toBeNull();
        expect(row.querySelector('.sb-prompt-token')).not.toBeNull();
        // A template with nothing in it still has its count column, as an unknown count does for a prompt.
        const empty = [...column.querySelectorAll('.sb-prompt-row--template')].find(node => node.dataset.promptId === 'tc-system');
        expect(empty.querySelector('.sb-prompt-token')).not.toBeNull();
        const more = row.querySelector('.sb-prompt-row-menu');
        expect(more.getAttribute('aria-label')).toBe('Actions for User');
        more.click();
        expect(openActionMenu.mock.calls.at(-1)[0].sections[0].items.map(item => item.label)).toEqual(['Edit', 'Preview']);
    });

    test('has no sort control, and a sort saved for the prompts does not press Search or reorder the groups', async () => {
        accountItems.set('PromptList_SortOrder', 'name-desc');
        const column = await mountEditor();
        expect(column.querySelector('.sb-prompt-search-field .sb-prompt-sort-button').hidden).toBe(true);
        expect(column.querySelector('button[aria-label="Search Prompts"]').getAttribute('aria-pressed')).toBe('false');
        expect([...column.querySelectorAll('.sb-prompt-tc-instruct .sb-prompt-row')].map(row => row.dataset.promptId)).toEqual(['tc-user', 'tc-system']);
    });

    test('a template that is not in use says so in words in its subtitle', async () => {
        const column = await mountEditor();
        expect(column.querySelector('[data-prompt-id="tc-user"] .sb-prompt-row-subtitle').textContent).toBe('Disabled · ### Instruction:');
        expect(column.querySelector('[data-prompt-id="tc-system"] .sb-prompt-row-subtitle').textContent).toBe('### Input:');
        expect(column.querySelector('[data-prompt-id="tc-user"]').classList.contains('is-disabled')).toBe(true);
    });

    test('a search hides the groups with no match, counts the results and shows the shared No Results page when nothing matches', async () => {
        const column = await mountEditor();
        column.querySelector('button[aria-label="Search Prompts"]').click();
        const input = column.querySelector('.sb-prompt-search');
        const type = value => {
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            jest.advanceTimersByTime(150);
        };
        type('story');
        expect([...column.querySelectorAll('.sb-prompt-section')].filter(section => !section.hidden).map(section => section.querySelector('h3').textContent)).toEqual(['Context']);
        expect(column.querySelector('.sb-list-header__subtitle').textContent).toBe('1 of 4 results');
        type('zz-no-such-template');
        const page = column.querySelector('.sb-prompt-list-body > .sb-status-page');
        expect(page.querySelector('.sb-status-page__title').textContent).toBe('No Results Found');
        expect([...column.querySelectorAll('.sb-prompt-section')].every(section => section.hidden)).toBe(true);
        expect(column.querySelector('.sb-list-header__subtitle').textContent).toBe('No results');
        type('');
        expect(column.querySelector('.sb-prompt-list-body > .sb-status-page')).toBeNull();
        expect(column.querySelector('.sb-list-header__subtitle').textContent).toBe('Grouped by role');
    });

    test('Preview in the row menu opens the template in preview mode', async () => {
        const column = await mountEditor();
        const detail = await openTemplate(column, 'tc-user', 'Preview');
        expect(detail.querySelectorAll('.sb-prompt-tc-textarea')).toHaveLength(0);
        expect(detail.querySelectorAll('pre.sb-prompt-preview')).toHaveLength(2);
        expect(detail.querySelector('.sb-prompt-mode-toggle').title).toBe('Edit');
        expect(detail.querySelector('.editor_maximize')).toBeNull();
    });
});

describe('Text Completion template detail', () => {
    test('the header has the shared order; the name is the page title and there is no item menu', async () => {
        const column = await mountEditor();
        const detail = await openTemplate(column, 'tc-user');
        const header = detail.querySelector('.sb-prompt-detail-header');
        expect([...header.children].map(node => node.className)).toEqual([
            'sb-editor-icon-button sb-header-icon-button sb-prompt-back',
            'sb-prompt-title sb-editor-title',
            'sb-editor-dirty sb-prompt-dirty',
            'sb-editor-tokens sb-prompt-tokens',
            'sb-boolean-radio-group sb-segmented-control--compact sb-prompt-modes',
            'sb-editor-icon-button sb-header-icon-button sb-prompt-mode-toggle',
            'sb-editor-icon-button sb-header-icon-button sb-prompt-more',
            'sb-editor-action sb-editor-action--secondary sb-prompt-cancel',
            'sb-editor-action sb-editor-action--primary sb-prompt-save',
        ]);
        expect(header.querySelector('.sb-prompt-title').textContent).toBe('User');
        expect(header.querySelector('.sb-prompt-title').tagName).toBe('SPAN');
        expect(header.querySelector('.sb-prompt-more').hidden).toBe(true);
        expect(detail.querySelector('.sb-prompt-footer')).toBeNull();
    });

    test('every field has its label row with Expand, which names the field that it opens', async () => {
        const column = await mountEditor();
        const detail = await openTemplate(column, 'tc-user');
        const fields = [...detail.querySelectorAll('.sb-prompt-content--fields > .sb-prompt-content-field')];
        expect(fields).toHaveLength(2);
        for (const field of fields) {
            const textarea = field.querySelector('textarea.sb-prompt-tc-textarea');
            const labelRow = field.querySelector(':scope > .sb-editor-label-row');
            const label = labelRow.querySelector('label');
            expect(textarea.id).toMatch(/^sb-prompt-tc-instruct_input_/);
            expect(label.htmlFor).toBe(textarea.id);
            const expand = labelRow.querySelector(':scope > .editor_maximize');
            expect(expand.dataset.for).toBe(textarea.id);
            expect(expand.title).toBe('Expand the Editor');
            expect(expand.getAttribute('aria-describedby')).toBe(label.id);
        }
        expect(fields.map(field => field.querySelector('label').textContent)).toEqual(['User Message Prefix', 'User Message Suffix']);
        expect(fields[0].querySelector('textarea').dataset.tcField).toBe('instruct_input_sequence');
    });

    test('a change that the expanded editor writes back (a jQuery input event) reaches the draft and the dirty mark', async () => {
        const column = await mountEditor();
        const detail = await openTemplate(column, 'tc-user');
        const textarea = detail.querySelector('#sb-prompt-tc-instruct_input_sequence');
        textarea.value = '### Changed:';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        expect(detail.querySelector('.sb-prompt-dirty').hidden).toBe(false);
        detail.querySelector('.sb-prompt-save').click();
        expect(fakeModel.saveTextCompletion).toHaveBeenCalledTimes(1);
        expect(fakeModel.saveTextCompletion.mock.calls[0][0].values.instruct_input_sequence).toBe('### Changed:');
    });

    test('the count of the template is in the header and, for a phone, in the summary row, and follows the text', async () => {
        const column = await mountEditor();
        const detail = await openTemplate(column, 'tc-user');
        await jest.advanceTimersByTimeAsync(300);
        expect(countTokens).toHaveBeenCalledWith('### Instruction:', 0);
        expect(detail.querySelector('.sb-prompt-detail-header > .sb-prompt-tokens').textContent).toBe('12 Tokens');
        expect(detail.querySelector(':scope > .sb-editor-summary-row > .sb-editor-tokens--row').textContent).toBe('12 Tokens');
        countTokens.mockResolvedValueOnce(30);
        const textarea = detail.querySelector('#sb-prompt-tc-instruct_input_suffix');
        textarea.value = 'Longer';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await jest.advanceTimersByTimeAsync(300);
        expect(countTokens).toHaveBeenLastCalledWith('### Instruction:\nLonger', 0);
        expect(column.querySelector('.sb-prompt-tokens').textContent).toBe('30 Tokens');
    });

    test('System same as User is a property of the template; it makes the two sequences read-only', async () => {
        const column = await mountEditor();
        const detail = await openTemplate(column, 'tc-system');
        const bar = detail.querySelector(':scope > .sb-prompt-properties');
        const control = bar.querySelector('input.sb-switch');
        expect(control.getAttribute('aria-label')).toBe('System same as User');
        expect(detail.querySelector('.sb-prompt-content .sb-switch')).toBeNull();
        expect(detail.querySelectorAll('.sb-prompt-tc-textarea')).toHaveLength(2);
        expect(detail.querySelector('.sb-prompt-property-summary').textContent).toBe('System same as User: Off ›');
        control.checked = true;
        control.dispatchEvent(new Event('change', { bubbles: true }));
        const sequence = detail.querySelector('[data-tc-field="instruct_system_sequence"]');
        expect(sequence.readOnly).toBe(true);
        expect(sequence.closest('.sb-prompt-content-field').classList.contains('is-disabled')).toBe(true);
        expect(detail.querySelector('.sb-prompt-property-summary').textContent).toBe('System same as User: On ›');
        expect(detail.querySelector('.sb-prompt-dirty').hidden).toBe(false);
    });

    test('Position and Role are menus of radio items taken from the legacy selects; Depth is a number', async () => {
        const column = await mountEditor();
        const detail = await openTemplate(column, 'context_story_string');
        const bar = detail.querySelector(':scope > .sb-prompt-tc-properties');
        expect(bar.querySelectorAll('select')).toHaveLength(0);
        // The name of the button holds the text that it shows.
        const position = bar.querySelector('button[aria-label="Position: Default (top of context)"]');
        expect(position.textContent).toBe('Default (top of context)');
        position.click();
        const menu = openActionMenu.mock.calls.at(-1)[0];
        expect(menu.title).toBe('Position');
        expect(menu.sections[0].items.map(item => [item.label, item.kind, item.checked])).toEqual([['Default (top of context)', 'radio', true], ['In-chat @ Depth', 'radio', false]]);
        menu.sections[0].items[1].onSelect();
        expect(position.textContent).toBe('In-chat @ Depth');
        expect(position.getAttribute('aria-label')).toBe('Position: In-chat @ Depth');
        expect(detail.querySelector('.sb-prompt-dirty').hidden).toBe(false);
        expect(detail.querySelector('.sb-prompt-property-summary').textContent).toBe('Position: In-chat @ Depth · Depth: 1 · Role: System ›');
        expect(bar.querySelectorAll('input[type="number"]')).toHaveLength(1);
        detail.querySelector('.sb-prompt-save').click();
        expect(fakeModel.saveTextCompletion.mock.calls[0][0].propertyValues.context_story_string_position).toBe('1');
    });

    test('preview shows each field under its own label, with no Expand', async () => {
        const column = await mountEditor();
        const detail = await openTemplate(column, 'tc-user');
        detail.querySelector('.sb-prompt-mode-toggle').click();
        await flush();
        const fields = [...column.querySelectorAll('.sb-prompt-content--fields > .sb-prompt-content-field')];
        expect(fields.map(field => field.querySelector('.sb-prompt-field-label').textContent)).toEqual(['User Message Prefix', 'User Message Suffix']);
        expect(fields.map(field => field.querySelector('pre').textContent)).toEqual(['### Instruction:', '—']);
        expect(column.querySelector('.editor_maximize')).toBeNull();
    });

    test('preview substitutes macros through the model preview, as a prompt does, and edit shows the raw text', async () => {
        entries.find(candidate => candidate.id === 'tc-user').values.instruct_input_suffix = '{{user}} says:';
        const column = await mountEditor();
        const detail = await openTemplate(column, 'tc-user');
        expect(detail.querySelector('#sb-prompt-tc-instruct_input_suffix').value).toBe('{{user}} says:');
        detail.querySelector('.sb-prompt-mode-toggle').click();
        await flush();
        const fields = [...column.querySelectorAll('.sb-prompt-content--fields > .sb-prompt-content-field')];
        expect(fields.map(field => field.querySelector('pre').textContent)).toEqual(['### Instruction:', 'Bunny says:']);
    });
});
