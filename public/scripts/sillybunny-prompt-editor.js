import { eventSource, event_types, getRequestHeaders, main_api } from '../script.js';
import { createPromptEditorModel, PROMPT_EDITOR_UTILITY_FIELDS as UTILITY_FIELDS } from './sillybunny-prompt-editor-model.js';
import { promptManager } from './openai.js';
import { openActionMenu, closeActionMenu } from './sillybunny-action-menu.js';
import { blockUpstreamDrawerClose } from './sillybunny-sheet.js';
import { play, stopMotion, MOTION_FAST, MOTION_SURFACE, MOTION_POPOVER_CLOSE, MOTION_EASE_OUT_CUBIC } from './sillybunny-motion.js';
import { Popup, POPUP_RESULT } from './popup.js';
import { getTokenCountAsync, getTokenizerModel } from './tokenizers.js';
import { t, translate } from './i18n.js';
import { createSegmentedControl } from './sillybunny-segmented-control.js';
import { createListEditor, loadListEditorStyles } from './sillybunny-editor/list-shell.js';
import { mountEditorChrome, createDirtyMark, createTokenReadout, createSummaryRow, setSummaryText, attachToLabelRow, showDraftRecoveryToast, dismissDraftRecoveryToast } from './sillybunny-editor/chrome.js';
import { createEditorSession } from './sillybunny-editor/session.js';
import { createEditorDraftStore } from './sillybunny-editor/drafts.js';
import { getCurrentUserHandle } from './user.js';
import { openDialog } from './sillybunny-editor/dialog.js';
import { LAYOUT_MOBILE_QUERY } from './sillybunny-editor/breakpoints.js';
import { reconcileRows, rowEntry, bindListKeyboard, bindSortable } from './sillybunny-editor/list-rows.js';
import { createListSearch } from './sillybunny-editor/list-search.js';
import { createSearchEntry } from './sillybunny-editor/search-entry.js';
import { announceReorder, reorderMenuItems } from './sillybunny-editor/reorder-menu.js';
import { hostOverlayLayer } from './sillybunny-editor/overlay-host.js';

const mountedEditors = new WeakSet();
let countingEditorContent = false;
let tokenizerPrefilterInstalled = false;
const TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

// Header Save/Cancel use the shared editor action style (sillybunny-character-editor.css), not .menu_button. The shared
// chrome binds their clicks and names their tooltips.
function actionButton(label, className, glyph = null) {
    const node = element('button', `sb-editor-action ${className}`);
    node.type = 'button';
    if (glyph) {
        node.setAttribute('aria-label', label);
        node.append(icon(glyph), element('span', 'sb-editor-action__label', label));
        node.firstChild.classList.add('sb-editor-action__icon');
    } else node.textContent = label;
    return node;
}

// Back, the item menu and the Edit/Preview toggle share the header icon button shape of every editor.
function headerIconButton(label, glyph, className = '') {
    const node = element('button', `sb-editor-icon-button sb-header-icon-button ${className}`.trim());
    node.type = 'button';
    node.setAttribute('aria-label', label);
    node.title = label;
    node.append(icon(glyph));
    return node;
}

