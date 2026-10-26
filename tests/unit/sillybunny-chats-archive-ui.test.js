/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: text => text,
}));
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({ Popup: class {}, POPUP_TYPE: {}, POPUP_RESULT: {} }));

const archive = '../../public/scripts/extensions/sillybunny-chats-archive/src';
const { parseChatJsonl } = await import(`${archive}/core.js`);
const { cancelViewer } = await import(`${archive}/ui/cancellation.js`);
const { organizationFocusKey, markOrganizationControl, preserveArchiveFocus } = await import(`${archive}/ui/focus.js`);
const { buildMessagesGroup, buildRawOnlyGroup } = await import(`${archive}/ui/messages.js`);
const { bindSearchField, closeMentionsOnEscape } = await import(`${archive}/ui/search.js`);
const { MESSAGE_PAGE_SIZE, RAW_PREVIEW_CHARS } = await import(`${archive}/ui/constants.js`);

const ctx = {
    translate: text => text,
    timestampToMoment: value => ({ isValid: () => true, format: () => `formatted ${value}` }),
};
// jsdom does not lay out, so it has no scrollIntoView.
Element.prototype.scrollIntoView = jest.fn();
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => {
    document.body.replaceChildren();
    jest.useRealTimers();
});

function chat(count, { header = { chat_metadata: { note: 'kept' } }, mutate } = {}) {
    const lines = header ? [JSON.stringify(header)] : [];
    for (let index = 0; index < count; index++) {
        const record = { name: index % 2 ? 'You' : 'Alice', is_user: index % 2 === 1, send_date: `October ${1 + index % 27}, 2026`, mes: `Message ${index + 1}` };
        lines.push(JSON.stringify(mutate?.(record, index) ?? record));
    }
    return lines.join('\n');
}

async function messagesGroup(raw, state = { deepRows: null, deepQuery: '' }) {
    const shaped = await parseChatJsonl(raw);
    const group = buildMessagesGroup(ctx, state, { raw, shaped });
    document.body.append(group.section);
    return { group, shaped };
}

const cards = () => [...document.querySelectorAll('.sbca-msg')];
const button = name => [...document.querySelectorAll('button, summary')].find(node => node.textContent.trim() === name);

describe('focus survives a rerender', () => {
    function layout() {
        const ui = {
            root: document.createElement('div'),
            list: document.createElement('div'),
            listHeading: document.createElement('h3'),
            viewerContent: document.createElement('div'),
        };
        for (const node of [ui.listHeading, ui.viewerContent]) node.tabIndex = -1;
        ui.root.append(ui.listHeading, ui.list, ui.viewerContent);
        document.body.append(ui.root);
        return ui;
    }

    function control(ui, parent, key, fallback = '') {
        const node = document.createElement('button');
        markOrganizationControl(node, key, fallback);
        parent.append(node);
        return node;
    }

    test('a rebuilt control with the same key takes the focus back', () => {
        const ui = layout();
        const key = organizationFocusKey('manager', 'folders', 'f1', 'rename');
        control(ui, ui.root, key).focus();
        preserveArchiveFocus(ui, () => {
            ui.root.querySelector('[data-sbca-focus-key]').remove();
            control(ui, ui.root, key);
        });
        expect(document.activeElement).toBe(ui.root.querySelector('[data-sbca-focus-key]'));
    });

    test('a control that is gone hands the focus to the one named as its fallback', () => {
        const ui = layout();
        const fallbackKey = organizationFocusKey('manager', 'folders', 'create');
        const create = control(ui, ui.root, fallbackKey);
        const doomed = control(ui, ui.root, organizationFocusKey('manager', 'folders', 'f1', 'delete'), fallbackKey);
        doomed.focus();
        preserveArchiveFocus(ui, () => doomed.remove());
        expect(document.activeElement).toBe(create);
    });

    test('with no keyed control left, the open chat or the list heading gets the focus', () => {
        const ui = layout();
        const inViewer = document.createElement('button');
        ui.viewerContent.append(inViewer);
        inViewer.focus();
        preserveArchiveFocus(ui, () => inViewer.remove());
        expect(document.activeElement).toBe(ui.viewerContent);

        const row = document.createElement('div');
        row.tabIndex = 0;
        ui.list.append(row);
        row.focus();
        preserveArchiveFocus(ui, () => row.remove());
        expect(document.activeElement).toBe(ui.listHeading);
    });

    test('focus outside the archive is never taken', () => {
        const ui = layout();
        const outside = document.createElement('button');
        document.body.append(outside);
        outside.focus();
        preserveArchiveFocus(ui, () => control(ui, ui.root, 'k'));
        expect(document.activeElement).toBe(outside);
    });

    test('focus that stays connected is left where it is', () => {
        const ui = layout();
        const kept = control(ui, ui.root, 'kept');
        control(ui, ui.root, 'other');
        kept.focus();
        preserveArchiveFocus(ui, () => ui.root.querySelectorAll('[data-sbca-focus-key]')[1].remove());
        expect(document.activeElement).toBe(kept);
    });
});

