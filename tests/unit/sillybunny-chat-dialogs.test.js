/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

const openDialog = jest.fn();
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: parts => parts.join('') }));
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/dialog.js', () => ({ openDialog }));
jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu: jest.fn() }));
const { openChatHistoryDialog, openMassDeleteChatDialog } = await import('../../public/scripts/sillybunny-chat-dialogs.js');
const { openActionMenu } = await import('../../public/scripts/sillybunny-action-menu.js');
const { releaseRowIds } = await import('../../public/scripts/sillybunny-editor/rows.js');

const frames = [];

function createFrame(options) {
    const root = document.createElement('section');
    root.className = `sb-dialog ${options.className ?? ''}`;
    const body = document.createElement('div');
    body.className = 'sb-dialog__body';
    const page = document.createElement('section');
    const header = document.createElement('header');
    header.className = 'sb-dialog__header';
    const headerStart = document.createElement('div');
    headerStart.className = 'sb-dialog__header-start';
    const headerEnd = document.createElement('div');
    headerEnd.className = 'sb-dialog__header-end';
    header.append(headerStart, headerEnd);
    page.append(header, body);
    root.append(page);
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
        page,
        header,
        surface: root,
        body,
        search,
        searchInput,
        closed,
        close: jest.fn((response, reason) => resolveClosed({ response, reason })),
        push: jest.fn(spec => {
            const childPage = document.createElement('section');
            childPage.className = spec.className ?? '';
            const childHeader = document.createElement('header');
            childHeader.className = 'sb-dialog__header';
            const childBody = document.createElement('div');
            childBody.className = 'sb-dialog__body';
            if (spec.content) childBody.append(spec.content);
            childPage.append(childHeader, childBody);
            root.append(childPage);
            let resolvePageClosed;
            const pageClosed = new Promise(resolve => { resolvePageClosed = resolve; });
            return { root, page: childPage, closed: pageClosed, resolveClosed: resolvePageClosed };
        }),
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
    const header = document.createElement('div');
    header.setAttribute('name', 'selectChatPopupHeader');
    const help = document.createElement('a');
    help.className = 'notes-link';
    help.href = 'https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/';
    heading.append(help);
    const newChat = document.createElement('button');
    newChat.id = 'newChatFromManageScreenButton';
    const importButton = document.createElement('button');
    importButton.id = 'chat_import_button';
    const backupsButton = document.createElement('button');
    backupsButton.setAttribute('aria-controls', 'chat_backups_list');
    header.append(heading, search, close, newChat, importButton, backupsButton);
    const management = document.createElement('div');
    management.id = 'chat_management_tools';
    const labelGroup = document.createElement('div');
    labelGroup.className = 'chat_label_group';
    for (const id of ['chat_auto_label_current', 'chat_auto_label_dated', 'chat_tools_cancel']) {
        const button = document.createElement('button');
        button.id = id;
        labelGroup.append(button);
    }
    const cleanupGroup = document.createElement('div');
    cleanupGroup.className = 'chat_cleanup_group';
    cleanupGroup.setAttribute('aria-label', 'Chat cleanup tools');
    for (const [id, value] of [['chat_cleanup_age', '90'], ['chat_cleanup_keep', '25']]) {
        const input = document.createElement('input');
        input.id = id;
        input.type = 'number';
        input.min = '0';
        input.max = '9999';
        input.step = '1';
        input.value = value;
        cleanupGroup.append(input);
    }
    const unit = document.createElement('select');
    unit.id = 'chat_cleanup_unit';
    unit.setAttribute('aria-label', 'Cleanup age unit');
    unit.append(new Option('days', 'days'));
    cleanupGroup.append(unit, datedLabel);
    for (const id of ['chat_cleanup_preview', 'chat_cleanup_run']) {
        const button = document.createElement('button');
        button.id = id;
        cleanupGroup.append(button);
    }
    management.append(labelGroup, cleanupGroup);
    const status = document.createElement('div');
    status.id = 'chat_cleanup_status';
    status.setAttribute('aria-live', 'polite');
    popup.append(header, management, status, list);
    legacyHost.append(popup);
    document.body.append(legacyHost);
    return { legacyHost, popup, heading, search, close, datedLabel, dated, list, management, labelGroup, cleanupGroup, status, newChat, importButton, backupsButton };
}

beforeEach(() => {
    openDialog.mockImplementation(createFrame);
});

afterEach(() => {
    for (const frame of frames.splice(0)) frame.root.remove();
    releaseRowIds(document.body);
    document.body.replaceChildren();
    openDialog.mockReset();
    openActionMenu.mockReset();
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
    expect(frame.header.querySelector('.sb-chat-history-new-chat')).not.toBeNull();
    expect(frame.options.subtitle).toBe('');
    source.search.value = 'QA query';
    expect(openChatHistoryDialog()).toBe(frame);
    expect(frame.search.setQuery).toHaveBeenLastCalledWith('QA query', { notify: false });

    frame.header.querySelector('.sb-chat-history-menu').click();
    const cleanupItem = openActionMenu.mock.lastCall[0].sections[0].items.find(item => item.label === 'Chat cleanup tools');
    cleanupItem.onSelect();
    const switchRow = frame.root.querySelector('.chat_cleanup_checkbox');
    expect(switchRow.querySelector('#chat_cleanup_only_dated')).toBe(source.dated);
    expect(source.dated.getAttribute('role')).toBe('switch');
    expect(source.dated.checked).toBe(true);
    expect(frame.root.querySelector('#chat_cleanup_age')).not.toBeNull();
    expect(frame.root.querySelector('#chat_cleanup_unit')).not.toBeNull();
    expect(frame.root.querySelector('#chat_cleanup_keep')).not.toBeNull();
    expect(frame.root.querySelector('#chat_cleanup_preview')).not.toBeNull();
    expect(frame.root.querySelector('#chat_cleanup_run')).not.toBeNull();
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
    expect(source.management.hidden).toBe(false);
    expect(source.labelGroup.parentElement).toBe(source.management);
    expect(source.cleanupGroup.parentElement).toBe(source.management);
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
