// SillyBunny: group editor controller — explicit save, draft backup (Step 4)
//
// Session, draft, leave-guard and header/toolbar mechanics are shared with the
// character editor through ./sillybunny-editor/. This file owns only what is
// specific to groups: the action menu, the save dispatch, and the reconciling
// of the editor's draft with the live group object.
//
// group-chats.js owns the draft itself (it is the only module allowed to import
// group state) and hands this controller three callbacks:
//   captureSnapshot()   — the draft as a plain object; the session compares it
//                         against its baseline to decide whether the editor is dirty.
//   applySnapshot(obj)  — write a snapshot back into the draft and the DOM.
//   writeDomFromDraft() — re-render the fields from the draft without marking
//                         anything dirty (used after a reconcile or a discard).
//
// Public API consumed by group-chats.js:
//   initGroupEditor(config)             — bind DOM handlers (called once at startup)
//   beginGroupEditorLoad()              — suspend the session before fields are written
//   openGroupEditorSession(groupId)     — open an edit session (call after fields load)
//   openGroupEditorCreateSession()      — open a create session
//   isGroupEditorOwner(groupId)         — true when this session owns the group
//   notifyGroupEditorChanged(options)   — report an edit instead of calling editGroup()

import { t } from './i18n.js';
import { getCurrentUserHandle } from './user.js';
import { createEditorSession } from './sillybunny-editor/session.js';
import { createEditorDraftStore } from './sillybunny-editor/drafts.js';
import { mountEditorChrome, showDraftRecoveryToast, dismissDraftRecoveryToast } from './sillybunny-editor/chrome.js';
import { registerEditorNavigation, confirmEditorLeave, discardEditorChanges } from './sillybunny-editor/navigation.js';
import { objectNavigation } from './sillybunny-editor/object-navigation.js';
import { MOTION_FAST, prefersReducedMotion } from './sillybunny-motion.js';
import { attachTagFilterMenu } from './sillybunny-editor/tag-filter-menu.js';
import { createComboRow } from './sillybunny-editor/rows.js';
import { getFolders, subscribe as subscribeFolders } from './sillybunny-folders.js';
import { LIST_EDITOR_STYLESHEET } from './sillybunny-editor/list-shell.js';
import { loadStylesheetAsync } from './dynamic-styles.js';

const GROUP_EDITOR_STYLESHEETS = [
    LIST_EDITOR_STYLESHEET,
    { href: 'css/sillybunny-entity-list.css?v=20261018a', id: 'deferred-entity-list-css' },
    { href: 'css/rm-groups.css', id: 'deferred-rm-groups-css' },
];
const groupEditorReveals = new WeakMap();

/** Keeps native group controls inert until all deferred member-list styles are ready. */
export async function prepareGroupEditorReveal(root, isCurrent) {
    if (!root) return false;
    const request = {};
    groupEditorReveals.set(root, request);
    root.style.visibility = 'hidden';
    root.inert = true;
    root.setAttribute('aria-busy', 'true');
    try {
        await Promise.all(GROUP_EDITOR_STYLESHEETS.map(({ href, id }) => loadStylesheetAsync(href, { id })));
        if (groupEditorReveals.get(root) !== request || !isCurrent()) return false;
        root.style.removeProperty('visibility');
        root.inert = false;
        return true;
    } finally {
        if (groupEditorReveals.get(root) === request) root.removeAttribute('aria-busy');
    }
}

const DRAFT_KEY_PREFIX = 'sb-group-editor-draft-';
const NEW_GROUP_DRAFT_KEY = 'new-group';

// --- Module state ---

const drafts = createEditorDraftStore({
    keyFor: (id) => `${DRAFT_KEY_PREFIX}${getCurrentUserHandle() || 'default'}-${id}`,
});

const session = createEditorSession({
    captureSnapshot: () => callbacks?.captureSnapshot() ?? {},
    restoreSnapshot: (snapshot) => callbacks?.applySnapshot(snapshot),
    persist: _persist,
    drafts,
    onStateChange: _renderChrome,
    offerDraft: (draft, actions) => showDraftRecoveryToast(draft, actions, `group:${session.context.entityId}`),
});

