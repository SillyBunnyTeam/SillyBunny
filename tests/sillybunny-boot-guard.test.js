import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootGuardSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-boot-guard.js'), 'utf8');

class FakeElement {
    constructor(tagName, { id = '', className = '' } = {}) {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.className = className;
        this.children = [];
        this.parentNode = null;
        this.style = { cssText: '' };
        this.attributes = new Map();
        this.listeners = new Map();
        this.textContent = '';
        this.type = '';
        this.disabled = false;
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    removeChild(child) {
        this.children = this.children.filter(candidate => candidate !== child);
        child.parentNode = null;
        return child;
    }

    remove() {
        if (this.parentNode) {
            this.parentNode.removeChild(this);
        }
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    addEventListener(type, listener) {
        this.listeners.set(type, listener);
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
        const selectors = selector.split(',').map(part => part.trim()).filter(Boolean);
        return getDescendants(this).filter(element => selectors.some(part => matchesSelector(element, part)));
    }

    set innerHTML(_value) {
        this.children.forEach(child => {
            child.parentNode = null;
        });
        this.children = [];
    }
}

class FakeDocument {
    constructor() {
        this.body = new FakeElement('body');
    }

    createElement(tagName) {
        return new FakeElement(tagName);
    }

    appendChild(element) {
        return this.body.appendChild(element);
    }

    getElementById(id) {
        return getDescendants(this.body).find(element => element.id === id) || null;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
        return this.body.querySelectorAll(selector);
    }
}

function getDescendants(root) {
    return root.children.flatMap(child => [child, ...getDescendants(child)]);
}

function matchesSimpleSelector(element, selector) {
    if (selector.startsWith('#')) {
        return element.id === selector.slice(1);
    }

    if (selector.startsWith('.')) {
        return element.className.split(/\s+/).includes(selector.slice(1));
    }

    return element.tagName.toLowerCase() === selector.toLowerCase();
}

function matchesSelector(element, selector) {
    const parts = selector.split(/\s+/).filter(Boolean);
    let currentElement = element;

    for (let index = parts.length - 1; index >= 0; index--) {
        if (index === parts.length - 1) {
            if (!matchesSimpleSelector(currentElement, parts[index])) {
                return false;
            }
            currentElement = currentElement.parentNode;
            continue;
        }

        while (currentElement && !matchesSimpleSelector(currentElement, parts[index])) {
            currentElement = currentElement.parentNode;
        }

        if (!currentElement) {
            return false;
        }

        currentElement = currentElement.parentNode;
    }

    return true;
}

function createBootGuardHarness() {
    const document = new FakeDocument();
    const timers = [];
    const listeners = new Map();
    let now = 0;

    const window = {
        addEventListener: (type, listener) => listeners.set(type, listener),
        clearTimeout: jest.fn(),
        location: { reload: jest.fn() },
        setTimeout: (callback, delay) => {
            timers.push({ callback, delay });
            return timers.length;
        },
    };

    vm.runInNewContext(bootGuardSource, {
        console,
        Date: { now: () => now },
        document,
        navigator: {},
        Promise,
        window,
    });

    return {
        document,
        listeners,
        setNow: value => {
            now = value;
        },
        timers,
        window,
    };
}

function addPreloader(document) {
    const preloader = new FakeElement('div', { id: 'preloader' });
    preloader.setAttribute('aria-hidden', 'true');
    document.appendChild(preloader);
    return preloader;
}

describe('SillyBunny boot guard', () => {
    test('removes startup loader artifacts before showing the recovery panel', () => {
        const { document, window } = createBootGuardHarness();
        const preloader = addPreloader(document);
        const dialog = document.appendChild(new FakeElement('dialog'));

        dialog.appendChild(new FakeElement('div', { id: 'loader' }));
        document.appendChild(new FakeElement('div', { className: '_poly_dialog_overlay' }));

        window.SillyBunnyBootGuard.showFailure('boom');

        expect(document.querySelector('dialog')).toBeNull();
        expect(document.getElementById('loader')).toBeNull();
        expect(document.querySelector('._poly_dialog_overlay')).toBeNull();
        expect(preloader.attributes.has('aria-hidden')).toBe(false);
        expect(preloader.querySelector('button').textContent).toBe('Clear frontend cache and reload');
    });

    test('defers timeout failures while the normal startup loader is active', () => {
        const { document, setNow, timers } = createBootGuardHarness();
        const preloader = addPreloader(document);
        const loader = document.appendChild(new FakeElement('div', { id: 'loader' }));

        expect(timers[0].delay).toBe(25000);

        setNow(26000);
        timers.shift().callback();

        expect(preloader.querySelector('button')).toBeNull();
        expect(timers[0].delay).toBe(10000);

        loader.remove();
        setNow(36000);
        timers.shift().callback();

        expect(preloader.querySelector('button').textContent).toBe('Clear frontend cache and reload');
    });

    test('offers a dismiss button that removes the panel and suppresses later failures', () => {
        const { document, window } = createBootGuardHarness();
        addPreloader(document);

        window.SillyBunnyBootGuard.showFailure('boom');

        const preloader = document.getElementById('preloader');
        const dismissButton = preloader.querySelectorAll('button').find(button => button.textContent === 'Continue anyway');
        expect(dismissButton).toBeDefined();

        dismissButton.listeners.get('click')();

        expect(document.getElementById('preloader')).toBeNull();
    });

    test('ignores startup errors originating from third-party extensions', () => {
        const { document, listeners, timers } = createBootGuardHarness();
        const preloader = addPreloader(document);
        const initialTimerCount = timers.length;

        listeners.get('error')({
            target: { tagName: 'SCRIPT', src: '/scripts/extensions/third-party/Extension-WebSearch/index.js?v=1.6.5' },
        });
        listeners.get('error')({
            filename: '/scripts/extensions/third-party/Extension-WebSearch/index.js',
            message: 'boom',
            lineno: 1,
            colno: 1,
        });
        listeners.get('unhandledrejection')({
            reason: { stack: 'Error: boom\n    at /scripts/extensions/third-party/Extension-WebSearch/index.js:1:1' },
        });

        timers.slice(initialTimerCount).forEach(timer => timer.callback());

        expect(preloader.querySelector('button')).toBeNull();
    });

    test('still surfaces non-extension startup errors', () => {
        const { document, listeners, timers } = createBootGuardHarness();
        const preloader = addPreloader(document);
        const initialTimerCount = timers.length;

        listeners.get('error')({
            filename: '/script.js',
            message: 'boom',
            lineno: 1,
            colno: 1,
        });

        timers.slice(initialTimerCount).forEach(timer => timer.callback());

        expect(preloader.querySelector('button').textContent).toBe('Clear frontend cache and reload');
    });
});
