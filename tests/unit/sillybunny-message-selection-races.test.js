/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom uses synchronous DOM assertions. */
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const confirmDestructiveAction = jest.fn();
const loadStylesheetAsync = jest.fn();
const deleteMessage = jest.fn();
const removeRenderedMessagesFrom = jest.fn();
const saveChatConditional = jest.fn();
const showSwipeButtons = jest.fn();
const deleteItemizedPromptForMessage = jest.fn();
const emitEvent = jest.fn();

const chat = [];
const chatMetadata = {};
let chatDomElement;

const chatElement = {
    get 0() {
        return chatDomElement;
    },
    scrollTop: jest.fn(),
    find(selector) {
        const nodes = [...(chatDomElement?.querySelectorAll(selector) ?? [])];
        return {
            removeClass: (cls) => {
                nodes.forEach(node => node.classList.remove(cls));
            },
            last: () => ({
                addClass: (cls) => {
                    nodes.at(-1)?.classList.add(cls);
                },
            }),
        };
    },
};

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
    translate: value => value,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-delete-confirm.js', () => ({
    confirmDestructiveAction,
}));
await jest.unstable_mockModule('../../public/scripts/dynamic-styles.js', () => ({
    loadStylesheetAsync,
}));
await jest.unstable_mockModule('../../public/scripts/events.js', () => ({
    eventSource: { emit: emitEvent },
    event_types: { MESSAGE_DELETED: 'message_deleted' },
}));
await jest.unstable_mockModule('../../public/scripts/itemized-prompts.js', () => ({
    deleteItemizedPromptForMessage,
}));
await jest.unstable_mockModule('../../public/script.js', () => ({
    chat,
    chat_metadata: chatMetadata,
    chatElement,
    deleteMessage,
    removeRenderedMessagesFrom,
    saveChatConditional,
    showSwipeButtons,
}));

const { createMessageSelection } = await import('../../public/scripts/sillybunny-editor/message-selection.js');
const {
    cancelMessageSelection,
    isMessageSelectionActive,
    openMessageSelection,
} = await import('../../public/scripts/sillybunny-message-selection.js');

beforeEach(() => {
    jest.clearAllMocks();
    document.body.replaceChildren();
    chat.length = 0;
    for (const key of Object.keys(chatMetadata)) {
        delete chatMetadata[key];
    }
    loadStylesheetAsync.mockResolvedValue();
    saveChatConditional.mockResolvedValue();
    emitEvent.mockResolvedValue();
    deleteMessage.mockResolvedValue();
});

afterEach(() => {
    cancelMessageSelection();
    document.body.replaceChildren();
});

describe('createMessageSelection confirm dialog races', () => {
    function buildFixture({ isStale = () => false, onDelete = jest.fn() } = {}) {
        const root = document.createElement('div');
        const header = document.createElement('div');
        const list = document.createElement('div');
        const actionBar = document.createElement('div');
        for (const key of ['m1', 'm2']) {
            const row = document.createElement('div');
            row.className = 'msg';
            row.dataset.id = key;
            row.textContent = key;
            list.append(row);
        }
        root.append(header, list, actionBar);
        document.body.append(root);
        const selection = createMessageSelection({
            root,
            list,
            rowSelector: '.msg',
            getKey: row => row.dataset.id ?? null,
            rowLabel: row => row.textContent ?? '',
            header,
            actionBar,
            isStale,
            onDelete,
        });
        return { root, list, actionBar, selection, onDelete };
    }

    test('does not delete when selection exited while the confirmation dialog was open', async () => {
        let resolveConfirm;
        confirmDestructiveAction.mockReturnValueOnce(new Promise((resolve) => {
            resolveConfirm = resolve;
        }));
        const { actionBar, selection, onDelete } = buildFixture();
        selection.enter('m1');

        actionBar.querySelector('[data-action-id="delete"]').click();
        selection.exit();
        resolveConfirm(true);
        await Promise.resolve();
        await Promise.resolve();

        expect(onDelete).not.toHaveBeenCalled();
        selection.destroy();
    });

    test('exits without deleting when isStale becomes true while the confirmation dialog was open', async () => {
        let stale = false;
        let resolveConfirm;
        confirmDestructiveAction.mockReturnValueOnce(new Promise((resolve) => {
            resolveConfirm = resolve;
        }));
        const { actionBar, selection, onDelete } = buildFixture({ isStale: () => stale });
        selection.enter('m1');

        actionBar.querySelector('[data-action-id="delete"]').click();
        stale = true;
        resolveConfirm(true);
        await Promise.resolve();
        await Promise.resolve();

        expect(selection.isActive).toBe(false);
        expect(onDelete).not.toHaveBeenCalled();
        selection.destroy();
    });
});

