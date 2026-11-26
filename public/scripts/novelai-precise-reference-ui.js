import { loadStylesheetAsync } from './dynamic-styles.js';
import { t } from './i18n.js';
import {
    MAX_PRECISE_REFERENCES,
    MAX_PRECISE_REFERENCE_BYTES,
    PRECISE_REFERENCE_FILE_PREFIX,
    getNovelAIPreciseReferenceByteSize,
    getNovelAIPreciseReferenceSize,
    normalizeNovelAIPreciseReferencePath,
    supportsNovelAIPreciseReference,
} from './novelai-precise-reference.js';
import {
    createButtonRow,
    createExpanderRow,
    createPrefGroup,
    createSwitchRow,
    releaseRowIds,
} from './sillybunny-editor/rows.js';
import { createToggleRow } from './sillybunny-editor/toggle-row.js';

export const PRECISE_REFERENCE_STYLESHEET_HREF = '/css/novelai-precise-reference.css?v=20261125a';
export const PRECISE_REFERENCE_STYLESHEET_ID = 'novelai-precise-reference-css';

let nextSliderId = 0;

function randomHex(byteCount = 8) {
    const bytes = new Uint8Array(byteCount);
    if (globalThis.crypto?.getRandomValues) {
        globalThis.crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function base64ByteLength(base64) {
    const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function defaultRequestHeaders() {
    return globalThis.SillyTavern?.getContext?.()?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' };
}

function ensureStylesheet() {
    const loader = globalThis.SillyBunnyAssets?.loadStylesheetAsync ?? loadStylesheetAsync;
    return Promise.resolve(loader(PRECISE_REFERENCE_STYLESHEET_HREF, { id: PRECISE_REFERENCE_STYLESHEET_ID })).catch(error => {
        console.warn('Failed to load the NovelAI Precise Reference stylesheet:', error);
    });
}

function setStaticI18n(node, key) {
    if (node instanceof HTMLElement && key) node.dataset.i18n = key;
}

function previewSourceOf(reference) {
    const path = normalizeNovelAIPreciseReferencePath(reference?.path);
    if (path) return path;
    if (typeof reference?.image === 'string' && reference.image) return `data:image/png;base64,${reference.image}`;
    return '';
}

function referenceTypeLabel(type) {
    if (type === 'style') return t`Style`;
    if (type === 'character&style') return t`Character & Style`;
    return t`Character`;
}

function formatSummaryValue(value) {
    return Number.isFinite(value) ? String(Number(value.toFixed(3))) : '0';
}

function formatReferenceSummary(reference) {
    const typeLabel = referenceTypeLabel(reference?.type);
    const strength = formatSummaryValue(reference?.strength);
    const fidelity = formatSummaryValue(reference?.fidelity);
    return t`${typeLabel} • Strength ${strength} • Fidelity ${fidelity}`;
}

function referenceBaseKey(reference) {
    const path = normalizeNovelAIPreciseReferencePath(reference?.path);
    if (path) return `path:${path}`;
    if (typeof reference?.image === 'string' && reference.image) return `inline:${reference.image.slice(0, 48)}`;
    return 'empty';
}

/** Prepares the provider's fixed-size, black-padded PNG without cropping the reference. */
export async function prepareNovelAIPreciseReference(file) {
    if (!file.type.startsWith('image/') || file.size > MAX_PRECISE_REFERENCE_BYTES) {
        throw new Error(t`Choose an image smaller than 25 MiB`);
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error(t`Unable to read this image. Choose a PNG, JPEG, or WebP file.`));
            image.src = url;
        });
        const { width, height } = getNovelAIPreciseReferenceSize(image.naturalWidth, image.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
        const drawnWidth = Math.round(image.naturalWidth * scale);
        const drawnHeight = Math.round(image.naturalHeight * scale);
        context.fillStyle = '#000000'; // NovelAI's reference encoder requires black padding.
        context.fillRect(0, 0, width, height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, Math.floor((width - drawnWidth) / 2), Math.floor((height - drawnHeight) / 2), drawnWidth, drawnHeight);
        return canvas.toDataURL('image/png').split(',')[1];
    } finally {
        URL.revokeObjectURL(url);
        image.src = '';
    }
}

/** Stores a prepared PNG as a user file so settings.json only carries its path and controls. */
export async function uploadNovelAIPreciseReference(base64Png, { fetchFn = globalThis.fetch, getRequestHeaders = defaultRequestHeaders } = {}) {
    if (typeof fetchFn !== 'function') throw new Error(t`Failed to store the reference image`);
    const name = `${PRECISE_REFERENCE_FILE_PREFIX}${randomHex(8)}.png`;
    const response = await fetchFn('/api/files/upload', {
        method: 'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, data: base64Png }),
    });
    if (!response?.ok) throw new Error(t`Failed to store the reference image`);
    const payload = await response.json();
    const path = normalizeNovelAIPreciseReferencePath(payload?.path);
    if (!path) throw new Error(t`Failed to store the reference image`);
    return { path, bytes: base64ByteLength(base64Png) };
}

/** Best-effort deletion of a stored Precise Reference PNG under /user/files/. */
export async function deleteNovelAIPreciseReferenceFile(filePath, { fetchFn = globalThis.fetch, getRequestHeaders = defaultRequestHeaders } = {}) {
    const normalized = normalizeNovelAIPreciseReferencePath(filePath);
    if (!normalized || typeof fetchFn !== 'function') return false;
    try {
        const response = await fetchFn('/api/files/delete', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: normalized }),
        });
        return Boolean(response?.ok || response?.status === 404);
    } catch {
        return false;
    }
}