const navigation = {
    session,
    isActive: _isEditorVisible,
    close: _navigateBack,
    afterDiscard: _syncDomFromDraft,
};

/** @type {ReturnType<typeof mountEditorChrome>|null} */
let chrome = null;
/** Header title for the open session; follows inline renames. */
let editorTitle = '';
let folderSelectRow = null;

/**
 * Callbacks supplied by group-chats.js at init time. This module never imports
 * group-chats.js, so the dependency runs one way only.
 * @type {{
 *   captureSnapshot: () => object,
 *   applySnapshot: (snapshot: object) => void,
 *   writeDomFromDraft: () => void,
 *   saveDraft: (groupId: string, snapshot: object) => Promise<boolean>,
 *   createGroup: (receipt: import('./sillybunny-editor/session.js').EditorSaveReceipt) => Promise<unknown>,
 *   getGroupName: (groupId: string) => string|null,
 *   canCreate: () => boolean,
 *   getFolderValue: () => string|null,
 *   setFolderValue: (value: string|null) => void,
 *   onFolderChanged: () => void,
 *   commitFolder: (groupId: string, folderId: string|null) => void,
 * }|null}
 */
let callbacks = null;

// ============================================================
// Public API
// ============================================================

/**
 * @param {{ captureSnapshot: () => object, applySnapshot: (snapshot: object) => void,
 *     writeDomFromDraft: () => void, saveDraft: (groupId: string, snapshot: object) => Promise<boolean>,
 *     createGroup: (receipt: import('./sillybunny-editor/session.js').EditorSaveReceipt) => Promise<unknown>, getGroupName: (groupId: string) => string|null,
 *     canCreate: () => boolean, canRestoreAvatar: () => boolean, reorderMembers: (from: number[], to: number[]) => void,
 *     getDraftName: () => string }} config
 */
export function initGroupEditor(config) {
    callbacks = config;
    _mountChrome();
    _mountFolderField();
    _mountMemberSortable();
    attachGroupTagFilterMenus(document.getElementById('rm_group_chats_block'));
    registerEditorNavigation(navigation);
}

/**
 * Attaches the shared tag menu to member/candidate controls, including the upstream popout clone.
 * @param {HTMLElement} root
 * @returns {{ destroy: () => void }}
 */
