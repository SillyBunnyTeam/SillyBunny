/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { mountNovelAIPreciseReferenceEditor } from '../public/scripts/novelai-precise-reference-ui.js';

const DROPPED_MESSAGE = 'The images were not added because the references changed while they were prepared. Add them again.';
const existingReference = { image: 'RVhJU1RJTkc=', type: 'style', strength: 0.5, fidelity: 0.5 };

let fakeDocument;
let pendingImageLoads;

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parent = null;
        this.listeners = new Map();
        this.attributes = new Map();
        this.dataset = {};
        this.classList = { add() {} };
        this.disabled = false;
        this.textContent = '';
    }

    get isConnected() {
        let node = this;
        while (node.parent) node = node.parent;
        return node === fakeDocument.body || node === fakeDocument.head;
    }

    append(...nodes) {
        for (const node of nodes) {
            node.remove();
            node.parent = this;
            this.children.push(node);
        }
    }

    prepend(node) {
        node.remove();
        node.parent = this;
        this.children.unshift(node);
    }

    remove() {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter(child => child !== this);
        this.parent = null;
    }

    replaceChildren() {
        for (const child of this.children) child.parent = null;
        this.children = [];
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    addEventListener(type, listener) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
    }

    dispatch(type) {
        for (const listener of this.listeners.get(type) || []) listener();
    }

    add() {}

    getContext() {
        return { fillRect() {}, drawImage() {} };
    }

    toDataURL() {
        return 'data:image/png;base64,UFJFUEFSRUQ=';
    }

    descendants() {
        return this.children.flatMap(child => [child, ...child.descendants()]);
    }
}

class FakeImage {
    set src(value) {
        if (!value) return;
        this.naturalWidth = 32;
        this.naturalHeight = 48;
        pendingImageLoads.push(() => this.onload());
    }
}

function mountEditor(initialState) {
    const host = { state: initialState };
    host.onChange = jest.fn(next => { host.state = next; });
    const container = new FakeElement('div');
    fakeDocument.body.append(container);
    const editor = mountNovelAIPreciseReferenceEditor(container, {
        getState: () => host.state,
        onChange: host.onChange,
        getModel: () => 'nai-diffusion-4-5-full',
    });
    return { host, container, editor };
}

function chooseImage(container) {
    const upload = container.descendants().find(node => node.type === 'file');
    upload.files = [{ type: 'image/png', size: 1000 }];
    upload.dispatch('change');
}

async function finishPreparation() {
    for (const load of pendingImageLoads.splice(0)) load();
    await new Promise(resolve => setTimeout(resolve, 0));
}

function statusLine(container) {
    const status = container.descendants().find(node => node.getAttribute('role'));
    return { role: status.getAttribute('role'), text: status.textContent };
}

describe('NovelAI Precise Reference editor', () => {
    beforeEach(() => {
        pendingImageLoads = [];
        fakeDocument = {
            head: new FakeElement('head'),
            body: new FakeElement('body'),
            createElement: tagName => new FakeElement(tagName),
            querySelector: () => null,
        };
        globalThis.document = fakeDocument;
        globalThis.Image = FakeImage;
        globalThis.Option = class {
            constructor(text, value) {
                Object.assign(this, { text, value });
            }
        };
        jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reference');
        jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete globalThis.document;
        delete globalThis.Image;
        delete globalThis.Option;
    });

    test('adds a prepared image without a message when the references stay the same', async () => {
        const { host, container } = mountEditor({ enabled: true, references: [existingReference] });

        chooseImage(container);
        await finishPreparation();

        expect(host.onChange).toHaveBeenCalledTimes(1);
        expect(host.state.references.map(reference => reference.type)).toEqual(['style', 'character']);
        expect(statusLine(container).role).toBe('status');
    });

    test('drops an image prepared for references that the host replaced, and says why', async () => {
        const { host, container } = mountEditor({ enabled: true, references: [existingReference] });
        const replacement = { enabled: true, references: [{ ...existingReference, image: 'UkVQTEFDRUQ=' }] };

        chooseImage(container);
        host.state = replacement;
        await finishPreparation();

        expect(host.onChange).not.toHaveBeenCalled();
        expect(host.state).toBe(replacement);
        expect(statusLine(container)).toEqual({ role: 'alert', text: DROPPED_MESSAGE });
    });

    test('drops an image prepared while its container was out of the page, and says why when it is shown again', async () => {
        const { host, container, editor } = mountEditor({ enabled: true, references: [existingReference] });

        chooseImage(container);
        container.remove();
        await finishPreparation();
        fakeDocument.body.append(container);
        editor.refresh();

        expect(host.onChange).not.toHaveBeenCalled();
        expect(host.state.references).toEqual([existingReference]);
        expect(statusLine(container)).toEqual({ role: 'alert', text: DROPPED_MESSAGE });
    });
});