describe('roleplay message selection async races and window controls', () => {
    function mountRoleplayDom(messageCount) {
        document.body.innerHTML = `
            <div id="sheld">
                <div id="chat"></div>
                <div id="form_sheld">
                    <div id="dialogue_del_mes"></div>
                </div>
            </div>
        `;
        chatDomElement = document.getElementById('chat');
        for (let index = 0; index < messageCount; index++) {
            chat.push({ is_user: index % 2 === 0, is_system: false, mes: `Message ${index}` });
            const row = document.createElement('div');
            row.className = 'mes';
            row.setAttribute('mesid', String(index));
            row.setAttribute('ch_name', 'Nova');
            row.innerHTML = `<div class="mes_text">Message ${index}</div>`;
            chatDomElement.append(row);
        }
    }

    test('does not enter selection mode when isStillWanted turns false during async stylesheet load', async () => {
        mountRoleplayDom(2);
        let releaseSheet;
        loadStylesheetAsync.mockReturnValueOnce(new Promise((resolve) => {
            releaseSheet = resolve;
        }));
        let wanted = true;
        const onExit = jest.fn();

        const opening = openMessageSelection({
            isStillWanted: () => wanted,
            onExit,
        });
        wanted = false;
        releaseSheet();
        await opening;

        expect(isMessageSelectionActive()).toBe(false);
        expect(onExit).not.toHaveBeenCalled();
    });

    test('cutTail invokes syncWindowControls after saving when deleting tail messages', async () => {
        mountRoleplayDom(3);
        const order = [];
        saveChatConditional.mockImplementationOnce(async () => {
            order.push('save');
        });
        const syncWindowControls = jest.fn(async () => {
            order.push('syncWindowControls');
        });
        confirmDestructiveAction.mockResolvedValueOnce(true);

        await openMessageSelection({ syncWindowControls });
        const rows = document.querySelectorAll('#chat > .mes');
        rows[2].click();
        document.querySelector('#dialogue_del_mes [data-action-id="delete"]').click();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(removeRenderedMessagesFrom).toHaveBeenCalledWith(2);
        expect(chat).toHaveLength(2);
        expect(syncWindowControls).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['save', 'syncWindowControls']);
    });

    test('non-tail deletion also invokes syncWindowControls after saving', async () => {
        mountRoleplayDom(3);
        const syncWindowControls = jest.fn();
        confirmDestructiveAction.mockResolvedValueOnce(true);

        await openMessageSelection({ syncWindowControls });
        const rows = document.querySelectorAll('#chat > .mes');
        rows[0].click();
        document.querySelector('#dialogue_del_mes [data-action-id="delete"]').click();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(deleteMessage).toHaveBeenCalledWith(0, undefined, false, false);
        expect(syncWindowControls).toHaveBeenCalledTimes(1);
    });
});

describe('public/script.js openMessageDelete and clearChat wiring', () => {
    const scriptSource = readFileSync(new URL('../../public/script.js', import.meta.url), 'utf8');
    const ast = parse(scriptSource, { ecmaVersion: 'latest', sourceType: 'module', ranges: true });

    function sourceOf(fnName, exported = false) {
        const node = ast.body.find(item => (exported
            ? item.type === 'ExportNamedDeclaration' && item.declaration?.type === 'FunctionDeclaration' && item.declaration.id?.name === fnName
            : item.type === 'FunctionDeclaration' && item.id?.name === fnName));
        const target = exported ? node?.declaration : node;
        return target ? scriptSource.slice(target.range[0], target.range[1]) : '';
    }

    test('clearChat resets is_delete_mode even when selection mode has not mounted its cancel button yet', () => {
        const clearChatSource = sourceOf('clearChat', true);
        expect(clearChatSource).toContain('if (is_delete_mode)');
        expect(clearChatSource).toContain('is_delete_mode = false;');
    });

    test('openMessageDelete guards async loading with request id and render version and wires syncWindowControls', () => {
        const openSource = sourceOf('openMessageDelete');
        expect(openSource).toContain('const requestId = ++messageDeleteRequestId;');
        expect(openSource).toContain('const renderVersion = chatRenderVersion;');
        expect(openSource).toContain('const isStillWanted = () => is_delete_mode && requestId === messageDeleteRequestId && renderVersion === chatRenderVersion;');
        expect(openSource).toContain('if (!isStillWanted())');
        expect(openSource).toContain('isStillWanted,');
        expect(openSource).toContain('syncWindowControls:');
        expect(openSource).toContain('printMessages()');
        expect(openSource).toContain('syncChatHistoryWindowControls()');
    });
});