export function attachGroupTagFilterMenus(root) {
    const cleanups = [];
    for (const controls of root?.querySelectorAll('.rm_tag_controls.ds-tag-filter') ?? []) {
        if (root.id === 'groupMemberListPopout') {
            // tags.js renders into every `#rm_group_members_header ~ .rm_tag_controls`; renaming the
            // cloned header keeps upstream rendering on the original so the clone is only synced from it.
            const clonedHeader = root.querySelector('#rm_group_members_header');
            if (clonedHeader) {
                clonedHeader.removeAttribute('id');
                clonedHeader.dataset.sbPopoutHeader = 'rm_group_members_header';
            }
            const source = document.querySelector('#currentGroupMembers .rm_tag_filter');
            const target = controls.querySelector('.rm_tag_filter');
            if (source && target) {
                const sync = () => target.replaceChildren(...[...source.children].map(tag => tag.cloneNode(true)));
                sync();
                // Upstream HTML clones have no tag handlers; forward to the original live transports.
                const forward = event => {
                    const tag = event.target.closest?.('.tag');
                    if (!tag || !target.contains(tag)) return;
                    event.stopImmediatePropagation();
                    [...source.querySelectorAll('.tag')].find(original => original.id === tag.id)?.click();
                    sync();
                };
                target.addEventListener('click', forward);
                const observer = new MutationObserver(sync);
                observer.observe(source, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
                cleanups.push(() => { observer.disconnect(); target.removeEventListener('click', forward); });
            }
        }
        const menu = attachTagFilterMenu(controls);
        cleanups.push(() => menu.destroy());
    }
    return { destroy: () => cleanups.forEach(cleanup => cleanup()) };
}

/**
 * Call immediately before group-chats.js overwrites the fields with group data.
 * Re-selecting the group the editor already owns reconciles instead of
 * reopening, so an in-progress draft is neither flushed nor re-offered.
 * @param {string|null} groupId  The group about to be loaded, or null for create.
 * @returns {'reconciled'|'suspended'} what the caller has to do about it. The
 *     controller only detects the overlap; group-chats.js merges the draft
 *     against the live group (it owns the draft) and then calls
 *     syncGroupEditor().
 */
export function beginGroupEditorLoad(groupId = null) {
    const key = groupId ?? NEW_GROUP_DRAFT_KEY;
    const ownsSameGroup = session.isOpen()
        && session.context?.entityId === key
        && session.context?.mode === (groupId ? 'edit' : 'create');

    if (ownsSameGroup) return 'reconciled';

    session.suspend();
    dismissDraftRecoveryToast();
    return 'suspended';
}

/**
 * Recapture the baseline without touching the draft store. group-chats.js calls
 * this after a save it performed itself (an avatar upload or restore) so the
 * editor does not report that change as unsaved. The fields are re-rendered from
 * the draft in the same breath.
 * @param {object} [nextSnapshot]  The values that are now saved. Pass when the
 *     live group diverged from the draft (a three-way merge on reselect), since
 *     the draft's own values are the unsaved edits and cannot be the baseline.
 */
export function rebaseGroupEditor(nextSnapshot) {
    session.rebase(nextSnapshot);
    _syncDomFromDraft();
}

/**
 * Open an edit-mode session. Call after the fields have been written.
 * @param {string} groupId
 */
export function openGroupEditorSession(groupId) {
    if (session.isOpen() && session.context?.mode === 'edit' && session.context?.entityId === String(groupId)) {
        // beginGroupEditorLoad() reported this overlap; the draft survived and
        // only the chrome needs to catch up with the re-rendered fields.
        editorTitle = callbacks?.getGroupName(groupId) ?? editorTitle;
        _refreshChrome();
        return;
    }

    editorTitle = callbacks?.getGroupName(groupId) ?? '';
    _openSession({ mode: 'edit', entityId: String(groupId) });
}

/**
 * Open a create-mode session. Call after the fields have been written.
 */
export function openGroupEditorCreateSession() {
    if (session.isOpen() && session.context?.mode === 'create') {
        _refreshChrome();
        return;
    }

    editorTitle = t`New Group`;
    _openSession({ mode: 'create', entityId: NEW_GROUP_DRAFT_KEY });
}

export function captureGroupEditorSave() {
    return session.captureSaveReceipt();
}

export function readGroupEditorBaseline() {
    return session.readBaseline();
}

/**
 * True when this session currently owns the given group.
 * @param {string} groupId
 * @returns {boolean}
 */
export function isGroupEditorOwner(groupId) {
    return session.isOpen()
        && session.context?.mode === 'edit'
        && session.context?.entityId === String(groupId);
}

/** Drops only the deleted group's session and backup; group-chats owns its draft and navigation. */
export function discardGroupEditorForEntity(groupId) {
    if (groupId === null || groupId === undefined || groupId === '') return false;
    const id = String(groupId);
    drafts.remove(id);
    dismissDraftRecoveryToast(`group:${id}`);
    if (!isGroupEditorOwner(id)) return false;
    session.close();
    return true;
}

/**
 * Called by group-chats.js's editor-owned handlers instead of editGroup().
 * @param {{ immediate?: boolean }} [options]  Typing debounces; anything
 *     structural (members, toggles, selects) is immediate.
 */
export function notifyGroupEditorChanged(options) {
    session.changed(options);
}

function folderOptions() {
    let folders = [];
    try {
        folders = getFolders('groups');
    } catch {
        folders = [];
    }
    return [{ value: '', label: t`No folder` }, ...folders.map(folder => ({ value: folder.id, label: folder.name }))];
}

function _mountFolderField() {
    const host = document.getElementById('group_folder_row');
    if (!(host instanceof HTMLElement) || folderSelectRow || !callbacks) return;
    const select = document.createElement('select');
    select.id = 'group_folder';
    select.setAttribute('aria-label', t`Folder`);
    folderSelectRow = createComboRow({
        label: t`Folder`,
        field: 'folder',
        options: folderOptions(),
        value: callbacks.getFolderValue?.() ?? '',
        onChange: value => {
            callbacks.setFolderValue?.(value || null);
            callbacks.onFolderChanged?.();
        },
        select,
    });
    host.replaceChildren(folderSelectRow.row);
    subscribeFolders(({ scope }) => {
        if (scope && scope !== 'groups') return;
        const value = folderSelectRow.getValue();
        const options = folderOptions();
        folderSelectRow.control.replaceChildren(...options.map(option => {
            const element = document.createElement('option');
            element.value = option.value;
            element.textContent = option.label;
            return element;
        }));
        folderSelectRow.setValue(options.some(option => option.value === value) ? value : '', { silent: true });
    });
}

export function setGroupEditorFolderValue(value) {
    folderSelectRow?.setValue(value ? String(value) : '', { silent: true });
}

// ============================================================
// Session plumbing
// ============================================================

/** @param {{ mode: 'create'|'edit', entityId: string }} context */
function _openSession(context) {
    const previous = session.context;
    session.open(context);
    chrome?.scheduleOverflow();
    chrome?.reset({ scrollToTop: previous?.mode !== context.mode || previous?.entityId !== context.entityId });
}

function _refreshChrome() {
    chrome?.scheduleOverflow();
    chrome?.reset();
    _renderChrome(session.getState());
}

function _syncDomFromDraft() {
    callbacks?.writeDomFromDraft();
}

// ============================================================
// Chrome
// ============================================================

function _mountChrome() {
    const root = document.getElementById('rm_group_chats_block');
    const header = document.getElementById('sb_group_editor_header');
    const toolbar = document.getElementById('sb_group_editor_toolbar');
    const content = document.getElementById('sb_group_editor_content');
    if (!root || !header || !toolbar || !content) return;

    const nameField = /** @type {HTMLInputElement|null} */ (document.getElementById('rm_group_chat_name'));

    chrome = mountEditorChrome({
        root,
        header,
        toolbar,
        content,
        controls: {
            back: document.getElementById('sb_group_editor_back'),
            cancel: /** @type {HTMLButtonElement} */ (document.getElementById('sb_group_editor_cancel')),
            save: /** @type {HTMLButtonElement} */ (document.getElementById('sb_group_editor_save')),
            title: document.getElementById('sb_group_editor_title'),
            titleButton: /** @type {HTMLButtonElement|null} */ (document.getElementById('sb_group_editor_title_button')),
            dirty: document.getElementById('sb_group_editor_dirty'),
            more: document.getElementById('sb_group_editor_more'),
        },
        onBack: _handleBack,
        onCancel: () => {
            // Cancel is disabled when clean, so a click is intentional.
            if (session.isDirty()) discardEditorChanges(navigation);
        },
        onSave: () => void session.save(),
        // The sticky header's title is the rename affordance, mirroring the
        // character editor. It is an ordinary unsaved edit: the draft name is
        // written, and Save commits it.
        rename: nameField ? {
            getValue: () => nameField.value,
            commit: (value) => {
                nameField.value = value;
                nameField.dispatchEvent(new Event('input', { bubbles: true }));
                editorTitle = value;
            },
            onFinish: (value) => {
                editorTitle = value;
            },
        } : undefined,
        overflowCandidates: GROUP_OVERFLOW_CANDIDATES,
        getActionSections: _buildActionSections,
        actionMenuTitle: () => t`Group Actions`,
        isActive: () => session.isOpen(),
    });
}

/** @param {import('./sillybunny-editor/session.js').EditorState} state */
function _renderChrome(state) {
    if (!state.open) return;
    chrome?.render({
        mode: state.mode,
        dirty: state.dirty,
        saving: state.saving,
        title: _resolveTitle(),
        canCreate: callbacks?.canCreate() ?? false,
    });
}

/**
 * The header title. In create mode it is the fixed "New Group"; in edit mode it
 * follows the draft's name, so renaming in the Name field updates the header as
 * it is typed rather than only after a save.
 * @returns {string}
 */
function _resolveTitle() {
    if (session.context?.mode === 'create') return t`New Group`;
    const draftName = callbacks?.getDraftName?.();
    return draftName || editorTitle;
}

/** @param {Event} event */
async function _handleBack(event) {
    if (!await confirmEditorLeave(navigation)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }
    await _navigateBack();
}

function _navigateBack() {
    return objectNavigation.back({
        current: { kind: 'group-editor', id: session.context?.mode === 'create' ? 'create' : session.context?.entityId },
        fallback: _closeSafely,
    });
}

function _closeSafely() {
    // Navigate back to the groups list. The panel is hosted either as a drawer
    // (data-sb-character-tab tabs) or as a settings page (data-sb-settings-tab).
    const drawerTab = document.getElementById('sb_character_tab_groups');
    const settingsTab = document.querySelector('[data-sb-settings-tab="groups"]');
    const isPageMode = !drawerTab?.offsetParent && Boolean(settingsTab?.offsetParent);
    (isPageMode ? settingsTab : drawerTab)?.click();
}

// ============================================================
// Action menu
// ============================================================

/**
 * Toolbar buttons that may collapse into the ⋯ menu when the panel is too
 * narrow. Ordered most expendable first.
 */
const GROUP_OVERFLOW_CANDIDATES = [
    '#rm_group_restore_avatar',
];

/**
 * Option id -> glyph for the transport select's entries, mirroring the
 * character editor's table. Unlisted ids fall back to a generic glyph.
 */
const ACTION_GLYPHS = {
    group_chat_lorebook_link: 'book',
    renameGroupButton: 'signature',
};

/**
 * The editor's ⋯ menu: the group-specific actions the toolbar has no room for.
 * Icons follow sillybunny-action-menu's registry; anything unrecognised falls
 * back to its default glyph.
 */
function _buildActionSections() {
    const isEdit = session.context?.mode === 'edit';
    const actions = [];

    if (isEdit && callbacks?.canRestoreAvatar()) {
        actions.push({
            label: t`Restore collage avatar`,
            icon: 'fa-solid fa-images',
            onSelect: () => _dispatchTransportClick('#rm_group_restore_avatar'),
        });
    }

    // The lorebook dropdown is a transport holding the entries world-info.js
    // dispatches (and anything an extension appends), so the menu is built from
    // its live options rather than a hardcoded list.
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('group-chat-lorebook-dropdown'));
    for (const option of Array.from(select?.options ?? [])) {
        if (!option.id || option.disabled) continue;
        if (option.hidden || getComputedStyle(option).display === 'none') continue;
        actions.push({
            label: option.textContent.trim(),
            icon: `fa-solid fa-${ACTION_GLYPHS[option.id] ?? 'circle-dot'}`,
            onSelect: () => _dispatchTransportOption(option.id),
        });
    }

    const danger = [];
    // Deleting is only meaningful for a group that exists.
    if (isEdit) {
        danger.push({
            label: t`Delete Group`,
            icon: 'fa-solid fa-skull',
            danger: true,
            onSelect: () => _dispatchTransportClick('#rm_group_delete'),
        });
    }

    return [{ items: actions }, { items: danger }];
}

