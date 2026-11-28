/* global globalThis */
import { describe, expect, jest, test } from '@jest/globals';

import {
    createStreamingReasoningFixture,
    measureStreamingWithReasoning,
} from '../scripts/measure-frontend-performance.js';

const fixture = createStreamingReasoningFixture({ stepCount: 4, reasoningRepeat: 3, responseRepeat: 2 });

class FakeElement {
    constructor(className = '', children = []) {
        this.className = className;
        this.children = [];
        this.attributes = {};
        this.parent = null;
        this.textContent = '';
        this.innerHTML = '';
        this.scrollTop = 0;
        this.scrollHeight = 100;
        children.forEach(child => this.appendChild(child));
    }

    appendChild(child) {
        child.parent = this;
        this.children.push(child);
    }

    setAttribute(name, value) {
        this.attributes[name] = value;
    }

    getAttribute(name) {
        return this.attributes[name] ?? null;
    }

    remove() {
        this.parent?.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = null;
    }

    cloneNode() {
        return new FakeElement(this.className, this.children.map(child => child.cloneNode()));
    }

    /** Finds the first descendant that carries the class of a `.name` selector. */
    querySelector(selector) {
        const className = selector.replace(/^\./, '');
        for (const child of this.children) {
            if (child.className.split(' ').includes(className)) {
                return child;
            }
            const nested = child.querySelector(selector);
            if (nested) {
                return nested;
            }
        }
        return null;
    }

    querySelectorAll() {
        return [];
    }

    getBoundingClientRect() {
        return {};
    }
}

class FakeDocument {
    constructor({ chat, template }) {
        this.chat = chat;
        this.template = template;
    }

    querySelector(selector) {
        if (selector === '#chat') {
            return this.chat;
        }
        return selector === '#message_template .mes' ? this.template : null;
    }

    querySelectorAll() {
        return [];
    }
}

function createMessageTemplate({ without = null } = {}) {
    const classes = ['mes_text', 'mes_reasoning_details', 'mes_reasoning', 'mes_reasoning_header_title', 'mes_edit_add_reasoning'];
    return new FakeElement('mes', classes.filter(name => name !== without).map(name => new FakeElement(name)));
}

/**
 * A page whose `evaluate` runs the callback in this process, against a fake document and a fake app context.
 * `window.updateReasoningUI` is set on purpose: the old harness looked there, and it must not be used.
 */
function createPage({ context, chat = new FakeElement('chat'), template = createMessageTemplate() }) {
    const fakeDocument = new FakeDocument({ chat, template });
    return {
        chat,
        evaluate: async (callback, argument) => {
            const previous = {
                SillyTavern: globalThis.SillyTavern,
                document: globalThis.document,
                Element: globalThis.Element,
                Document: globalThis.Document,
                requestAnimationFrame: globalThis.requestAnimationFrame,
                updateReasoningUI: globalThis.updateReasoningUI,
            };
            try {
                globalThis.SillyTavern = { getContext: () => context };
                globalThis.document = fakeDocument;
                globalThis.Element = FakeElement;
                globalThis.Document = FakeDocument;
                globalThis.requestAnimationFrame = callbackRef => setTimeout(() => callbackRef(0), 0);
                globalThis.updateReasoningUI = jest.fn();
                return await callback(argument);
            } finally {
                const stale = globalThis.updateReasoningUI;
                Object.assign(globalThis, previous);
                if (previous.updateReasoningUI === undefined) {
                    delete globalThis.updateReasoningUI;
                }
                expect(stale).not.toHaveBeenCalled();
            }
        },
    };
}

function createContext(overrides = {}) {
    return {
        chat: [{ name: 'earlier', mes: 'kept' }],
        messageFormatting: text => `<p>${text}</p>`,
        updateReasoningUI: jest.fn(),
        ...overrides,
    };
}

/** What the app's reasoning UI does to the message element in the chat, without its dependencies. */
function renderReasoning(chat, messageId, { queries = 0 } = {}) {
    const element = chat.children.find(child => child.getAttribute('mesid') === String(messageId));
    for (let index = 0; index < queries; index++) {
        globalThis.document.querySelectorAll('#chat .mes');
    }
    element.querySelector('.mes_reasoning').textContent = fixture.reasoningText;
}

describe('streaming-with-reasoning measurement', () => {
    test('drives the reasoning UI of a message that is in the chat, once per step', async () => {
        const context = createContext();
        const page = createPage({ context });
        const inChatAtCall = [];
        context.updateReasoningUI.mockImplementation((messageId) => {
            inChatAtCall.push(page.chat.children.some(child => child.getAttribute('mesid') === String(messageId)));
            renderReasoning(page.chat, messageId);
        });

        const result = await measureStreamingWithReasoning(page, fixture);

        expect(result.available).toBe(true);
        expect(context.updateReasoningUI).toHaveBeenCalledTimes(fixture.stepCount);
        expect(context.updateReasoningUI).toHaveBeenCalledWith(1);
        expect(inChatAtCall).toEqual(Array(fixture.stepCount).fill(true));
        expect(result.reasoningUpdateCount).toBe(fixture.stepCount);
        expect(result.reasoningRenderedChars).toBe(fixture.reasoningText.length);
        expect(result.reasoningBytes).toBe(fixture.reasoningText.length);
    });

    test('counts the querySelectorAll calls that the reasoning UI makes, and restores the DOM and the chat', async () => {
        const context = createContext();
        const page = createPage({ context });
        context.updateReasoningUI.mockImplementation(messageId => renderReasoning(page.chat, messageId, { queries: 5 }));
        const originalQuerySelectorAll = FakeDocument.prototype.querySelectorAll;
        const originalGetBoundingClientRect = FakeElement.prototype.getBoundingClientRect;

        const result = await measureStreamingWithReasoning(page, fixture);

        expect(result.querySelectorAllCount).toBe(5 * fixture.stepCount);
        expect(result.getBoundingClientRectCount).toBe(0);
        expect(FakeDocument.prototype.querySelectorAll).toBe(originalQuerySelectorAll);
        expect(FakeElement.prototype.getBoundingClientRect).toBe(originalGetBoundingClientRect);
        expect(page.chat.children).toEqual([]);
        expect(context.chat).toEqual([{ name: 'earlier', mes: 'kept' }]);
    });

    test('stops with an error that names the missing function instead of recording zero counters', async () => {
        const page = createPage({ context: createContext({ updateReasoningUI: undefined }) });

        await expect(measureStreamingWithReasoning(page, fixture)).rejects.toThrow('updateReasoningUI');
        expect(page.chat.children).toEqual([]);
    });

    test.each([
        '.mes_reasoning_header_title',
        '.mes_edit_add_reasoning',
        '.mes_reasoning',
    ])('stops with an error that names %s when the message template lacks it', async (selector) => {
        const page = createPage({
            context: createContext(),
            template: createMessageTemplate({ without: selector.slice(1) }),
        });

        await expect(measureStreamingWithReasoning(page, fixture)).rejects.toThrow(selector);
    });

    test('stops with an error when there is no message template', async () => {
        const page = createPage({ context: createContext(), template: null });

        await expect(measureStreamingWithReasoning(page, fixture)).rejects.toThrow('#message_template');
    });

    test('reports the measurement unavailable when the page has no chat element', async () => {
        const page = createPage({ context: createContext(), chat: null });

        await expect(measureStreamingWithReasoning(page, fixture)).resolves.toEqual({
            available: false,
            reason: 'chat-formatting-unavailable',
            cdp: null,
        });
    });
});
