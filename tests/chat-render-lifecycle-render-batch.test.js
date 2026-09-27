/* eslint-disable playwright/no-standalone-expect */
import { describe, expect, test } from '@jest/globals';

import { renderMessagesInBatches } from '../public/scripts/chat-render-lifecycle/render-batch.js';

class FakeElement {
    constructor(messageId) {
        this.messageId = messageId;
        this.children = [];
        this.classList = {
            classes: [],
            add: className => this.classList.classes.push(className),
        };
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }
}

class FakeDocument {
    constructor() {
        this.fragments = [];
    }

    createDocumentFragment() {
        const fragment = new FakeElement('fragment');
        this.fragments.push(fragment);
        return fragment;
    }
}

function pickBatchMeta(batchMeta) {
    return {
        batchIndex: batchMeta.batchIndex,
        startOffset: batchMeta.startOffset,
        endOffset: batchMeta.endOffset,
        firstMessageId: batchMeta.firstMessageId,
        lastMessageId: batchMeta.lastMessageId,
        renderedMessageIds: batchMeta.renderedMessageIds,
        isFinalBatch: batchMeta.isFinalBatch,
    };
}

describe('chat render lifecycle render batch helper', () => {
    test.each([100, 8])('yields when elapsed work exceeds the budget even when the count limit is %s', async batchSize => {
        let elapsed = 0;
        const inserted = [];
        const waits = [];
        const result = await renderMessagesInBatches({
            messages: ['first', 'second', 'third', 'fourth', 'fifth'],
            firstMessageId: 7,
            batchSize,
            timeBudgetMs: 8,
            now: () => elapsed,
            documentRef: new FakeDocument(),
            renderMessageElement: (message, messageId) => {
                elapsed += 5;
                return new FakeElement(messageId);
            },
            insertFragment: (fragment, meta) => inserted.push(meta),
            waitForNextFrame: async () => waits.push('frame'),
            markLastMessage: true,
        });
        expect(inserted.map(meta => meta.renderedMessageIds)).toEqual([[7, 8], [9, 10], [11]]);
        expect(waits).toHaveLength(2);
        expect(result.renderedMessageIds).toEqual([7, 8, 9, 10, 11]);
        expect(result.renderedMessageElements.map(element => element.classList.classes)).toEqual([[], [], [], [], ['last_mes']]);
    });

    test('stops rendering the previous chat when ownership changes during a frame yield', async () => {
        let current = true;
        const inserted = [];
        const result = await renderMessagesInBatches({
            messages: ['old first', 'old second'], firstMessageId: 0, batchSize: 1,
            documentRef: new FakeDocument(),
            renderMessageElement: (message, messageId) => new FakeElement(messageId),
            insertFragment: (fragment, meta) => inserted.push(meta.renderedMessageIds),
            waitForNextFrame: async () => { current = false; },
            isCurrent: () => current,
        });
        expect(inserted).toEqual([[0]]);
        expect(result.renderedMessageIds).toEqual([0]);
    });

    test('renders caller-selected messages in deterministic yielded fragments', async () => {
        const documentRef = new FakeDocument();
        const messages = [{ text: 'first' }, { text: 'second' }, { text: 'third' }];
        const rendered = [];
        const inserted = [];
        const waits = [];
        const afterBatches = [];

        const result = await renderMessagesInBatches({
            messages,
            firstMessageId: 10,
            batchSize: 2,
            documentRef,
            renderMessageElement: (message, messageId) => {
                rendered.push({ message, messageId });
                return new FakeElement(messageId);
            },
            insertFragment: (fragment, batchMeta) => inserted.push({ fragment, batchMeta }),
            waitForNextFrame: async () => waits.push('frame'),
            afterBatch: batchMeta => afterBatches.push(batchMeta),
        });

        expect(rendered).toEqual([
            { message: messages[0], messageId: 10 },
            { message: messages[1], messageId: 11 },
            { message: messages[2], messageId: 12 },
        ]);
        expect(inserted.map(item => item.fragment.children.map(child => child.messageId))).toEqual([[10, 11], [12]]);
        expect(waits).toEqual(['frame']);
        expect(afterBatches.map(pickBatchMeta)).toEqual([
            {
                batchIndex: 0,
                startOffset: 0,
                endOffset: 2,
                firstMessageId: 10,
                lastMessageId: 11,
                renderedMessageIds: [10, 11],
                isFinalBatch: false,
            },
            {
                batchIndex: 1,
                startOffset: 2,
                endOffset: 3,
                firstMessageId: 12,
                lastMessageId: 12,
                renderedMessageIds: [12],
                isFinalBatch: true,
            },
        ]);
        expect(result.renderedMessageIds).toEqual([10, 11, 12]);
        expect(result.renderedMessageElements.map(element => element.messageId)).toEqual([10, 11, 12]);
    });

    test('marks only the final rendered element when requested', async () => {
        const documentRef = new FakeDocument();
        const elements = [];

        await renderMessagesInBatches({
            messages: ['first', 'second', 'third'],
            firstMessageId: 4,
            batchSize: 2,
            documentRef,
            renderMessageElement: (message, messageId) => {
                const element = new FakeElement(messageId);
                elements.push(element);
                return [element];
            },
            insertFragment: () => {},
            waitForNextFrame: async () => {},
            markLastMessage: true,
        });

        expect(elements.map(element => element.classList.classes)).toEqual([[], [], ['last_mes']]);
    });

    test('does not yield when all messages fit in one batch', async () => {
        const waits = [];

        await renderMessagesInBatches({
            messages: ['first', 'second'],
            firstMessageId: 0,
            batchSize: 10,
            documentRef: new FakeDocument(),
            renderMessageElement: (message, messageId) => new FakeElement(messageId),
            insertFragment: () => {},
            waitForNextFrame: async () => waits.push('frame'),
        });

        expect(waits).toEqual([]);
    });

    test('returns an empty result without inserting or yielding when there are no messages', async () => {
        const inserted = [];
        const waits = [];

        const result = await renderMessagesInBatches({
            messages: [],
            firstMessageId: 0,
            batchSize: 1,
            documentRef: new FakeDocument(),
            renderMessageElement: () => new FakeElement(0),
            insertFragment: fragment => inserted.push(fragment),
            waitForNextFrame: async () => waits.push('frame'),
        });

        expect(inserted).toEqual([]);
        expect(waits).toEqual([]);
        expect(result).toEqual({
            renderedMessageIds: [],
            renderedMessageElements: [],
        });
    });

    test('fails fast for invalid boundary options', async () => {
        const validOptions = {
            messages: ['message'],
            firstMessageId: 0,
            batchSize: 1,
            documentRef: new FakeDocument(),
            renderMessageElement: (message, messageId) => new FakeElement(messageId),
            insertFragment: () => {},
            waitForNextFrame: async () => {},
        };

        await expect(renderMessagesInBatches({ ...validOptions, messages: null })).rejects.toThrow('messages');
        await expect(renderMessagesInBatches({ ...validOptions, firstMessageId: 0.5 })).rejects.toThrow('firstMessageId');
        await expect(renderMessagesInBatches({ ...validOptions, batchSize: 0 })).rejects.toThrow('batchSize');
        await expect(renderMessagesInBatches({ ...validOptions, documentRef: null })).rejects.toThrow('documentRef');
        await expect(renderMessagesInBatches({ ...validOptions, renderMessageElement: null })).rejects.toThrow('renderMessageElement');
        await expect(renderMessagesInBatches({ ...validOptions, insertFragment: null })).rejects.toThrow('insertFragment');
        await expect(renderMessagesInBatches({ ...validOptions, waitForNextFrame: null })).rejects.toThrow('waitForNextFrame');
        await expect(renderMessagesInBatches({ ...validOptions, afterBatch: true })).rejects.toThrow('afterBatch');
        await expect(renderMessagesInBatches({
            ...validOptions,
            renderMessageElement: () => null,
        })).rejects.toThrow('message 0');
    });
});