/**
 * Runs a transport-select entry by selecting it and firing change, so
 * world-info.js's own dispatcher stays the single implementation.
 * @param {string} optionId
 */
function _dispatchTransportOption(optionId) {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('group-chat-lorebook-dropdown'));
    if (!select) return;
    const option = Array.from(select.options).find(o => o.id === optionId);
    if (!option) return;
    select.value = option.value;
    $(select).trigger('change');
}

/** @param {string} selector */
function _dispatchTransportClick(selector) {
    /** @type {HTMLElement|null} */ (document.querySelector(selector))?.click();
}

// ============================================================
// Persist
// ============================================================

/** @param {import('./sillybunny-editor/session.js').EditorSaveReceipt} receipt */
async function _persist(receipt) {
    if (!receipt.isCurrent() || !callbacks) return;
    const ctx = receipt.context;

    if (ctx.mode === 'create') {
        await callbacks.createGroup(receipt);
    } else {
        const saved = await callbacks.saveDraft(ctx.entityId, receipt.snapshot);
        if (saved) {
            callbacks.commitFolder?.(ctx.entityId, receipt.snapshot?._folder ?? null);
            receipt.markSaved();
        }
    }
}

// ============================================================
// Utilities
// ============================================================

/**
 * Drag-to-reorder for the current-members list. The row's grip is the handle,
 * so a drag never competes with the row's own buttons or its mobile tap target;
 * the up/down buttons stay as the keyboard and touch fallback.
 *
 * Sortable reports positions among the rows on screen, and the list is
 * paginated, so the visible rows are mapped back to their draft indices through
 * the member ids they carry.
 */