function icon(name) {
    const node = element('i', `fa-solid fa-${name}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

/**
 * Storage key of an unsaved prompt editor draft. The entity is `<kind>:<identifier>`; a new prompt has no identifier
 * that survives a reload, so every new prompt shares `<kind>:new`.
 * @param {string} entity
 */
export function promptDraftKey(entity) {
    return `sb-prompt-editor-draft-${getCurrentUserHandle() || 'default'}-${encodeURIComponent(entity)}`;
}

function isStoredPromptDraft(kind, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (typeof value.identifier !== 'string' || typeof value.name !== 'string') return false;
    if (kind === 'text-completion') {
        return [value.values, value.propertyValues].every(group => group && typeof group === 'object' && !Array.isArray(group));
    }
    return value.content === undefined || typeof value.content === 'string';
}

function button(label, glyph, action, className = '') {
    const node = element('button', `menu_button ${glyph ? 'menu_button_icon' : ''} ${className}`);
    node.type = 'button';
    node.setAttribute('aria-label', label);
    if (glyph) {
        node.title = label;
        node.append(icon(glyph));
    } else node.textContent = label;
    node.addEventListener('click', event => {
        event.stopPropagation();
        void action(node, event);
    });
    return node;
}

function switchControl(label, checked, action, disabled = false) {
    const node = element('input', 'sb-switch');
    node.type = 'checkbox';
    node.checked = Boolean(checked);
    node.disabled = disabled;
    node.setAttribute('role', 'switch');
    node.setAttribute('aria-label', label);
    node.addEventListener('change', () => {
        void action(node.checked);
    });
    return node;
}

function capitalized(value) {
    return value ? value[0].toUpperCase() + value.slice(1) : '';
}

export function initializePromptEditor(column) {
    if (mountedEditors.has(column)) return;
    mountedEditors.add(column);
    let model = null;
    const listHeader = element('header', 'sb-prompt-list-header');
    const titles = element('div', 'sb-prompt-list-titles');
    const subtitle = element('span', 'sb-prompt-list-subtitle');
    titles.append(element('h2', '', t`Prompts`), subtitle);
    const searchEntry = createSearchEntry({
        clearLabel: t`Clear Entry`,
        variant: 'bar', className: 'sb-prompt-search-field', inputClassName: 'sb-prompt-search',
        placeholder: t`Search...`, label: t`Search prompts`, clearOnEscape: false,
    });
    const searchField = searchEntry.element;
    const search = searchEntry.input;
    searchField.hidden = true;
    const listBody = element('div', 'sb-prompt-list-body');

    let state = null;
    let draft = null;
    let draftScope = '';
    // A new prompt counts as unsaved from the moment it opens, so Save is available before the first edit.
    let unsaved = false;
    let chrome = null;
    // The last counted total of the open draft; the header and phone readouts are rebuilt with every render.
    let tokenCount = null;
    let kind = 'prompt';
    let mode = 'edit';
    let filter = '';
    let synchronizeFrame = 0;
    let renderedListKey = '';
    let headerMeasuredWidth = 0;
    let headerMeasuredText = '';
    let overlay = null;
    let dragScope = '';
    let propertyDialog = null;
    let tokenTimer = null;
    let listTokenTimer = null;
    let tokenRequest = 0;
    let toastTimer = null;
    let replayingChange = false;
    let stylesReady = false;
    let tokenizerKey = '';
    const contentCounts = new Map();
    const contentRequests = new Map();
    const listGroups = new Map();
    const mobile = matchMedia(LAYOUT_MOBILE_QUERY);

    const dirty = () => Boolean(draft) && (unsaved || session.isDirty());
    const textCompletionView = () => state?.type === 'text-completions';
    const promptFor = id => state.prompts.find(prompt => prompt.identifier === id);
    const rowFor = id => id == null ? null : listBody.querySelector(`[data-prompt-id="${CSS.escape(id)}"]`);
    const selectedId = () => draft?.identifier;

    // The session owns the saved baseline, the dirty comparison and the backup of an unsaved draft.
    // A backup is written every five seconds while the draft differs from the saved prompt and on pagehide. It is
    // dropped by Save, Cancel, Discard and by closing a draft that has nothing left to keep.
    const entityKey = () => `${kind}:${unsaved ? 'new' : draft.identifier}`;
    const draftOwner = () => `prompt:${session.context?.entityId}`;
    const baselineFingerprint = () => unsaved ? '' : JSON.stringify(session.readBaseline());
    const draftStore = createEditorDraftStore({ keyFor: promptDraftKey });
    // The shared envelope stays as it is; the payload carries the preset scope and a fingerprint of the saved prompt,
    // so a backup is only offered over the prompt it was made from.
    const drafts = {
        read(entity) {
            const stored = draftStore.read(entity);
            if (!stored) return null;
            const payload = stored.snapshot;
            const sameEntity = unsaved || payload.draft?.identifier === draft?.identifier;
            if (payload.scope !== draftScope || payload.fingerprint !== baselineFingerprint() || !sameEntity || !isStoredPromptDraft(kind, payload.draft)) {
                draftStore.remove(entity);
                return null;
            }
            return { ...stored, snapshot: payload.draft };
        },
        write(entity, snapshot) {
            draftStore.write(entity, { scope: draftScope, fingerprint: baselineFingerprint(), draft: snapshot });
        },
        remove: entity => draftStore.remove(entity),
    };
    const session = createEditorSession({
        captureSnapshot: () => draft ? structuredClone(draft) : {},
        restoreSnapshot,
        drafts,
        onStateChange: () => renderState(),
        offerDraft: (stored, actions) => showDraftRecoveryToast(stored, actions, draftOwner()),
    });

    // Assigned below; renderList returns early until synchronize() has produced state.
    let shell = null;
    shell = createListEditor({
        container: column,
        storageKey: 'sb-pm-list-width',
        rootTag: 'section',
        label: t`Prompts`,
        dividerLabel: t`Resize prompt sidebar`,
        classNames: { root: 'sb-prompt-editor', sidebar: 'sb-prompt-list', divider: 'sb-prompt-divider', detail: 'sb-prompt-detail' },
        dragHandleSelector: '.sb-prompt-grip[aria-disabled="false"]',
        // The editor's own keydown closes on Escape from any field and handles Ctrl/Cmd+S.
        escapeCloses: false,
        renderList: () => renderList(),
        renderDetail: () => renderEditor(),
        isDirty: dirty,
        onSave: save,
        onDiscard: discardDraft,
        onDeselect: () => {
            closeOverlays();
            endSession();
            draft = null;
        },
        findRow: rowFor,
        focusTarget: detail => detail.querySelector('.sb-prompt-title'),
        fadeTarget: detail => detail.querySelector('.sb-prompt-content'),
        measureLayout: measureShellLayout,
        applyLayout: applyShellLayout,
        onCollapseChange: () => closeOverlays(),
    });
    const root = shell.root;
    const list = shell.sidebar;
    const editor = shell.detail;
    const status = shell.status;
    const allowLeave = () => shell.allowLeave();
    list.append(listHeader, searchField, listBody);
    root.hidden = true;

    if (!tokenizerPrefilterInstalled) {
        // Extensions can replace jQuery without the app's CSRF prefilter; scope this repair to our reads.
        $.ajaxPrefilter((options, _original, xhr) => {
            if (countingEditorContent && options.url.startsWith('/api/tokenizers/')) xhr.setRequestHeader('X-CSRF-Token', getRequestHeaders()['X-CSRF-Token']);
        });
        tokenizerPrefilterInstalled = true;
    }

    function countContent(content) {
        if (contentCounts.has(content)) return Promise.resolve(contentCounts.get(content));
        if (contentRequests.has(content)) return contentRequests.get(content);
        const expectedTokenizer = tokenizerKey;
        let request;
        countingEditorContent = true;
        try { request = getTokenCountAsync(content, 0); } finally { countingEditorContent = false; }
        const pending = request.then(count => {
            if (tokenizerKey === expectedTokenizer) {
                contentCounts.set(content, count);
                if (contentCounts.size > 128) contentCounts.delete(contentCounts.keys().next().value);
            }
            return count;
        }).finally(() => {
            if (contentRequests.get(content) === pending) contentRequests.delete(content);
        });
        contentRequests.set(content, pending);
        return pending;
    }

    function knownCount(prompt) {
        return state.counts[prompt.identifier] ?? contentCounts.get(prompt.content) ?? '-';
    }

    function textCompletionContent(entry) {
        return Object.entries(entry.values)
            .filter(([id, value]) => id !== 'instruct_system_same_as_user' && typeof value === 'string' && value)
            .map(([, value]) => value)
            .join('\n');
    }

    function knownTextCompletionCount(entry) {
        const content = textCompletionContent(entry);
        return content ? contentCounts.get(content) ?? '-' : '';
    }

    function run(action) {
        try {
            const result = action();
            if (result?.catch) result.catch(error => toastr.error(error.message));
            return result;
        } catch (error) {
            toastr.error(error.message);
            return false;
        }
    }

    function menu(trigger, title, sections) {
        closePopover(false);
        openActionMenu({ trigger, title, sections: sections.map(items => ({ items: items.filter(Boolean) })) });
        document.querySelectorAll('.sb-action-menu, .sb-action-sheet').forEach(node => node.dataset.sbPromptMenu = 'true');
    }

    function menuItem(label, glyph, action, danger = false) {
        return { label, icon: `fa-solid fa-${glyph}`, onSelect: () => run(action), danger };
    }

    function toast(message, undo) {
        clearTimeout(toastTimer);
        root.querySelector('.sb-prompt-toast')?.remove();
        const node = element('div', 'sb-prompt-toast');
        node.setAttribute('role', 'status');
        node.append(element('span', '', message));
        if (undo) node.append(button(t`Undo`, null, () => {
            run(undo);
            node.remove();
            synchronize();
        }));
        root.append(node);
        play(node, [{ opacity: 0, transform: 'translateY(100%)' }, { opacity: 1, transform: 'none' }], { duration: MOTION_SURFACE });
        toastTimer = setTimeout(() => {
            if (node.contains(document.activeElement)) return;
            play(node, [{ opacity: 1 }, { opacity: 0, transform: 'scale(0.95)' }], { duration: MOTION_SURFACE, onFinish: () => node.remove() });
        }, 5000);
    }

    function orderedIds() {
        return state.order.filter(entry => promptFor(entry.identifier)).map(entry => entry.identifier);
    }

    // Keyboard and drag moves announce and refocus here; the menu's moves do it through reorderMenuItems.
    function movedByKeyboardOrDrag(id) {
        const ids = orderedIds();
        announceReorder({ name: promptFor(id)?.name ?? '', position: ids.indexOf(id) + 1, count: ids.length, region: status });
        rowFor(id)?.focus({ preventScroll: true });
    }

    function move(id, position) {
        if (filter) return false;
        const ids = orderedIds();
        const previous = ids.indexOf(id);
        if (previous < 0) return false;
        ids.splice(previous, 1);
        ids.splice(Math.max(0, Math.min(ids.length, position)), 0, id);
        const saved = run(() => model.reorder(ids, state.scope)) !== false;
        state = model.snapshot();
        renderList();
        return saved;
    }

    function moveItems(id) {
        const ids = orderedIds();
        return reorderMenuItems({
            index: ids.indexOf(id),
            count: ids.length,
            filtered: Boolean(filter),
            extremes: true,
            name: promptFor(id)?.name ?? '',
            move: to => move(id, to),
            focus: () => rowFor(id),
            region: status,
        });
    }

    async function remove(id) {
        if (draft && !(await allowLeave())) return;
        const expectedScope = state.scope;
        const name = promptFor(id)?.name;
        const row = rowFor(id);
        if (row) await new Promise(resolve => play(row, [{ opacity: 1 }, { opacity: 0, transform: 'translateX(12px)' }], { duration: MOTION_FAST, onEnd: resolve }));
        const removed = run(() => model.remove(id, expectedScope));
        if (!removed) return;
        if (draft?.identifier === id) closeNow();
        synchronize();
        toast(t`Removed ${name}`, () => model.undoRemove(removed));
    }

    async function deletePrompt(id) {
        if (draft && !(await allowLeave())) return;
        const expectedScope = state.scope;
        if (!await Popup.show.confirm(t`Are you sure you want to delete this prompt?`, null, {
            okButton: t`Delete`,
            defaultResult: POPUP_RESULT.NEGATIVE,
            onOpening: popup => popup.okButton.classList.add('is-destructive'),
        })) return;
        const result = run(() => model.delete(id, expectedScope));
        if (result === false) return;
        if (draft?.identifier === id) closeNow();
        synchronize();
    }

    async function rename(prompt) {
        if (draft && !(await allowLeave())) return;
        const row = rowFor(prompt.identifier);
        const name = row?.querySelector('.sb-prompt-row-name');
        if (!name || !model.permissions(prompt).rename) return;
        const expectedScope = state.scope;
        const input = element('input', 'sb-prompt-rename');
        input.value = prompt.name;
        input.setAttribute('aria-label', t`Prompt name`);
        name.replaceWith(input);
        input.focus();
        input.select();
        let finished = false;
        const finish = save => {
            if (finished) return;
            finished = true;
            input.replaceWith(name);
            if (save) run(() => model.rename(prompt.identifier, input.value, expectedScope));
            if (draft?.identifier === prompt.identifier && save) {
                draft.name = input.value;
                session.rebase();
                renderEditor();
            }
            synchronize();
            rowFor(prompt.identifier)?.focus({ preventScroll: true });
        };
        input.addEventListener('keydown', event => {
            event.stopPropagation();
            if (!['Enter', 'Escape'].includes(event.key)) return;
            event.preventDefault();
            finish(event.key === 'Enter');
        });
        input.addEventListener('blur', () => finish(true));
    }

    function promptMenu(trigger, prompt, available) {
        const id = prompt.identifier;
        const permission = model.permissions(prompt);
        menu(trigger, prompt.name, [
            [permission.edit && menuItem(t`Edit`, 'pen', () => openPrompt(prompt)), permission.rename && menuItem(t`Rename`, 'i-cursor', () => rename(prompt)), menuItem(t`Preview`, 'eye', () => openPrompt(prompt, 'preview'))],
            available ? [] : moveItems(id),
            [!prompt.marker && menuItem(t`Send to agents`, 'robot', () => model.sendToAgents(id))],
            [!available && permission.remove && menuItem(t`Remove from list`, 'minus', () => remove(id), true), permission.delete && menuItem(t`Delete`, 'trash', () => deletePrompt(id), true)],
        ]);
    }

    function describe(prompt) {
        if (prompt.marker) return `${t`Marker`} · ${state.sources[prompt.identifier] ?? t`Generation time`}`;
        const position = Number(prompt.injection_position) === 1 ? `${t`In-chat`} @ ${prompt.injection_depth ?? 4}` : t`Relative`;
        return `${capitalized(prompt.role ?? 'system')} · ${position}${prompt.injection_trigger?.length ? ` · ${prompt.injection_trigger.map(capitalized).join(', ')}` : ''}`;
    }

    function makeRow(prompt, orderEntry = null, available = false, utility = false) {
        const textCompletion = textCompletionView();
        const id = textCompletion ? prompt.id : prompt.identifier;
        const nameText = translate(prompt.name);
        const row = element('div', 'sb-prompt-row');
        row.dataset.promptId = id;
        row.tabIndex = 0;
        row.setAttribute('role', 'listitem');
        row.setAttribute('aria-label', nameText);
        row.classList.toggle('is-selected', selectedId() === id);
        const disabledDrag = Boolean(filter);
        if (orderEntry) {
            const grip = element('div', 'sb-prompt-grip menu_button menu_button_icon ui-sortable-handle');
            grip.append(icon('grip-vertical'));
            grip.setAttribute('role', 'button');
            grip.setAttribute('aria-label', t`Drag to reorder ${nameText}`);
            grip.setAttribute('aria-disabled', String(disabledDrag));
            grip.title = grip.getAttribute('aria-label');
            row.append(grip);
        } else if (prompt.runtime) {
            const slot = element('span', 'sb-prompt-handle-slot');
            slot.setAttribute('aria-hidden', 'true');
            row.append(slot);
        }
        row.append(icon(textCompletion ? 'align-left' : utility ? 'file-lines' : prompt.runtime ? 'robot' : prompt.marker ? 'thumbtack' : Number(prompt.injection_position) === 1 ? 'syringe' : prompt.role === 'system' ? 'gear' : 'comment'));
        const text = element('div', 'sb-prompt-row-text');
        const name = element('span', 'sb-prompt-row-name', nameText);
        const preview = textCompletion
            ? Object.values(prompt.values).find(value => typeof value === 'string' && value.trim()) ?? ''
            : utility ? model.readUtility(id) : describe(prompt);
        text.append(name, element('span', 'sb-prompt-row-subtitle', textCompletion || utility ? preview.replace(/\s+/g, ' ').slice(0, 100) || '—' : preview));
        row.append(text);
        if (textCompletion) {
            if (textCompletionContent(prompt)) row.append(element('span', 'sb-prompt-token', String(knownTextCompletionCount(prompt))));
        } else if (!utility) row.append(element('span', 'sb-prompt-token', String(knownCount(prompt))));
        if (orderEntry) row.append(switchControl(t`Enable ${prompt.name}`, orderEntry.enabled, () => {
            run(() => model.toggle(id, state.scope));
            synchronize();
        }, !model.permissions(prompt).toggle));
        if (available) row.append(button(t`Add ${prompt.name}`, 'plus', () => {
            run(() => model.insert(id, state.scope));
            synchronize();
        }));
        if (!prompt.runtime) {
            const more = button(t`Actions for ${nameText}`, 'ellipsis-vertical', trigger => textCompletion
                ? menu(trigger, nameText, [[menuItem(t`Edit`, 'pen', () => openTextCompletion(prompt))]])
                : utility
                    ? menu(trigger, nameText, [[menuItem(t`Edit`, 'pen', () => openUtility(prompt)), model.canRestoreUtility(id) && menuItem(t`Restore default`, 'rotate-left', () => restoreUtility(id))]])
                    : promptMenu(trigger, prompt, available), 'sb-prompt-row-menu');
            more.setAttribute('aria-haspopup', 'menu');
            more.setAttribute('aria-expanded', 'false');
            row.append(more);
        } else {
            for (const className of ['sb-prompt-switch-slot', 'sb-prompt-row-menu sb-prompt-menu-slot']) {
                const slot = element('span', className);
                slot.setAttribute('aria-hidden', 'true');
                row.append(slot);
            }
        }
        if (!utility && !textCompletion && !prompt.marker) name.addEventListener('dblclick', event => {
            event.stopPropagation();
            void rename(prompt);
        });
        return row;
    }

    function group(title, className = '') {
        if (listGroups.has(className)) return listGroups.get(className);
        const section = element('section', `sb-prompt-section ${className}`);
        const heading = element('h3', '', title);
        heading.tabIndex = -1;
        const box = element('div', 'sb-prompt-box');
        box.setAttribute('role', 'list');
        section.append(heading, box);
        listBody.append(section);
        const result = { section, box, rows: new Map() };
        listGroups.set(className, result);
        return result;
    }

    function renderRows(group, entries) {
        const textCompletion = textCompletionView();
        reconcileRows({
            container: group.box,
            cache: group.rows,
            entries,
            key: ({ prompt }) => textCompletion ? prompt.id : prompt.identifier,
            signature: ({ prompt, utility = false }) => {
                const id = textCompletion ? prompt.id : prompt.identifier;
                return JSON.stringify([prompt, utility ? model.readUtility(id) : textCompletion ? prompt : [model.permissions(prompt), describe(prompt)]]);
            },
            create: ({ prompt, orderEntry = null, available = false, utility = false }) => makeRow(prompt, orderEntry, available, utility),
            update: (row, { prompt, orderEntry = null }) => {
                const id = textCompletion ? prompt.id : prompt.identifier;
                const selected = selectedId() === id;
                const disabled = textCompletion ? Boolean(prompt.disabled) : orderEntry?.enabled === false;
                if (row.classList.contains('is-selected') !== selected) row.classList.toggle('is-selected', selected);
                if (row.classList.contains('is-disabled') !== disabled) row.classList.toggle('is-disabled', disabled);
                const grip = row.querySelector('.sb-prompt-grip');
                if (grip && grip.getAttribute('aria-disabled') !== String(Boolean(filter))) grip.setAttribute('aria-disabled', String(Boolean(filter)));
                const control = row.querySelector('input.sb-switch');
                if (control && control.checked !== Boolean(orderEntry.enabled)) control.checked = Boolean(orderEntry.enabled);
                const token = row.querySelector('.sb-prompt-token');
                const count = String(textCompletion ? knownTextCompletionCount(prompt) : knownCount(prompt));
                if (token && token.textContent !== count) token.textContent = count;
            },
        });
    }

    function openEntry({ prompt, utility = false }) {
        if (textCompletionView()) return openTextCompletion(prompt);
        if (utility) return openUtility(prompt);
        return openPrompt(prompt, prompt.runtime ? 'inspect' : null);
    }

    bindListKeyboard(listBody, {
        rowSelector: '.sb-prompt-row',
        keySourceSelector: '.sb-prompt-grip',
        onOpen: row => {
            const entry = rowEntry(row);
            if (entry) void openEntry(entry);
        },
        onRename: row => {
            const entry = rowEntry(row);
            if (!entry || entry.utility || textCompletionView() || entry.prompt.runtime) return false;
            void rename(entry.prompt);
        },
        onMove: (row, direction) => {
            const entry = rowEntry(row);
            if (!entry?.orderEntry) return false;
            const id = entry.prompt.identifier;
            if (move(id, state.order.findIndex(item => item.identifier === id) + direction)) movedByKeyboardOrDrag(id);
        },
    });

    function renderList() {
        if (!state || !shell) return false;
        if (shell.isNavigating || shell.pointerActive || listBody.querySelector('.ui-sortable-helper, .ui-sortable-placeholder')) {
            shell.deferRefresh();
            return;
        }
        const textCompletion = textCompletionView();
        for (const control of [addPromptButton, listActionsButton]) {
            if (control.hidden !== textCompletion) control.hidden = textCompletion;
        }
        const title = titles.querySelector('h2');
        const titleText = textCompletion ? t`Prompt templates` : t`Prompts`;
        if (title.textContent !== titleText) title.textContent = titleText;
        const sectionClasses = ['sb-prompt-order', 'sb-prompt-available', '', 'sb-prompt-tc-system', 'sb-prompt-tc-context', 'sb-prompt-tc-instruct'];
        for (const className of sectionClasses) {
            const section = listGroups.get(className)?.section;
            if (!section) continue;
            const hidden = textCompletion ? !className.startsWith('sb-prompt-tc-') : className.startsWith('sb-prompt-tc-');
            if (section.hidden !== hidden) section.hidden = hidden;
        }
        if (textCompletion) {
            clearTimeout(listTokenTimer);
            const nextKey = JSON.stringify([state.scope, state.textCompletionEntries, filter, selectedId(), kind]);
            if (nextKey === renderedListKey) return false;
            renderedListKey = nextKey;
            const matches = entry => translate(entry.name).toLowerCase().includes(filter.toLowerCase());
            let shown = 0;
            for (const [section, className] of [
                ['System prompt', 'sb-prompt-tc-system'],
                ['Context', 'sb-prompt-tc-context'],
                ['Instruct', 'sb-prompt-tc-instruct'],
            ]) {
                const entries = state.textCompletionEntries.filter(entry => entry.section === section && matches(entry));
                shown += entries.length;
                renderRows(group(translate(section), className), entries.map(prompt => ({ prompt })));
            }
            searchControl.report(shown, state.textCompletionEntries.length);
            updateListSubtitle();
            return true;
        }
        const utilities = UTILITY_FIELDS.map(([identifier, name]) => ({ identifier, name: translate(name), content: model.readUtility(identifier) }));
        const nextKey = JSON.stringify([state.scope, state.prompts, state.order, state.counts, state.sources, state.error, state.runtime, state.character?.name, utilities, filter, selectedId(), tokenizerKey]);
        if (nextKey === renderedListKey) return false;
        renderedListKey = nextKey;
        const focused = listBody.contains(document.activeElement) ? document.activeElement : null;
        const focusedId = focused?.closest('[data-prompt-id]')?.dataset.promptId;
        const matches = prompt => prompt.name.toLowerCase().includes(filter.toLowerCase());
        const rows = state.order.flatMap(entry => {
            const prompt = promptFor(entry.identifier);
            return prompt && matches(prompt) ? [{ prompt, orderEntry: entry }] : [];
        });
        // The assembled Agents row is inspection-only and never enters persisted order data.
        if (matches(state.runtime)) rows.push({ prompt: state.runtime });
        const order = group(t`Prompt order`, 'sb-prompt-order');
        renderRows(order, rows);
        const box = order.box;
        const error = listBody.querySelector('.sb-prompt-error');
        if (!state.error) error?.remove();
        else if (!error) listBody.prepend(element('div', 'sb-prompt-error', state.error));
        else if (error.textContent !== state.error) error.textContent = state.error;
        const available = state.prompts.filter(prompt => !state.order.some(entry => entry.identifier === prompt.identifier));
        const availableRows = available.filter(matches).map(prompt => ({ prompt, available: true }));
        const utilityRows = utilities.filter(matches).map(prompt => ({ prompt, utility: true }));
        renderRows(group(t`Available`, 'sb-prompt-available'), availableRows);
        renderRows(group(t`Utility prompts`), utilityRows);
        const ordered = state.order.filter(entry => promptFor(entry.identifier)).length;
        searchControl.report(rows.length + availableRows.length + utilityRows.length, ordered + 1 + available.length + utilities.length);
        updateListSubtitle();
        bindSortable(box, {
            handle: '.sb-prompt-grip',
            items: '> .sb-prompt-row:has(.sb-prompt-grip)',
            disabled: Boolean(filter),
            touch: () => mobile.matches,
            start: () => dragScope = state.scope,
            update: (_event, ui) => {
                const ids = [...box.children].filter(row => row.querySelector('.sb-prompt-grip')).map(row => row.dataset.promptId);
                run(() => model.reorder(ids, dragScope));
                state = model.snapshot();
                movedByKeyboardOrDrag(ui.item[0].dataset.promptId);
            },
            stop: () => requestAnimationFrame(() => shell.flushRefresh()),
        });
        if (focusedId && !focused.isConnected) rowFor(focusedId)?.focus({ preventScroll: true });
        scheduleListTokens();
        return true;
    }

    function updateListSubtitle() {
        if (textCompletionView()) {
            const value = t`Text completion · Grouped by role`;
            if (subtitle.textContent !== value) subtitle.textContent = value;
            return;
        }
        const enabled = state.order.filter(entry => entry.enabled && promptFor(entry.identifier));
        const counts = enabled.map(entry => promptFor(entry.identifier)).filter(Boolean).map(knownCount).filter(count => typeof count === 'number');
        subtitle.textContent = state.strategy === 'character' && state.character?.name
            ? t`Order for ${state.character.name}`
            : t`${enabled.length} active · ${counts.length ? counts.reduce((sum, count) => sum + count, 0) : '-'} tokens`;
    }

    function scheduleListTokens() {
        clearTimeout(listTokenTimer);
        listTokenTimer = setTimeout(async () => {
            if (shell.isNavigating) { scheduleListTokens(); return; }
            const expectedScope = state.scope;
            const expectedTokenizer = tokenizerKey;
            if (textCompletionView()) {
                for (const entry of state.textCompletionEntries) {
                    const content = textCompletionContent(entry);
                    if (!content || contentCounts.has(content)) continue;
                    try {
                        const count = await countContent(content);
                        if (state.scope !== expectedScope || tokenizerKey !== expectedTokenizer || !textCompletionView()) return;
                        const token = rowFor(entry.id)?.querySelector('.sb-prompt-token');
                        if (token && !shell.isNavigating && token.textContent !== String(count)) token.textContent = String(count);
                    } catch { return; }
                }
                return;
            }
            const prompts = [...listBody.querySelectorAll('[data-prompt-id]')].map(row => promptFor(row.dataset.promptId)).filter(prompt => prompt && !prompt.marker && prompt.content && knownCount(prompt) === '-');
            for (const prompt of prompts) {
                if (knownCount(prompt) !== '-') continue;
                const content = prompt.content;
                try {
                    const count = await countContent(content);
                    if (state.scope !== expectedScope || tokenizerKey !== expectedTokenizer) return;
                    if (promptFor(prompt.identifier)?.content !== content) continue;
                    const token = rowFor(prompt.identifier)?.querySelector('.sb-prompt-token');
                    if (token && !shell.isNavigating) token.textContent = String(count);
                } catch { return; }
            }
            if (!shell.isNavigating) updateListSubtitle();
        }, 300);
    }

    const searchButton = button(t`Search prompts`, 'magnifying-glass', () => searchControl.toggle());
    listHeader.append(titles, searchButton);
    const addPromptButton = button(t`Add prompt`, 'plus', trigger => {
        const count = state.prompts.filter(prompt => !state.order.some(entry => entry.identifier === prompt.identifier)).length;
        menu(trigger, t`Add prompt`, [[
            menuItem(t`New prompt`, 'plus', async () => {
                if (!(await allowLeave())) return;
                await openDraft(model.newDraft(), 'prompt', 'edit', true);
            }),
            { ...menuItem(t`Add from available (${count})`, 'folder-open', () => {
                searchControl.setQuery('');
                const section = listBody.querySelector('.sb-prompt-available');
                const top = listBody.scrollTop + section.getBoundingClientRect().top - listBody.getBoundingClientRect().top;
                listBody.scrollTo({ top, behavior: document.body.classList.contains('reduced-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
                section.querySelector('h3').focus({ preventScroll: true });
            }), disabled: count === 0 },
        ]]);
    });
    const listActionsButton = button(t`Prompt list actions`, 'ellipsis-vertical', trigger => menu(trigger, t`Prompt list`, [
        [menuItem(t`Import prompt list`, 'file-import', async () => { if (await allowLeave()) model.importList(); }), menuItem(t`Export prompt list`, 'file-export', () => model.exportList()), state.strategy === 'character' && state.character && menuItem(t`Export character prompts`, 'file-export', () => model.exportCharacter())],
        [menuItem(t`Reset order`, 'rotate-left', async () => { if (await allowLeave()) model.resetOrder(); })],
    ]));
    listHeader.append(addPromptButton, listActionsButton);
    for (const trigger of listHeader.querySelectorAll('button:not(:first-of-type)')) {
        trigger.setAttribute('aria-haspopup', 'menu');
        trigger.setAttribute('aria-expanded', 'false');
    }
    const searchControl = createListSearch({
        field: searchField,
        input: search,
        trigger: searchButton,
        scope: list,
        scroller: listBody,
        status,
        typeToSearchSelector: '.sb-prompt-row',
        onChange: query => {
            filter = query;
            renderList();
        },
    });

    function discardDraft() {
        const live = kind === 'utility'
            ? { ...draft, content: model.readUtility(draft.identifier) }
            : kind === 'text-completion' ? model.readTextCompletionEntry(draft.identifier) : promptFor(draft.identifier);
        if (!live) {
            closeNow();
            return;
        }
        draft = structuredClone(live);
        draftScope = state.scope;
        unsaved = false;
        drafts.remove(session.context?.entityId ?? entityKey());
        session.rebase();
        renderEditor();
    }

    function cancelEdits() {
        if (!draft || !dirty()) return;
        discardDraft();
        editor.querySelector('.sb-prompt-title')?.focus({ preventScroll: true });
    }

    function save() {
        if (!draft || !dirty()) return true;
        if (kind === 'prompt' && run(() => model.save(draft, draftScope)) === false) return false;
        if (kind === 'utility') {
            if (run(() => model.saveUtility(draft, draftScope)) === false) return false;
        }
        if (kind === 'text-completion' && run(() => model.saveTextCompletion(draft, draftScope)) === false) return false;
        unsaved = false;
        session.markSaved({ entityId: entityKey() });
        synchronize();
        status.textContent = t`Saved`;
        return true;
    }

    function markDirty() {
        session.changed({ immediate: true });
        if (kind !== 'text-completion') scheduleTokens();
    }

    // Presents the dirty state in the header; the session calls it after every change of the baseline or the draft.
    function renderState() {
        if (!draft || !chrome) return;
        chrome.render({ mode: 'edit', title: draft.name, dirty: dirty(), saveLabel: t`Save` });
        if (kind === 'prompt' && !model.permissions(draft).edit) editor.querySelector('.sb-prompt-save').disabled = true;
    }

    async function openPrompt(prompt, requestedMode = null) {
        if (draft?.identifier === prompt.identifier && requestedMode === null) return closeEditor();
        if (!(await allowLeave())) return;
        const nextMode = requestedMode ?? (model.permissions(prompt).edit ? 'edit' : 'preview');
        await openDraft(prompt, 'prompt', nextMode);
    }

    async function openUtility(prompt) {
        if (!(await allowLeave())) return;
        await openDraft({ ...prompt, content: model.readUtility(prompt.identifier) }, 'utility', 'edit');
    }

    async function openTextCompletion(entry) {
        if (draft?.identifier === entry.identifier && kind === 'text-completion') return closeEditor();
        if (!(await allowLeave())) return;
        await openDraft(model.readTextCompletionEntry(entry.identifier), 'text-completion', 'edit');
    }

    async function restoreUtility(identifier) {
        if (!(await allowLeave())) return;
        if (run(() => model.restoreUtility(identifier, state.scope)) === false) return;
        synchronize();
    }

    async function openDraft(value, nextKind, nextMode, isNew = false) {
        shell.cancelNavigation();
        closeOverlays();
        // The previous draft is settled; its backup must not take the new draft's values while this one renders.
        session.close();
        dismissDraftRecoveryToast();
        draft = structuredClone(value);
        kind = nextKind;
        mode = nextMode;
        draftScope = state.scope;
        unsaved = isNew;
        tokenCount = null;
        renderList();
        // Callers ran the leave guard; force re-renders the same prompt in a new mode.
        const shown = await shell.selectItem(draft.identifier, { guard: false, force: true });
        // The baseline is the draft as it stands once the editor is on screen; a stored backup is offered from here.
        if (shown && draft) session.open({ mode: 'edit', entityId: entityKey() });
    }

    function closeEditor() {
        return shell.deselectItem();
    }

    // Ends the session of a draft that is clean or already settled by the leave guard, and drops its backup.
    function endSession() {
        if (session.isOpen()) drafts.remove(session.context.entityId);
        dismissDraftRecoveryToast(draftOwner());
        session.close();
        unsaved = false;
        chrome?.dispose();
        chrome = null;
    }

    function closeNow() {
        endSession();
        draft = null;
        closeOverlays();
        shell.deselectNow();
    }

    function property(label, control) {
        const node = element('div', 'sb-prompt-property');
        node.append(element('span', '', label), control);
        return node;
    }

    function segmented(label, choices, value, change) {
        return createSegmentedControl(label, choices, value, change);
    }

    function closePopover(animate = true, restoreFocus = false) {
        if (!overlay) return;
        const current = overlay;
        overlay = null;
        current.trigger.setAttribute('aria-expanded', 'false');
        current.trigger.removeAttribute('aria-controls');
        current.node.inert = true;
        if (restoreFocus) current.trigger.focus({ preventScroll: true });
        if (!animate) { stopMotion(current.node); current.node.remove(); return; }
        play(current.node, [{ opacity: 1 }, { opacity: 0 }], { duration: MOTION_POPOVER_CLOSE, onFinish: () => current.node.remove() });
    }

    function showPopover(trigger, node, focusTarget = node) {
        closePopover(false);
        document.querySelectorAll('.sb-prompt-popover[inert]').forEach(previous => { stopMotion(previous); previous.remove(); });
        closeActionMenu({ animate: false, restoreFocus: false });
        overlay = { trigger, node };
        trigger.setAttribute('aria-expanded', 'true');
        hostOverlayLayer(node);
        blockUpstreamDrawerClose(node);
        const rect = trigger.getBoundingClientRect();
        const width = Math.min(Math.max(208, rect.width), innerWidth - 16);
        node.style.width = `${width}px`;
        node.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
        node.style.top = `${innerHeight - rect.bottom > node.offsetHeight + 14 ? rect.bottom + 6 : Math.max(8, rect.top - node.offsetHeight - 6)}px`;
        play(node, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: MOTION_FAST, easing: MOTION_EASE_OUT_CUBIC });
        focusTarget.focus({ preventScroll: true });
        node.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            closePopover(true, true);
        });
    }

    function roleControl() {
        const choices = [['system', t`System`], ['user', t`User`], ['assistant', t`Assistant`]];
        const label = element('span', '', choices.find(([value]) => value === (draft.role ?? 'system'))[1]);
        const trigger = button(t`Role`, null, () => {
            if (overlay?.trigger === trigger) { closePopover(true, true); return; }
            const node = element('div', 'sb-prompt-popover sb-prompt-role-list');
            node.setAttribute('role', 'listbox');
            node.setAttribute('aria-label', t`Role`);
            node.tabIndex = 0;
            let activeIndex = Math.max(0, choices.findIndex(([value]) => value === (draft.role ?? 'system')));
            const options = choices.map(([value, text], index) => {
                const option = element('div', 'sb-prompt-option');
                option.id = `sb-prompt-role-${index}`;
                option.setAttribute('role', 'option');
                option.setAttribute('aria-selected', String(value === (draft.role ?? 'system')));
                option.append(icon('check'), element('span', '', text));
                option.addEventListener('pointermove', () => { activeIndex = index; update(); });
                option.addEventListener('click', () => choose(index));
                return option;
            });
            const update = () => {
                options.forEach((option, index) => option.classList.toggle('is-active', index === activeIndex));
                node.setAttribute('aria-activedescendant', options[activeIndex].id);
            };
            const choose = index => {
                draft.role = choices[index][0];
                label.textContent = choices[index][1];
                markDirty();
                refreshSummary();
                closePopover(true, true);
            };
            node.append(...options);
            node.addEventListener('keydown', event => {
                if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) event.preventDefault();
                if (event.key === 'ArrowDown') activeIndex = (activeIndex + 1) % choices.length;
                if (event.key === 'ArrowUp') activeIndex = (activeIndex + choices.length - 1) % choices.length;
                if (event.key === 'Home') activeIndex = 0;
                if (event.key === 'End') activeIndex = choices.length - 1;
                if (event.key === 'Enter' || event.key === ' ') choose(activeIndex);
                if (event.key === 'Tab') closePopover(true, true);
                update();
            });
            update();
            showPopover(trigger, node);
        }, 'sb-prompt-dropdown');
        trigger.replaceChildren(label, icon('chevron-down'));
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.addEventListener('keydown', event => {
            if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
            event.preventDefault();
            trigger.click();
        });
        return trigger;
    }

    function triggerSummary() {
        return draft.injection_trigger?.length ? draft.injection_trigger.map(capitalized).join(', ') : t`All triggers`;
    }

    function triggersControl() {
        const label = element('span', '', triggerSummary());
        const trigger = button(t`Triggers`, null, () => {
            if (overlay?.trigger === trigger) { closePopover(true, true); return; }
            const node = element('div', 'sb-prompt-popover');
            node.setAttribute('role', 'dialog');
            node.setAttribute('aria-label', t`Generation triggers`);
            node.tabIndex = -1;
            for (const value of TRIGGERS) {
                const row = element('label', 'sb-prompt-trigger-row');
                const input = element('input');
                input.type = 'checkbox';
                input.checked = draft.injection_trigger?.includes(value) ?? false;
                input.addEventListener('change', () => {
                    const values = new Set(draft.injection_trigger ?? []);
                    if (input.checked) values.add(value);
                    else values.delete(value);
                    draft.injection_trigger = TRIGGERS.filter(item => values.has(item));
                    label.textContent = triggerSummary();
                    markDirty();
                    refreshSummary();
                });
                row.append(input, element('span', '', translate(capitalized(value))));
                node.append(row);
            }
            node.append(button(t`Done`, null, () => closePopover(true, true)));
            showPopover(trigger, node, node.querySelector('input'));
        }, 'sb-prompt-dropdown');
        trigger.replaceChildren(label, icon('chevron-down'));
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-expanded', 'false');
        return trigger;
    }

    function properties() {
        if (kind === 'text-completion') return textCompletionProperties();
        const props = element('div', 'sb-prompt-properties');
        props.append(property(t`Role`, roleControl()), property(t`Position`, segmented(t`Position`, [[0, t`Relative`], [1, t`In-chat`]], draft.injection_position ?? 0, value => {
            draft.injection_position = value;
            markDirty();
            refreshProperties();
        })));
        if (Number(draft.injection_position) === 1) {
            for (const [key, label, fallback] of [['injection_depth', t`Depth`, 4], ['injection_order', t`Order`, 100]]) {
                const input = element('input');
                input.type = 'number';
                input.value = draft[key] ?? fallback;
                input.setAttribute('aria-label', label);
                input.addEventListener('input', () => {
                    if (!Number.isFinite(input.valueAsNumber)) return;
                    draft[key] = input.valueAsNumber;
                    markDirty();
                    refreshSummary();
                });
                props.append(property(label, input));
            }
        }
        props.append(property(t`Triggers`, triggersControl()));
        if (['main', 'jailbreak'].includes(draft.identifier)) props.append(property(t`Forbid overrides`, switchControl(t`Forbid overrides`, draft.forbid_overrides, value => {
            draft.forbid_overrides = value;
            markDirty();
        })));
        return props;
    }

    function textCompletionProperties() {
        const props = element('div', 'sb-prompt-properties sb-prompt-tc-properties');
        if (!draft.properties?.length) return props;
        for (const descriptor of draft.properties) {
            const label = translate(descriptor.name);
            const value = draft.propertyValues[descriptor.id];
            let control;
            if (descriptor.id === 'context_story_string_position' || descriptor.id === 'context_story_string_role') {
                const source = document.getElementById(descriptor.id);
                control = element('select');
                if (source instanceof HTMLSelectElement) {
                    for (const option of source.options) {
                        const copy = element('option', '', option.textContent);
                        copy.value = option.value;
                        copy.selected = option.value === String(value);
                        control.append(copy);
                    }
                }
                control.setAttribute('aria-label', label);
                control.addEventListener('change', () => {
                    draft.propertyValues[descriptor.id] = control.value;
                    markDirty();
                    refreshSummary();
                });
            } else {
                control = element('input');
                control.type = 'number';
                control.value = value ?? '';
                control.setAttribute('aria-label', label);
                control.addEventListener('input', () => {
                    if (!Number.isFinite(control.valueAsNumber)) return;
                    draft.propertyValues[descriptor.id] = control.valueAsNumber;
                    markDirty();
                    refreshSummary();
                });
            }
            props.append(property(label, control));
        }
        return props;
    }

    function refreshSummary() {
        const summary = editor.querySelector('.sb-prompt-property-summary');
        if (!summary) return;
        if (kind === 'text-completion') {
            const position = draft.propertyValues.context_story_string_position;
            const depth = draft.propertyValues.context_story_string_depth;
            setSummaryText(summary, t`Prompt properties`, `${t`Story string`} · ${t`Position`} ${position} · ${t`Depth`} ${depth} ›`);
            return;
        }
        setSummaryText(summary, t`Prompt properties`, `${capitalized(draft.role ?? 'system')} · ${Number(draft.injection_position) === 1 ? `${t`In-chat`} @ ${draft.injection_depth ?? 4}` : t`Relative`} · ${triggerSummary()} ›`);
    }

    function refreshProperties() {
        closePopover(false);
        editor.querySelector('.sb-prompt-properties')?.replaceWith(properties());
        propertyDialog?.body.querySelector('.sb-prompt-properties')?.replaceWith(properties());
        refreshSummary();
    }

    function openProperties(trigger) {
        closeOverlays();
        const heading = element('h2', '', t`Prompt properties`);
        heading.id = 'sb-prompt-properties-title';
        heading.tabIndex = -1;
        const content = document.createDocumentFragment();
        content.append(heading, properties());
        const dialog = openDialog({
            tier: 'dialog',
            title: heading.textContent,
            content,
            className: 'sb-prompt-properties-dialog',
            initialFocus: () => heading,
        });
        dialog.header.querySelector('.sb-dialog__title')?.replaceWith(heading);
        heading.classList.add('sb-dialog__title');
        const closeButton = dialog.header.querySelector('.sb-dialog__close');
        closeButton?.setAttribute('aria-label', t`Close prompt properties`);
        closeButton?.setAttribute('title', t`Close prompt properties`);
        dialog.root.setAttribute('aria-labelledby', heading.id);
        propertyDialog = dialog;
        dialog.closed.then(() => {
            if (propertyDialog !== dialog) return;
            propertyDialog = null;
            closePopover(false);
            if (draft) refreshProperties();
        });
    }

    function closeOverlays() {
        closeActionMenu({ animate: false, restoreFocus: false });
        closePopover(false);
        propertyDialog?.forceClose();
        propertyDialog = null;
    }

    function setMode(value) {
        shell.cancelNavigation();
        mode = value;
        renderEditor();
        play(editor.querySelector('.sb-prompt-content'), [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST });
    }

    function restoreSnapshot(snapshot) {
        draft = structuredClone(snapshot);
        renderEditor();
    }

    // The header item menu: the actions the editor had as inline buttons and in its phone menu, in sections.
    function actionSections() {
        const permission = kind === 'prompt' ? model.permissions(draft) : {};
        const persisted = kind === 'prompt' && (Boolean(promptFor(draft.identifier)) || draft.runtime);
        return [
            [
                persisted && menuItem(t`Inspect`, 'list-check', () => setMode('inspect')),
                persisted && !draft.marker && menuItem(t`Send to agents`, 'robot', () => model.sendToAgents(draft.identifier)),
            ],
            [
                kind === 'utility' && model.canRestoreUtility(draft.identifier) && menuItem(t`Restore default`, 'rotate-left', () => restoreUtility(draft.identifier)),
                permission.reset && menuItem(t`Reset to default`, 'rotate-left', () => { draft = model.resetDraft(draft); renderEditor(); markDirty(); }),
            ],
            [
                permission.remove && state.order.some(entry => entry.identifier === draft.identifier) && menuItem(t`Remove from list`, 'minus', () => remove(draft.identifier)),
                persisted && permission.delete && menuItem(t`Delete`, 'trash', () => deletePrompt(draft.identifier), true),
            ],
        ].map(items => ({ items: items.filter(Boolean) })).filter(section => section.items.length);
    }

    function knownTokens() {
        if (kind === 'text-completion') return null;
        const total = tokenCount ?? state.counts?.[draft.identifier];
        return total === undefined || total === null ? null : { total };
    }

    // The label row of the content field: its name, with Expand at the inline end while the field can be edited.
    function contentField(textarea, body) {
        const field = element('div', 'sb-prompt-content-field');
        const labelRow = element('div', 'sb-prompt-label-row ds-row-textarea__label-row sb-editor-label-row');
        const label = element(textarea ? 'label' : 'span', 'sb-prompt-field-label ds-row-textarea__label', t`Prompt content`);
        if (textarea) label.htmlFor = textarea.id;
        labelRow.append(label);
        field.append(labelRow, body);
        if (textarea) {
            const expand = headerIconButton(t`Expand the editor`, 'maximize', 'editor_maximize ds-row-textarea__expand sb-prompt-expand');
            expand.dataset.for = textarea.id;
            attachToLabelRow(field, expand);
        }
        return field;
    }

    function renderEditor() {
        if (!draft) return;
        closePopover(false);
        chrome?.dispose();
        editor.hidden = false;
        editor.inert = false;
        editor.dataset.disabled = String(kind === 'text-completion' && draft.disabled);
        editor.replaceChildren();
        const header = element('header', 'sb-prompt-detail-header');
        const back = headerIconButton(t`Back to prompt list`, 'chevron-left', 'sb-prompt-back');
        const title = element('input', 'sb-prompt-title');
        title.id = 'sb-prompt-form_name';
        title.value = draft.name;
        title.readOnly = kind !== 'prompt' || !model.permissions(draft).rename;
        title.setAttribute('aria-label', t`Prompt name`);
        title.addEventListener('input', () => { draft.name = title.value; markDirty(); });
        const dirtyMark = createDirtyMark('sb-prompt-dirty');
        // A header rebuilt over unsaved edits shows its mark at once instead of animating it in again.
        dirtyMark.hidden = !dirty();
        const readout = createTokenReadout();
        readout.classList.add('sb-prompt-tokens');
        const modes = segmented(t`Edit / Preview`, [['edit', t`Edit`], ['preview', t`Preview`]], mode, setMode);
        modes.classList.add('sb-prompt-modes');
        const modeToggle = headerIconButton(mode === 'edit' ? t`Preview` : t`Edit`, mode === 'edit' ? 'eye' : 'pen', 'sb-prompt-mode-toggle');
        modeToggle.setAttribute('aria-pressed', String(mode === 'preview'));
        modeToggle.addEventListener('click', () => setMode(mode === 'edit' ? 'preview' : 'edit'));
        const more = headerIconButton(t`Prompt Actions`, 'ellipsis-vertical', 'sb-prompt-more');
        more.setAttribute('aria-haspopup', 'menu');
        more.setAttribute('aria-expanded', 'false');
        more.hidden = !actionSections().length;
        const cancel = actionButton(t`Cancel`, 'sb-editor-action--secondary sb-prompt-cancel', 'xmark');
        const saveButton = actionButton(t`Save`, 'sb-editor-action--primary sb-prompt-save');
        for (const control of [back, modeToggle, more, cancel, saveButton]) control.addEventListener('click', event => event.stopPropagation());
        // The chrome puts the readout and the item menu in their places in the header.
        header.append(back, title, dirtyMark, modes, modeToggle, cancel, saveButton);
        editor.append(header);
        const permission = kind === 'prompt' ? model.permissions(draft) : {};
        const hasProperties = (kind === 'prompt' && permission.edit || kind === 'text-completion' && draft.properties?.length) && mode !== 'inspect';
        // The phone count sits in the row of the property summary; an item without properties keeps the row for it alone.
        let summaryRow = null;
        if (hasProperties) {
            const summary = button('', null, openProperties, 'sb-prompt-property-summary');
            summaryRow = createSummaryRow(summary);
            editor.append(summaryRow, properties());
            refreshSummary();
        } else if (kind !== 'text-completion') {
            summaryRow = createSummaryRow();
            editor.append(summaryRow);
        }
        const content = element('div', 'sb-prompt-content');
        if (mode === 'inspect') {
            const messages = model.inspect(draft.identifier);
            const block = element('div', 'sb-prompt-preview');
            block.tabIndex = 0;
            for (const message of messages) {
                const details = element('details', 'sb-prompt-inspect-message');
                details.append(element('summary', '', `${message.name} · ${message.role} · ${message.tokens} ${t`tokens`}`), element('pre', '', message.content));
                block.append(details);
            }
            if (!messages.length) block.textContent = t`(Empty prompt)`;
            content.append(block);
        } else if (mode === 'preview' && kind !== 'text-completion') {
            const block = element('pre', 'sb-prompt-preview', kind === 'prompt' ? run(() => model.preview(draft)) || t`(Empty prompt)` : draft.content);
            block.tabIndex = 0;
            content.append(contentField(null, block));
        } else if (kind === 'text-completion') {
            for (const field of draft.fields) {
                const label = translate(field.name);
                const value = draft.values[field.id];
                if (typeof value === 'boolean') {
                    const row = property(label, switchControl(label, value, checked => {
                        draft.values[field.id] = checked;
                        markDirty();
                        for (const relatedId of ['instruct_system_sequence', 'instruct_system_suffix']) {
                            const related = content.querySelector(`[data-tc-field="${relatedId}"]`);
                            if (related) {
                                related.readOnly = checked;
                                related.closest('.sb-prompt-content-field')?.classList.toggle('is-disabled', checked);
                            }
                        }
                    }));
                    row.classList.add('sb-prompt-tc-toggle');
                    content.append(row);
                    continue;
                }
                const fieldNode = element('label', 'sb-prompt-content-field sb-prompt-tc-field');
                fieldNode.append(element('span', 'sb-prompt-field-label', label));
                if (mode === 'preview') {
                    fieldNode.append(element('pre', 'sb-prompt-preview', String(value ?? '') || '—'));
                } else {
                    const textarea = element('textarea', 'sb-prompt-textarea sb-prompt-tc-textarea');
                    textarea.value = value ?? '';
                    textarea.dataset.tcField = field.id;
                    textarea.setAttribute('aria-label', label);
                    textarea.spellcheck = false;
                    const followsUser = ['instruct_system_sequence', 'instruct_system_suffix'].includes(field.id) && Boolean(draft.values.instruct_system_same_as_user);
                    textarea.readOnly = followsUser;
                    fieldNode.classList.toggle('is-disabled', followsUser);
                    textarea.addEventListener('input', () => {
                        draft.values[field.id] = textarea.value;
                        markDirty();
                    });
                    fieldNode.append(textarea);
                }
                content.append(fieldNode);
            }
        } else {
            const textarea = element('textarea', 'sb-prompt-textarea');
            textarea.id = 'sb-prompt-form_prompt';
            textarea.value = draft.marker ? run(() => model.preview(draft)) || '' : draft.content ?? '';
            textarea.readOnly = Boolean(draft.marker);
            if (draft.marker) textarea.placeholder = state.sources[draft.identifier] ?? t`Generation time`;
            textarea.setAttribute('aria-label', t`Prompt content`);
            textarea.spellcheck = false;
            // The legacy expanded editor writes back with jQuery .trigger('input').
            $(textarea).on('input', () => { draft.content = textarea.value; markDirty(); });
            content.append(contentField(textarea, textarea));
        }
        editor.append(content);
        const footer = element('footer', 'sb-prompt-footer');
        if (kind === 'text-completion' && draft.disabled) footer.append(element('span', '', t`Disabled`));
        if (state.sources?.[draft.identifier]) footer.append(element('span', '', `${t`Source`}: ${state.sources[draft.identifier]}`));
        if (footer.childElementCount) editor.append(footer);
        chrome = mountEditorChrome({
            root: editor, header, content,
            controls: { back, title, dirty: dirtyMark, more, modes: [modes, modeToggle], cancel, save: saveButton },
            tokens: summaryRow && kind !== 'text-completion' ? { element: readout, row: { host: summaryRow } } : null,
            itemMenuLabel: t`Prompt Actions`,
            onBack: () => { void closeEditor(); },
            onCancel: cancelEdits,
            onSave: () => { save(); },
            getActionSections: actionSections,
            actionMenuTitle: () => draft.name,
        });
        // The editor's menus are part of its edit surface for the preset autosave (see sillybunny-preset-autosave.js).
        more.addEventListener('click', () => {
            document.querySelectorAll('.sb-action-menu, .sb-action-sheet').forEach(node => node.dataset.sbPromptMenu = 'true');
        });
        renderState();
        chrome.setTokens(knownTokens());
        scheduleLayout();
        scheduleTokens();
    }

    function scheduleTokens() {
        clearTimeout(tokenTimer);
        if (kind === 'text-completion') return;
        const request = ++tokenRequest;
        tokenTimer = setTimeout(async () => {
            if (!draft || draft.marker) return;
            if (shell.isNavigating) { scheduleTokens(); return; }
            try {
                const count = await countContent(draft.content || '');
                if (request !== tokenRequest || !draft) return;
                tokenCount = count;
            } catch {
                if (request !== tokenRequest) return;
                tokenCount = '?';
            }
            chrome?.setTokens(knownTokens());
        }, 300);
    }

    function scheduleLayout() {
        shell?.scheduleLayout();
    }

    // Reads for the shell's layout pass; the shell applies its own writes in between.
    function measureShellLayout({ width, collapsed }) {
        const hideCollapsed = Boolean(draft) && collapsed;
        const card = column.querySelector(':scope > .sb-backend-section-header');
        const headerText = card?.textContent ?? '';
        const headerHidden = column.classList.contains('sb-prompt-hide-header');
        const revealHeader = !hideCollapsed && headerHidden && (headerMeasuredWidth !== width || headerMeasuredText !== headerText || !draft);
        const fits = !headerHidden && card && [...card.querySelectorAll('.sb-backend-title-row, .sb-editor-meta')].every(node => node.scrollWidth <= node.clientWidth + 1);
        return { headerText, headerHidden, revealHeader, fits };
    }

    function applyShellLayout({ headerText, headerHidden, revealHeader, fits }, { width, collapsed }) {
        if (column.classList.contains('sb-prompt-detail-open') !== Boolean(draft)) column.classList.toggle('sb-prompt-detail-open', Boolean(draft));
        const hideHeader = !revealHeader && Boolean(draft) && (collapsed || !fits);
        if (headerHidden !== hideHeader) column.classList.toggle('sb-prompt-hide-header', hideHeader);
        headerMeasuredWidth = width;
        headerMeasuredText = headerText;
        // A previously collapsed header must become measurable before checking its overflow.
        if (revealHeader) scheduleLayout();
    }

    function scheduleSynchronize() {
        if (synchronizeFrame) return;
        synchronizeFrame = requestAnimationFrame(() => {
            synchronizeFrame = 0;
            synchronize();
        });
    }

    function synchronize() {
        cancelAnimationFrame(synchronizeFrame);
        synchronizeFrame = 0;
        if (!stylesReady || !promptManager?.serviceSettings) return;
        model ??= createPromptEditorModel(promptManager);
        const isChatCompletion = main_api === 'openai';
        if (!isChatCompletion && !document.getElementById('sysprompt_content')) return;
        const next = isChatCompletion ? model.snapshot() : model.snapshotTextCompletions();
        if (!next) return;
        state = next;
        const nextTokenizer = isChatCompletion ? JSON.stringify([getTokenizerModel(), state.scope]) : '';
        if (nextTokenizer !== tokenizerKey) {
            tokenizerKey = nextTokenizer;
            contentCounts.clear();
            contentRequests.clear();
            tokenRequest++;
            if (draft) scheduleTokens();
        }
        if (draft && draftScope !== state.scope && !dirty()) closeNow();
        if (!isChatCompletion) {
            tokenizerKey = '';
            contentCounts.clear();
            contentRequests.clear();
        }
        if (root.hidden) root.hidden = false;
        if (!column.classList.contains('sb-prompt-owned')) {
            column.classList.add('sb-prompt-owned');
            // The legacy popup sits outside this column. Finding the column with a body-wide :has() made every DOM change re-check the document.
            document.getElementById('completion_prompt_manager_popup')?.setAttribute('data-sb-prompt-owned', '');
        }
        if (draft && session.isOpen() && !dirty()) {
            const live = kind === 'prompt'
                ? promptFor(draft.identifier)
                : kind === 'text-completion' ? model.readTextCompletionEntry(draft.identifier) : { ...draft, content: model.readUtility(draft.identifier) };
            if (!live && !draft.runtime) closeNow();
            else if (live && JSON.stringify(live) !== JSON.stringify(session.readBaseline())) {
                draft = structuredClone(live);
                draftScope = state.scope;
                session.rebase();
                renderEditor();
            }
        }
        if (renderList()) scheduleLayout();
    }

    editor.addEventListener('keydown', event => {
        if (event.isComposing) return;
        // Escape closes the innermost surface only; the settings page closes itself on any bubbling Escape.
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void closeEditor(); }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
    });
    document.addEventListener('pointerdown', event => {
        if (overlay && !overlay.node.contains(event.target) && !overlay.trigger.contains(event.target)) closePopover();
    });
    document.addEventListener('change', async event => {
        if (replayingChange || !dirty() || !(event.target instanceof HTMLSelectElement)) return;
        const select = event.target;
        const isBackendSwitch = select.id === 'main_api';
        const tcPresetIndex = { sysprompt_select: 1, instruct_presets: 2, context_presets: 3 }[select.id];
        const isRelevantPreset = kind === 'text-completion' ? tcPresetIndex !== undefined : select.id === 'settings_preset_openai';
        if (!isBackendSwitch && !isRelevantPreset) return;
        event.stopImmediatePropagation();
        const nextValue = select.value;
        const scope = JSON.parse(draftScope);
        const previousValue = isBackendSwitch
            ? kind === 'text-completion' ? scope[0] : main_api
            : tcPresetIndex !== undefined ? scope[tcPresetIndex] : [...select.options].find(option => option.textContent === scope[2])?.value;
        select.value = previousValue;
        if (!(await allowLeave())) return;
        closeNow();
        select.value = nextValue;
        replayingChange = true;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        replayingChange = false;
    }, true);
    document.addEventListener('sb:shell-tab-activated', async event => {
        if (event.detail.tabId === 'editor') { synchronize(); return; }
        shell.cancelNavigation();
        closeOverlays();
        if (!dirty()) return;
        if (!(await allowLeave())) {
            window.SillyBunnyShell.openTab('left', 'editor');
            if (mobile.matches) document.querySelector('button[data-sb-settings-tab="editor"]')?.click();
        } else closeNow();
    });
    document.addEventListener('change', event => {
        if (event.target instanceof HTMLSelectElement && event.target.matches('#sysprompt_select, #instruct_presets, #context_presets')) scheduleSynchronize();
    });
    document.addEventListener('sb:prompt-manager-rendered', scheduleSynchronize);
    document.getElementById('main_api')?.addEventListener('change', scheduleSynchronize);
    eventSource.on(event_types.APP_READY, synchronize);
    window.addEventListener('pagehide', () => session.flushDraft());
    Promise.all([
        loadListEditorStyles(),
        window.SillyBunnyAssets.loadStylesheetAsync('css/sillybunny-prompt-editor.css?v=20261115u', { id: 'deferred-prompt-editor-css' }),
    ])
        .then(() => { stylesReady = true; synchronize(); })
        .catch(error => toastr.error(error.message));
}
