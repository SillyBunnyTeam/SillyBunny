/* eslint-disable playwright/no-standalone-expect */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderMessagesInBatches } from '../public/scripts/chat-render-lifecycle/render-batch.js';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');

function runtime() {
    let elements = [];
    let elapsed = 0;
    const frames = [];
    class Element {
        constructor(messageId, message) { this.messageId = messageId; this.message = message; }
        classList = { add() {} };
    }
    class Collection {
        constructor(items, previous = null) {
            this.items = items;
            this.previous = previous;
            Object.assign(this, items);
            this.length = items.length;
        }
        removeClass() { return this; }
        addClass() { return this; }
        filter(selector) { return new Collection(this.items.filter(element => element.messageId === Number(selector.match(/mesid="(\d+)"/)[1]))); }
        nextAll() { return new Collection(elements.slice(elements.indexOf(this.items[0]) + 1), this); }
        addBack() { return new Collection([...this.previous.items, ...this.items]); }
        remove() { elements = elements.filter(element => !this.items.includes(element)); return this; }
        first() { return new Collection(this.items.slice(0, 1)); }
        last() { return new Collection(this.items.slice(-1)); }
        each(callback) { this.items.forEach((element, index) => callback(index, element)); return this; }
        attr(name, value) {
            if (value === undefined) return this.items[0]?.messageId;
            this.items.forEach(element => { element.messageId = value; });
            return this;
        }
        find() { return new Collection([]); }
        text() { return this; }
    }
    const select = selector => {
        if (selector === '.mes') return new Collection(elements);
        const match = selector.match(/mesid="(\d+)"/);
        return new Collection(match ? elements.filter(element => element.messageId === Number(match[1])) : []);
    };
    const context = vm.createContext({
        console: { info() {}, debug() {} },
        chat: ['A', 'B', 'C'].map(mes => ({ mes, extra: {} })), chatGeneration: 1, chatRenderVersion: 0,
        chat_metadata: {}, this_edit_mes_id: undefined, isLoadingMoreMessages: false,
        power_user: { chat_truncation: 100 }, CHAT_HISTORY_OLDER_BUTTON_ID: 'older',
        HTMLElement: Element,
        $: element => typeof element === 'string' ? select(element) : new Collection([element]),
        chatElement: {
            0: { appendChild(fragment) { elements.push(...fragment.children); }, get firstChild() { return elements[0]; } },
            find: select, children: select,
        },
        document: { createDocumentFragment: () => ({ children: [], appendChild(element) { this.children.push(element); } }) },
        performance: { now: () => elapsed },
        renderMessagesInBatches: options => renderMessagesInBatches({ ...options, documentRef: context.document, now: () => elapsed }),
        updateMessageElement: (message, { messageId }) => { elapsed += 9; return [new Element(messageId, message)]; },
        getMobileChatRenderBatchSize: () => 100,
        getChatRenderWindowSize: () => 100,
        getRenderedChatMessageWindow: () => ({ renderedMessageCount: elements.length, firstMessageId: elements[0]?.messageId, lastMessageId: elements.at(-1)?.messageId }),
        getRenderedChatMessageElements: () => elements,
        getFirstDisplayedMessageId: () => Math.min(...elements.map(element => element.messageId)),
        getPagedChatRenderWindowSize: () => 100, getChatHistoryPageSize: () => 100,
        clamp: value => Math.max(0, value),
        insertShowMoreFragment: (reference, fragment) => {
            const index = elements.indexOf(reference);
            elements.splice(index < 0 ? 0 : index, 0, ...fragment.children);
        },
        captureVisibleChatMessageAnchor: () => null,
        waitForNextFrame: () => new Promise(resolve => frames.push(resolve)),
        isChatRenderLifecycleRolloutEnabled: () => true,
        CHAT_RENDER_LIFECYCLE_ROUTE: { REDISPLAY_BATCH: 'redisplay', SHOW_MORE_BATCH: 'history' },
        eventSource: { emit: jest.fn(async () => {}) }, event_types: { MESSAGE_DELETED: 'deleted', MORE_MESSAGES_LOADED: 'loaded' },
    });
    for (const name of ['unobserveChatMessageResize', 'applyCharacterTagsToMessageDivs', 'syncChatHistoryWindowControls', 'refreshSwipeButtons', 'applyStylePins', 'updateEditArrowClasses', 'deleteItemizedPromptForMessage', 'saveChatDebounced', 'pruneRenderedChatMessagesToWindow']) {
        context[name] = jest.fn();
    }
    for (const name of ['createChatRenderTransaction', 'renderRedisplayChatMessagesThroughLifecycle', 'renderRedisplayChatMessages', 'redisplayChat', 'getMessageDeletionStartId', 'deleteMessage', 'updateViewMessageIds', 'renderShowMoreMessagesThroughLifecycle', 'renderShowMoreMessages', 'showMoreMessages']) {
        const declaration = source.match(new RegExp(`^(?:export )?((?:async )?function ${name}\\([\\s\\S]*?^}\\r?$)`, 'm'))[1];
        vm.runInContext(declaration, context);
    }
    const waitForFrame = async () => {
        for (let turn = 0; frames.length === 0 && turn < 100; turn++) await Promise.resolve();
        if (frames.length === 0) throw new Error('Render did not schedule a frame');
    };
    const finish = async pending => {
        let done = false;
        const completion = Promise.all(pending).finally(() => { done = true; });
        for (let turn = 0; !done && turn < 100; turn++) {
            frames.shift()?.();
            await Promise.resolve();
        }
        if (!done) throw new Error('Render did not complete');
        await completion;
    };
    return { context, frames, waitForFrame, finish, rows: () => elements.map(element => `${element.message.mes}@${element.messageId}`), insert: (message, id) => elements.push(new Element(id, message)) };
}