function createSliderRow({ label, i18nKey, field, value, onPreview, onCommit }) {
    const row = document.createElement('div');
    row.className = 'ds-row ds-row-slider';
    row.dataset.sbEditorField = field;

    const range = document.createElement('input');
    range.type = 'range';
    range.className = 'neo-range-slider';
    range.min = '0';
    range.max = '1';
    range.step = '0.05';
    range.id = `sb-nai-ref-slider-${++nextSliderId}`;

    const number = document.createElement('input');
    number.type = 'number';
    number.className = 'text_pole neo-range-input';
    number.step = 'any';
    number.inputMode = 'decimal';

    const text = document.createElement('span');
    text.className = 'ds-row-text';
    const caption = document.createElement('label');
    caption.className = 'ds-row-label';
    caption.htmlFor = range.id;
    caption.textContent = label;
    setStaticI18n(caption, i18nKey);
    text.append(caption);

    const suffix = document.createElement('span');
    suffix.className = 'ds-row-suffix';
    suffix.append(range, number);

    row.append(text, suffix);

    let committed = Number.isFinite(value) ? value : 1;
    const clampRange = next => String(Math.min(1, Math.max(0, next)));
    const writeInputs = next => {
        range.value = clampRange(next);
        number.value = String(next);
    };
    writeInputs(committed);

    range.addEventListener('input', () => {
        const next = range.valueAsNumber;
        if (!Number.isFinite(next) || !range.checkValidity()) return;
        number.value = range.value;
        onPreview(next);
    });
    range.addEventListener('change', () => {
        const next = range.valueAsNumber;
        if (!Number.isFinite(next) || !range.checkValidity()) {
            writeInputs(committed);
            return;
        }
        committed = next;
        number.value = range.value;
        onCommit(next);
    });

    number.addEventListener('input', () => {
        const next = number.valueAsNumber;
        if (!Number.isFinite(next) || !number.checkValidity()) return;
        range.value = clampRange(next);
        onPreview(next);
    });
    number.addEventListener('change', () => {
        const next = number.valueAsNumber;
        if (!Number.isFinite(next) || !number.checkValidity()) {
            writeInputs(committed);
            onPreview(committed);
            return;
        }
        committed = next;
        range.value = clampRange(next);
        onCommit(next);
    });

    return {
        row,
        range,
        number,
        setValue(next) {
            if (!Number.isFinite(next)) return;
            committed = next;
            if (document.activeElement !== range) range.value = clampRange(next);
            if (document.activeElement !== number) number.value = String(next);
        },
        setReferenceNumber(referenceNumber) {
            const name = field === 'novelai-precise-reference-strength'
                ? t`Strength for Reference ${referenceNumber}`
                : t`Fidelity for Reference ${referenceNumber}`;
            range.setAttribute('aria-label', name);
            number.setAttribute('aria-label', name);
        },
        setDisabled(disabled) {
            const insensitive = Boolean(disabled);
            range.disabled = insensitive;
            number.disabled = insensitive;
            row.setAttribute('aria-disabled', String(insensitive));
            row.classList.toggle('is-insensitive', insensitive);
        },
        destroy() {
            releaseRowIds(row);
            row.remove();
        },
    };
}

