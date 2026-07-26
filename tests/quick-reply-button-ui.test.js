/* global document, globalThis */
import { beforeAll, beforeEach, afterEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/script.js', () => ({
    animation_duration: 0,
}));

await jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({
    dragElement: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    loadMovingUIState: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/extensions/quick-reply/src/QuickReplySettings.js', () => ({
    QuickReplySettings: class QuickReplySettings {},
}));

class FakeClassList {
    constructor() {
        this.classes = new Set();
    }

    add(...names) {
        names.forEach(name => this.classes.add(name));
    }

    remove(...names) {
        names.forEach(name => this.classes.delete(name));
    }

    contains(name) {
        return this.classes.has(name);
    }
}

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.parentNode = null;
        this.classList = new FakeClassList();
        this.style = { setProperty: jest.fn() };
        this.id = '';
        this.textContent = '';
    }

    append(...children) {
        children.forEach(child => this.appendChild(child));
    }

    appendChild(child) {
        child.remove?.();
        child.parentElement = this;
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    insertBefore(child, referenceChild) {
        child.remove?.();
        child.parentElement = this;
        child.parentNode = this;

        const referenceIndex = referenceChild ? this.children.indexOf(referenceChild) : -1;
        if (referenceIndex === -1) {
            this.children.push(child);
        } else {
            this.children.splice(referenceIndex, 0, child);
        }

        return child;
    }

    insertAdjacentElement(position, element) {
        if (position === 'beforebegin' && this.parentElement) {
            this.parentElement.insertBefore(element, this);
            return element;
        }

        this.appendChild(element);
        return element;
    }

    remove() {
        if (!this.parentElement) return;
        this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
        this.parentNode = null;
    }

    get firstElementChild() {
        return this.children[0] ?? null;
    }

    get nextElementSibling() {
        if (!this.parentElement) return null;
        const index = this.parentElement.children.indexOf(this);
        return this.parentElement.children[index + 1] ?? null;
    }

    addEventListener() {}

    matches(selector) {
        if (selector.startsWith('#')) {
            return this.id === selector.slice(1);
        }

        if (selector.startsWith('.')) {
            return this.classList.contains(selector.slice(1));
        }

        return this.tagName.toLowerCase() === selector.toLowerCase();
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
    }

    querySelectorAll(selector) {
        const matches = [];
        const visit = (node) => {
            if (node.matches?.(selector)) {
                matches.push(node);
            }
            for (const child of node.children ?? []) {
                visit(child);
            }
        };
        for (const child of this.children) {
            visit(child);
        }
        return matches;
    }
}

class FakeDocument {
    constructor() {
        this.body = new FakeElement('body');
    }

    createElement(tagName) {
        return new FakeElement(tagName);
    }

    querySelector(selector) {
        if (this.body.matches(selector)) {
            return this.body;
        }
        return this.body.querySelector(selector);
    }

    querySelectorAll(selector) {
        const matches = this.body.matches(selector) ? [this.body] : [];
        return matches.concat(this.body.querySelectorAll(selector));
    }
}

let ButtonUi;
let mutationObservers;

class FakeMutationObserver {
    constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        mutationObservers.push(this);
    }

    observe(target, options) {
        this.target = target;
        this.options = options;
    }

    disconnect() {
        this.disconnected = true;
    }
}

function createVisibleSet(label = 'HELP', name = label) {
    return {
        name,
        render() {
            const button = document.createElement('button');
            button.classList.add('qr--button');
            button.textContent = label;
            return button;
        },
    };
}

function createSettings(label = 'HELP', name = label) {
    return {
        isEnabled: true,
        isPopout: false,
        isCombined: false,
        showPopoutButton: false,
        config: {
            setList: [{ isVisible: true, set: createVisibleSet(label, name) }],
        },
    };
}

function appendComposer() {
    const sendForm = document.createElement('div');
    sendForm.id = 'send_form';
    const fileForm = document.createElement('form');
    fileForm.id = 'file_form';
    const nonQrFormItems = document.createElement('div');
    nonQrFormItems.id = 'nonQRFormItems';
    sendForm.append(fileForm, nonQrFormItems);
    document.body.append(sendForm);

    return { sendForm, fileForm, nonQrFormItems };
}

beforeAll(async () => {
    ({ ButtonUi } = await import('../public/scripts/extensions/quick-reply/src/ui/ButtonUi.js'));
});

beforeEach(() => {
    mutationObservers = [];
    globalThis.document = new FakeDocument();
    globalThis.MutationObserver = FakeMutationObserver;
    globalThis.$ = jest.fn(() => ({ fadeIn: jest.fn() }));
});

