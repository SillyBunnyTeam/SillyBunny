/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const translate = jest.fn((text, key) => key ? `translated:${key}` : text);
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate,
}));
await jest.unstable_mockModule('../../public/script.js', () => ({ characters: [{ name: 'Alice' }, { name: 'Bob' }] }));
await jest.unstable_mockModule('../../public/scripts/tags.js', () => ({ tags: [{ id: 'tag-1', name: 'Fantasy' }] }));
await jest.unstable_mockModule('../../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'test-user' }));
const countTokens = jest.fn(async () => 12);
await jest.unstable_mockModule('../../public/scripts/tokenizers.js', () => ({ getTokenCountAsync: countTokens }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu: jest.fn(), closeActionMenu: jest.fn(), isActionMenuOpen: () => false,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateIn: jest.fn(), animateOut: (_node, _frames, finish) => finish(), animateHeightFrom: jest.fn(),
    stopMotion: jest.fn(), prefersReducedMotion: () => true, MOTION_EASE_OUT_QUAD: 'linear', MOTION_FAST: 0, SPRING_SHEET: {},
}));

const { mountWorldInfoEntry, worldInfoDraftKey } = await import('../../public/scripts/sillybunny-world-info-entry.js');
const model = await import('../../public/scripts/sillybunny-world-info-model.js');
const { eventSource, event_types } = await import('../../public/scripts/events.js');
const { createEntryRow } = await import('../../public/scripts/sillybunny-editor/rows.js');
const mounted = [];
let recoveryActions;

function entry(overrides = {}) {
    return {
        uid: 0, comment: 'First entry', key: ['alpha'], keysecondary: [], selective: true,
        content: 'Original content', disable: false, constant: false, vectorized: false,
        position: 0, role: null, order: 100, ...overrides,
    };
}

function mount(options = {}) {
    const host = document.createElement('div');
    const shell = document.createElement('div');
    shell.className = 'sb-list-editor';
    shell.dataset.collapsed = 'false';
    shell.append(host);
    document.body.append(shell);
    const data = options.data ?? { entries: { 0: entry() } };
    const deps = {
        saveWorldInfo: jest.fn(async name => name),
        setOriginal: jest.fn(),
        deleteOriginal: jest.fn(),
        createEntry: jest.fn((_name, data) => {
            const created = entry({ uid: 1 });
            data.entries[1] = created;
            return created;
        }),
        ...options.deps,
    };
    const callbacks = { requestClose: jest.fn(), onSaved: jest.fn(), onStateChange: jest.fn() };
    const controller = mountWorldInfoEntry({ host, name: 'My book', uid: 0, ...callbacks, ...options, data, deps });
    mounted.push(controller);
    return { controller, host, shell, data, deps, ...callbacks };
}

function row(host, id) {
    return host.querySelector(`[data-sb-editor-field="${id}"].ds-row, [data-sb-editor-field="${id}"].sb-wi-entry-filter, [data-sb-editor-field="${id}"].sb-wi-property`);
}

function control(host, id) {
    return row(host, id).querySelector('textarea, input, select') ?? row(host, id).querySelector('button');
}

function edit(host, id, value, type = 'input') {
    const input = control(host, id);
    if (input.matches('.sb-wi-dropdown')) {
        input.click();
        const index = model.FIELD_BY_ID.get(id).options.findIndex(option => option.value === value);
        document.querySelectorAll('.sb-wi-property-option')[index].click();
        return input;
    }
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
    input.dispatchEvent(new Event(type, { bubbles: true }));
    return input;
}

function keydown(target, key, extra = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(event);
    return event;
}

function draftKey(name = 'My book', uid = 0) {
    return `sb-wi-editor-draft-test-user-${encodeURIComponent(name)}-${uid}`;
}

function storedDraft(name, uid) {
    return JSON.parse(localStorage.getItem(draftKey(name, uid)));
}

function backup(harness) {
    window.dispatchEvent(new Event('pagehide'));
    return storedDraft();
}

beforeEach(() => {
    jest.useFakeTimers();
    document.body.replaceChildren();
    localStorage.clear();
    translate.mockClear();
    countTokens.mockClear();
    recoveryActions = new Map();
    global.structuredClone ??= value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    global.CSS = { escape: value => value };
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
    global.toastr = {
        error: jest.fn(), clear: jest.fn(),
        info: jest.fn(() => ({ find: selector => ({ on: (_type, handler) => recoveryActions.set(selector, handler) }) })),
    };
});

afterEach(() => {
    for (const controller of mounted.splice(0)) controller.destroy();
    jest.useRealTimers();
});

