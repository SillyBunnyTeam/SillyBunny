import { characters, default_avatar, default_user_avatar, getThumbnailUrl, getThumbnailUrlForViewport } from '../script.js';
import { groups, getGroupAvatar } from './group-chats.js';
import { t, translate } from './i18n.js';
import { getCurrentUserHandle } from './user.js';
import { getTokenCountAsync } from './tokenizers.js';
import { world_names } from './world-info.js';
import {
    getPersonaRecord, getPersonaModelDeps, getPersonaEditorStates, getPersonaAppendixScope,
    getPersonaActiveAppendixIds, getCurrentConnectionObj, usePersona, setPersonaDefault,
    setPersonaChatLock, setPersonaCharacterConnection, removePersonaConnection, setPersonaLorebook,
    setPersonaAppendicesActive, createPersonaRecord, duplicatePersonaRecord, deletePersonaRecord,
    changePersonaImage, convertPersonaToCharacter,
} from './personas.js';
import * as model from './sillybunny-persona-model.js';
import { createRow, createSwitchRow, createEntryRow, createPropertyRow, createExpanderRow, createButtonRow, createPrefGroup } from './sillybunny-editor/rows.js';
import { openPicker } from './sillybunny-editor/picker.js';
import { mountEditorChrome, showDraftRecoveryToast, dismissDraftRecoveryToast } from './sillybunny-editor/chrome.js';
import { createEditorSession } from './sillybunny-editor/session.js';
import { objectNavigation } from './sillybunny-editor/object-navigation.js';
import { createEntityRow } from './sillybunny-editor/entity-row.js';
import { bindListKeyboard, reconcileRows, rowEntry } from './sillybunny-editor/list-rows.js';
import { createEditorDraftStore } from './sillybunny-editor/drafts.js';
import { createSegmentedControl, setSegmentedControlValue } from './sillybunny-segmented-control.js';
import { animateIn, stopMotion, MOTION_FAST } from './sillybunny-motion.js';
import { createSheetController, blockUpstreamDrawerClose } from './sillybunny-sheet.js';

let nextDetailId = 0;

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

