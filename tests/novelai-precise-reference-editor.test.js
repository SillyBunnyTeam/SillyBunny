/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom unit tests. */
/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const loadStylesheetAsyncMock = jest.fn(() => Promise.resolve());

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));

jest.unstable_mockModule('../public/scripts/dynamic-styles.js', () => ({
    loadStylesheetAsync: loadStylesheetAsyncMock,
}));

const {
    PRECISE_REFERENCE_STYLESHEET_HREF,
    PRECISE_REFERENCE_STYLESHEET_ID,
    mountNovelAIPreciseReferenceEditor,
} = await import('../public/scripts/novelai-precise-reference-ui.js');

const DROPPED_MESSAGE = 'The images were not added because the references changed while they were prepared. Add them again.';
const EXISTING_PATH = '/user/files/sb-nai-ref-1111111111111111.png';
const existingReference = { path: EXISTING_PATH, bytes: 1024, type: 'style', strength: 0.5, fidelity: 0.5 };

let pendingImageLoads;
let uploads;
let deletes;

class FakeImage {
    set src(value) {
        if (!value) return;
        this.naturalWidth = 32;
        this.naturalHeight = 48;
        pendingImageLoads.push(() => this.onload?.());
    }
}

function createMockFetch() {
    return jest.fn(async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : {};
        if (url === '/api/files/upload') {
            uploads.push(body);
            return {
                ok: true,
                status: 200,
                json: async () => ({ path: `/user/files/${body.name}` }),
            };
        }
        if (url === '/api/files/delete') {
            deletes.push(body.path);
            return { ok: true, status: 200 };
        }
        return { ok: false, status: 404 };
    });
}

function mountEditor(initialState, { id = 'test_precise_reference_enabled', model = 'nai-diffusion-4-5-full', onRemoveFile, cloneOnSave = false } = {}) {
    const host = { state: initialState, model };
    host.onChange = jest.fn(next => {
        host.state = cloneOnSave ? JSON.parse(JSON.stringify(next)) : next;
    });
    const fetchFn = createMockFetch();
    const container = document.createElement('div');
    document.body.append(container);
    const editor = mountNovelAIPreciseReferenceEditor(container, {
        id,
        getState: () => host.state,
        onChange: host.onChange,
        getModel: () => host.model,
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
        onRemoveFile,
        fetchFn,
    });
    return { host, container, editor, fetchFn };
}

function chooseImage(container, files = [new File(['png'], 'ref.png', { type: 'image/png' })]) {
    const upload = container.querySelector('input[type="file"]');
    Object.defineProperty(upload, 'files', { configurable: true, value: files });
    upload.dispatchEvent(new Event('change'));
}