describe('cancelling the open chat', () => {
    test('aborts the load without forgetting it, so a late result can still be recognised as stale', () => {
        const controller = new AbortController();
        const state = { viewerAbort: controller };
        cancelViewer(state);
        expect(controller.signal.aborted).toBe(true);
        expect(state.viewerAbort).toBe(controller);
    });
});

describe('search field keys', () => {
    function mount() {
        const field = document.createElement('div');
        field.className = 'sb-dialog__search';
        const input = document.createElement('input');
        field.append(input);
        const menu = document.createElement('div');
        menu.hidden = true;
        document.body.append(field);
        const ui = { search: input, mentionMenu: menu, mentionIndex: -1, queryTimer: null, characterMentions: [] };
        const cleanup = bindSearchField(ctx, {}, ui);
        return { ui, input, menu, cleanup };
    }

    function press(input, key, init = {}) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
        input.dispatchEvent(event);
        return event;
    }

    test('Enter while an IME composes leaves the pending content search alone', () => {
        const { ui, input } = mount();
        ui.queryTimer = setTimeout(() => {}, 10_000);
        const composing = press(input, 'Enter', { isComposing: true });
        expect(composing.defaultPrevented).toBe(false);
        expect(ui.queryTimer).not.toBeNull();
        const plain = press(input, 'Enter');
        expect(plain.defaultPrevented).toBe(true);
        expect(ui.queryTimer).toBeNull();
    });

    test('arrows move through the mention options and Enter picks the active one', () => {
        const { input, menu } = mount();
        const picked = [];
        ['Alice', 'Bob'].forEach((name, index) => {
            const option = document.createElement('button');
            option.className = 'sbca-mention-option';
            option.id = `option-${index}`;
            option.addEventListener('click', () => picked.push(name));
            menu.append(option);
        });
        menu.hidden = false;
        press(input, 'ArrowUp');
        expect(input.getAttribute('aria-activedescendant')).toBe('option-1');
        press(input, 'ArrowDown');
        expect(input.getAttribute('aria-activedescendant')).toBe('option-0');
        press(input, 'Enter');
        expect(picked).toEqual(['Alice']);
    });

    test('Escape closes an open mention menu first and reports it handled', () => {
        const { ui, input, menu } = mount();
        expect(closeMentionsOnEscape(ui)).toBe(false);
        menu.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        expect(closeMentionsOnEscape(ui)).toBe(true);
        expect(menu.hidden).toBe(true);
        expect(input.getAttribute('aria-expanded')).toBe('false');
    });

    test('the cleanup stops the listeners', () => {
        const { ui, input, cleanup } = mount();
        ui.queryTimer = setTimeout(() => {}, 10_000);
        cleanup();
        press(input, 'Enter');
        expect(ui.queryTimer).not.toBeNull();
    });
});