function icon(name) {
    const node = element('i', `fa-solid fa-${name}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

function iconButton(label, glyph, className = '') {
    const node = button('', `menu_button_icon ${className}`);
    node.title = label;
    node.setAttribute('aria-label', label);
    node.append(icon(glyph));
    return node;
}

function copyDraft(draft) {
    return model.personaToDraft({ name: draft.name, descriptor: draft });
}

function isStoredDraft(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (!['name', 'title', 'description'].every(key => typeof value[key] === 'string')) return false;
    if (!['position', 'depth', 'role'].every(key => Number.isFinite(value[key]))) return false;
    if (!Array.isArray(value.appendices)) return false;
    const ids = new Set();
    return value.appendices.every(note => {
        if (!note || typeof note.id !== 'string' || !note.id || ids.has(note.id)) return false;
        ids.add(note.id);
        return typeof note.name === 'string' && typeof note.description === 'string';
    });
}

export function personaDraftKey(avatarId) {
    return `sb-persona-editor-draft-${getCurrentUserHandle() || 'default'}-${encodeURIComponent(avatarId || 'new-persona')}`;
}

/** Detached content drafts; state actions use the targetable persona API immediately. */
export function mountPersonaDetail({ host, avatarId, mode = 'edit', requestClose, onSaved = () => {}, onStateChange = () => {} }) {
    if (!(host instanceof HTMLElement)) throw new TypeError('Persona detail requires a host element');
    if (!['edit', 'create'].includes(mode)) throw new RangeError(`Unknown persona editor mode: ${mode}`);
    const initialRecord = mode === 'edit' ? getPersonaRecord(avatarId) : null;
    if (mode === 'edit' && !initialRecord) throw new RangeError(`Persona ${avatarId} no longer exists`);
    const instanceId = `sb-persona-detail-${++nextDetailId}`;
    let currentId = mode === 'create' ? null : avatarId;
    let currentMode = mode;
    let baseline = model.personaToDraft(initialRecord ?? undefined);
    let draft = copyDraft(baseline);
    let destroyed = false;
    let missing = false;
    let conflict = false;
    let immediateBusy = false;
    let provisionalId = null;
    let rescueSave = null;
    let session;
    let chrome;
    let showingPreview = false;
    let tokenTimer = null;
    let tokenRequest = 0;
    let dropdown = null;
    let propertySheet = null;
    let sheetBackdrop = null;
    let sheetController = null;
    let picker = null;
    const connectionRows = new Map();
    const connectionViews = new WeakMap();
    let nextConnectionId = 0;
    let nextNoteId = 0;
    let avatarCacheStamp = '';
    const propertyViews = [];
    const noteViews = new Map();

    const root = element('section', 'sb-persona-entry');
    root.tabIndex = -1;
    const header = element('header', 'sb-persona-detail-header sb-persona-entry-header');
    const back = iconButton(t`Back`, 'chevron-left', 'sb-persona-detail-back');
    const name = element('input', 'sb-persona-entry-name');
    name.type = 'text';
    name.required = true;
    name.autocomplete = 'off';
    name.dataset.sbEditorField = 'name';
    name.setAttribute('aria-label', t`Name`);
    name.value = draft.name;
    const dirtyDot = element('span', 'sb-persona-entry-dirty', '•');
    dirtyDot.setAttribute('aria-label', t`Unsaved changes`);
    dirtyDot.hidden = true;
    const modes = createSegmentedControl(t`Edit / Preview`, [[false, t`Edit`], [true, t`Preview`]], false, setPreview, { compact: true, detachFromForm: true });
    modes.classList.add('sb-persona-entry-modes');
    const modeToggle = iconButton(t`Preview`, 'eye', 'sb-persona-entry-mode-toggle');
    modeToggle.addEventListener('click', () => setPreview(!showingPreview));
    const more = iconButton(t`More...`, 'ellipsis-vertical', 'sb-persona-entry-more');
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    const actions = element('div', 'sb-persona-entry-actions');
    actions.append(more);
    const cancel = element('button', 'sb-editor-action sb-editor-action--secondary sb-persona-entry-cancel');
    cancel.type = 'button';
    cancel.title = t`Cancel`;
    cancel.setAttribute('aria-label', t`Cancel`);
    const cancelIcon = icon('xmark');
    cancelIcon.classList.add('sb-editor-action__icon');
    cancel.append(cancelIcon, element('span', 'sb-editor-action__label', t`Cancel`));
    const saveButton = element('button', 'sb-editor-action sb-editor-action--primary sb-persona-entry-save', t`Save`);
    saveButton.type = 'button';
    header.append(back, name, dirtyDot, modes, modeToggle, actions, cancel, saveButton);
    const summary = button('', 'sb-persona-property-summary');
    summary.setAttribute('aria-label', t`Persona`);
    summary.setAttribute('aria-haspopup', 'dialog');
    summary.setAttribute('aria-expanded', 'false');
    summary.addEventListener('click', openProperties);
    const banner = element('div', 'sb-persona-entry-banner');
    banner.setAttribute('role', 'status');
    banner.hidden = true;
    const body = element('div', 'sb-persona-entry-body');
    const propertyFields = [
        { id: 'position', label: t`Position`, options: model.POSITION_OPTIONS },
        { id: 'depth', label: t`Depth` },
        { id: 'role', label: t`Role`, options: model.ROLE_OPTIONS },
    ];
    root.append(header, summary, createProperties(), banner, body);
    host.replaceChildren(root);

    const storage = createEditorDraftStore({ keyFor: personaDraftKey });
    const drafts = {
        read(id) {
            const stored = storage.read(id);
            if (!stored) return null;
            if (stored.snapshot.fingerprint !== model.fingerprint(baseline) || !isStoredDraft(stored.snapshot.draft)) {
                storage.remove(id);
                return null;
            }
            const storedId = stored.snapshot.provisionalId;
            if (currentMode === 'create' && typeof storedId === 'string' && getPersonaRecord(storedId)) provisionalId = storedId;
            return { ...stored, snapshot: copyDraft(stored.snapshot.draft) };
        },
        write(id, snapshot) {
            if (missing) return;
            storage.write(id, {
                fingerprint: model.fingerprint(baseline), draft: snapshot,
                ...(currentMode === 'create' && provisionalId ? { provisionalId } : {}),
            });
        },
        remove: id => storage.remove(id),
    };

    const avatar = element('img', 'sb-persona-identity-avatar');
    avatar.alt = '';
    avatar.decoding = 'async';
    const changeImage = button('', 'sb-persona-change-image');
    changeImage.title = t`Change Persona Image`;
    changeImage.setAttribute('aria-label', t`Change Persona Image`);
    changeImage.append(avatar);
    changeImage.addEventListener('click', () => changePersonaImage(currentId));
    const identityAvatar = createRow({ label: t`Change Persona Image`, field: 'image', prefix: changeImage });
    const title = createEntryRow({ label: t`Persona Title (optional, display only)`, field: 'title', value: draft.title, onInput: value => writeField('title', value) });
    const inUse = createPropertyRow({ label: t`Current Persona`, field: 'inUse', value: draft.name });
    // HUMAN: replace — Use this persona (also used by the detail action menu).
    const useLabel = t`Use this persona`;
    const use = createButtonRow({ label: useLabel, field: 'use', icon: 'circle-check', onActivate: () => { void runImmediate(() => usePersona(currentId)); } });
    const defaultPersona = createSwitchRow({ label: t`Default Persona`, field: 'default', onChange: enabled => { void runImmediate(() => setPersonaDefault(currentId, enabled)); } });
    // HUMAN: replace — Identity section heading.
    const identitySection = createPrefGroup({ title: t`Identity`, field: 'section-identity', rows: [identityAvatar, title, inUse, use, defaultPersona] });
    identitySection.section.dataset.sbSection = 'identity';
    body.append(identitySection.section);

    const description = element('textarea', 'text_pole sb-persona-entry-textarea');
    description.id = `${instanceId}-description`;
    description.dataset.macros = '';
    description.dataset.sbEditorField = 'description';
    description.setAttribute('aria-label', t`Persona Description`);
    description.value = draft.description;
    // The expanded editor writes back with jQuery .trigger('input'), not a native event.
    $(description).on('input.sbPersonaDetail', () => writeField('description', description.value));
    const preview = element('pre', 'sb-preview-pane sb-persona-entry-preview');
    preview.dataset.sbPreviewPane = description.id;
    preview.setAttribute('aria-label', t`Persona Description`);
    preview.tabIndex = 0;
    preview.hidden = true;
    const content = element('div', 'ds-field sb-persona-entry-content');
    content.append(description, preview);
    const contentRow = createRow({ label: t`Persona Description`, field: 'description-content', stacked: true, suffix: content });
    contentRow.row.querySelector('.ds-row-text').remove();
    const descriptionSection = createPrefGroup({ title: t`Persona Description`, field: 'section-description', rows: [contentRow] });
    descriptionSection.section.dataset.sbSection = 'description';
    const footer = element('footer', 'sb-persona-entry-footer');
    const tokens = element('span', 'sb-persona-entry-tokens', `— ${t`tokens`}`);
    const expand = iconButton(t`Expand the editor`, 'maximize', 'editor_maximize sb-persona-entry-expand');
    expand.dataset.for = description.id;
    footer.append(tokens, expand);
    body.append(descriptionSection.section, footer);

    const addNote = createButtonRow({ label: t`Add Scenario Note`, field: 'appendix-add', icon: 'plus', onActivate: () => addAppendix() });
    const importNote = createButtonRow({ label: t`Import another persona as a scenario note`, field: 'appendix-import', icon: 'file-import', onActivate: () => openImportPicker() });
    // HUMAN: replace — scenario-note activation scope / inactive-persona explanation.
    const notesSection = createPrefGroup({ title: t`Scenario Notes`, subtitle: t`lorum ipsum`, field: 'section-notes', rows: [addNote, importNote] });
    notesSection.section.dataset.sbSection = 'notes';
    body.append(notesSection.section);

    // HUMAN: replace — chat lock requires the persona in use.
    const chatLock = createSwitchRow({ label: t`Persona is locked to the current chat`, subtitle: t`Prevents persona changes in this chat`, field: 'chatLock', onChange: enabled => { void runImmediate(() => setPersonaChatLock(currentId, enabled)); } });
    const characterConnection = createSwitchRow({ label: t`Persona is locked to the current character`, field: 'characterConnection', onChange: enabled => { void runImmediate(() => setPersonaCharacterConnection(currentId, enabled)); } });
    const connectionList = element('div', 'sb-persona-connections');
    connectionList.setAttribute('role', 'list');
    connectionList.setAttribute('aria-label', t`Connections`);
    const unbindConnections = bindListKeyboard(connectionList, {
        onOpen: row => {
            const connection = rowEntry(row);
            if (row.getAttribute('aria-disabled') === 'true') return false;
            void navigateRelated(connection.type === 'character'
                ? { kind: 'character-editor', id: connection.id, via: 'persona' }
                : { kind: 'group-editor', id: String(connection.id) }, 'connections');
        },
    });
    const connectionSection = createPrefGroup({ title: t`Connections`, field: 'section-connections', rows: [chatLock, characterConnection, connectionList] });
    connectionSection.section.dataset.sbSection = 'connections';
    body.append(connectionSection.section);

    const lorebookTrigger = button('', 'sb-persona-dropdown sb-persona-lorebook-picker');
    lorebookTrigger.setAttribute('aria-label', t`Link to Persona Lorebook`);
    lorebookTrigger.setAttribute('aria-haspopup', 'dialog');
    lorebookTrigger.setAttribute('aria-expanded', 'false');
    lorebookTrigger.addEventListener('click', openLorebookPicker);
    const lorebook = createRow({ label: t`Link to Persona Lorebook`, field: 'lorebook', suffix: lorebookTrigger });
    // HUMAN: replace — Open the linked lorebook.
    const openBook = createButtonRow({ label: t`lorum ipsum`, field: 'lorebook-open', icon: 'arrow-up-right-from-square', onActivate: () => { void openLinkedLorebook(); } });
    const lorebookSection = createPrefGroup({ title: t`Lorebook`, field: 'section-lorebook', rows: [lorebook, openBook] });
    lorebookSection.section.dataset.sbSection = 'lorebook';
    body.append(lorebookSection.section);

    function captureSnapshot() {
        return copyDraft(draft);
    }

    function restoreSnapshot(snapshot) {
        draft = copyDraft(snapshot);
        name.value = draft.name;
        title.setValue(draft.title);
        description.value = draft.description;
        refreshProperties(true);
        reconcileNotes();
        refreshStates();
        setPreview(false);
    }

    function writeField(key, value) {
        if (destroyed) return;
        if (key === 'position') draft.position = model.parsePosition(value);
        else if (key === 'depth') draft.depth = model.parseDepth(value);
        else if (key === 'role') draft.role = model.parseRole(value);
        else draft[key] = value;
        refreshProperties();
        if (key === 'description') refreshPreview();
        session?.changed({ immediate: true });
    }

    function renderState(state = session.getState()) {
        if (destroyed) return;
        const saving = state.saving || rescueSave !== null;
        const { ok: valid, errors } = model.validateDraft(draft);
        chrome.render({ mode: currentMode, title: draft.name, dirty: state.dirty, saving, canCreate: valid });
        // Unlike character creation, this editor always calls its primary action Save.
        saveButton.textContent = t`Save`;
        saveButton.disabled ||= missing || !valid;
        cancel.disabled ||= saving;
        name.setAttribute('aria-invalid', String(Boolean(errors.name)));
        for (const [index, note] of draft.appendices.entries()) {
            noteViews.get(note.id)?.name.control.setAttribute('aria-invalid', String(Boolean(errors.appendices?.[index])));
        }
        root.setAttribute('aria-busy', String(saving || immediateBusy));
        for (const control of banner.querySelectorAll('button')) control.disabled = saving || !valid && control.classList.contains('sb-persona-entry-save-as-new');
        refreshStates();
        onStateChange({ dirty: state.dirty, saving });
    }

    function effectiveDescription() {
        const active = new Set(currentId && !missing ? getPersonaActiveAppendixIds(currentId) : []);
        const chunks = [draft.description.trim()];
        for (const note of draft.appendices) {
            if (active.has(note.id) && note.description.trim()) chunks.push(`(${note.name})\n${note.description.trim()}`);
        }
        return chunks.filter(Boolean).join('\n\n');
    }

    function refreshPreview() {
        if (showingPreview) preview.textContent = effectiveDescription();
        clearTimeout(tokenTimer);
        const request = ++tokenRequest;
        const text = effectiveDescription();
        tokenTimer = setTimeout(async () => {
            try {
                const count = await getTokenCountAsync(text, 0);
                if (!destroyed && request === tokenRequest) tokens.textContent = `${count} ${t`tokens`}`;
            } catch {
                if (!destroyed && request === tokenRequest) tokens.textContent = `? ${t`tokens`}`;
            }
        }, 300);
    }

    function setPreview(show) {
        showingPreview = show;
        setSegmentedControlValue(modes, show);
        const label = show ? t`Edit` : t`Preview`;
        modeToggle.title = label;
        modeToggle.setAttribute('aria-label', label);
        modeToggle.setAttribute('aria-pressed', String(show));
        modeToggle.replaceChildren(icon(show ? 'pen' : 'eye'));
        expand.hidden = show;
        if (show) {
            preview.style.height = `${description.getBoundingClientRect().height}px`;
            preview.textContent = effectiveDescription();
        }
        const changed = description.hidden !== show;
        stopMotion(description);
        stopMotion(preview);
        description.hidden = show;
        preview.hidden = !show;
        if (changed) animateIn(show ? preview : description, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST });
    }

    function addAppendix(source) {
        // HUMAN: replace — initial name for a new scenario note.
        const noteName = source?.name || t`lorum ipsum`;
        let id = model.createAppendixId(noteName);
        while (draft.appendices.some(note => note.id === id)) id += '-1';
        draft.appendices.push({ id, name: noteName, description: source?.descriptor?.description ?? '' });
        reconcileNotes();
        noteViews.get(id).expander.setOpen(true);
        noteViews.get(id).name.control.focus({ preventScroll: true });
        session.changed({ immediate: true });
        refreshStates();
    }

    function openImportPicker() {
        const records = Object.keys(getPersonaModelDeps().state.personas).filter(id => id !== currentId).map(getPersonaRecord).filter(Boolean);
        picker = openPicker({
            trigger: importNote.row, title: t`Import Scenario Note`, bounds: root, matchTriggerWidth: true,
            items: records.map(record => ({ value: record.avatarId, label: record.name, subtitle: record.descriptor?.title })),
            onSelect: id => {
                if (destroyed) return;
                const record = getPersonaRecord(id);
                if (record) addAppendix(record);
            },
        });
    }

    function createNoteView(note) {
        const name = createEntryRow({ label: t`Label`, field: 'appendix-name', value: note.name, onInput: value => {
            note.name = value;
            expander.row.querySelector('summary .ds-row-label').textContent = value;
            session.changed({ immediate: true });
            refreshPreview();
        } });
        const textarea = element('textarea', 'text_pole sb-persona-note-textarea');
        textarea.id = `${instanceId}-note-${++nextNoteId}`;
        textarea.dataset.macros = '';
        textarea.value = note.description;
        textarea.setAttribute('aria-label', t`Scenario Note text`);
        $(textarea).on('input.sbPersonaDetail', () => {
            note.description = textarea.value;
            session.changed();
            refreshPreview();
        });
        const noteBody = createRow({ label: t`Scenario Note text`, field: 'appendix-description', stacked: true, suffix: textarea });
        const active = createSwitchRow({ label: t`Enabled`, field: 'appendix-active', onChange: enabled => {
            void runImmediate(() => {
                const ids = new Set(getPersonaActiveAppendixIds(currentId));
                if (enabled) ids.add(note.id);
                else ids.delete(note.id);
                return setPersonaAppendicesActive(currentId, [...ids]);
            });
        } });
        const remove = createButtonRow({ label: t`Delete Scenario Note`, icon: 'trash', field: 'appendix-delete', danger: true, onActivate: () => {
            draft.appendices = draft.appendices.filter(candidate => candidate.id !== note.id);
            reconcileNotes();
            refreshPreview();
            session.changed({ immediate: true });
            addNote.row.focus({ preventScroll: true });
        } });
        const expander = createExpanderRow({ label: note.name, field: 'appendix', children: [name, noteBody, remove] });
        active.row.classList.add('sb-persona-note-activation');
        active.row.addEventListener('click', event => event.stopPropagation());
        expander.row.querySelector('summary').append(active.row);
        expander.row.dataset.appendixId = note.id;
        return { note, expander, name, textarea, active };
    }

    function reconcileNotes() {
        const ids = new Set(draft.appendices.map(note => note.id));
        for (const [id, view] of noteViews) {
            if (ids.has(id)) continue;
            $(view.textarea).off('.sbPersonaDetail');
            view.expander.row.remove();
            noteViews.delete(id);
        }
        for (const [index, note] of draft.appendices.entries()) {
            if (!noteViews.has(note.id)) noteViews.set(note.id, createNoteView(note));
            const view = noteViews.get(note.id);
            if (note !== view.note) {
                Object.assign(view.note, note);
                draft.appendices[index] = view.note;
                if (view.name.control.value !== note.name) view.name.setValue(note.name);
                if (view.textarea.value !== note.description) view.textarea.value = note.description;
                view.expander.row.querySelector('summary > .ds-row-text > .ds-row-label').textContent = note.name;
            }
            const sibling = notesSection.group.children[index];
            if (sibling !== view.expander.row) notesSection.group.insertBefore(view.expander.row, sibling ?? null);
        }
    }

    function connectionName(connection) {
        return connection.type === 'group'
            ? groups.find(group => String(group.id) === String(connection.id))?.name || String(connection.id)
            : characters.find(character => character.avatar === connection.id)?.name || String(connection.id);
    }

    function refreshConnections(record, disabled) {
        const connections = record?.descriptor?.connections ?? [];
        reconcileRows({
            container: connectionList, cache: connectionRows, entries: connections,
            key: connection => `${connection.type}:${connection.id}`,
            signature: connection => `${connection.type}:${connection.id}`,
            create: connection => {
                let avatar;
                if (connection.type === 'group') avatar = getGroupAvatar(groups.find(group => String(group.id) === String(connection.id)))[0];
                else {
                    avatar = element('img', 'sb-persona-connection-avatar');
                    avatar.src = characters.some(character => character.avatar === connection.id) ? getThumbnailUrl('avatar', connection.id) : default_avatar;
                    avatar.alt = '';
                    avatar.loading = 'lazy';
                    avatar.decoding = 'async';
                }
                const remove = iconButton(t`Remove`, 'xmark', 'sb-persona-connection-remove');
                remove.addEventListener('click', event => {
                    event.stopPropagation();
                    void runImmediate(() => removePersonaConnection(currentId, connection));
                });
                // HUMAN: replace — opens this character's chat.
                const subtitle = connection.type === 'character' ? t`lorum ipsum` : null;
                const view = createEntityRow({
                    key: `${connection.type}:${connection.id}`, label: connectionName(connection), subtitle,
                    avatar, suffix: [remove], activation: 'navigate',
                    attributes: { 'data-sb-editor-field': 'connection' },
                });
                if (view.slots.subtitle) {
                    view.slots.subtitle.id = `${instanceId}-connection-${++nextConnectionId}`;
                    view.row.setAttribute('aria-describedby', view.slots.subtitle.id);
                }
                connectionViews.set(view.row, view);
                return view.row;
            },
            update: (row, connection) => {
                connectionViews.get(row).update({ label: connectionName(connection) });
                row.setAttribute('aria-disabled', String(disabled));
                row.tabIndex = disabled ? -1 : 0;
            },
        });
        connectionList.hidden = !connections.length;
        for (const button of connectionList.querySelectorAll('button')) button.disabled = disabled;
    }

    function refreshStates() {
        if (destroyed) return;
        const record = currentId && !missing ? getPersonaRecord(currentId) : null;
        const states = record ? getPersonaEditorStates(currentId) : { inUse: false, default: false, locked: {} };
        const busy = immediateBusy || Boolean(session?.getState().saving) || rescueSave !== null;
        const disabled = !record || busy;
        root.setAttribute('aria-busy', String(busy));
        more.hidden = !record;
        more.disabled = disabled;
        const avatarSource = record ? `${getThumbnailUrlForViewport('persona', currentId)}${avatarCacheStamp ? `&t=${avatarCacheStamp}` : ''}` : default_user_avatar;
        if (avatar.getAttribute('src') !== avatarSource) avatar.src = avatarSource;
        changeImage.disabled = disabled;
        inUse.setVisible(states.inUse);
        inUse.setValue(record?.name ?? '');
        use.setVisible(!states.inUse);
        use.setDisabled(disabled);
        defaultPersona.setValue(states.default);
        defaultPersona.setDisabled(disabled);
        chatLock.setValue(states.locked.chat);
        chatLock.setDisabled(disabled || !states.inUse);
        chatLock.row.querySelector('.ds-row-subtitle').hidden = states.inUse;
        const connection = getCurrentConnectionObj();
        characterConnection.setValue(states.locked.character);
        characterConnection.setDisabled(disabled || !connection);
        characterConnection.control.title = connection ? connectionName(connection) : '';
        refreshConnections(record, disabled);
        const bookName = record?.descriptor?.lorebook || '';
        lorebookTrigger.replaceChildren(element('span', '', bookName || t`None`), icon('chevron-down'));
        lorebookTrigger.disabled = disabled;
        openBook.setVisible(Boolean(bookName));
        openBook.setDisabled(disabled);
        const scope = getPersonaAppendixScope();
        // HUMAN: replace — activation applies to this scope, or requires the persona in use.
        const scopeCopy = t`lorum ipsum`;
        const scopeName = scope.kind === 'group'
            ? groups.find(group => String(group.id) === scope.key)?.name
            : scope.kind === 'character' ? characters.find(character => character.avatar === scope.key)?.name : t`Default`;
        notesSection.section.querySelector('.ds-pref-group-subtitle').textContent = states.inUse && scopeName ? `${scopeCopy} · ${scopeName}` : scopeCopy;
        const active = new Set(record ? getPersonaActiveAppendixIds(currentId) : []);
        const persisted = new Set(record?.descriptor?.appendices?.map(note => note.id));
        for (const [id, view] of noteViews) {
            view.active.setVisible(states.inUse);
            view.active.setValue(active.has(id));
            // Activation cannot target an ID that has not been saved into the note library yet.
            view.active.setDisabled(disabled || !persisted.has(id));
        }
        refreshPreview();
    }

    function openLorebookPicker() {
        const value = getPersonaRecord(currentId)?.descriptor?.lorebook || '';
        picker = openPicker({
            trigger: lorebookTrigger, title: t`Link to Persona Lorebook`, selected: value, bounds: root,
            items: [{ value: '', label: t`None` }, ...(world_names ?? []).map(name => ({ value: name, label: name }))],
            onSelect: book => { void runImmediate(() => setPersonaLorebook(currentId, book)); },
        });
    }

    async function openLinkedLorebook() {
        const bookName = getPersonaRecord(currentId)?.descriptor?.lorebook;
        if (bookName) await navigateRelated({ kind: 'world-info', id: bookName }, 'lorebook');
    }

    async function navigateRelated(target, section) {
        if (destroyed || immediateBusy || session.getState().saving || rescueSave) return;
        if (!currentId || missing) return;
        return objectNavigation.navigate(target, { from: { kind: 'persona-editor', id: currentId, section } });
    }

    async function runImmediate(action) {
        if (destroyed || !currentId || missing || immediateBusy || session.getState().saving || rescueSave) return;
        immediateBusy = true;
        refreshStates();
        try {
            await action();
        } catch {
            if (!destroyed) showSaveError();
        } finally {
            immediateBusy = false;
            if (!destroyed) refreshStates();
        }
    }

    function actionSections() {
        const states = getPersonaEditorStates(currentId);
        return [{ items: [
            { label: useLabel, icon: 'fa-solid fa-circle-check', disabled: states.inUse, onSelect: () => { void runImmediate(() => usePersona(currentId)); } },
            { label: t`Change Persona Image`, icon: 'fa-solid fa-image', onSelect: () => changePersonaImage(currentId) },
            { label: t`Create Character Card from Persona`, icon: 'fa-solid fa-address-card', onSelect: () => { void runImmediate(() => convertPersonaToCharacter(currentId)); } },
            ...(states.inUse ? [{ label: t`Click to set user name for all messages`, icon: 'fa-solid fa-sync', onSelect: () => document.getElementById('sync_name_button')?.click() }] : []),
            { label: t`Duplicate Persona`, icon: 'fa-solid fa-clone', onSelect: () => { void runImmediate(() => duplicatePersonaRecord(currentId)); } },
            { label: t`Delete Persona`, icon: 'fa-solid fa-trash', danger: true, onSelect: () => {
                void runImmediate(async () => {
                    if (!await deletePersonaRecord(currentId) || destroyed) return;
                    storage.remove(currentId);
                    session.discard();
                    requestClose();
                });
            } },
        ] }];
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

    function comboControl(field) {
        const trigger = button('', 'sb-persona-dropdown');
        const caption = element('span');
        trigger.append(caption, icon('chevron-down'));
        trigger.setAttribute('aria-label', field.label);
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.addEventListener('click', () => {
            if (dropdown?.trigger === trigger) return closeDropdown(true);
            closeDropdown();
            const node = element('div', 'sb-persona-property-popover');
            node.id = `${instanceId}-${field.id}-options`;
            node.setAttribute('role', 'listbox');
            node.setAttribute('aria-label', field.label);
            node.tabIndex = 0;
            let active = Math.max(0, field.options.findIndex(option => Number(option.value) === draft[field.id]));
            const choose = index => {
                writeField(field.id, field.options[index].value);
                closeDropdown(true);
            };
            const options = field.options.map((option, index) => {
                const item = element('div', 'sb-persona-property-option');
                item.id = `${node.id}-${index}`;
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', String(index === active));
                item.append(icon('check'), element('span', '', translate(option.label, option.i18n)));
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
                event.stopPropagation();
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
        return { control: trigger, setValue(value) {
            const option = field.options.find(option => Number(option.value) === value);
            caption.textContent = option ? translate(option.label, option.i18n) : value;
        } };
    }

    function createProperties() {
        const bar = element('div', 'sb-persona-properties');
        for (const field of propertyFields) {
            let view;
            if (field.options) view = comboControl(field);
            else {
                const control = element('input');
                control.type = 'number';
                control.inputMode = 'numeric';
                control.min = '0';
                control.max = String(model.MAX_DEPTH);
                control.step = '1';
                control.setAttribute('aria-label', field.label);
                control.addEventListener('input', () => writeField(field.id, control.value));
                control.addEventListener('change', () => writeField(field.id, control.value));
                control.addEventListener('blur', () => refreshProperties(true));
                view = { control, setValue(value, force = false) {
                    if (force || document.activeElement !== control) control.value = value;
                } };
            }
            const row = element('div', 'sb-persona-property');
            row.dataset.sbEditorField = field.id;
            row.append(element('span', '', field.label), view.control);
            view.setValue(draft[field.id]);
            row.hidden = field.id !== 'position' && draft.position !== model.PERSONA_POSITION.AT_DEPTH;
            propertyViews.push({ field, row, ...view });
            bar.append(row);
        }
        return bar;
    }

    function refreshProperties(force = false) {
        for (const view of propertyViews) {
            view.row.hidden = view.field.id !== 'position' && draft.position !== model.PERSONA_POSITION.AT_DEPTH;
            view.setValue(draft[view.field.id], force);
        }
        const position = model.POSITION_OPTIONS.find(option => Number(option.value) === draft.position);
        const role = model.ROLE_OPTIONS.find(option => Number(option.value) === draft.role);
        summary.textContent = `${translate(position.label, position.i18n)}${draft.position === model.PERSONA_POSITION.AT_DEPTH ? ` · ${t`Depth`} ${draft.depth} · ${translate(role.label, role.i18n)}` : ''} ›`;
    }

    function openProperties() {
        if (sheetController?.isOpen()) return sheetController.close();
        closeDropdown();
        if (!sheetController) {
            sheetBackdrop = button('', 'sb-persona-sheet-backdrop');
            sheetBackdrop.tabIndex = -1;
            sheetBackdrop.hidden = true;
            sheetBackdrop.setAttribute('aria-label', t`Close`);
            propertySheet = element('div', 'sb-persona-property-sheet');
            propertySheet.hidden = true;
            propertySheet.setAttribute('role', 'dialog');
            propertySheet.setAttribute('aria-modal', 'true');
            const heading = element('h2', '', t`Persona`);
            heading.id = `${instanceId}-properties-title`;
            heading.tabIndex = -1;
            propertySheet.setAttribute('aria-labelledby', heading.id);
            const sheetHeader = element('header', 'sb-persona-sheet-header');
            const close = iconButton(t`Close`, 'xmark');
            close.addEventListener('click', () => sheetController.close());
            sheetHeader.append(heading, close);
            propertySheet.append(sheetHeader, createProperties());
            propertySheet.addEventListener('keydown', event => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') onKeydown(event);
            });
            document.body.append(sheetBackdrop, propertySheet);
            sheetController = createSheetController({
                sheet: propertySheet, backdrop: sheetBackdrop, getInitialFocus: () => heading, getReturnFocus: () => summary,
                onClose: () => { closeDropdown(); summary.setAttribute('aria-expanded', 'false'); refreshProperties(true); },
            });
        }
        refreshProperties(true);
        summary.setAttribute('aria-expanded', 'true');
        sheetController.open();
    }

    function renderBanner() {
        banner.replaceChildren();
        banner.hidden = !missing && !conflict;
        if (banner.hidden) return;
        // HUMAN: replace — persona changed externally / persona deleted explanation.
        banner.append(element('span', 'sb-persona-entry-banner-message', t`lorum ipsum`));
        const actions = element('div', 'sb-persona-entry-banner-actions');
        if (missing) {
            // HUMAN: replace — Save as new persona.
            const rescue = button(t`lorum ipsum`, 'sb-persona-entry-save-as-new');
            rescue.addEventListener('click', () => { void saveAsNew(); });
            actions.append(rescue);
        } else {
            const reload = button(t`Reload`, 'sb-persona-entry-reload');
            // HUMAN: replace — Keep mine.
            const keep = button(t`lorum ipsum`, 'sb-persona-entry-keep-mine');
            reload.addEventListener('click', reloadLive);
            keep.addEventListener('click', () => {
                const record = getPersonaRecord(currentId);
                if (!record) return refresh('persona', currentId);
                const live = model.personaToDraft(record);
                for (const key of model.externalChanges(live, baseline)) model.rebaseKey(live, baseline, draft, key);
                baseline = live;
                conflict = false;
                restoreSnapshot(draft);
                session.rebase(copyDraft(baseline));
                renderBanner();
            });
            actions.append(reload, keep);
        }
        banner.append(actions);
    }

    function reloadLive() {
        const record = getPersonaRecord(currentId);
        if (!record) return;
        dismissDraftRecoveryToast();
        baseline = model.personaToDraft(record);
        conflict = false;
        missing = false;
        restoreSnapshot(baseline);
        session.rebase(copyDraft(baseline));
        storage.remove(currentId);
        renderBanner();
    }

    function showSaveError() {
        // HUMAN: replace — persona save/action failure.
        toastr.error(t`lorum ipsum`);
    }

    function acceptSave(receipt, id, created) {
        if (!receipt.isCurrent()) return;
        const record = getPersonaRecord(id);
        if (!record) {
            refresh('persona', id);
            return;
        }
        const live = model.personaToDraft(record);
        const submitted = copyDraft(receipt.snapshot);
        for (const key of model.DRAFT_KEYS) model.rebaseKey(live, submitted, draft, key);
        baseline = copyDraft(live);
        currentId = id;
        currentMode = 'edit';
        provisionalId = null;
        missing = false;
        conflict = false;
        restoreSnapshot(draft);
        receipt.markSaved({ mode: 'edit', entityId: id }, copyDraft(baseline));
        renderBanner();
        onSaved({ avatarId: id, created });
    }

    async function persistCreated(receipt) {
        if (provisionalId && !getPersonaRecord(provisionalId)) provisionalId = null;
        provisionalId ||= await createPersonaRecord({ name: receipt.snapshot.name, title: receipt.snapshot.title, description: receipt.snapshot.description });
        if (!provisionalId) return false;
        // Store ownership before the acknowledged save, even if navigation closed the session during upload.
        if (currentMode === 'create') drafts.write(receipt.context.entityId, captureSnapshot());
        if (!receipt.isCurrent()) return false;
        const record = getPersonaRecord(provisionalId);
        if (!record) {
            provisionalId = null;
            return false;
        }
        const deps = getPersonaModelDeps();
        const result = await model.commit(deps, provisionalId, model.personaToDraft(record), receipt.snapshot);
        if (!result.ok) return false;
        // The default creation path can leave no remaining changed keys; it still needs an acknowledged save.
        if (!result.keys.length && !await deps.save()) return false;
        acceptSave(receipt, provisionalId, true);
        return true;
    }

    async function persist(receipt) {
        if (missing || !model.validateDraft(receipt.snapshot).ok) return;
        try {
            if (currentMode === 'create') {
                if (!await persistCreated(receipt) && receipt.isCurrent()) showSaveError();
                return;
            }
            const result = await model.commit(getPersonaModelDeps(), currentId, baseline, receipt.snapshot);
            if (result.ok) acceptSave(receipt, currentId, false);
            else if (receipt.isCurrent()) showSaveError();
        } catch {
            if (receipt.isCurrent()) showSaveError();
        }
    }

    function saveAsNew() {
        if (rescueSave) return rescueSave;
        if (destroyed || !model.validateDraft(draft).ok || session.getState().saving) return Promise.resolve(false);
        const receipt = session.captureSaveReceipt();
        rescueSave = Promise.resolve().then(async () => {
            try {
                if (!await persistCreated(receipt)) {
                    if (receipt.isCurrent()) showSaveError();
                    return false;
                }
                return !session.isDirty();
            } catch {
                if (receipt.isCurrent()) showSaveError();
                return false;
            }
        }).finally(() => {
            rescueSave = null;
            renderState();
        });
        renderState();
        return rescueSave;
    }

    function save() {
        if (destroyed || missing || immediateBusy || !model.validateDraft(draft).ok) return Promise.resolve(false);
        if (rescueSave) return rescueSave;
        return session.save();
    }

    function discard() {
        if (destroyed || session.getState().saving || rescueSave) return;
        session.discard();
        return resetDiscardedState();
    }

    async function resetDiscardedState() {
        conflict = false;
        renderBanner();
        if (currentMode !== 'create' || !provisionalId) return;
        const id = provisionalId;
        provisionalId = null;
        try {
            if (!await deletePersonaRecord(id, { silent: true }) && !destroyed) showSaveError();
        } catch {
            if (!destroyed) showSaveError();
        }
    }

    function refresh(reason, id) {
        if (destroyed || id && id !== currentId) return;
        if (reason === 'states' || !currentId) {
            refreshStates();
            return;
        }
        if (reason === 'avatar') avatarCacheStamp = String(Date.now());
        const record = getPersonaRecord(currentId);
        missing = !record;
        if (missing) {
            storage.remove(currentId);
            dismissDraftRecoveryToast();
            conflict = false;
        } else if (!session.getState().saving && !rescueSave) {
            const live = model.personaToDraft(record);
            if (!session.isDirty()) {
                if (model.fingerprint(live) !== model.fingerprint(baseline)) reloadLive();
                conflict = false;
            } else {
                conflict = model.externalChanges(live, baseline).length > 0;
                if (conflict) dismissDraftRecoveryToast();
            }
        }
        renderBanner();
        renderState();
    }

    function onKeydown(event) {
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
    }

    const flushDraft = () => session.flushDraft();
    const onPointerdown = event => {
        if (dropdown && !dropdown.node.contains(event.target) && !dropdown.trigger.contains(event.target)) closeDropdown();
    };
    root.addEventListener('keydown', onKeydown, true);
    name.addEventListener('input', () => writeField('name', name.value));
    window.addEventListener('pagehide', flushDraft);
    document.addEventListener('pointerdown', onPointerdown);
    chrome = mountEditorChrome({
        root, header, content: body, controls: { back, title: name, dirty: dirtyDot, more, cancel, save: saveButton },
        onBack: () => requestClose(), onCancel: discard, onSave: () => { void save(); },
        getActionSections: actionSections, actionMenuTitle: () => draft.name, scrollHide: false,
    });
    session = createEditorSession({
        captureSnapshot, restoreSnapshot, persist, drafts, onStateChange: renderState,
        offerDraft: (stored, actions) => showDraftRecoveryToast(stored, {
            restore: actions.restore,
            discard: () => {
                if (destroyed) return;
                if (currentMode === 'create') void resetDiscardedState();
                actions.discard();
            },
        }),
    });
    reconcileNotes();
    refreshProperties();
    setPreview(false);
    session.open({ mode: currentMode, entityId: currentId || 'new-persona' });

    return {
        isDirty: () => !destroyed && session.isDirty(),
        save,
        discard,
        focusTarget: () => destroyed ? null : name,
        refresh,
        scrollToSection(section) {
            if (destroyed) return;
            const target = [...body.querySelectorAll('[data-sb-section]')].find(node => node.dataset.sbSection === section);
            target?.scrollIntoView?.({ block: 'start' });
        },
        destroy({ keepDraft = false } = {}) {
            if (destroyed) return;
            if (keepDraft || currentMode === 'create' && provisionalId) session.flushDraft();
            else storage.remove(currentId || 'new-persona');
            destroyed = true;
            session.close();
            clearTimeout(tokenTimer);
            tokenRequest++;
            chrome.dispose();
            unbindConnections();
            picker?.close();
            closeDropdown();
            sheetController?.close({ animate: false, restoreFocus: false });
            propertySheet?.remove();
            sheetBackdrop?.remove();
            $(description).off('.sbPersonaDetail');
            for (const view of noteViews.values()) $(view.textarea).off('.sbPersonaDetail');
            stopMotion(description);
            stopMotion(preview);
            dismissDraftRecoveryToast();
            window.removeEventListener('pagehide', flushDraft);
            document.removeEventListener('pointerdown', onPointerdown);
            root.removeEventListener('keydown', onKeydown, true);
            root.remove();
        },
    };
}