async function finishPreparation() {
    for (const load of pendingImageLoads.splice(0)) load();
    for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

function statusLine(container) {
    const status = container.querySelector('.nai-precise-reference__status [role]');
    return { role: status?.getAttribute('role') ?? null, text: status?.textContent ?? '' };
}

describe('NovelAI Precise Reference editor', () => {
    const originalImage = globalThis.Image;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;

    beforeEach(() => {
        pendingImageLoads = [];
        uploads = [];
        deletes = [];
        loadStylesheetAsyncMock.mockClear();
        document.body.replaceChildren();
        globalThis.Image = FakeImage;
        URL.createObjectURL = jest.fn(() => 'blob:reference');
        URL.revokeObjectURL = jest.fn();
        HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage() {} });
        HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,UFJFUEFSRUQ=';
        window.matchMedia = () => ({ matches: true });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        globalThis.Image = originalImage;
        URL.createObjectURL = originalCreateObjectURL;
        URL.revokeObjectURL = originalRevokeObjectURL;
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    });

    test('builds shared rows with a deterministic switch id and loads the stylesheet lazily via loadStylesheetAsync', () => {
        const { container } = mountEditor({ enabled: false, references: [] }, { id: 'sd_novel_precise_reference_enabled' });

        expect(container.getAttribute('data-sb-presentation')).toBe('manual');
        expect(container.querySelector('.ds-pref-group')).not.toBeNull();
        const toggle = container.querySelector('#sd_novel_precise_reference_enabled');
        expect(toggle).not.toBeNull();
        expect(toggle.getAttribute('role')).toBe('switch');
        expect(container.querySelector('.ds-pref-group-heading')?.textContent).toBe('Precise Reference');
        expect(container.querySelector('[data-sb-editor-field="novelai-precise-reference-add"]').disabled).toBe(true);
        expect(container.querySelector('input[type="file"]').disabled).toBe(true);
        expect(container.querySelector('.nai-precise-reference__status').classList.contains('sb-inline-hint')).toBe(true);
        expect(loadStylesheetAsyncMock).not.toHaveBeenCalled();

        // Toggling the switch keeps keyboard focus on the switch and loads the versioned stylesheet.
        toggle.focus();
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        expect(document.activeElement).toBe(toggle);
        expect(loadStylesheetAsyncMock).toHaveBeenCalledWith(PRECISE_REFERENCE_STYLESHEET_HREF, { id: PRECISE_REFERENCE_STYLESHEET_ID });
        expect(PRECISE_REFERENCE_STYLESHEET_HREF).toContain('?v=');
        expect(container.querySelector('fieldset, select, .menu_button')).toBeNull();
        expect(container.querySelector('.ds-button-row')).not.toBeNull();
        expect(container.querySelector('[data-sb-editor-field="novelai-precise-reference-add"]').disabled).toBe(false);
        expect(statusLine(container)).toEqual({ role: 'status', text: 'No references selected' });
    });

    test('keeps saved references in view and insensitive while the switch is off', () => {
        const { host, container } = mountEditor({ enabled: false, references: [existingReference] }, { cloneOnSave: true });

        const reference = container.querySelector('.ds-row-expander');
        expect(reference).not.toBeNull();
        expect(reference.querySelector('.ds-row-expander__toggle').disabled).toBe(true);
        expect(reference.querySelector('[data-sb-editor-field="novelai-precise-reference-remove"]').disabled).toBe(true);
        expect(container.querySelector('[data-sb-editor-field="novelai-precise-reference-add"]').disabled).toBe(true);
        expect(container.querySelector('.nai-precise-reference__status').hidden).toBe(true);
        // The thumbnails need the stylesheet even while the switch is off.
        expect(loadStylesheetAsyncMock).toHaveBeenCalledWith(PRECISE_REFERENCE_STYLESHEET_HREF, { id: PRECISE_REFERENCE_STYLESHEET_ID });

        const toggle = container.querySelector('#test_precise_reference_enabled');
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));

        expect(host.state.enabled).toBe(true);
        expect(container.querySelector('.ds-row-expander')).toBe(reference);
        expect(reference.querySelector('.ds-row-expander__toggle').disabled).toBe(false);
        expect(reference.querySelector('[data-sb-editor-field="novelai-precise-reference-remove"]').disabled).toBe(false);
        expect(container.querySelector('.nai-precise-reference__status').hidden).toBe(false);
    });

    test('names each Remove button and marks an error as a danger status line', async () => {
        const { container } = mountEditor({ enabled: true, references: [existingReference] });

        const remove = container.querySelector('.ds-row-expander__header [data-sb-editor-field="novelai-precise-reference-remove"]');
        expect(remove.localName).toBe('button');
        expect(remove.getAttribute('aria-label')).toBe('Remove Reference 1');
        expect(remove.title).toBe('Remove');

        chooseImage(container, [new File(['text'], 'notes.txt', { type: 'text/plain' })]);
        await finishPreparation();

        const status = container.querySelector('.nai-precise-reference__status');
        expect(status.classList.contains('sb-server-note')).toBe(true);
        expect(status.dataset.tone).toBe('danger');
        expect(statusLine(container).role).toBe('alert');
    });

    test('stores uploaded PNGs as user files and keeps references collapsed with live summaries', async () => {
        const { host, container } = mountEditor({ enabled: true, references: [existingReference] }, { cloneOnSave: true });

        const addButton = container.querySelector('[data-sb-editor-field="novelai-precise-reference-add"]');
        addButton.focus();
        chooseImage(container);
        await finishPreparation();

        expect(uploads).toHaveLength(1);
        expect(uploads[0].name).toMatch(/^sb-nai-ref-[0-9a-f]{16}\.png$/);
        expect(host.onChange).toHaveBeenCalledTimes(1);
        expect(host.state.references).toHaveLength(2);
        expect(host.state.references[1]).toEqual(expect.objectContaining({
            path: `/user/files/${uploads[0].name}`,
            type: 'character',
            strength: 1,
            fidelity: 1,
        }));
        expect(host.state.references[1]).not.toHaveProperty('image');
        expect(document.activeElement).toBe(addButton);

        const expanders = container.querySelectorAll('.ds-row-expander');
        expect(expanders).toHaveLength(2);
        expect(expanders[0].querySelector('.ds-row-expander__toggle').getAttribute('aria-expanded')).toBe('false');
        expect(expanders[0].querySelector('.ds-row-expander__toggle .ds-row-subtitle').textContent).toBe('Style • Strength 0.5 • Fidelity 0.5');
        expect(expanders[1].querySelector('.ds-row-expander__toggle').getAttribute('aria-expanded')).toBe('false');
        expect(expanders[1].querySelector('.ds-row-expander__toggle .ds-row-subtitle').textContent).toBe('Character • Strength 1 • Fidelity 1');
        expect(statusLine(container).role).toBe('status');
    });

    test('slider input previews live without saving settings, and change commits once while keeping focus', () => {
        const { host, container } = mountEditor({ enabled: true, references: [existingReference] }, { cloneOnSave: true });
        const toggleBtn = container.querySelector('.ds-row-expander__toggle');
        toggleBtn.click();
        expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');

        const strengthRow = container.querySelector('[data-sb-editor-field="novelai-precise-reference-strength"]');
        const range = strengthRow.querySelector('input[type="range"]');
        const number = strengthRow.querySelector('input[type="number"]');
        const summary = container.querySelector('.ds-row-expander__toggle .ds-row-subtitle');

        range.focus();
        range.value = '0.85';
        range.dispatchEvent(new Event('input', { bubbles: true }));
        expect(number.value).toBe('0.85');
        expect(summary.textContent).toBe('Style • Strength 0.85 • Fidelity 0.5');
        expect(host.onChange).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(range);

        range.dispatchEvent(new Event('change', { bubbles: true }));
        expect(host.onChange).toHaveBeenCalledTimes(1);
        expect(host.state.references[0].strength).toBe(0.85);
        expect(document.activeElement).toBe(range);
        expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');

        // Uncapped negative fidelity via numeric field stays supported.
        const fidelityNumber = container.querySelector('[data-sb-editor-field="novelai-precise-reference-fidelity"] input[type="number"]');
        fidelityNumber.focus();
        fidelityNumber.value = '-0.5';
        fidelityNumber.dispatchEvent(new Event('input', { bubbles: true }));
        expect(host.onChange).toHaveBeenCalledTimes(1);
        fidelityNumber.dispatchEvent(new Event('change', { bubbles: true }));
        expect(host.onChange).toHaveBeenCalledTimes(2);
        expect(host.state.references[0].fidelity).toBe(-0.5);
        expect(document.activeElement).toBe(fidelityNumber);
    });

    test('removing a reference moves focus to the next reference or Add button and delegates file cleanup', () => {
        const secondPath = '/user/files/sb-nai-ref-2222222222222222.png';
        const onRemoveFile = jest.fn();
        const { container } = mountEditor({
            enabled: true,
            references: [
                existingReference,
                { path: secondPath, bytes: 1024, type: 'character', strength: 1, fidelity: 1 },
            ],
        }, { onRemoveFile, cloneOnSave: true });

        const firstRemove = container.querySelectorAll('[data-sb-editor-field="novelai-precise-reference-remove"]')[0];
        firstRemove.focus();
        firstRemove.click();

        expect(onRemoveFile).toHaveBeenCalledWith(EXISTING_PATH);
        const remainingToggle = container.querySelector('.ds-row-expander__toggle');
        expect(document.activeElement).toBe(remainingToggle);

        const lastRemove = container.querySelector('[data-sb-editor-field="novelai-precise-reference-remove"]');
        lastRemove.focus();
        lastRemove.click();

        expect(onRemoveFile).toHaveBeenCalledWith(secondPath);
        const addButton = container.querySelector('[data-sb-editor-field="novelai-precise-reference-add"]');
        expect(document.activeElement).toBe(addButton);
    });

    test('drops an image prepared for references that the host replaced, cleans up its uploaded file, and says why', async () => {
        const { host, container } = mountEditor({ enabled: true, references: [existingReference] });
        const replacement = { enabled: true, references: [{ ...existingReference, path: '/user/files/sb-nai-ref-9999999999999999.png' }] };

        chooseImage(container);
        host.state = replacement;
        await finishPreparation();

        expect(host.onChange).not.toHaveBeenCalled();
        expect(host.state).toBe(replacement);
        expect(deletes).toEqual([`/user/files/${uploads[0].name}`]);
        expect(statusLine(container)).toEqual({ role: 'alert', text: DROPPED_MESSAGE });
    });

    test('drops an image prepared while its container was out of the page, cleans up its uploaded file, and says why when shown again', async () => {
        const { host, container, editor } = mountEditor({ enabled: true, references: [existingReference] });

        chooseImage(container);
        container.remove();
        await finishPreparation();
        document.body.append(container);
        editor.refresh();

        expect(host.onChange).not.toHaveBeenCalled();
        expect(host.state.references).toEqual([existingReference]);
        expect(deletes).toEqual([`/user/files/${uploads[0].name}`]);
        expect(statusLine(container)).toEqual({ role: 'alert', text: DROPPED_MESSAGE });
    });
});