afterEach(() => {
    delete globalThis.document;
    delete globalThis.MutationObserver;
    delete globalThis.$;
});

describe('Quick Reply button bar', () => {
    test('mounts visible quick replies when the composer becomes available after startup', () => {
        const buttons = new ButtonUi(createSettings());

        expect(() => buttons.show()).not.toThrow();
        expect(document.querySelector('#qr--bar')).toBeNull();
        expect(mutationObservers).toHaveLength(1);

        const { sendForm, fileForm, nonQrFormItems } = appendComposer();

        mutationObservers[0].callback();

        const qrBar = document.querySelector('#qr--bar');
        expect(qrBar).toBeTruthy();
        expect(sendForm.children).toEqual([fileForm, qrBar, nonQrFormItems]);
        expect(qrBar.querySelector('.qr--button').textContent).toBe('HELP');
        expect(mutationObservers[0].disconnected).toBe(true);
    });

    test('refresh keeps one QR bar attached to the composer controls', () => {
        const { sendForm, fileForm, nonQrFormItems } = appendComposer();
        const buttons = new ButtonUi(createSettings());

        buttons.show();
        buttons.refresh();

        const qrBars = document.body.querySelectorAll('#qr--bar');
        expect(qrBars).toHaveLength(1);
        expect(sendForm.children).toEqual([fileForm, qrBars[0], nonQrFormItems]);
        expect(qrBars[0].querySelector('.qr--button').textContent).toBe('HELP');
    });

    test('renderBar removes a stale bar left behind by an integration host', () => {
        const { sendForm } = appendComposer();
        const staleHost = document.createElement('div');
        staleHost.id = 'gg-qr-container';
        const staleBar = document.createElement('div');
        staleBar.id = 'qr--bar';
        staleHost.appendChild(staleBar);
        document.body.append(staleHost);

        const buttons = new ButtonUi(createSettings());
        buttons.show();

        const qrBars = document.body.querySelectorAll('#qr--bar');
        expect(qrBars).toHaveLength(1);
        expect(qrBars[0].parentElement).toBe(sendForm);
        expect(staleHost.children).toEqual([]);
    });

    test('refresh renders updated visible quick replies from the active set', () => {
        appendComposer();
        const settings = createSettings('HELP');
        const buttons = new ButtonUi(settings);

        buttons.show();
        expect(document.querySelector('#qr--bar')?.querySelector('.qr--button')?.textContent).toBe('HELP');

        settings.config.setList = [{ isVisible: true, set: createVisibleSet('Shard Memory') }];
        buttons.refresh();

        expect(document.querySelector('#qr--bar')?.querySelector('.qr--button')?.textContent).toBe('Shard Memory');
    });

    test('renders one visible button set when active scopes contain duplicate set names', () => {
        appendComposer();
        const settings = createSettings('Global Help');
        settings.chatConfig = {
            setList: [{ isVisible: true, set: createVisibleSet('Chat Help', ' global help ') }],
        };
        const buttons = new ButtonUi(settings);

        buttons.show();

        const qrButtons = document.querySelector('#qr--bar')?.querySelectorAll('.qr--button') ?? [];
        expect(qrButtons).toHaveLength(1);
        expect(qrButtons[0].textContent).toBe('Global Help');
    });

    test('lets a visible duplicate render when the earlier matching link is hidden', () => {
        appendComposer();
        const settings = createSettings('Hidden Global', 'Memory Sharding');
        settings.config.setList[0].isVisible = false;
        settings.chatConfig = {
            setList: [{ isVisible: true, set: createVisibleSet('Visible Chat', ' memory sharding ') }],
        };
        const buttons = new ButtonUi(settings);

        buttons.show();

        const qrButtons = document.querySelector('#qr--bar')?.querySelectorAll('.qr--button') ?? [];
        expect(qrButtons).toHaveLength(1);
        expect(qrButtons[0].textContent).toBe('Visible Chat');
    });

    test('does not render stale visible links to deleted sets', () => {
        appendComposer();
        const settings = createSettings('Deleted Help');
        settings.config.setList[0].set.isDeleted = true;
        settings.chatConfig = {
            setList: [{ isVisible: true, set: createVisibleSet('Active Chat') }],
        };
        const buttons = new ButtonUi(settings);

        buttons.show();

        const qrButtons = document.querySelector('#qr--bar')?.querySelectorAll('.qr--button') ?? [];
        expect(qrButtons).toHaveLength(1);
        expect(qrButtons[0].textContent).toBe('Active Chat');
    });
});