describe('Messages group', () => {
    test('a long chat opens on its first page, pages forward, and jumps to the latest messages', async () => {
        await messagesGroup(chat(250));
        expect(MESSAGE_PAGE_SIZE).toBe(100);
        const list = document.querySelector('.sbca-message-list');
        expect(list.getAttribute('role')).toBe('list');
        expect(list.getAttribute('aria-label')).toBe('Chat Messages');
        expect(cards()).toHaveLength(100);
        expect(cards()[0].textContent).toContain('Message 1');
        expect(button('Show 100 More Messages')).toBeDefined();
        expect(button('Show 100 Earlier Messages')).toBeUndefined();

        button('Show 100 More Messages').click();
        expect(cards()).toHaveLength(100);
        expect(cards()[0].textContent).toContain('Message 101');
        expect(button('Show 100 Earlier Messages')).toBeDefined();
        expect(document.activeElement).toBe(cards()[0]);

        button('Latest Messages').click();
        expect(cards()).toHaveLength(100);
        expect(cards().at(-1).textContent).toContain('Message 250');
        expect(button('Show 100 More Messages')).toBeUndefined();
        expect(document.activeElement).toBe(cards()[0]);
    });

    test('a short chat has no paging and no Latest Messages button', async () => {
        await messagesGroup(chat(5));
        expect(cards()).toHaveLength(5);
        expect(button('Latest Messages')).toBeUndefined();
        expect(document.querySelector('.sbca-pager')).toBeNull();
    });

    test('authors keep their role label and date, and swipes and extra data open lazily', async () => {
        await messagesGroup(chat(6, {
            mutate: (record, index) => (index === 2
                ? { ...record, swipes: ['a', 'b'], extra: { model: 'x' } }
                : index === 3 ? { ...record, is_system: true, name: 'Narrator' } : record),
        }));
        expect(cards()[0].querySelector('time').textContent).toBe('formatted October 1, 2026');
        expect(cards()[1].querySelector('.sbca-role')).toBeNull();
        expect(cards()[3].dataset.sbcaRole).toBe('system');
        expect(cards()[3].querySelector('.sbca-role').textContent).toBe('System');
        expect(cards()[2].textContent).toContain('2 response alternatives');
        const details = cards()[2].querySelectorAll('details');
        expect([...details].map(node => node.querySelector('summary').textContent)).toEqual(['Response Alternatives', 'Extension Data']);
        expect(cards()[2].querySelector('.sbca-json')).toBeNull();
        details[1].open = true;
        await settle();
        expect(JSON.parse(details[1].querySelector('.sbca-json').textContent)).toEqual({ model: 'x' });
    });

    test('a search match opens its page, is marked and named, and takes the focus', async () => {
        const state = { deepRows: [], deepQuery: '150' };
        const { group } = await messagesGroup(chat(250), state);
        expect(cards()[0].textContent).toContain('Message 101');
        const marked = document.querySelectorAll('.sbca-msg-match');
        expect(marked).toHaveLength(1);
        expect(marked[0].textContent).toContain('Message 150');
        expect(marked[0].querySelector('.sbca-match-label').textContent).toBe('First search match');
        group.focusMatch();
        expect(document.activeElement).toBe(marked[0]);
    });

    test('a chat with no search never marks a message', async () => {
        await messagesGroup(chat(120));
        expect(document.querySelector('.sbca-msg-match')).toBeNull();
    });

    test('an empty chat says so and offers nothing to page', async () => {
        await messagesGroup(chat(0));
        expect(cards()).toHaveLength(0);
        expect(document.body.textContent).toContain('This chat is empty.');
        expect(document.querySelector('.sbca-pager')).toBeNull();
    });

    test('Show Raw File swaps the messages for the raw text and back', async () => {
        const raw = chat(3);
        await messagesGroup(raw);
        const toggle = button('Show Raw File');
        const view = document.querySelector('.sbca-raw');
        expect(view.hidden).toBe(true);
        expect(toggle.getAttribute('aria-controls')).toBe(view.id);
        toggle.click();
        expect(view.hidden).toBe(false);
        expect(view.textContent).toBe(raw);
        expect(document.querySelector('.sbca-messages').hidden).toBe(true);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(toggle.textContent).toBe('Show Messages');
        toggle.click();
        expect(view.hidden).toBe(true);
        expect(document.querySelector('.sbca-messages').hidden).toBe(false);
    });

    test('a raw file past the preview limit is cut and says how to get the rest', async () => {
        const raw = chat(2, { mutate: (record, index) => ({ ...record, mes: index === 0 ? 'x'.repeat(RAW_PREVIEW_CHARS) : record.mes }) });
        await messagesGroup(raw);
        button('Show Raw File').click();
        const text = document.querySelector('.sbca-raw').textContent;
        expect(text.startsWith(raw.slice(0, RAW_PREVIEW_CHARS))).toBe(true);
        expect(text.length).toBeLessThan(raw.length);
        expect(text.endsWith('Raw preview truncated. Download the original file to inspect the rest.')).toBe(true);
    });

    test('chat metadata is an expander that renders its JSON on first open only', async () => {
        await messagesGroup(chat(2));
        const metadata = [...document.querySelectorAll('.sbca-messages-group > details')].find(node => node.textContent.includes('Chat Metadata'));
        expect(metadata.querySelector('.sbca-json')).toBeNull();
        metadata.open = true;
        await settle();
        metadata.open = false;
        metadata.open = true;
        await settle();
        expect(metadata.querySelectorAll('.sbca-json')).toHaveLength(1);
        expect(JSON.parse(metadata.querySelector('.sbca-json').textContent)).toEqual({ note: 'kept' });
    });

    test('a chat without metadata has no metadata expander', async () => {
        await messagesGroup(chat(2, { header: null }));
        expect(document.querySelector('.sbca-messages-group > details')).toBeNull();
    });

    test('a file that cannot be parsed shows a warning and the raw text behind its toggle', () => {
        const raw = '{"chat_metadata": {}}\n{this is not json';
        const { section } = buildRawOnlyGroup(ctx, raw);
        document.body.append(section);
        const warning = section.querySelector('[role="alert"]');
        expect(warning.textContent).toContain('This file contains invalid JSONL. You can still download or inspect the original file.');
        const toggle = button('Show Raw File');
        const view = section.querySelector('.sbca-raw');
        expect(view.hidden).toBe(true);
        toggle.click();
        expect(view.textContent).toBe(raw);
        expect(toggle.textContent).toBe('Hide Raw File');
        expect(section.querySelector('.sbca-message-list')).toBeNull();
    });
});