function _mountMemberSortable() {
    const list = document.getElementById('rm_group_members');
    if (!list || typeof $(list).sortable !== 'function') return;

    /** Draft indices of the rows on screen, captured when the drag starts. */
    let visibleBefore = [];

    $(list).sortable({
        handle: '.sb-group-member-grip',
        items: '.group_member',
        axis: 'y',
        tolerance: 'pointer',
        revert: prefersReducedMotion() ? 0 : MOTION_FAST,
        // A filtered list shows a subset in a different order, so the resulting
        // positions would not mean anything.
        cancel: '.is-filtered .group_member',
        start: () => {
            visibleBefore = _renderedMemberIndices();
            _swallowDragEndClick(list);
        },
        stop: () => {
            const visibleAfter = _renderedMemberIndices();
            if (!visibleBefore.length || visibleAfter.length !== visibleBefore.length) return;
            // Nothing moved as far as the draft is concerned.
            if (visibleAfter.every((index, position) => index === visibleBefore[position])) return;
            callbacks?.reorderMembers(visibleBefore, visibleAfter);
        },
    });
}

/**
 * The mouseup that ends a drag is followed by a click on the nearest common
 * ancestor of the grip and the release point, which is the member row whenever
 * the drop lands on its avatar or text. jQuery UI only suppresses that click when
 * both events hit the same element, so swallow it here or the row would open
 * the member's character editor. Armed at drag start because `stop` waits for
 * the revert animation, which ends after that click; the click follows the
 * release in the same task, so the listener is dropped on the next macrotask.
 * @param {HTMLElement} list
 */
function _swallowDragEndClick(list) {
    const swallow = (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    const onRelease = () => {
        window.removeEventListener('mouseup', onRelease, true);
        window.removeEventListener('touchend', onRelease, true);
        list.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => list.removeEventListener('click', swallow, { capture: true }), 0);
    };
    window.addEventListener('mouseup', onRelease, true);
    window.addEventListener('touchend', onRelease, true);
}

/**
 * The draft indices of the rendered member rows, top to bottom. Each row carries
 * data-sb-member-index from getGroupCharacterBlock(), which is what makes a drag
 * work across a page boundary: the new visible order is applied to the draft
 * positions those rows came from, so members on other pages keep their slots.
 * @returns {number[]}
 */
function _renderedMemberIndices() {
    return Array.from(document.querySelectorAll('#rm_group_members .group_member'), (element) => Number(element.dataset.sbMemberIndex))
        .filter((index) => Number.isInteger(index));
}

function _isEditorVisible() {
    if (!session.isOpen()) return false;
    const panel = document.getElementById('right-nav-panel');
    if (!panel?.classList.contains('openDrawer')) return false;
    const menuType = panel.dataset.menuType;
    return menuType === 'group_edit' || menuType === 'group_create';
}
