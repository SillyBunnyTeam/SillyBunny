/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

const openDialog = jest.fn();
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: parts => parts.join('') }));
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/dialog.js', () => ({ openDialog }));
const { openChatHistoryDialog, openMassDeleteChatDialog } = await import('../../public/scripts/sillybunny-chat-dialogs.js');
const { releaseRowIds } = await import('../../public/scripts/sillybunny-editor/rows.js');

const frames = [];

function createFrame(options) {
    const root = document.createElement('section');
    root.className = `sb-dialog ${options.className ?? ''}`;
    const body = document.createElement('div');
    root.append(body);
    if (options.content) body.append(options.content);
    document.body.append(root);

    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    let query = '';
    const searchInput = document.createElement('input');
    const search = {
        setQuery: jest.fn((value, { notify = true } = {}) => {
            searchInput.value = value;
            query = value;
            return notify;
        }),
        get query() { return query; },
    };
    const frame = {
        options,
        root,
        body,
        search,
        searchInput,
        closed,
        close: jest.fn((response, reason) => resolveClosed({ response, reason })),
        setResponseEnabled: jest.fn(),
        resolveClosed,
    };
    frames.push(frame);
    return frame;
}

function historyMarkup() {
    const legacyHost = document.createElement('div');
    legacyHost.id = 'shadow_select_chat_popup';
    legacyHost.style.display = 'none';

    const popup = document.createElement('div');
    popup.id = 'select_chat_popup';
    const heading = document.createElement('h3');
    heading.id = 'selectChatPopupHeaderText';
    heading.textContent = 'Chat History';
    const search = document.createElement('input');
    search.id = 'select_chat_search';
    search.placeholder = 'Search...';
    const close = document.createElement('button');
    close.id = 'select_chat_cross';
    const datedLabel = document.createElement('label');
    datedLabel.title = 'Dated only';
    const datedText = document.createElement('span');
    datedText.dataset.i18n = 'Dated only';
    datedText.textContent = 'Dated only';
    const dated = document.createElement('input');
    dated.id = 'chat_cleanup_only_dated';
    dated.type = 'checkbox';
    dated.checked = true;
    datedLabel.append(datedText, dated);
    const list = document.createElement('div');
    list.id = 'select_chat_div';
    popup.append(heading, search, close, datedLabel, list);
    legacyHost.append(popup);
    document.body.append(legacyHost);
    return { legacyHost, popup, heading, search, close, datedLabel, dated, list };
}

beforeEach(() => {
    openDialog.mockImplementation(createFrame);
});

afterEach(() => {
    for (const frame of frames.splice(0)) frame.root.remove();
    releaseRowIds(document.body);
    document.body.replaceChildren();
    openDialog.mockReset();
});

test('mass delete keeps live checkbox values, current-chat protection and dialog response state', async () => {
    const files = Array.from({ length: 7 }, (_, index) => ({
        fileName: `chat-${index}.jsonl`,
        lastMessage: index,
        chatItems: index + 1,
    }));
    const getOlderCount = jest.fn(days => Number(days) >= 90 ? 2 : 1);
    const formatChatTimestamp = jest.fn(timestamp => `time-${timestamp}`);
    const resultPromise = openMassDeleteChatDialog(files, 'chat-0.jsonl', { getOlderCount, formatChatTimestamp });
    const frame = frames[0];
    const checkboxes = [...frame.root.querySelectorAll('.sb-chat-delete-row input[type="checkbox"]')];
    const selectAll = frame.root.querySelector('[data-sb-editor-field="mass-delete-select-all"] input');

    expect(frame.options).toMatchObject({ tier: 'window', title: 'Mass delete chats', className: 'sb-chat-mass-delete' });
    expect(frame.options.responses.cancel.label).toBe('Cancel');
    expect(frame.options.responses.affirmative).toMatchObject({ id: 'delete-selected', appearance: 'destructive', enabled: false });
    expect(frame.options.responses.extra[0]).toMatchObject({ id: 'delete-older', enabled: false });
    expect(frame.root.querySelectorAll('.sb-chat-delete-row')).toHaveLength(7);
    expect(checkboxes.map(input => input.value)).toEqual(files.map(file => file.fileName));
    expect(checkboxes[0].disabled).toBe(true);
    expect(selectAll).not.toBeNull();
    expect(frame.root.querySelector('.sb-chat-delete-status').textContent).toBe('0 selected. 1 older than 30 day(s).');
    expect(formatChatTimestamp).toHaveBeenCalledTimes(7);

    checkboxes[1].click();
    expect(frame.root.querySelector('.sb-chat-delete-status').textContent).toBe('1 selected. 1 older than 30 day(s).');
    expect(frame.setResponseEnabled).toHaveBeenCalledWith('delete-selected', true);
    selectAll.click();
    expect(checkboxes.slice(1).every(input => input.checked)).toBe(true);
    expect(selectAll.checked).toBe(true);

    frame.resolveClosed({ response: 'delete-selected' });
    await expect(resultPromise).resolves.toEqual({ mode: 'selected', names: files.slice(1).map(file => file.fileName) });
});

