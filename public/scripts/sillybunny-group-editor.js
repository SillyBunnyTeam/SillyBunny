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
//   markGroupEditorSaved(newGroupId?)   — recapture the baseline after a save
//   isGroupEditorOwner(groupId)         — true when this session owns the group
//   notifyGroupEditorChanged(options)   — report an edit instead of calling editGroup()
//   getGroupEditorTitle()               — current header title

import { t } from './i18n.js';
import { getCurrentUserHandle } from './user.js';
import { createEditorSession } from './sillybunny-editor/session.js';
import { createEditorDraftStore } from './sillybunny-editor/drafts.js';
import { mountEditorChrome, showDraftRecoveryToast, dismissDraftRecoveryToast } from './sillybunny-editor/chrome.js';
import { registerEditorNavigation, confirmEditorLeave, discardEditorChanges } from './sillybunny-editor/navigation.js';
import { MOTION_FAST, prefersReducedMotion } from './sillybunny-motion.js';

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
    offerDraft: showDraftRecoveryToast,
});

const navigation = {
    session,
    isActive: _isEditorVisible,
    close: _closeSafely,
    afterDiscard: _syncDomFromDraft,
};

/** @type {ReturnType<typeof mountEditorChrome>|null} */
let chrome = null;
/** Header title for the open session; follows inline renames. */
let editorTitle = '';

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
    _mountMemberSortable();
    registerEditorNavigation(navigation);
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

/**
 * Recapture the baseline after a successful save. Pass the new group ID when
 * transitioning from create to edit.
 * @param {string} [newGroupId]
 */
export function markGroupEditorSaved(newGroupId) {
    if (newGroupId && session.context?.mode === 'create') {
        editorTitle = callbacks?.getGroupName(newGroupId) ?? editorTitle;
        session.markSaved({ entityId: newGroupId, mode: 'edit' });
    } else {
        session.markSaved();
    }
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

/**
 * Called by group-chats.js's editor-owned handlers instead of editGroup().
 * @param {{ immediate?: boolean }} [options]  Typing debounces; anything
 *     structural (members, toggles, selects) is immediate.
 */
export function notifyGroupEditorChanged(options) {
    session.changed(options);
}

/** @returns {string} the title currently shown in the header. */
export function getGroupEditorTitle() {
    return editorTitle;
}

// ============================================================
// Session plumbing
// ============================================================

/** @param {{ mode: 'create'|'edit', entityId: string }} context */
function _openSession(context) {
    session.open(context);
    chrome?.scheduleOverflow();
    chrome?.reset();
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
    _closeSafely();
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
        if (saved) receipt.markSaved();
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