/** Shared editor; each generation surface owns and persists its own reference state. */
export function mountNovelAIPreciseReferenceEditor(container, {
    id,
    getState,
    onChange,
    getModel,
    getRequestHeaders = defaultRequestHeaders,
    onRemoveFile,
    fetchFn = globalThis.fetch,
}) {
    container.classList.add('nai-precise-reference');
    container.setAttribute('data-sb-presentation', 'manual');
    let busy = false;
    let error = '';
    let destroyed = false;

    function state() {
        const current = getState() || {};
        return { enabled: current.enabled === true, references: Array.isArray(current.references) ? current.references : [] };
    }

    function save(next) {
        onChange(next);
        error = '';
    }

    function updateReference(index, field, value) {
        const current = state();
        save({
            ...current,
            references: current.references.map((reference, i) => (i === index ? { ...reference, [field]: value } : reference)),
        });
    }

    // A dependent set: the group takes the switch's title, and the rows after the switch stay in view, insensitive while it is off.
    const prefGroup = createPrefGroup({ title: t`Precise Reference`, field: 'novelai-precise-reference', headingLevel: 4 });
    setStaticI18n(prefGroup.section.querySelector('.ds-pref-group-heading'), 'Precise Reference');

    const switchRow = createSwitchRow({
        id,
        label: t`Precise Reference`,
        subtitle: ' ',
        field: 'novelai-precise-reference-enabled',
        checked: false,
        onChange: checked => {
            save({ ...state(), enabled: checked });
            refresh();
        },
    });
    setStaticI18n(switchRow.row.querySelector('.ds-row-label'), 'Precise Reference');
    const switchSubtitle = switchRow.row.querySelector('.ds-row-subtitle');
    // Built-in extension pages bind Enter on switches in settings presentation, while QIG does not.
    switchRow.control.addEventListener('keydown', event => {
        if (event.defaultPrevented || event.key !== 'Enter' || event.repeat || switchRow.control.disabled) return;
        event.preventDefault();
        switchRow.control.click();
    });
    prefGroup.append(switchRow);

    const upload = document.createElement('input');
    upload.type = 'file';
    upload.accept = 'image/png,image/jpeg,image/webp,image/avif,image/gif';
    upload.multiple = true;
    upload.hidden = true;
    upload.setAttribute('aria-label', t`Add Reference Images…`);

    const addRow = createButtonRow({
        label: t`Add Reference Images…`,
        icon: 'plus',
        field: 'novelai-precise-reference-add',
        onActivate: () => upload.click(),
    });
    const addLabel = addRow.row.querySelector('.ds-row-label');

    const statusRow = document.createElement('div');
    statusRow.className = 'ds-row nai-precise-reference__status';
    statusRow.dataset.sbEditorField = 'novelai-precise-reference-status';
    const statusText = document.createElement('span');
    statusText.setAttribute('role', 'status');
    statusRow.append(statusText);

    /** @type {Map<string, object>} */
    const itemEntries = new Map();
    let listMounted = false;

    upload.addEventListener('change', async () => {
        const files = Array.from(upload.files || []);
        upload.value = '';
        if (!files.length) return;
        const originalReferences = state().references;
        const restoreFocus = container.contains(document.activeElement);
        const uploadedPaths = [];
        busy = true;
        error = '';
        refresh();
        try {
            if (originalReferences.length + files.length > MAX_PRECISE_REFERENCES) {
                throw new Error(t`Precise Reference supports up to 16 images`);
            }
            const prepared = [];
            let bytes = originalReferences.reduce((sum, reference) => sum + getNovelAIPreciseReferenceByteSize(reference), 0);
            for (const file of files) {
                const image = await prepareNovelAIPreciseReference(file);
                const imageBytes = base64ByteLength(image);
                bytes += imageBytes;
                if (bytes > MAX_PRECISE_REFERENCE_BYTES) {
                    throw new Error(t`Reference images are limited to 25 MiB total. Remove a reference before adding more.`);
                }
                const stored = await uploadNovelAIPreciseReference(image, { fetchFn, getRequestHeaders });
                uploadedPaths.push(stored.path);
                prepared.push({ path: stored.path, bytes: stored.bytes, type: 'character', strength: 1, fidelity: 1 });
            }
            if (container.isConnected && state().references === originalReferences) {
                const latest = state();
                save({ ...latest, references: [...latest.references, ...prepared] });
            } else {
                await Promise.all(uploadedPaths.map(filePath => deleteNovelAIPreciseReferenceFile(filePath, { fetchFn, getRequestHeaders })));
                error = t`The images were not added because the references changed while they were prepared. Add them again.`;
            }
        } catch (cause) {
            if (uploadedPaths.length) {
                await Promise.all(uploadedPaths.map(filePath => deleteNovelAIPreciseReferenceFile(filePath, { fetchFn, getRequestHeaders })));
            }
            error = cause.message;
        } finally {
            busy = false;
            if (!destroyed) {
                refresh();
                if (restoreFocus && container.isConnected) {
                    if (!addRow.row.disabled) addRow.row.focus({ preventScroll: true });
                    else if (!switchRow.control.disabled) switchRow.control.focus({ preventScroll: true });
                }
            }
        }
    });

    function createReferenceItem(reference, initialIndex, initialDisabled) {
        const item = {
            index: initialIndex,
            previewState: {
                type: reference.type,
                strength: reference.strength,
                fidelity: reference.fidelity,
            },
            src: '',
            expander: null,
        };

        const previewRow = document.createElement('div');
        previewRow.className = 'ds-row nai-precise-reference__preview-row';
        const preview = document.createElement('img');
        preview.className = 'nai-precise-reference__preview';
        preview.decoding = 'async';
        previewRow.append(preview);

        const typeRow = createToggleRow({
            label: t`Reference Type`,
            field: 'novelai-precise-reference-type',
            fill: true,
            choices: [
                ['character', t`Character`],
                ['style', t`Style`],
                ['character&style', t`Character & Style`],
            ],
            value: reference.type,
            onChange: value => {
                item.previewState.type = value;
                summaryEl.textContent = formatReferenceSummary(item.previewState);
                updateReference(item.index, 'type', value);
            },
        });
        setStaticI18n(typeRow.row.querySelector('.ds-row-label'), 'Reference Type');

        const strengthRow = createSliderRow({
            label: t`Strength`,
            i18nKey: 'Strength',
            field: 'novelai-precise-reference-strength',
            value: reference.strength,
            onPreview: value => {
                item.previewState.strength = value;
                summaryEl.textContent = formatReferenceSummary(item.previewState);
            },
            onCommit: value => {
                item.previewState.strength = value;
                summaryEl.textContent = formatReferenceSummary(item.previewState);
                updateReference(item.index, 'strength', value);
            },
        });

        const fidelityRow = createSliderRow({
            label: t`Fidelity`,
            i18nKey: 'Fidelity',
            field: 'novelai-precise-reference-fidelity',
            value: reference.fidelity,
            onPreview: value => {
                item.previewState.fidelity = value;
                summaryEl.textContent = formatReferenceSummary(item.previewState);
            },
            onCommit: value => {
                item.previewState.fidelity = value;
                summaryEl.textContent = formatReferenceSummary(item.previewState);
                updateReference(item.index, 'fidelity', value);
            },
        });

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'nai-precise-reference__remove';
        removeButton.dataset.sbEditorField = 'novelai-precise-reference-remove';
        removeButton.title = t`Remove`;
        setStaticI18n(removeButton, '[title]Remove');
        const removeGlyph = document.createElement('i');
        removeGlyph.className = 'fa-solid fa-trash-can';
        removeGlyph.setAttribute('aria-hidden', 'true');
        removeButton.append(removeGlyph);
        removeButton.addEventListener('click', () => {
            const removedIndex = item.index;
            const latest = state();
            const removed = latest.references[removedIndex];
            const remaining = latest.references.filter((_, i) => i !== removedIndex);
            save({ ...latest, references: remaining });
            refresh();
            const targetIndex = Math.min(removedIndex, remaining.length - 1);
            const ordered = [...itemEntries.values()];
            const nextFocus = targetIndex >= 0 ? ordered[targetIndex]?.expander.toggle : addRow.row;
            nextFocus?.focus({ preventScroll: true });
            const removedPath = normalizeNovelAIPreciseReferencePath(removed?.path);
            if (removedPath) {
                if (typeof onRemoveFile === 'function') {
                    Promise.resolve(onRemoveFile(removedPath)).catch(cause => {
                        console.warn('Failed to clean up removed NovelAI Precise Reference file:', cause);
                    });
                } else if (!remaining.some(ref => normalizeNovelAIPreciseReferencePath(ref?.path) === removedPath)) {
                    void deleteNovelAIPreciseReferenceFile(removedPath, { fetchFn, getRequestHeaders });
                }
            }
        });

        const expander = createExpanderRow({
            label: t`Reference ${initialIndex + 1}`,
            subtitle: formatReferenceSummary(reference),
            field: 'novelai-precise-reference-item',
            open: false,
            children: [previewRow, typeRow, strengthRow, fidelityRow],
            suffix: removeButton,
        });

        const thumb = document.createElement('img');
        thumb.className = 'nai-precise-reference__thumb';
        thumb.alt = '';
        thumb.decoding = 'async';
        thumb.loading = 'lazy';
        expander.toggle.prepend(thumb);

        const titleEl = expander.toggle.querySelector('.ds-row-label');
        const summaryEl = expander.toggle.querySelector('.ds-row-subtitle');
        item.expander = expander;

        item.sync = (nextReference, index, disabled) => {
            item.index = index;
            const referenceNumber = index + 1;
            const title = t`Reference ${referenceNumber}`;
            titleEl.textContent = title;
            preview.alt = title;

            item.previewState.type = nextReference.type;
            if (document.activeElement !== strengthRow.range && document.activeElement !== strengthRow.number) {
                item.previewState.strength = nextReference.strength;
            }
            if (document.activeElement !== fidelityRow.range && document.activeElement !== fidelityRow.number) {
                item.previewState.fidelity = nextReference.fidelity;
            }
            summaryEl.textContent = formatReferenceSummary(item.previewState);

            const src = previewSourceOf(nextReference);
            if (item.src !== src) {
                item.src = src;
                thumb.src = src;
                preview.src = src;
            }

            typeRow.setValue(nextReference.type);
            typeRow.setDisabled(disabled);
            strengthRow.setValue(nextReference.strength);
            strengthRow.setReferenceNumber(referenceNumber);
            strengthRow.setDisabled(disabled);
            fidelityRow.setValue(nextReference.fidelity);
            fidelityRow.setReferenceNumber(referenceNumber);
            fidelityRow.setDisabled(disabled);
            removeButton.setAttribute('aria-label', t`Remove Reference ${referenceNumber}`);
            removeButton.disabled = Boolean(disabled);
            expander.setDisabled(disabled);
            expander.toggle.disabled = Boolean(disabled);
        };

        item.destroy = () => {
            typeRow.destroy();
            strengthRow.destroy();
            fidelityRow.destroy();
            expander.destroy();
        };

        item.sync(reference, initialIndex, initialDisabled);
        return item;
    }

    function unmountList() {
        for (const entry of itemEntries.values()) entry.destroy();
        itemEntries.clear();
        if (listMounted) {
            addRow.row.remove();
            statusRow.remove();
            upload.remove();
            listMounted = false;
        }
    }

    function refresh() {
        if (destroyed) return;
        const current = state();
        const supported = supportsNovelAIPreciseReference(getModel());

        switchRow.setValue(current.enabled);
        switchRow.setDisabled(busy);
        if (switchSubtitle) {
            const noteKey = supported
                ? '5 additional Anlas per reference, per image. Not compatible with Vibe Transfer.'
                : 'Precise Reference requires NovelAI V4.5. Saved references are retained when switching models.';
            switchSubtitle.textContent = supported
                ? t`5 additional Anlas per reference, per image. Not compatible with Vibe Transfer.`
                : t`Precise Reference requires NovelAI V4.5. Saved references are retained when switching models.`;
            setStaticI18n(switchSubtitle, noteKey);
        }

        // The stylesheet styles only the reference rows and the status line, so an empty list with the switch off does not request it.
        if (current.enabled || current.references.length) void ensureStylesheet();

        if (!listMounted) {
            prefGroup.group.append(addRow.row, statusRow);
            container.append(upload);
            listMounted = true;
        }

        const insensitive = busy || !current.enabled;
        upload.disabled = insensitive || !supported;
        addRow.setDisabled(insensitive || !supported);
        if (addLabel) {
            addLabel.textContent = busy ? t`Preparing References…` : t`Add Reference Images…`;
            setStaticI18n(addLabel, busy ? 'Preparing References…' : 'Add Reference Images…');
        }

        const occurrences = new Map();
        const nextEntries = new Map();
        const orderedNodes = [];
        current.references.forEach((reference, index) => {
            const base = referenceBaseKey(reference);
            const seen = occurrences.get(base) ?? 0;
            occurrences.set(base, seen + 1);
            const key = `${base}#${seen}`;
            let entry = itemEntries.get(key);
            if (!entry) {
                entry = createReferenceItem(reference, index, insensitive);
            } else {
                itemEntries.delete(key);
                entry.sync(reference, index, insensitive);
            }
            nextEntries.set(key, entry);
            orderedNodes.push(entry.expander.row);
        });

        for (const stale of itemEntries.values()) stale.destroy();
        itemEntries.clear();
        for (const [key, entry] of nextEntries) itemEntries.set(key, entry);

        // Reorder without detaching already-in-place nodes so active focus stays intact.
        let cursor = switchRow.row.nextSibling;
        for (const node of orderedNodes) {
            if (node !== cursor) {
                prefGroup.group.insertBefore(node, cursor ?? addRow.row);
            }
            cursor = node.nextSibling;
        }

        // A message is a status line, and an empty list a centred hint. The cost applies only while the switch is on.
        const hint = !error && !current.references.length;
        statusRow.hidden = !error && !hint && !current.enabled;
        statusRow.classList.toggle('sb-server-note', !hint);
        statusRow.classList.toggle('sb-inline-hint', hint);
        if (error) statusRow.dataset.tone = 'danger';
        else delete statusRow.dataset.tone;
        statusText.setAttribute('role', error ? 'alert' : 'status');
        if (error) {
            delete statusText.dataset.i18n;
            statusText.textContent = error;
        } else if (current.references.length) {
            delete statusText.dataset.i18n;
            const cost = current.references.length * 5;
            statusText.textContent = t`Additional cost: ${cost} Anlas per image. Multiple character references blend together.`;
        } else {
            statusText.textContent = t`No references selected`;
            setStaticI18n(statusText, 'No references selected');
        }
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        unmountList();
        switchRow.destroy();
        addRow.destroy();
        prefGroup.destroy();
        releaseRowIds(container);
    }

    container.replaceChildren(prefGroup.section);
    refresh();
    return { refresh, destroy };
}
