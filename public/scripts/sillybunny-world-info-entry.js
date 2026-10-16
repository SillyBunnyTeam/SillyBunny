import { characters } from '../script.js';
import { eventSource, event_types } from './events.js';
import { tags } from './tags.js';
import { t, translate } from './i18n.js';
import { getCurrentUserHandle } from './user.js';
import { getTokenCountAsync } from './tokenizers.js';
import * as model from './sillybunny-world-info-model.js';
import { createRow, createSwitchRow, createComboRow, createSpinRow, createEntryRow, createPropertyRow, createExpanderRow, createPrefGroup } from './sillybunny-editor/rows.js';
import { createChipEntry } from './sillybunny-editor/chip-entry.js';
import { mountEditorChrome, showDraftRecoveryToast, dismissDraftRecoveryToast } from './sillybunny-editor/chrome.js';
import { createEditorSession } from './sillybunny-editor/session.js';
import { createEditorDraftStore } from './sillybunny-editor/drafts.js';
import { mountEditorPreviews } from './sillybunny-editor/preview.js';

let nextEntryId = 0;

function element(tag, className = '', text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label, className = '') {
    const node = element('button', `menu_button ${className}`, label);
    node.type = 'button';
    return node;
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function fingerprint(entry) {
    return JSON.stringify(stableValue(Object.fromEntries(model.EDITABLE_KEYS.map(key => [key, entry[key]]))));
}

function snapshotOf(entry) {
    return stableValue(model.entryToDraft(entry));
}

export function worldInfoDraftKey(name, uid = '') {
    return `sb-wi-editor-draft-${getCurrentUserHandle() || 'default'}-${encodeURIComponent(name)}-${uid}`;
}

function revertUnsavedKeys(data, uid, previous, submitted, keys, setOriginal) {
    const live = data?.entries?.[uid];
    if (!live) return;
    const laterChanges = new Set(model.changedKeys(submitted, live, keys));
    const reverted = keys.filter(key => !laterChanges.has(key));
    for (const key of reverted) {
        if (Object.prototype.hasOwnProperty.call(previous, key)) live[key] = structuredClone(previous[key]);
        else delete live[key];
    }
    model.mirrorKeys(data, uid, reverted, setOriginal);
}

/** Schema-driven explicit-save detail for one entry in the tracked World Info book. */
export function mountWorldInfoEntry({ host, name, data, uid, deps, requestClose, onSaved = () => {}, onStateChange = () => {} }) {
    const initialEntry = data?.entries?.[uid];
    if (!initialEntry) throw new RangeError(`World Info entry ${uid} no longer exists`);
    const instanceId = `sb-wi-entry-${++nextEntryId}`;
    let bookName = name;
    let bookData = data;
    let entryUid = uid;
    let baseline = snapshotOf(initialEntry);
    let draft = snapshotOf(initialEntry);
    let destroyed = false;
    let bookDeleted = false;
    let missing = false;
    let conflict = false;
    let capturing = false;
    let tokenTimer = null;
    let tokenRequest = 0;
    let rescueSave = null;
    let chrome;
    let previews;
    let session;
    let lastState = { dirty: false, saving: false };
    const fields = new Map();
    const chips = [];
    const root = element('section', 'sb-wi-entry');
    const header = element('header', 'sb-wi-detail-header sb-wi-entry-header');
    const back = button(t`Back`, 'menu_button_icon sb-wi-detail-back');
    back.setAttribute('aria-label', t`Back`);
    back.title = t`Back`;
    const backIcon = element('i', 'fa-solid fa-chevron-left');
    backIcon.setAttribute('aria-hidden', 'true');
    back.replaceChildren(backIcon);
    const titleField = model.FIELDS.find(field => field.header);
    const title = element('input', 'sb-wi-entry-title');
    title.type = 'text';
    title.dataset.sbEditorField = titleField.id;
    title.setAttribute('aria-label', translate(titleField.label, titleField.i18n));
    const dirtyDot = element('span', 'sb-wi-entry-dirty', '•');
    dirtyDot.setAttribute('aria-label', t`Unsaved changes`);
    dirtyDot.hidden = true;
    const tokens = element('span', 'sb-wi-entry-tokens', `— ${t`tokens`}`);
    const cancel = element('button', 'sb-editor-action sb-editor-action--secondary sb-wi-entry-cancel', t`Cancel`);
    cancel.type = 'button';
    const saveButton = element('button', 'sb-editor-action sb-editor-action--primary sb-wi-entry-save', t`Save`);
    saveButton.type = 'button';
    const banner = element('div', 'sb-wi-entry-banner');
    banner.setAttribute('role', 'status');
    banner.hidden = true;
    const body = element('div', 'sb-wi-entry-body');
    header.append(back, title, dirtyDot, tokens, cancel, saveButton);
    root.append(header, banner, body);
    host.replaceChildren(root);

    const storage = createEditorDraftStore({
        keyFor: id => worldInfoDraftKey(bookName, id),
    });
    // The shared envelope stays unchanged; only this editor's storage payload carries the fingerprint.
    const drafts = {
        read(id) {
            const stored = storage.read(id);
            if (!stored) return null;
            const payload = stored.snapshot;
            if (payload.fingerprint !== fingerprint(baseline) || !payload.draft || typeof payload.draft !== 'object' || Array.isArray(payload.draft)) {
                storage.remove(id);
                console.debug('[sb-wi-editor] Discarded draft with a different baseline', bookName, id);
                return null;
            }
            return { ...stored, snapshot: payload.draft };
        },
        write(id, snapshot) {
            if (!bookDeleted) storage.write(id, { fingerprint: fingerprint(baseline), draft: snapshot });
        },
        remove: id => storage.remove(id),
    };

    function rekeyBook(nextName) {
        if (nextName === bookName) return;
        const id = String(entryUid);
        const stored = storage.read(id);
        storage.remove(id);
        bookName = nextName;
        if (stored && !bookDeleted) storage.write(id, stored.snapshot);
    }

    function captureSnapshot() {
        capturing = true;
        try {
            for (const chip of chips) chip.commitPending();
            return snapshotOf(draft);
        } finally {
            capturing = false;
        }
    }

    function restoreSnapshot(snapshot) {
        draft = snapshotOf(snapshot);
        for (const [id, field] of fields) field.setValue(model.readField(draft, id));
        refreshVisibility();
        previews?.reset();
        scheduleTokens();
    }

    function refreshVisibility() {
        for (const [id, field] of fields) field.setVisible(model.isFieldVisible(draft, id));
        const titleValue = model.readField(draft, titleField.id);
        if (title.value !== titleValue) title.value = titleValue;
        title.placeholder = model.entryTitle({ ...draft, comment: '' }, translate(titleField.placeholder, titleField.placeholderI18n));
    }

    function writeField(field, value) {
        model.writeField(draft, field.id, value);
        if (field.id === titleField.id) fields.get(field.id)?.setValue(model.readField(draft, field.id));
        refreshVisibility();
        if (field.control === 'content') scheduleTokens();
        if (!capturing) session?.changed({ immediate: true });
    }

    function renderState(state = session.getState()) {
        lastState = state;
        presentState(state);
    }

    function presentState(state) {
        if (destroyed) return;
        const dirty = state.dirty || chips.some(chip => chip.getPending().trim());
        const saving = state.saving || rescueSave !== null;
        chrome.render({ mode: 'edit', title: model.entryTitle(draft), dirty: Boolean(dirty), saving });
        saveButton.disabled ||= missing || bookDeleted;
        cancel.disabled ||= saving;
        root.setAttribute('aria-busy', String(saving));
        for (const control of banner.querySelectorAll('button')) control.disabled = saving || bookDeleted;
        onStateChange({ dirty: Boolean(dirty), saving });
    }

    function scheduleTokens() {
        clearTimeout(tokenTimer);
        const request = ++tokenRequest;
        tokenTimer = setTimeout(async () => {
            try {
                const count = await getTokenCountAsync(model.readField(draft, 'content'), 0);
                if (!destroyed && request === tokenRequest) tokens.textContent = `${count} ${t`tokens`}`;
            } catch {
                if (!destroyed && request === tokenRequest) tokens.textContent = `? ${t`tokens`}`;
            }
        }, 300);
    }

    function makeChips({ field, label, values, onChange, ...options }) {
        const chip = createChipEntry({
            field, label, values, onChange, ...options,
            removeLabel: value => t`Remove ${options.chipLabel?.(value) ?? value}`,
        });
        chips.push(chip);
        // Present pending edits without querying the session: snapshot capture intentionally commits chips.
        chip.input.addEventListener('input', () => { if (session) presentState(lastState); });
        const row = createRow({ field, label, stacked: true, suffix: chip.element });
        row.row.classList.add('sb-wi-entry-chip-row');
        return { ...row, setValue: value => chip.setValues(value) };
    }

    function createCharacterFilter(field, label) {
        let filter = model.readField(draft, field.id);
        const children = element('div', 'sb-wi-entry-filter-children');
        const update = () => {
            children.hidden = !filter.enabled;
            writeField(field, filter);
        };
        const enabled = createSwitchRow({ label, field: field.id, checked: filter.enabled, onChange: value => {
            // Disabling is lossless within the open draft; the persisted disabled state remains absent.
            filter.enabled = value;
            update();
        } });
        const names = makeChips({
            field: 'characterFilterNames', label: t`Characters`, values: filter.names,
            suggestions: () => characters.map(character => character.name).filter(Boolean),
            onChange: values => { filter.names = values; update(); },
        });
        const filterTags = makeChips({
            field: 'characterFilterTags', label: t`Tags`, values: filter.tags,
            suggestions: () => tags.map(tag => tag.name),
            normalize: value => tags.find(tag => tag.name === value)?.id ?? value.trim(),
            chipLabel: value => tags.find(tag => tag.id === value)?.name ?? value,
            onChange: values => { filter.tags = values; update(); },
        });
        const exclude = createSwitchRow({ label: t`Exclude`, field: 'characterFilterExclude', checked: filter.isExclude, onChange: value => {
            filter.isExclude = value;
            update();
        } });
        children.append(names.row, filterTags.row, exclude.row);
        const row = element('div', 'sb-wi-entry-filter');
        row.dataset.sbEditorField = field.id;
        row.append(enabled.row, children);
        children.hidden = !filter.enabled;
        return {
            row,
            setVisible: visible => { row.hidden = !visible; },
            setValue(value) {
                filter = value;
                enabled.setValue(filter.enabled);
                names.setValue(filter.names);
                filterTags.setValue(filter.tags);
                exclude.setValue(filter.isExclude);
                children.hidden = !filter.enabled;
            },
        };
    }

    function createContent(field, label) {
        const wrapper = element('div', 'ds-field sb-wi-entry-content');
        const toolbar = element('div', 'sb-wi-entry-content-toolbar');
        const caption = element('label', 'ds-row-label', label);
        const textarea = element('textarea', 'text_pole sb-wi-entry-textarea');
        textarea.id = `${instanceId}-content`;
        caption.htmlFor = textarea.id;
        textarea.placeholder = translate(field.placeholder, field.placeholderI18n);
        textarea.value = model.readField(draft, field.id);
        textarea.addEventListener('input', () => writeField(field, textarea.value));
        const toggle = element('span', 'sb-preview-toggle');
        toggle.dataset.sbPreviewFor = textarea.id;
        const pane = element('pre', 'sb-preview-pane sb-wi-entry-preview');
        pane.dataset.sbPreviewPane = textarea.id;
        pane.setAttribute('aria-label', label);
        pane.hidden = true;
        pane.tabIndex = 0;
        toolbar.append(caption, toggle);
        wrapper.append(toolbar, textarea, pane);
        const row = createRow({ field: field.id, label, stacked: true, suffix: wrapper });
        // Content already has an associated visible label beside its Edit/Preview toggle.
        row.row.querySelector('.ds-row-text').remove();
        return { ...row, setValue: value => { if (textarea.value !== value) textarea.value = value; } };
    }

    function createField(field) {
        const label = translate(field.label, field.i18n);
        const value = model.readField(draft, field.id);
        const options = { field: field.id, label, value, onChange: next => writeField(field, next) };
        switch (field.control) {
            case 'switch': return createSwitchRow({ ...options, checked: value });
            case 'combo': return createComboRow({ ...options, options: field.options.map(option => ({ ...option, label: translate(option.label, option.i18n) })) });
            case 'spin': {
                // rows.js normally clamps; the model alone owns legacy coercion (order is not clamped).
                const spin = createSpinRow({ ...options, nullable: true, step: 'any', placeholder: field.placeholder ? translate(field.placeholder, field.placeholderI18n) : '' });
                if (field.min !== undefined) spin.control.min = String(field.min);
                if (field.max !== undefined) spin.control.max = String(field.max);
                spin.control.addEventListener('input', () => writeField(field, spin.control.value));
                return spin;
            }
            case 'entry': return createEntryRow({ ...options, placeholder: field.placeholder ? translate(field.placeholder, field.placeholderI18n) : '', onInput: options.onChange });
            case 'property': return createPropertyRow(options);
            case 'content': return createContent(field, label);
            case 'character-filter': return createCharacterFilter(field, label);
            case 'chips': return makeChips({
                field: field.id, label, values: value, onChange: options.onChange,
                placeholder: field.placeholder ? translate(field.placeholder, field.placeholderI18n) : '',
                ...(field.split === 'keywords' ? { split: model.splitKeywords, chipClass: value => model.isRegexKeyword(value) ? 'sb-wi-entry-regex' : '' } : {}),
                ...(field.suggestions ? {
                    suggestions: () => field.suggestions.map(option => translate(option.label, option.i18n)),
                    normalize: value => field.suggestions.find(option => option.value === value || translate(option.label, option.i18n) === value)?.value ?? value.trim(),
                    chipLabel: value => {
                        const option = field.suggestions.find(option => option.value === value);
                        return option ? translate(option.label, option.i18n) : value;
                    },
                } : {}),
            });
            default: throw new RangeError(`Unknown World Info control: ${field.control}`);
        }
    }

    for (const section of model.SECTIONS) {
        const rows = model.FIELDS.filter(field => field.section === section.id).map(field => {
            const row = createField(field);
            fields.set(field.id, row);
            return row;
        });
        const title = section.title ? translate(section.title, section.i18n) : undefined;
        const group = section.expander
            ? createPrefGroup({ field: `section-${section.id}`, rows: [createExpanderRow({ label: title, field: `expander-${section.id}`, children: rows })] })
            : createPrefGroup({ title, field: `section-${section.id}`, rows });
        body.append(group.section);
    }

    function renderBanner() {
        banner.replaceChildren();
        banner.hidden = !missing && !conflict;
        if (banner.hidden) return;
        // HUMAN: replace — external-change/deleted-entry explanation.
        banner.append(element('span', 'sb-wi-entry-banner-message', t`lorum ipsum`));
        const actions = element('div', 'sb-wi-entry-banner-actions');
        if (missing) {
            // HUMAN: replace — Save as new entry.
            const rescue = button(t`lorum ipsum`, 'sb-wi-entry-save-as-new');
            rescue.disabled = bookDeleted;
            rescue.addEventListener('click', () => { void saveAsNew(); });
            actions.append(rescue);
        } else {
            const reload = button(t`Reload`, 'sb-wi-entry-reload');
            // HUMAN: replace — Keep mine.
            const keep = button(t`lorum ipsum`, 'sb-wi-entry-keep-mine');
            reload.addEventListener('click', reloadLive);
            keep.addEventListener('click', () => {
                const live = bookData.entries[entryUid];
                if (!live) return sync({ name: bookName, data: bookData });
                // Acknowledge external keys without overwriting values the user edited.
                const next = snapshotOf(live);
                for (const key of model.externalChanges(next, baseline)) model.rebaseKey(next, baseline, draft, key);
                baseline = next;
                session.rebase(snapshotOf(baseline));
                conflict = false;
                restoreSnapshot(draft);
                renderBanner();
            });
            actions.append(reload, keep);
        }
        banner.append(actions);
    }

    function reloadLive() {
        const live = bookData?.entries?.[entryUid];
        if (!live) return;
        dismissDraftRecoveryToast();
        baseline = snapshotOf(live);
        restoreSnapshot(baseline);
        conflict = false;
        missing = false;
        session.rebase(snapshotOf(baseline));
        storage.remove(String(entryUid));
        renderBanner();
    }

    function showSaveError() {
        // HUMAN: replace — no existing generic save-failure translation fits a World Info entry.
        toastr.error(t`lorum ipsum`);
    }

    function acceptSave(receipt, result, savedUid = entryUid) {
        if (!receipt.isCurrent()) return;
        rekeyBook(result.name);
        const live = snapshotOf(bookData.entries[savedUid]);
        const submitted = snapshotOf(receipt.snapshot);
        const savedKeys = new Set([...Object.keys(live), ...Object.keys(submitted)]);
        for (const key of savedKeys) model.rebaseKey(live, submitted, draft, key);
        entryUid = savedUid;
        draft.uid = savedUid;
        baseline = snapshotOf(live);
        missing = false;
        conflict = false;
        restoreSnapshot(draft);
        receipt.markSaved({ entityId: String(savedUid) }, snapshotOf(baseline));
        renderBanner();
        onSaved({ name: bookName, uid: savedUid });
    }

    async function persist(receipt) {
        if (missing || bookDeleted) return;
        const data = bookData;
        const uid = entryUid;
        const previous = model.entryToDraft(data.entries[uid]);
        const keys = model.changedKeys(baseline, receipt.snapshot);
        let committed = false;
        try {
            model.applyDraft(data, uid, baseline, receipt.snapshot, { setOriginal: deps.setOriginal });
            const result = await model.commit(deps, bookName, data);
            committed = result.ok;
            if (!result.ok) {
                if (receipt.isCurrent()) showSaveError();
                return;
            }
            acceptSave(receipt, result);
        } catch {
            if (receipt.isCurrent()) showSaveError();
        } finally {
            if (!committed) revertUnsavedKeys(data, uid, previous, receipt.snapshot, keys, deps.setOriginal);
        }
    }

    function saveAsNew() {
        if (rescueSave) return rescueSave;
        if (destroyed || bookDeleted || session.getState().saving) return Promise.resolve(false);
        const receipt = session.captureSaveReceipt();
        const data = bookData;
        const name = bookName;
        rescueSave = Promise.resolve().then(async () => {
            let provisional;
            let committed = false;
            try {
                const result = await model.createEntry({
                    ...deps,
                    createEntry: (...args) => { provisional = deps.createEntry(...args); return provisional; },
                }, name, data, receipt.snapshot);
                committed = result.ok;
                if (!result.ok) {
                    if (receipt.isCurrent()) showSaveError();
                    return false;
                }
                acceptSave(receipt, result, result.entry.uid);
                return !session.isDirty();
            } catch {
                if (receipt.isCurrent()) showSaveError();
                return false;
            } finally {
                if (!committed && provisional && data.entries[provisional.uid] === provisional) {
                    delete data.entries[provisional.uid];
                    deps.deleteOriginal(data, provisional.uid);
                }
            }
        }).finally(() => {
            rescueSave = null;
            renderState();
        });
        renderState();
        return rescueSave;
    }

    function save() {
        if (destroyed || missing || bookDeleted) return Promise.resolve(false);
        return session.save();
    }

    function discard() {
        session.discard();
        conflict = false;
        renderBanner();
    }

    function sync({ name, data }) {
        if (destroyed) return;
        rekeyBook(name);
        bookData = data;
        const live = data?.entries?.[entryUid];
        missing = !live;
        if (!missing && !session.getState().saving && rescueSave === null) {
            if (!session.isDirty()) {
                if (JSON.stringify(snapshotOf(live)) !== JSON.stringify(baseline)) reloadLive();
                conflict = false;
            } else {
                conflict = model.externalChanges(snapshotOf(live), baseline).length > 0;
                if (conflict) dismissDraftRecoveryToast();
            }
        }
        renderBanner();
        renderState();
    }

    function rebaseKey(key) {
        const live = bookData?.entries?.[entryUid];
        if (!live || destroyed) return;
        captureSnapshot();
        model.rebaseKey(snapshotOf(live), baseline, draft, key);
        restoreSnapshot(draft);
        session.rebase(snapshotOf(baseline));
        conflict = model.externalChanges(snapshotOf(live), baseline).length > 0;
        renderBanner();
    }

    const onKeydown = event => {
        if (event.isComposing) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            event.stopPropagation();
            void save();
            return;
        }
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        const field = event.target.closest('input, textarea, select, [contenteditable="true"]');
        if (field) {
            field.blur();
            root.focus({ preventScroll: true });
        } else requestClose();
    };
    const onBookDeleted = deletedName => {
        if (deletedName !== bookName) return;
        bookDeleted = true;
        missing = true;
        storage.remove(String(entryUid));
        dismissDraftRecoveryToast();
        renderBanner();
        renderState();
    };
    const onBookRenamed = (oldName, newName) => {
        if (oldName === bookName) rekeyBook(newName);
    };
    const flushDraft = () => session.flushDraft();

    root.tabIndex = -1;
    root.addEventListener('keydown', onKeydown, true);
    title.addEventListener('input', () => writeField(titleField, title.value));
    eventSource.on(event_types.WORLDINFO_DELETED, onBookDeleted);
    eventSource.on(event_types.WORLDINFO_RENAMED, onBookRenamed);
    window.addEventListener('pagehide', flushDraft);
    previews = mountEditorPreviews(root, (textarea, pane) => { pane.textContent = textarea.value; });
    chrome = mountEditorChrome({
        root, header, content: body, controls: { back, title, dirty: dirtyDot, cancel, save: saveButton },
        onBack: () => requestClose(), onCancel: discard, onSave: () => { void save(); },
    });
    session = createEditorSession({ captureSnapshot, restoreSnapshot, persist, drafts, offerDraft: showDraftRecoveryToast, onStateChange: renderState });
    refreshVisibility();
    session.open({ mode: 'edit', entityId: String(entryUid) });
    scheduleTokens();

    return {
        isDirty: () => !destroyed && session.isDirty(),
        save,
        discard,
        sync,
        rebaseKey,
        focusTarget: () => destroyed ? null : title,
        destroy({ keepDraft = false } = {}) {
            if (destroyed) return;
            if (keepDraft) session.flushDraft();
            else storage.remove(String(entryUid));
            session.close();
            destroyed = true;
            clearTimeout(tokenTimer);
            tokenRequest++;
            chrome.dispose();
            previews.dispose();
            for (const chip of chips) chip.destroy();
            dismissDraftRecoveryToast();
            eventSource.removeListener(event_types.WORLDINFO_DELETED, onBookDeleted);
            eventSource.removeListener(event_types.WORLDINFO_RENAMED, onBookRenamed);
            window.removeEventListener('pagehide', flushDraft);
            root.removeEventListener('keydown', onKeydown, true);
            root.remove();
        },
    };
}
