/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { JSDOM } from 'jsdom';

const GLOBAL_KEYS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'CSS', 'getComputedStyle', 'requestAnimationFrame'];
const savedGlobals = new Map();

function installJsdom() {
    const dom = new JSDOM('<!doctype html><body><div id="chat"><div class="mes"><div class="mes_text"></div><div class="mes_reasoning"></div></div></div></body>', { url: 'http://localhost/' });
    const w = dom.window;
    for (const key of GLOBAL_KEYS) {
        if (!savedGlobals.has(key)) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    Object.assign(globalThis, {
        window: w,
        document: w.document,
        Node: w.Node,
        Element: w.Element,
        HTMLElement: w.HTMLElement,
        MutationObserver: w.MutationObserver,
        CSS: { supports: () => true },
        getComputedStyle: w.getComputedStyle.bind(w),
        requestAnimationFrame: (callback) => setTimeout(callback, 0),
    });
    return w;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

afterEach(() => {
    for (const [key, descriptor] of savedGlobals) {
        if (descriptor === undefined) delete globalThis[key];
        else Object.defineProperty(globalThis, key, descriptor);
    }
    savedGlobals.clear();
    jest.resetModules();
});

const CONTROLS_IN_PROSE = {
    'a div.menu_button': '<div class="menu_button">x</div>',
    'a div.menu_button inside a span': '<span><div class="menu_button">x</div></span>',
    'a button.menu_button inside a paragraph': '<p>text <button class="menu_button">x</button></p>',
    'a div.menu_button inside a blockquote': '<blockquote><div class="menu_button">x</div></blockquote>',
    'a div.menu_button inside a list item': '<ul><li><div class="menu_button">x</div></li></ul>',
    'a span.custom_interactable inside an em': '<em><span class="custom_interactable">x</span></em>',
    'a span.interactable inside a pre': '<pre><span class="code-copy interactable">c</span><code>x</code></pre>',
    'a div.menu_button inside the summary of a details element': '<details><summary><div class="menu_button">x</div></summary></details>',
};

describe('controls that enter message prose after the message is in the page', () => {
    test.each(Object.entries(CONTROLS_IN_PROSE))('keyboard.js gives %s a tab stop', async (_name, html) => {
        const w = installJsdom();
        const { initKeyboard } = await import('../../public/scripts/keyboard.js');
        initKeyboard();

        w.document.querySelector('.mes_text').innerHTML = html;
        await settle();

        const control = w.document.querySelector('.mes_text .menu_button, .mes_text .custom_interactable, .mes_text .interactable');
        expect(control.getAttribute('tabindex')).toBe('0');
    });

    test.each(Object.entries(CONTROLS_IN_PROSE).filter(([, html]) => html.includes('menu_button')))('a11y.js gives %s the button role', async (_name, html) => {
        const w = installJsdom();
        const { initAccessibility } = await import('../../public/scripts/a11y.js');
        initAccessibility();

        w.document.querySelector('.mes_text').innerHTML = html;
        w.document.querySelector('.mes_reasoning').innerHTML = html;
        await settle();

        for (const control of w.document.querySelectorAll('.menu_button')) {
            expect(control.getAttribute('role')).toBe('button');
        }
    });

    test('keyboard.js gives a control of a selector that an extension registered a tab stop, inside an em', async () => {
        const w = installJsdom();
        const { initKeyboard, registerInteractableType } = await import('../../public/scripts/keyboard.js');
        initKeyboard();
        registerInteractableType('.my_extension_control');

        w.document.querySelector('.mes_text').innerHTML = '<em><span class="my_extension_control">x</span></em>';
        await settle();

        expect(w.document.querySelector('.my_extension_control').getAttribute('tabindex')).toBe('0');
    });

    test('keyboard.js and a11y.js give a control that morphdom-style patches add to a paragraph the same treatment', async () => {
        const w = installJsdom();
        const { initKeyboard } = await import('../../public/scripts/keyboard.js');
        const { initAccessibility } = await import('../../public/scripts/a11y.js');
        initKeyboard();
        initAccessibility();

        const text = w.document.querySelector('.mes_text');
        text.innerHTML = '<p>first</p>';
        await settle();
        const paragraph = text.querySelector('p');
        const wrapper = w.document.createElement('span');
        wrapper.innerHTML = '<div class="menu_button">x</div>';
        paragraph.appendChild(wrapper);
        await settle();

        const control = paragraph.querySelector('.menu_button');
        expect(control.getAttribute('tabindex')).toBe('0');
        expect(control.getAttribute('role')).toBe('button');
    });
});

describe('prose that holds no control is not scanned', () => {
    test('streamed spans and paragraphs cause no subtree query on the added node', async () => {
        const w = installJsdom();
        const { initKeyboard } = await import('../../public/scripts/keyboard.js');
        const { initAccessibility } = await import('../../public/scripts/a11y.js');
        initKeyboard();
        initAccessibility();

        const queriedAll = new Set();
        const original = w.Element.prototype.querySelectorAll;
        w.Element.prototype.querySelectorAll = function (selector) {
            queriedAll.add(this);
            return original.call(this, selector);
        };

        const text = w.document.querySelector('.mes_text');
        const span = w.document.createElement('span');
        span.className = 'text_segment';
        span.textContent = 'chunk';
        const paragraph = w.document.createElement('p');
        paragraph.innerHTML = '<em>emphasis</em> and <code>code</code> and <strong>bold</strong>';
        const reasoningSpan = w.document.createElement('span');
        reasoningSpan.textContent = 'thinking';
        text.appendChild(span);
        text.appendChild(paragraph);
        w.document.querySelector('.mes_reasoning').appendChild(reasoningSpan);
        await settle();
        w.Element.prototype.querySelectorAll = original;

        expect(queriedAll.has(span)).toBe(false);
        expect(queriedAll.has(paragraph)).toBe(false);
        expect(queriedAll.has(reasoningSpan)).toBe(false);
        expect(span.hasAttribute('tabindex')).toBe(false);
        expect(paragraph.hasAttribute('tabindex')).toBe(false);
    });
});