test('mass delete omits Select All at five choices and returns the unchanged age value', async () => {
    const files = Array.from({ length: 5 }, (_, index) => ({ fileName: `chat-${index}`, lastMessage: index }));
    const resultPromise = openMassDeleteChatDialog(files, 'chat-0', {
        getOlderCount: () => 1,
        formatChatTimestamp: timestamp => String(timestamp),
    });
    const frame = frames[0];
    const ageInput = frame.root.querySelector('[data-sb-editor-field="mass-delete-age"] input');
    ageInput.value = '180';
    ageInput.dispatchEvent(new Event('input', { bubbles: true }));

    expect(frame.root.querySelector('[data-sb-editor-field="mass-delete-select-all"]')).toBeNull();
    expect(frame.root.querySelector('.sb-chat-delete-status').textContent).toBe('0 selected. 1 older than 180 day(s).');
    frame.resolveClosed({ response: 'delete-older' });
    await expect(resultPromise).resolves.toEqual({ mode: 'older', days: 180 });
});

test('Chat History moves the source nodes, proxies frame search and restores its compatibility host', async () => {
    const source = historyMarkup();
    const searchEvents = jest.fn();
    source.search.addEventListener('input', searchEvents);
    const frame = openChatHistoryDialog();

    expect(openChatHistoryDialog()).toBe(frame);
    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(frame.options).toMatchObject({ tier: 'window', title: 'Chat History', className: 'sb-chat-history-dialog' });
    expect(frame.options.content).toBe(source.popup);
    expect(source.search).toBe(frame.root.querySelector('#select_chat_search'));
    expect(source.heading.hidden).toBe(true);
    expect(source.search.hidden).toBe(true);
    expect(source.close.hidden).toBe(true);
    expect(source.legacyHost.classList.contains('sb-chat-history-compat-open')).toBe(true);
    source.search.value = 'QA query';
    expect(openChatHistoryDialog()).toBe(frame);
    expect(frame.search.setQuery).toHaveBeenLastCalledWith('QA query', { notify: false });

    const switchRow = frame.root.querySelector('.chat_cleanup_checkbox');
    expect(switchRow.querySelector('#chat_cleanup_only_dated')).toBe(source.dated);
    expect(source.dated.getAttribute('role')).toBe('switch');
    expect(source.dated.checked).toBe(true);
    frame.options.search.onChange('history query');
    expect(source.search.value).toBe('history query');
    expect(searchEvents).toHaveBeenCalledTimes(1);

    frame.search.setQuery('history query', { notify: false });
    source.search.value = '';
    source.list.append(document.createElement('div'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(frame.search.query).toBe('');
    expect(frame.searchInput.value).toBe('');

    source.close.click();
    await frame.closed;
    await Promise.resolve();
    expect(frame.close).toHaveBeenCalledWith('close', 'close');
    expect(source.popup.parentElement).toBe(source.legacyHost);
    expect(source.legacyHost.style.display).toBe('none');
    expect(source.legacyHost.classList.contains('sb-chat-history-compat-open')).toBe(false);
    expect(source.heading.hidden).toBe(false);
    expect(source.search.hidden).toBe(false);
    expect(source.close.hidden).toBe(false);
});

test('Chat History closes when an upstream flow hides its compatibility wrapper', async () => {
    const source = historyMarkup();
    const frame = openChatHistoryDialog();
    source.legacyHost.style.display = 'none';
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(frame.close).toHaveBeenCalledWith('close', 'legacy-host-hidden');
    await frame.closed;
    await Promise.resolve();
    expect(source.legacyHost.style.display).toBe('none');
    expect(source.popup.parentElement).toBe(source.legacyHost);
});

test('Chat History reports incomplete required markup instead of silently returning', () => {
    expect(() => openChatHistoryDialog()).toThrow('Chat History markup is incomplete');
});