describe('yielded chat render transactions', () => {
    test('restarts from current indices when a visible message is deleted during redisplay', async () => {
        const host = runtime();
        const pending = host.context.redisplayChat();
        await host.waitForFrame();
        expect(host.rows()).toEqual(['A@0']);
        await host.context.deleteMessage(0, undefined, false, false);
        await host.finish([pending]);
        expect(host.rows()).toEqual(['B@0', 'C@1']);
    });

    test('restarts history insertion when deletion changes its selected indices', async () => {
        const host = runtime();
        host.insert(host.context.chat[2], 2);
        const pending = host.context.showMoreMessages();
        await host.waitForFrame();
        expect(host.rows()).toEqual(['A@0', 'C@2']);
        await host.context.deleteMessage(0, undefined, false, false);
        await host.finish([pending]);
        expect(host.rows()).toEqual(['B@0', 'C@1']);
        expect(host.context.eventSource.emit.mock.calls.map(call => call[0])).toEqual(['deleted']);
    });

    test.each(['older first', 'newer first'])('only the replacement render finishes when frames resume %s', async order => {
        const host = runtime();
        const first = host.context.redisplayChat();
        await host.waitForFrame();
        const second = host.context.redisplayChat();
        for (let turn = 0; host.frames.length < 2 && turn < 100; turn++) await Promise.resolve();
        expect(host.frames).toHaveLength(2);
        if (order === 'newer first') host.frames.reverse();
        await host.finish([first, second]);
        expect(host.rows()).toEqual(['A@0', 'B@1', 'C@2']);
        expect(host.context.applyCharacterTagsToMessageDivs).toHaveBeenCalledTimes(1);
    });

    test('detects same-length reordering rather than only changes to chat length', async () => {
        const host = runtime();
        const pending = host.context.redisplayChat();
        await host.waitForFrame();
        [host.context.chat[1], host.context.chat[2]] = [host.context.chat[2], host.context.chat[1]];
        await host.finish([pending]);
        expect(host.rows()).toEqual(['A@0', 'C@1', 'B@2']);
    });
});
