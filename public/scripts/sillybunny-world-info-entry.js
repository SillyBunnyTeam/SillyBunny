import { characters } from '../script.js';
import { eventSource, event_types } from './events.js';
import { tags } from './tags.js';
import { t, translate } from './i18n.js';
import { getCurrentUserHandle } from './user.js';
import { getTokenCountAsync } from './tokenizers.js';
import * as model from './sillybunny-world-info-model.js';
import { createRow, createSwitchRow, createComboRow, createSpinRow, createEntryRow, createPropertyRow, createExpanderRow, createPrefGroup, releaseRowIds } from './sillybunny-editor/rows.js';
import { createChipEntry } from './sillybunny-editor/chip-entry.js';
import { mountEditorChrome, showDraftRecoveryToast, dismissDraftRecoveryToast } from './sillybunny-editor/chrome.js';
import { createEditorSession } from './sillybunny-editor/session.js';
import { createEditorDraftStore } from './sillybunny-editor/drafts.js';
import { createSegmentedControl, setSegmentedControlValue } from './sillybunny-segmented-control.js';
import { animateIn, stopMotion, MOTION_FAST } from './sillybunny-motion.js';
import { createSheetController, blockUpstreamDrawerClose } from './sillybunny-sheet.js';

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
    let contentField;
    let showingPreview = false;
    let session;
    let dropdown = null;
    let propertySheet = null;
    let sheetBackdrop = null;
    let sheetController = null;
    const propertyViews = [];
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
    const modes = createSegmentedControl(t`Edit / Preview`, [[false, t`Edit`], [true, t`Preview`]], false, setPreview, { compact: true, detachFromForm: true });
    modes.classList.add('sb-wi-entry-modes');
    const modeToggle = button(t`Preview`, 'menu_button_icon sb-wi-entry-mode-toggle');
    modeToggle.addEventListener('click', () => setPreview(!showingPreview));
    const cancel = element('button', 'sb-editor-action sb-editor-action--secondary sb-wi-entry-cancel');
    cancel.type = 'button';
    cancel.title = t`Cancel`;
    const cancelIcon = element('i', 'fa-solid fa-xmark sb-editor-action__icon');
    cancelIcon.setAttribute('aria-hidden', 'true');
    cancel.append(cancelIcon, element('span', 'sb-editor-action__label', t`Cancel`));
    const saveButton = element('button', 'sb-editor-action sb-editor-action--primary sb-wi-entry-save', t`Save`);
    saveButton.type = 'button';
    const banner = element('div', 'sb-wi-entry-banner');
    banner.setAttribute('role', 'status');
    banner.hidden = true;
    const body = element('div', 'sb-wi-entry-body');
    const summary = button('', 'sb-wi-property-summary');
    summary.setAttribute('aria-label', t`World Info`);
    summary.setAttribute('aria-haspopup', 'dialog');
    summary.setAttribute('aria-expanded', 'false');
    summary.addEventListener('click', openProperties);
    header.append(back, title, dirtyDot, modes, modeToggle, cancel, saveButton);
    root.append(header, summary, createProperties(), banner, body);
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
        refreshVisibility(true);
        setPreview(false);
        scheduleTokens();
    }

    function refreshVisibility(force = false) {
        for (const [id, field] of fields) field.setVisible(model.isFieldVisible(draft, id));
        refreshProperties(force);
        const titleValue = model.readField(draft, titleField.id);
        if (title.value !== titleValue) title.value = titleValue;
        title.placeholder = model.entryTitle({ ...draft, comment: '' }, translate(titleField.placeholder, titleField.placeholderI18n));
    }

    function closeDropdown(restoreFocus = false) {
        if (!dropdown) return;
        const { trigger, node } = dropdown;
        dropdown = null;
        trigger.setAttribute('aria-expanded', 'false');
        trigger.removeAttribute('aria-controls');
        node.remove();
        if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
    }

    function comboControl(field, label) {
        const trigger = button('', 'sb-wi-dropdown');
        const caption = element('span');
        const chevron = element('i', 'fa-solid fa-chevron-down');
        chevron.setAttribute('aria-hidden', 'true');
        trigger.append(caption, chevron);
        trigger.setAttribute('aria-label', label);
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.addEventListener('click', () => {
            if (dropdown?.trigger === trigger) return closeDropdown(true);
            closeDropdown();
            const node = element('div', 'sb-wi-property-popover');
            node.id = `${instanceId}-${field.id}-options`;
            node.setAttribute('role', 'listbox');
            node.setAttribute('aria-label', label);
            node.tabIndex = 0;
            let active = Math.max(0, field.options.findIndex(option => option.value === model.readField(draft, field.id)));
            const choose = index => {
                writeField(field, field.options[index].value);
                closeDropdown(true);
            };
            const options = field.options.map((option, index) => {
                const item = element('div', 'sb-wi-property-option');
                item.id = `${node.id}-${index}`;
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', String(index === active));
                const check = element('i', 'fa-solid fa-check');
                check.setAttribute('aria-hidden', 'true');
                item.append(check, element('span', '', translate(option.label, option.i18n)));
                item.addEventListener('pointermove', () => { active = index; update(); });
                item.addEventListener('click', () => choose(index));
                return item;
            });
            const update = () => {
                options.forEach((option, index) => option.classList.toggle('is-active', index === active));
                node.setAttribute('aria-activedescendant', options[active].id);
                options[active].scrollIntoView?.({ block: 'nearest' });
            };
            node.append(...options);
            node.addEventListener('keydown', event => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    closeDropdown(true);
                    return;
                }
                if (event.key === 'Tab') return closeDropdown(true);
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
                event.preventDefault();
                if (event.key === 'ArrowDown') active = (active + 1) % options.length;
                if (event.key === 'ArrowUp') active = (active + options.length - 1) % options.length;
                if (event.key === 'Home') active = 0;
                if (event.key === 'End') active = options.length - 1;
                if (event.key === 'Enter' || event.key === ' ') return choose(active);
                update();
            });
            dropdown = { trigger, node };
            trigger.setAttribute('aria-expanded', 'true');
            trigger.setAttribute('aria-controls', node.id);
            document.body.append(node);
            blockUpstreamDrawerClose(node);
            const rect = trigger.getBoundingClientRect();
            const width = Math.min(Math.max(208, rect.width), innerWidth - 16);
            node.style.width = `${width}px`;
            node.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
            node.style.top = `${innerHeight - rect.bottom > node.offsetHeight + 14 ? rect.bottom + 6 : Math.max(8, rect.top - node.offsetHeight - 6)}px`;
            update();
            animateIn(node, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: MOTION_FAST });
            node.focus({ preventScroll: true });
        });
        trigger.addEventListener('keydown', event => {
            if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
            event.preventDefault();
            trigger.click();
        });
        return { control: trigger, setValue: value => {
            const option = field.options.find(option => option.value === value);
            caption.textContent = option ? translate(option.label, option.i18n) : value;
        } };
    }

    function createProperties() {
        const bar = element('div', 'sb-wi-properties');
        for (const field of model.FIELDS.filter(field => field.placement === 'bar')) {
            const label = translate(field.label, field.i18n);
            let view;
            if (field.control === 'combo') view = comboControl(field, label);
            else {
                const control = element('input');
                control.type = field.control === 'spin' ? 'number' : 'text';
                if (field.min !== undefined) control.min = String(field.min);
                if (field.max !== undefined) control.max = String(field.max);
                if (field.control === 'spin') control.step = 'any';
                control.setAttribute('aria-label', label);
                control.addEventListener('input', () => writeField(field, control.value));
                control.addEventListener('change', () => writeField(field, control.value));
                control.addEventListener('blur', () => refreshProperties());
                view = { control, setValue: (value, force = false) => {
                    if (force || document.activeElement !== control) control.value = value ?? '';
                } };
            }
            const row = element('div', 'sb-wi-property');
            row.dataset.sbEditorField = field.id;
            row.append(element('span', '', label), view.control);
            view.setValue(model.readField(draft, field.id));
            row.hidden = !model.isFieldVisible(draft, field.id);
            propertyViews.push({ field, row, ...view });
            bar.append(row);
        }
        return bar;
    }

    function refreshProperties(force = false) {
        for (const view of propertyViews) {
            view.row.hidden = !model.isFieldVisible(draft, view.field.id);
            view.setValue(model.readField(draft, view.field.id), force);
        }
        const strategy = model.STRATEGY_OPTIONS.find(option => option.value === model.entryStrategy(draft));
        const outlet = Number(draft.position) === model.WI_POSITION.outlet && draft.outletName ? ` ${draft.outletName}` : '';
        summary.textContent = `${translate(strategy.label, strategy.i18n)} · ${model.entryBadge(draft)}${outlet} · ${model.readField(draft, 'probability') ?? '—'}% ›`;
    }

    function openProperties() {
        closeDropdown();
        if (!sheetController) {
            sheetBackdrop = element('button', 'sb-wi-sheet-backdrop');
            sheetBackdrop.type = 'button';
            sheetBackdrop.tabIndex = -1;
            sheetBackdrop.hidden = true;
            sheetBackdrop.setAttribute('aria-label', t`Close`);
            propertySheet = element('div', 'sb-wi-property-sheet');
            propertySheet.hidden = true;
            propertySheet.setAttribute('role', 'dialog');
            propertySheet.setAttribute('aria-modal', 'true');
            const heading = element('h2', '', t`World Info`);
            heading.id = `${instanceId}-properties-title`;
            heading.tabIndex = -1;
            propertySheet.setAttribute('aria-labelledby', heading.id);
            const sheetHeader = element('header', 'sb-wi-sheet-header');
            const close = button('', 'menu_button_icon');
            close.title = t`Close`;
            close.setAttribute('aria-label', t`Close`);
            const glyph = element('i', 'fa-solid fa-xmark');
            glyph.setAttribute('aria-hidden', 'true');
            close.append(glyph);
            close.addEventListener('click', () => sheetController.close());
            sheetHeader.append(heading, close);
            propertySheet.append(sheetHeader, createProperties());
            propertySheet.addEventListener('keydown', event => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') onKeydown(event);
            });
            document.body.append(sheetBackdrop, propertySheet);
            sheetController = createSheetController({
                sheet: propertySheet, backdrop: sheetBackdrop, getInitialFocus: () => heading, getReturnFocus: () => summary,
                onClose: () => { closeDropdown(); summary.setAttribute('aria-expanded', 'false'); refreshProperties(); },
            });
        }
        summary.setAttribute('aria-expanded', 'true');
        sheetController.open();
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
        const textarea = element('textarea', 'text_pole sb-wi-entry-textarea');
        textarea.id = `${instanceId}-content`;
        textarea.setAttribute('aria-label', label);
        textarea.placeholder = translate(field.placeholder, field.placeholderI18n);
        textarea.value = model.readField(draft, field.id);
        // The legacy expanded editor writes back with jQuery .trigger('input').
        $(textarea).on('input.sbWiEntry', () => writeField(field, textarea.value));
        const pane = element('pre', 'sb-preview-pane sb-wi-entry-preview');
        pane.dataset.sbPreviewPane = textarea.id;
        pane.setAttribute('aria-label', label);
        pane.hidden = true;
        pane.tabIndex = 0;
        const footer = element('footer', 'sb-wi-entry-footer');
        const expand = button('', 'menu_button_icon editor_maximize sb-wi-entry-expand');
        expand.title = t`Expand the editor`;
        expand.setAttribute('aria-label', t`Expand the editor`);
        expand.dataset.for = textarea.id;
        const expandIcon = element('i', 'fa-solid fa-maximize');
        expandIcon.setAttribute('aria-hidden', 'true');
        expand.append(expandIcon);
        footer.append(tokens, expand);
        wrapper.append(textarea, pane);
        const row = createRow({ field: field.id, label, stacked: true, suffix: wrapper });
        // The section heading supplies the visible Content caption.
        row.row.querySelector('.ds-row-text').remove();
        contentField = { textarea, pane, footer, expand };
        return { ...row, setValue: value => { if (textarea.value !== value) textarea.value = value; } };
    }

    function setPreview(showPreview) {
        showingPreview = showPreview;
        setSegmentedControlValue(modes, showPreview);
        const label = showPreview ? t`Edit` : t`Preview`;
        modeToggle.setAttribute('aria-label', label);
        modeToggle.title = label;
        modeToggle.setAttribute('aria-pressed', String(showPreview));
        const glyph = element('i', `fa-solid fa-${showPreview ? 'pen' : 'eye'}`);
        glyph.setAttribute('aria-hidden', 'true');
        modeToggle.replaceChildren(glyph);
        if (!contentField) return;
        const { textarea, pane, expand } = contentField;
        expand.hidden = showPreview;
        if (showPreview) {
            pane.style.height = `${textarea.getBoundingClientRect().height}px`;
            pane.textContent = textarea.value;
        }
        const changed = textarea.hidden !== showPreview;
        stopMotion(textarea);
        stopMotion(pane);
        textarea.hidden = showPreview;
        pane.hidden = !showPreview;
        if (changed) animateIn(showPreview ? pane : textarea, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST });
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
        // The header field (comment) is edited inline in the header, as in the Prompt Editor.
        const rows = model.FIELDS.filter(field => field.section === section.id && !field.header && !field.placement).map(field => {
            const row = createField(field);
            fields.set(field.id, row);
            return row;
        });
        if (!rows.length) continue;
        const title = section.title ? translate(section.title, section.i18n) : undefined;
        const group = section.expander
            ? createPrefGroup({ field: `section-${section.id}`, rows: [createExpanderRow({ label: title, field: `expander-${section.id}`, children: rows })] })
            : createPrefGroup({ title, field: `section-${section.id}`, rows });
        body.append(group.section);
        if (rows.some(row => row.row.dataset.sbEditorField === 'content')) body.append(contentField.footer);
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
    const onPointerdown = event => {
        if (dropdown && !dropdown.node.contains(event.target) && !dropdown.trigger.contains(event.target)) closeDropdown();
    };

    root.tabIndex = -1;
    root.addEventListener('keydown', onKeydown, true);
    title.addEventListener('input', () => writeField(titleField, title.value));
    eventSource.on(event_types.WORLDINFO_DELETED, onBookDeleted);
    eventSource.on(event_types.WORLDINFO_RENAMED, onBookRenamed);
    window.addEventListener('pagehide', flushDraft);
    document.addEventListener('pointerdown', onPointerdown);
    setPreview(false);
    chrome = mountEditorChrome({
        root, header, content: body, controls: { back, title, dirty: dirtyDot, cancel, save: saveButton },
        onBack: () => requestClose(), onCancel: discard, onSave: () => { void save(); },
        scrollHide: false,
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
            closeDropdown();
            sheetController?.close({ animate: false, restoreFocus: false });
            propertySheet?.remove();
            sheetBackdrop?.remove();
            $(contentField.textarea).off('.sbWiEntry');
            stopMotion(contentField.textarea);
            stopMotion(contentField.pane);
            for (const chip of chips) chip.destroy();
            dismissDraftRecoveryToast();
            eventSource.removeListener(event_types.WORLDINFO_DELETED, onBookDeleted);
            eventSource.removeListener(event_types.WORLDINFO_RENAMED, onBookRenamed);
            window.removeEventListener('pagehide', flushDraft);
            document.removeEventListener('pointerdown', onPointerdown);
            root.removeEventListener('keydown', onKeydown, true);
            releaseRowIds(root);
            root.remove();
        },
    };
}
