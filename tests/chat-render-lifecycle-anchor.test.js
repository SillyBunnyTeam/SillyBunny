import { describe, expect, test } from '@jest/globals';

import {
    captureVisibleMessageAnchor,
    restoreVisibleMessageAnchor,
    settleVisibleMessageAnchor,
} from '../public/scripts/chat-render-lifecycle/anchor.js';

class FakeMessageElement {
    constructor(messageId, rect) {
        this.messageId = String(messageId);
        this.rect = rect;
    }

    getAttribute(attribute) {
        return attribute === 'mesid' ? this.messageId : null;
    }

    getBoundingClientRect() {
        return this.rect;
    }
}

class FakeScrollElement {
    constructor(messages, rect = { top: 0, bottom: 100 }) {
        this.messages = messages;
        this.rect = rect;
        this.scrollTop = 0;
    }

    getBoundingClientRect() {
        return this.rect;
    }

    querySelectorAll(selector) {
        return selector === '.mes[mesid]' ? this.messages : [];
    }
}

describe('chat render lifecycle anchor helpers', () => {
    test('captures the first message intersecting the chat viewport', () => {
        const messages = [
            new FakeMessageElement(4, { top: -120, bottom: -20 }),
            new FakeMessageElement(5, { top: 24, bottom: 84 }),
            new FakeMessageElement(6, { top: 90, bottom: 160 }),
        ];

        expect(captureVisibleMessageAnchor(new FakeScrollElement(messages))).toEqual({
            messageId: '5',
            offsetTop: 24,
        });
    });

    test('restores the captured message to the same viewport offset', () => {
        const anchorMessage = new FakeMessageElement(5, { top: 24, bottom: 84 });
        const scrollElement = new FakeScrollElement([anchorMessage]);
        const anchor = captureVisibleMessageAnchor(scrollElement);

        anchorMessage.rect = { top: 96, bottom: 156 };
        restoreVisibleMessageAnchor(scrollElement, anchor);

        expect(scrollElement.scrollTop).toBe(72);
    });

    test('preserves viewport-relative anchors during top, middle, and tail replacements', () => {
        const cases = [
            {
                messages: [
                    new FakeMessageElement(10, { top: 12, bottom: 68 }),
                    new FakeMessageElement(11, { top: 76, bottom: 132 }),
                    new FakeMessageElement(12, { top: 140, bottom: 196 }),
                ],
                mutate(messages) {
                    messages[0].rect = { top: 42, bottom: 118 };
                },
                expectedScrollTop: 30,
            },
            {
                messages: [
                    new FakeMessageElement(20, { top: -92, bottom: -24 }),
                    new FakeMessageElement(21, { top: 18, bottom: 82 }),
                    new FakeMessageElement(22, { top: 90, bottom: 160 }),
                ],
                mutate(messages) {
                    messages[1].rect = { top: -14, bottom: 106 };
                },
                expectedScrollTop: -32,
            },
            {
                messages: [
                    new FakeMessageElement(30, { top: -150, bottom: -80 }),
                    new FakeMessageElement(31, { top: -72, bottom: -8 }),
                    new FakeMessageElement(32, { top: 28, bottom: 94 }),
                ],
                mutate(messages) {
                    messages[2].rect = { top: 64, bottom: 156 };
                },
                expectedScrollTop: 36,
            },
        ];

        for (const { messages, mutate, expectedScrollTop } of cases) {
            const scrollElement = new FakeScrollElement(messages);
            const anchor = captureVisibleMessageAnchor(scrollElement);

            mutate(messages);
            restoreVisibleMessageAnchor(scrollElement, anchor);

            expect(scrollElement.scrollTop).toBe(expectedScrollTop);
        }
    });

    test('settles the anchor across multiple animation frames', async () => {
        const anchorMessage = new FakeMessageElement(5, { top: 10, bottom: 60 });
        const scrollElement = new FakeScrollElement([anchorMessage]);
        const anchor = captureVisibleMessageAnchor(scrollElement);
        const frameCallbacks = [];
        const settling = settleVisibleMessageAnchor(scrollElement, anchor, {
            frames: 2,
            requestAnimationFrameRef: callback => frameCallbacks.push(callback),
        });

        anchorMessage.rect = { top: 40, bottom: 90 };
        frameCallbacks.shift()();
        await Promise.resolve();
        expect(scrollElement.scrollTop).toBe(30);

        anchorMessage.rect = { top: 65, bottom: 115 };
        frameCallbacks.shift()();
        await settling;
        expect(scrollElement.scrollTop).toBe(85);
    });

    test('ignores missing scroll elements and anchors', () => {
        expect(captureVisibleMessageAnchor(null)).toBeNull();

        const scrollElement = new FakeScrollElement([]);
        restoreVisibleMessageAnchor(scrollElement, null);

        expect(scrollElement.scrollTop).toBe(0);
    });

    test('uses binary search to bound getBoundingClientRect reads on long chats', () => {
        let rectReads = 0;
        const messages = Array.from({ length: 500 }, (_value, index) => {
            const top = (index - 450) * 50;
            const element = new FakeMessageElement(index, { top, bottom: top + 48 });
            const originalGetRect = element.getBoundingClientRect.bind(element);
            element.getBoundingClientRect = () => {
                rectReads += 1;
                return originalGetRect();
            };
            return element;
        });

        const anchor = captureVisibleMessageAnchor(new FakeScrollElement(messages, { top: 0, bottom: 200 }));
        expect(anchor).toEqual({ messageId: '450', offsetTop: 0 });
        expect(rectReads).toBeLessThanOrEqual(12);
    });

    test('falls back cleanly when a collapsed zero-box message sits in the list', () => {
        const messages = [
            new FakeMessageElement(1, { top: -120, bottom: -20, width: 300, height: 100 }),
            new FakeMessageElement(2, { top: 0, bottom: 0, width: 0, height: 0 }),
            new FakeMessageElement(3, { top: 16, bottom: 84, width: 300, height: 68 }),
        ];

        expect(captureVisibleMessageAnchor(new FakeScrollElement(messages, { top: 0, bottom: 200 }))).toEqual({
            messageId: '3',
            offsetTop: 16,
        });
    });
});