describe('World Info schema form', () => {
    test('destroy releases row reservations owned by the entry detail', () => {
        const { host, controller } = mount();
        const marker = createEntryRow({ label: 'Marker', field: 'marker' });
        const nextId = `sb-row-${Number(marker.control.id.split('-').at(-1)) + 1}`;
        const reserved = createEntryRow({ label: 'Reserved', field: 'reserved', id: nextId });
        host.querySelector('.sb-wi-entry').append(reserved.row);
        controller.destroy();
        const next = createEntryRow({ label: 'Next', field: 'next' });
        expect(next.control.id).toBe(nextId);
        marker.destroy();
        next.destroy();
    });

    test('renders every visible schema field, translates runtime keys and leaves expanders collapsed', () => {
        const { host, controller, data } = mount();
        const headerFields = model.FIELDS.filter(field => field.header);
        expect(headerFields.map(field => field.id)).toEqual(['comment']);
        expect(host.querySelector('.sb-wi-entry-title').dataset.sbEditorField).toBe('comment');
        expect(row(host, 'comment')).toBeNull();
        for (const field of model.FIELDS.filter(candidate => !candidate.header && candidate.placement !== 'list')) {
            const fieldRow = row(host, field.id);
            expect(fieldRow).not.toBeNull();
            expect(fieldRow.hidden).toBe(!model.isFieldVisible(data.entries[0], field.id));
            expect(translate).toHaveBeenCalledWith(field.label, field.i18n);
        }
        expect([...host.querySelectorAll('.ds-row-expander')].every(node => !node.open)).toBe(true);
        expect(controller.isDirty()).toBe(false);
        expect(control(host, 'key').placeholder).toBe('translated:Keywords or Regexes');
        expect(control(host, 'position').textContent).toBe('translated:Before Char Defs');
        expect(host.querySelector('.sb-wi-detail-header')).not.toBeNull();
        expect(host.querySelector('.sb-wi-detail-back')).not.toBeNull();
    });

    test('properties follow the header and leave no duplicate body rows or empty cards', () => {
        const { host } = mount();
        const bar = host.querySelector('.sb-wi-entry > .sb-wi-properties');
        expect([...bar.children].map(node => node.dataset.sbEditorField)).toEqual(['strategy', 'position', 'depth', 'outletName', 'order', 'probability']);
        expect(bar.previousElementSibling.classList.contains('sb-wi-property-summary')).toBe(true);
        expect(bar.previousElementSibling.previousElementSibling.classList.contains('sb-wi-entry-header')).toBe(true);
        for (const id of ['enabled', 'strategy', 'position', 'depth', 'outletName', 'order', 'probability', 'section-entry', 'section-insertion']) {
            expect(host.querySelector(`.sb-wi-entry-body [data-sb-editor-field="${id}"]`)).toBeNull();
        }
        expect(host.querySelector('[data-sb-editor-field="enabled"]')).toBeNull();
        expect(Boolean(bar.compareDocumentPosition(host.querySelector('.sb-wi-entry-body')) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    });

    test('bar edits refresh the summary and use explicit save with unchanged metadata', async () => {
        const { host, controller, data, deps } = mount({ data: { entries: { 0: entry({ extension: { untouched: true } }) } } });
        edit(host, 'strategy', 'constant');
        edit(host, 'position', '4:1');
        edit(host, 'depth', '8');
        edit(host, 'order', '250');
        edit(host, 'probability', '45');
        expect(host.querySelector('.sb-wi-property-summary').textContent).toContain('translated:Constant');
        expect(host.querySelector('.sb-wi-property-summary').textContent).toContain('45%');
        expect(controller.isDirty()).toBe(true);
        expect(data.entries[0].position).toBe(0);
        expect(deps.saveWorldInfo).not.toHaveBeenCalled();
        expect(await controller.save()).toBe(true);
        expect(data.entries[0]).toMatchObject({ constant: true, vectorized: false, position: 4, role: 1, depth: 8, order: 250, probability: 45, useProbability: true, extension: { untouched: true } });
        expect(deps.setOriginal).toHaveBeenCalledWith(data, 0, 'extensions.role', 1);
        expect(controller.isDirty()).toBe(false);
    });

    test('sheet edits synchronize existing controls, retain input focus, and Escape closes only the sheet', async () => {
        const { host, controller, requestClose } = mount();
        const summary = host.querySelector('.sb-wi-property-summary');
        summary.getClientRects = () => [{}];
        summary.click();
        const sheet = document.querySelector('.sb-wi-property-sheet');
        const position = control(host, 'position');
        edit(sheet, 'position', '7');
        const outlet = control(sheet, 'outletName');
        outlet.focus();
        edit(sheet, 'outletName', 'sheet-outlet');
        expect(document.activeElement).toBe(outlet);
        expect(control(sheet, 'outletName')).toBe(outlet);
        expect(control(host, 'position')).toBe(position);
        expect(control(host, 'outletName').value).toBe('sheet-outlet');
        expect(summary.textContent).toContain('sheet-outlet');
        expect(controller.isDirty()).toBe(true);
        const outer = jest.fn();
        document.body.addEventListener('keydown', outer);
        const event = keydown(outlet, 'Escape');
        expect(event.defaultPrevented).toBe(true);
        expect(sheet.hidden).toBe(true);
        expect(summary.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(summary);
        expect(outer).not.toHaveBeenCalled();
        expect(requestClose).not.toHaveBeenCalled();
        document.body.removeEventListener('keydown', outer);
        summary.click();
        expect(control(sheet, 'outletName').value).toBe('sheet-outlet');
        controller.destroy();
        expect(document.querySelector('.sb-wi-property-sheet')).toBeNull();
        expect(document.querySelector('.sb-wi-sheet-backdrop')).toBeNull();
    });

    test('discard restores focused bar inputs as well as their sheet counterparts', () => {
        const { host, controller } = mount();
        const order = control(host, 'order');
        order.focus();
        edit(host, 'order', '999');
        controller.discard();
        expect(order.value).toBe('100');
        expect(controller.isDirty()).toBe(false);
    });

    test('expand targets unique textarea IDs and synthetic jQuery write-back reaches save', async () => {
        const first = mount();
        const second = mount({ name: 'Other book' });
        const textarea = control(first.host, 'content');
        const expand = first.host.querySelector('.sb-wi-entry-footer .editor_maximize');
        expect(textarea.id).toMatch(/^sb-/);
        expect(textarea.id).not.toBe(control(second.host, 'content').id);
        expect(expand.dataset.for).toBe(textarea.id);
        expect(expand.getAttribute('aria-label')).toBe('Expand the editor');
        expect(expand.querySelector('.fa-solid.fa-maximize')).not.toBeNull();
        $(textarea).val('Expanded content').trigger('input');
        expect(first.controller.isDirty()).toBe(true);
        first.host.querySelector('.sb-wi-entry-mode-toggle').click();
        expect(expand.hidden).toBe(true);
        first.host.querySelector('.sb-wi-entry-mode-toggle').click();
        expect(expand.hidden).toBe(false);
        expect(await first.controller.save()).toBe(true);
        expect(first.data.entries[0].content).toBe('Expanded content');
    });

    test('UID zero is selectable, read-only and saved through the tracked data object', async () => {
        const { host, controller, data, deps } = mount();
        expect(row(host, 'uid').textContent).toContain('0');
        expect(row(host, 'uid').querySelector('input')).toBeNull();
        edit(host, 'content', 'Changed');
        expect(await controller.save()).toBe(true);
        expect(deps.saveWorldInfo).toHaveBeenCalledWith('My book', data, true);
        expect(data.entries[0].content).toBe('Changed');
    });

    test('header edits comment and uses the key fallback as placeholder', () => {
        const { host, controller } = mount();
        const title = host.querySelector('.sb-wi-entry-title');
        expect(row(host, 'comment')).toBeNull();
        title.value = '';
        title.dispatchEvent(new Event('input'));
        expect(title.placeholder).toBe('alpha');
        title.value = 'New title';
        title.dispatchEvent(new Event('input'));
        expect(title.value).toBe('New title');
        expect(controller.isDirty()).toBe(true);
        expect(controller.focusTarget()).toBe(title);
    });

    test('editing marks dirty without changing the live entry', () => {
        const { host, controller, data, onStateChange } = mount();
        edit(host, 'content', 'Uncommitted');
        expect(controller.isDirty()).toBe(true);
        expect(data.entries[0].content).toBe('Original content');
        expect(host.querySelector('.sb-wi-entry-dirty').hidden).toBe(false);
        expect(host.querySelector('.sb-wi-entry-save').disabled).toBe(false);
        expect(onStateChange).toHaveBeenLastCalledWith({ dirty: true, saving: false });
    });

    test('position/depth/outlet and secondary-key visibility follow the schema', () => {
        const { host } = mount();
        edit(host, 'position', '4:1', 'change');
        expect(row(host, 'depth').hidden).toBe(false);
        expect(row(host, 'outletName').hidden).toBe(true);
        edit(host, 'position', '7', 'change');
        expect(row(host, 'depth').hidden).toBe(true);
        expect(row(host, 'outletName').hidden).toBe(false);
        edit(host, 'keysecondary', 'beta');
        keydown(control(host, 'keysecondary'), 'Enter');
        expect(row(host, 'selectiveLogic').hidden).toBe(false);
    });

    test('numbers use model coercion instead of the generic spin clamp', async () => {
        const { host, controller, data } = mount();
        edit(host, 'order', '-120', 'change');
        edit(host, 'probability', '1000', 'change');
        edit(host, 'scanDepth', '4.7', 'change');
        await controller.save();
        expect(data.entries[0].order).toBe(-120);
        expect(data.entries[0].probability).toBe(100);
        expect(data.entries[0].useProbability).toBe(true);
        expect(data.entries[0].scanDepth).toBe(4);
    });

    test('content preview is safe text and discard resets to Edit', () => {
        const { host, controller } = mount();
        edit(host, 'content', '<img src=x>');
        const preview = host.querySelector('input[type="radio"][value="true"]');
        preview.click();
        const pane = host.querySelector('.sb-wi-entry-preview');
        expect(pane.hidden).toBe(false);
        expect(pane.textContent).toBe('<img src=x>');
        expect(pane.querySelector('img')).toBeNull();
        expect(control(host, 'content').hidden).toBe(true);
        controller.discard();
        expect(pane.hidden).toBe(true);
        expect(control(host, 'content').hidden).toBe(false);
    });

    test('header owns both preview controls, content has one caption, and tokens follow its card', () => {
        const { host, requestClose } = mount();
        const header = host.querySelector('.sb-wi-entry-header');
        expect(header.querySelector('.sb-wi-entry-modes')).not.toBeNull();
        expect(header.querySelector('.sb-wi-entry-mode-toggle').getAttribute('aria-label')).toBe('Preview');
        expect(row(host, 'content').querySelector('.ds-row-label')).toBeNull();
        expect(control(host, 'content').getAttribute('aria-label')).toBe('translated:Content');
        expect(host.querySelector('.sb-wi-entry-footer .sb-wi-entry-tokens')).not.toBeNull();
        header.querySelector('.sb-wi-detail-back').click();
        expect(requestClose).toHaveBeenCalledTimes(1);
        const toggle = header.querySelector('.sb-wi-entry-mode-toggle');
        toggle.click();
        expect(control(host, 'content').hidden).toBe(true);
        expect(toggle.getAttribute('aria-label')).toBe('Edit');
        expect(header.querySelector('input[value="true"]').checked).toBe(true);
        toggle.click();
        expect(control(host, 'content').hidden).toBe(false);
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
    });

    test('token count is debounced and ignores stale responses', async () => {
        let finish;
        countTokens.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const { host } = mount();
        await jest.advanceTimersByTimeAsync(300);
        edit(host, 'content', 'New content');
        await jest.advanceTimersByTimeAsync(300);
        finish(99);
        await Promise.resolve();
        expect(host.querySelector('.sb-wi-entry-tokens').textContent).toBe('12 tokens');
    });
});

describe('explicit save and drafts', () => {
    test('draft keys expose the same encoded user/book prefix for lifecycle cleanup', () => {
        const prefix = 'sb-wi-editor-draft-test-user-Book%20%2F%20%25-';
        expect(worldInfoDraftKey('Book / %')).toBe(prefix);
        expect(worldInfoDraftKey('Book / %', 0)).toBe(`${prefix}0`);
    });

    test('save applies changed keys, mirrors originalData and clears dirty and backup', async () => {
        const harness = mount();
        edit(harness.host, 'content', 'Saved content');
        backup(harness);
        expect(await harness.controller.save()).toBe(true);
        expect(harness.deps.setOriginal).toHaveBeenCalledWith(harness.data, 0, 'content', 'Saved content');
        expect(harness.controller.isDirty()).toBe(false);
        expect(storedDraft()).toBeNull();
        expect(harness.onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: 'My book' }));
        expect(harness.onStateChange).toHaveBeenCalledWith({ dirty: true, saving: true });
    });

    test('a failed list toggle rebases to rolled-back data before an unrelated detail save', async () => {
        const { controller, host, data, deps } = mount();
        edit(host, 'content', 'Unrelated detail edit');
        deps.saveWorldInfo.mockRejectedValueOnce(new Error('Offline'));
        expect((await model.setEnabled(deps, 'My book', data, 0, false)).ok).toBe(false);
        controller.rebaseKey('disable');
        controller.sync({ name: 'My book', data });
        expect(controller.isDirty()).toBe(true);
        expect(await controller.save()).toBe(true);
        expect(data.entries[0]).toMatchObject({ content: 'Unrelated detail edit', disable: false });
        expect(controller.isDirty()).toBe(false);
    });

    test.each([null, new Error('failure')])('failed persistence (%s) keeps dirty and reports an error', async failure => {
        const saveWorldInfo = jest.fn(async () => { if (failure instanceof Error) throw failure; return failure; });
        const { host, controller, onSaved } = mount({ deps: { saveWorldInfo } });
        edit(host, 'content', 'Unsaved');
        expect(await controller.save()).toBe(false);
        expect(controller.isDirty()).toBe(true);
        expect(global.toastr.error).toHaveBeenCalledWith('lorum ipsum');
        expect(onSaved).not.toHaveBeenCalled();
    });

    test.each([null, new Error('failure')])('failed saves roll back submitted keys before discard and an unrelated list save (%s)', async failure => {
        const saveWorldInfo = jest.fn(async () => { if (failure instanceof Error) throw failure; return failure; });
        const setOriginal = jest.fn((data, uid, path, value) => {
            const parts = path.split('.');
            const key = parts.pop();
            const target = parts.reduce((object, part) => object[part] ??= {}, data.originalData.entries.find(entry => entry.id === uid));
            target[key] = structuredClone(value);
        });
        const harness = mount({ deps: { saveWorldInfo, setOriginal } });
        harness.data.originalData = { entries: [{ id: 0, content: 'Live before save', keys: ['alpha'] }] };
        edit(harness.host, 'content', 'Unsaved');
        edit(harness.host, 'key', 'unsaved key');
        keydown(control(harness.host, 'key'), 'Enter');
        edit(harness.host, 'outletName', 'Unsaved outlet');
        harness.data.entries[0].content = 'Live before save';
        harness.data.entries[0].order = 250;
        const before = structuredClone(harness.data.entries[0]);

        expect(await harness.controller.save()).toBe(false);
        expect(harness.data.entries[0]).toEqual(before);
        expect(harness.deps.setOriginal).toHaveBeenCalledWith(harness.data, 0, 'content', 'Live before save');
        expect(harness.deps.setOriginal).toHaveBeenCalledWith(harness.data, 0, 'keys', ['alpha']);
        expect(harness.deps.setOriginal).toHaveBeenLastCalledWith(harness.data, 0, 'extensions.outlet_name', undefined);
        expect(harness.data.originalData.entries[0]).toEqual(expect.objectContaining({
            content: 'Live before save', keys: ['alpha'], extensions: { outlet_name: undefined },
        }));
        harness.controller.discard();
        saveWorldInfo.mockImplementation(async name => name);
        await model.setEnabled(harness.deps, 'My book', harness.data, 0, false);
        expect(harness.data.entries[0]).toEqual({ ...before, disable: true });
        expect(harness.data.originalData.entries[0].content).toBe('Live before save');
    });

    test('failed save rollback preserves later writers and restores deleted nested values', async () => {
        let finish;
        const saveWorldInfo = jest.fn(() => new Promise(resolve => { finish = resolve; }));
        const filter = { names: ['Alice'], tags: ['tag-1'], isExclude: false };
        const harness = mount({ data: { entries: { 0: entry({ characterFilter: filter }) } }, deps: { saveWorldInfo } });
        edit(harness.host, 'content', 'Submitted');
        edit(harness.host, 'characterFilter', false, 'change');
        edit(harness.host, 'key', 'submitted');
        const saving = harness.controller.save();
        await Promise.resolve();
        harness.data.entries[0].content = 'Later writer';
        harness.data.entries[0].key.push('later writer');
        harness.deps.setOriginal.mockClear();
        finish(null);

        expect(await saving).toBe(false);
        expect(harness.data.entries[0].content).toBe('Later writer');
        expect(harness.data.entries[0].key).toEqual(['alpha', 'submitted', 'later writer']);
        expect(harness.data.entries[0].characterFilter).toEqual(filter);
        expect(harness.deps.setOriginal.mock.calls.map(([, , path]) => path)).toEqual(['character_filter']);
        expect(harness.deps.setOriginal).toHaveBeenLastCalledWith(harness.data, 0, 'character_filter', filter);
    });

    test('pending chip text is included in both save and draft capture, with regexes intact', async () => {
        const harness = mount();
        control(harness.host, 'key').value = '/a,b/i';
        const stored = backup(harness);
        expect(stored.snapshot.draft.key).toEqual(['alpha', '/a,b/i']);
        expect(harness.host.querySelector('.sb-wi-entry-regex').textContent).toContain('/a,b/i');
        control(harness.host, 'group').value = 'group1,group2';
        await harness.controller.save();
        expect(harness.data.entries[0].group).toBe('group1, group2');
    });

    test('typing pending chip text enables Save without prematurely committing it', async () => {
        const harness = mount();
        edit(harness.host, 'key', 'still typing');
        expect(control(harness.host, 'key').value).toBe('still typing');
        expect(row(harness.host, 'key').querySelectorAll('.sb-chip')).toHaveLength(1);
        expect(harness.host.querySelector('.sb-wi-entry-save').disabled).toBe(false);
        await harness.controller.save();
        expect(harness.data.entries[0].key).toEqual(['alpha', 'still typing']);
    });

    test('discard restores all field values and removes the backup', () => {
        const harness = mount();
        edit(harness.host, 'content', 'Unsaved');
        edit(harness.host, 'position', '4:0', 'change');
        backup(harness);
        harness.controller.discard();
        expect(control(harness.host, 'content').value).toBe('Original content');
        expect(control(harness.host, 'position').textContent).toBe('translated:Before Char Defs');
        expect(harness.controller.isDirty()).toBe(false);
        expect(storedDraft()).toBeNull();
    });

    test('later edits during a coalesced save stay dirty', async () => {
        let finish;
        const saveWorldInfo = jest.fn(() => new Promise(resolve => { finish = resolve; }));
        const { host, controller } = mount({ deps: { saveWorldInfo } });
        edit(host, 'content', 'Submitted');
        const saving = controller.save();
        expect(controller.save()).toBe(saving);
        await Promise.resolve();
        edit(host, 'content', 'Later edit');
        finish('My book');
        expect(await saving).toBe(false);
        expect(controller.isDirty()).toBe(true);
        expect(control(host, 'content').value).toBe('Later edit');
        expect(storedDraft().snapshot.draft.content).toBe('Later edit');
        controller.discard();
        expect(control(host, 'content').value).toBe('Submitted');
    });

    test('rename re-keys an existing backup without cleaning the draft', async () => {
        const harness = mount();
        edit(harness.host, 'content', 'Unsaved');
        backup(harness);
        await eventSource.emit(event_types.WORLDINFO_RENAMED, 'My book', 'Renamed');
        harness.controller.sync({ name: 'Renamed', data: harness.data });
        expect(storedDraft()).toBeNull();
        expect(storedDraft('Renamed').snapshot.draft.content).toBe('Unsaved');
        expect(harness.controller.isDirty()).toBe(true);
        await harness.controller.save();
        expect(harness.deps.saveWorldInfo).toHaveBeenCalledWith('Renamed', harness.data, true);
    });

    test('canonical commit names are followed for subsequent saves', async () => {
        const harness = mount({ deps: { saveWorldInfo: jest.fn(async () => 'Canonical') } });
        edit(harness.host, 'content', 'One');
        await harness.controller.save();
        edit(harness.host, 'content', 'Two');
        await harness.controller.save();
        expect(harness.deps.saveWorldInfo).toHaveBeenLastCalledWith('Canonical', harness.data, true);
    });

    test('draft restoration is offered only for a matching baseline fingerprint', () => {
        const first = mount();
        edit(first.host, 'content', 'Recovered');
        first.controller.destroy({ keepDraft: true });
        const second = mount();
        expect(global.toastr.info).toHaveBeenCalledTimes(1);
        recoveryActions.get('#sb_draft_restore_btn')();
        expect(control(second.host, 'content').value).toBe('Recovered');
        expect(second.controller.isDirty()).toBe(true);
    });

    test('a reused UID or changed live baseline discards an old backup', () => {
        const first = mount();
        edit(first.host, 'content', 'Recovered');
        first.controller.destroy({ keepDraft: true });
        mount({ data: { entries: { 0: entry({ content: 'Different entry' }) } } });
        expect(global.toastr.info).not.toHaveBeenCalled();
        expect(storedDraft()).toBeNull();
    });

    test('fingerprints ignore object-key order and non-editable imported metadata', () => {
        const first = mount({ data: { entries: { 0: entry({ characterFilter: { names: ['Alice'], tags: ['tag-1'], isExclude: false }, extension: 1 }) } } });
        edit(first.host, 'content', 'Recovered');
        first.controller.destroy({ keepDraft: true });
        mount({ data: { entries: { 0: entry({ extension: 2, characterFilter: { isExclude: false, tags: ['tag-1'], names: ['Alice'] } }) } } });
        expect(global.toastr.info).toHaveBeenCalledTimes(1);
    });

    test('an unchanged clean sync does not erase a backup awaiting recovery', () => {
        const first = mount();
        edit(first.host, 'content', 'Recovered');
        first.controller.destroy({ keepDraft: true });
        const second = mount();
        second.controller.sync({ name: 'My book', data: second.data });
        expect(storedDraft().snapshot.draft.content).toBe('Recovered');
    });

    test('deleting a book removes its draft and prevents future backups or rescue saves', async () => {
        const harness = mount();
        edit(harness.host, 'content', 'Unsaved');
        backup(harness);
        await eventSource.emit(event_types.WORLDINFO_DELETED, 'My book');
        window.dispatchEvent(new Event('pagehide'));
        expect(storedDraft()).toBeNull();
        expect(await harness.controller.save()).toBe(false);
        expect(harness.host.querySelector('.sb-wi-entry-save-as-new').disabled).toBe(true);
    });
});

describe('external changes and character filters', () => {
    test('clean sync silently refreshes from a replacement tracked object', async () => {
        const harness = mount();
        const replacement = { entries: { 0: entry({ content: 'External' }) } };
        harness.controller.sync({ name: 'My book', data: replacement });
        expect(control(harness.host, 'content').value).toBe('External');
        expect(harness.host.querySelector('.sb-wi-entry-banner').hidden).toBe(true);
        edit(harness.host, 'content', 'New');
        await harness.controller.save();
        expect(harness.deps.saveWorldInfo).toHaveBeenCalledWith('My book', replacement, true);
    });

    test('dirty sync shows a conflict banner without losing the draft; Reload adopts the live entry', () => {
        const { host, controller, data } = mount();
        edit(host, 'content', 'Mine');
        data.entries[0].content = 'External';
        controller.sync({ name: 'My book', data });
        expect(control(host, 'content').value).toBe('Mine');
        expect(host.querySelector('.sb-wi-entry-banner[role="status"]').hidden).toBe(false);
        host.querySelector('.sb-wi-entry-reload').click();
        expect(control(host, 'content').value).toBe('External');
        expect(controller.isDirty()).toBe(false);
    });

    test('Keep mine retains edited keys and adopts unrelated external changes', async () => {
        const { host, controller, data } = mount();
        edit(host, 'content', 'Mine');
        data.entries[0].content = 'External';
        data.entries[0].order = 222;
        controller.sync({ name: 'My book', data });
        host.querySelector('.sb-wi-entry-keep-mine').click();
        expect(control(host, 'content').value).toBe('Mine');
        expect(control(host, 'order').value).toBe('222');
        expect(controller.isDirty()).toBe(true);
        expect(host.querySelector('.sb-wi-entry-banner').hidden).toBe(true);
        await controller.save();
        expect(data.entries[0].content).toBe('Mine');
        expect(data.entries[0].order).toBe(222);
    });

    test('a deleted entry disables Save and can be saved as a new entry', async () => {
        const harness = mount();
        edit(harness.host, 'content', 'Rescue me');
        delete harness.data.entries[0];
        harness.controller.sync({ name: 'My book', data: harness.data });
        expect(harness.host.querySelector('.sb-wi-entry-save').disabled).toBe(true);
        expect(await harness.controller.save()).toBe(false);
        harness.host.querySelector('.sb-wi-entry-save-as-new').click();
        await jest.advanceTimersByTimeAsync(0);
        expect(harness.deps.createEntry).toHaveBeenCalledWith('My book', harness.data);
        expect(harness.data.entries[1].content).toBe('Rescue me');
        expect(harness.controller.isDirty()).toBe(false);
        expect(row(harness.host, 'uid').textContent).toContain('1');
    });

    test.each([null, new Error('failure')])('failed Save as new removes its provisional native and originalData entry before retry (%s)', async failure => {
        const harness = mount({ deps: {
            saveWorldInfo: jest.fn(async () => { if (failure instanceof Error) throw failure; return failure; }),
            createEntry: jest.fn((_name, data) => {
                const uid = Math.max(0, ...Object.keys(data.entries).map(Number)) + 1;
                const created = entry({ uid });
                data.entries[uid] = created;
                data.originalData.entries.push({ id: uid });
                return created;
            }),
            deleteOriginal: jest.fn((data, uid) => { data.originalData.entries = data.originalData.entries.filter(entry => entry.id !== uid); }),
        } });
        harness.data.originalData = { entries: [] };
        edit(harness.host, 'content', 'Rescue me');
        delete harness.data.entries[0];
        harness.controller.sync({ name: 'My book', data: harness.data });
        harness.host.querySelector('.sb-wi-entry-save-as-new').click();
        await jest.advanceTimersByTimeAsync(0);
        expect(harness.data.entries).toEqual({});
        expect(harness.data.originalData.entries).toEqual([]);
        expect(harness.deps.deleteOriginal).toHaveBeenCalledWith(harness.data, 1);
        expect(harness.controller.isDirty()).toBe(true);
        harness.deps.saveWorldInfo.mockImplementation(async name => name);
        harness.host.querySelector('.sb-wi-entry-save-as-new').click();
        await jest.advanceTimersByTimeAsync(0);
        expect(Object.keys(harness.data.entries)).toEqual(['1']);
        expect(harness.data.entries[1].content).toBe('Rescue me');
        expect(harness.data.originalData.entries).toEqual([{ id: 1 }]);
        expect(harness.controller.isDirty()).toBe(false);
    });

    test('list enable rebase preserves other dirty fields and is not saved again', async () => {
        const harness = mount();
        edit(harness.host, 'content', 'Mine');
        harness.data.entries[0].disable = true;
        harness.controller.rebaseKey('disable');
        expect(harness.controller.isDirty()).toBe(true);
        expect(row(harness.host, 'enabled')).toBeNull();
        expect(harness.data.entries[0].disable).toBe(true);
        expect(control(harness.host, 'content').value).toBe('Mine');
        await harness.controller.save();
        expect(harness.deps.setOriginal).not.toHaveBeenCalledWith(harness.data, 0, 'enabled', expect.anything());
    });

    test('character-filter switch round-trips names, tag IDs and exclusion losslessly', async () => {
        const harness = mount({ data: { entries: { 0: entry({ characterFilter: { names: ['Alice'], tags: ['tag-1'], isExclude: true } }) } } });
        const names = control(harness.host, 'characterFilterNames');
        names.focus();
        expect([...names.list.options].map(option => option.value)).toEqual(['Alice', 'Bob']);
        expect(row(harness.host, 'characterFilterTags').textContent).toContain('Fantasy');
        edit(harness.host, 'characterFilter', false, 'change');
        expect(harness.host.querySelector('.sb-wi-entry-filter-children').hidden).toBe(true);
        edit(harness.host, 'characterFilter', true, 'change');
        expect(harness.host.querySelector('.sb-wi-entry-filter-children').hidden).toBe(false);
        expect(harness.controller.isDirty()).toBe(false);
        edit(harness.host, 'content', 'Save filter');
        await harness.controller.save();
        expect(harness.data.entries[0].characterFilter).toEqual({ names: ['Alice'], tags: ['tag-1'], isExclude: true });
    });

    test('a blank character filter can be enabled and new tag suggestions store IDs', async () => {
        const harness = mount();
        edit(harness.host, 'characterFilter', true, 'change');
        expect(harness.host.querySelector('.sb-wi-entry-filter-children').hidden).toBe(false);
        const input = control(harness.host, 'characterFilterTags');
        input.focus();
        input.value = 'Fantasy';
        input.dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText' }));
        await harness.controller.save();
        expect(harness.data.entries[0].characterFilter).toEqual({ names: [], tags: ['tag-1'], isExclude: false });
    });
});

describe('keyboard and disposal', () => {
    test.each([{ ctrlKey: true }, { metaKey: true }])('Ctrl/Cmd+S saves and does not bubble (%j)', async modifier => {
        const { host, deps } = mount();
        edit(host, 'content', 'Shortcut');
        const outer = jest.fn();
        document.body.addEventListener('keydown', outer, { once: true });
        const event = keydown(control(host, 'content'), 's', modifier);
        await jest.advanceTimersByTimeAsync(0);
        expect(event.defaultPrevented).toBe(true);
        expect(outer).not.toHaveBeenCalled();
        expect(deps.saveWorldInfo).toHaveBeenCalledTimes(1);
        document.body.removeEventListener('keydown', outer);
    });

    test('Escape in a field blurs, outside a field requests close, and neither bubbles', () => {
        const { host, requestClose } = mount();
        const outer = jest.fn();
        document.body.addEventListener('keydown', outer);
        const textarea = control(host, 'content');
        textarea.focus();
        keydown(textarea, 'Escape');
        expect(document.activeElement).not.toBe(textarea);
        expect(requestClose).not.toHaveBeenCalled();
        keydown(host.querySelector('.sb-wi-entry'), 'Escape');
        expect(requestClose).toHaveBeenCalledTimes(1);
        expect(outer).not.toHaveBeenCalled();
        document.body.removeEventListener('keydown', outer);
    });

    test('Escape in a pending chip field blurs without throwing away the typed keyword', () => {
        const { host, controller, requestClose } = mount();
        const input = edit(host, 'key', 'pending');
        input.focus();
        keydown(input, 'Escape');
        expect(document.activeElement).not.toBe(input);
        expect(row(host, 'key').textContent).toContain('pending');
        expect(controller.isDirty()).toBe(true);
        expect(requestClose).not.toHaveBeenCalled();
    });

    test('destroy keeps an outgoing draft only when requested and removes listeners and DOM', async () => {
        const harness = mount();
        edit(harness.host, 'content', 'Keep me');
        harness.controller.destroy({ keepDraft: true });
        expect(storedDraft().snapshot.draft.content).toBe('Keep me');
        expect(harness.host.children).toHaveLength(0);
        expect(harness.controller.focusTarget()).toBeNull();
        await eventSource.emit(event_types.WORLDINFO_DELETED, 'My book');
        expect(storedDraft()).not.toBeNull();
        expect(jest.getTimerCount()).toBe(0);
        expect(await harness.controller.save()).toBe(false);
    });
});
