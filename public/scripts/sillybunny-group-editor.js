// SillyBunny: group editor controller — explicit-save, draft backup (Step 4)
//
// Session, draft, leave-guard, header/toolbar mechanics are shared with the
// character editor through ./sillybunny-editor/. This file owns only what is
// specific to groups: the field snapshot, the action menu, and save dispatch.
//
// Public API consumed by group-chats.js:
//   initGroupEditor(config)             — bind DOM handlers (called once at startup)
//   beginGroupEditorLoad()              — suspend session before fields are written
//   openGroupEditorSession(groupId)     — open edit session (call after fields loaded)
//   openGroupEditorCreateSession()      — open create session
//   markGroupEditorSaved(groupId)       — recapture baseline after a successful save
//   isGroupEditorOwner(groupId)         — true when this session owns the given group
//   notifyGroupEditorChanged()          — call instead of editGroup() for editor-owned changes

import { t } from './i18n.js';
import { getCurrentUserHandle } from './user.js';
import { createEditorSession } from './sillybunny-editor/session.js';
import { createEditorDraftStore } from './sillybunny-editor/drafts.js';
import { mountEditorChrome, showDraftRecoveryToast, dismissDraftRecoveryToast } from './sillybunny-editor/chrome.js';
import { registerEditorNavigation, confirmEditorLeave, discardEditorChanges } from './sillybunny-editor/navigation.js';

const DRAFT_KEY_PREFIX = 'sb-group-editor-draft-';
const NEW_GROUP_DRAFT_KEY = 'new-group';

// --- Module state ---

const drafts = createEditorDraftStore({
    keyFor: (id) => `${DRAFT_KEY_PREFIX}${getCurrentUserHandle() || 'default'}-${id}`,
});

const session = createEditorSession({
    captureSnapshot: _captureSnapshot,
    restoreSnapshot: _restoreSnapshot,
    persist: _persist,
    drafts,
    onStateChange: _renderChrome,
    offerDraft: showDraftRecoveryToast,
});

const navigation = {
    session,
    isActive: _isEditorVisible,
    close: _closeSafely,
    afterDiscard: _afterDiscard,
};

/** @type {ReturnType<typeof mountEditorChrome>|null} */
let chrome = null;
let editorTitle = '';

/**
 * Callbacks supplied by group-chats.js at init time.
 * Avoids circular imports: group-chats.js imports this module and this module
 * does not import group-chats.js.
 * @type {{ getGroups: () => object[], persistEdit: (groupId: string) => Promise<void>, persistCreate: () => Promise<void> }|null}
 */
let callbacks = null;

// ============================================================
// Public API
// ============================================================

/**
 * @param {{ getGroups: () => object[], persistEdit: (groupId: string) => Promise<void>, persistCreate: () => Promise<void> }} config
 */
export function initGroupEditor(config) {
    callbacks = config;
    _mountChrome();
    registerEditorNavigation(navigation);
}

/**
 * Call immediately before group-chats.js overwrites form fields with group data.
 */
export function beginGroupEditorLoad() {
    session.suspend();
    dismissDraftRecoveryToast();
}

/**
 * Open an edit-mode session after select_group_chats() has finished populating fields.
 * @param {string} groupId
 */
export function openGroupEditorSession(groupId) {
    const group = callbacks?.getGroups().find((x) => x.id === groupId);
    if (!group) {
        console.warn('[sb-group-editor] openGroupEditorSession: group not found', groupId);
        return;
    }

    editorTitle = group.name;
    session.open({ mode: 'edit', entityId: groupId });
    chrome?.scheduleOverflow();
    chrome?.reset();
}

/**
 * Open a create-mode session.
 */
export function openGroupEditorCreateSession() {
    editorTitle = t`New Group`;
    session.open({ mode: 'create', entityId: NEW_GROUP_DRAFT_KEY });
    chrome?.scheduleOverflow();
    chrome?.reset();
}

/**
 * Recapture baseline after a successful save. Pass the new group ID when
 * transitioning from create mode.
 * @param {string} [newGroupId]
 */
export function markGroupEditorSaved(newGroupId) {
    if (newGroupId && session.context?.mode === 'create') {
        editorTitle = callbacks?.getGroups().find((x) => x.id === newGroupId)?.name ?? editorTitle;
        session.markSaved({ entityId: newGroupId, mode: 'edit' });
    } else {
        session.markSaved();
    }
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
 * Called by group-chats.js editor-owned handlers instead of editGroup().
 * Marks dirty without triggering a backend save.
 */
export function notifyGroupEditorChanged() {
    session.changed({ immediate: true });
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
            if (session.isDirty()) discardEditorChanges(navigation);
        },
        onSave: () => void session.save(),
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
        actionMenuTitle: t`Group Actions`,
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
        title: editorTitle,
        canCreate: _hasMembers(),
    });
}

function _hasMembers() {
    if (session.context?.mode === 'edit') return true;
    return Boolean(document.querySelector('#rm_group_members .group_member'));
}

async function _handleBack(event) {
    if (!await confirmEditorLeave(navigation)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }
    _closeSafely();
}

function _closeSafely() {
    const drawerTab = document.getElementById('sb_character_tab_groups');
    const settingsTab = document.querySelector('[data-sb-settings-tab="groups"]');
    const isPageMode = !drawerTab?.offsetParent && Boolean(settingsTab?.offsetParent);
    (isPageMode ? settingsTab : drawerTab)?.click();
}

function _afterDiscard() {
    const groupId = session.context?.entityId;
    if (!groupId || groupId === NEW_GROUP_DRAFT_KEY) return;
    const group = callbacks?.getGroups().find((x) => x.id === groupId);
    if (group) _syncSelectsFromGroup(group);
}

// ============================================================
// Action menu
// ============================================================

const GROUP_OVERFLOW_CANDIDATES = [
    '#rm_group_restore_avatar',
    '#groupCurrentMemberPopoutButton',
];

function _buildActionSections() {
    const danger = [];
    if (session.context?.mode === 'edit') {
        danger.push({
            label: t`Delete Group`,
            icon: 'fa-solid fa-skull',
            danger: true,
            onSelect: () => document.getElementById('rm_group_delete')?.click(),
        });
    }
    return [{ items: danger }];
}

// ============================================================
// Persist
// ============================================================

async function _persist() {
    const ctx = session.context;
    if (!ctx || !callbacks) return;

    if (ctx.mode === 'create') {
        // group-chats.js's createGroup() calls markGroupEditorSaved() on success.
        await callbacks.persistCreate();
    } else {
        await callbacks.persistEdit(ctx.entityId);
        markGroupEditorSaved();
    }
}

// ============================================================
// Snapshot: capture / restore
// ============================================================

const DOM_SNAPSHOT_FIELDS = [
    'rm_group_chat_name',
    'rm_group_activation_strategy',
    'rm_group_generation_mode',
    'rm_group_generation_mode_join_prefix',
    'rm_group_generation_mode_join_suffix',
];

function _captureSnapshot() {
    const snap = {};
    for (const id of DOM_SNAPSHOT_FIELDS) {
        const el = /** @type {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|null} */ (document.getElementById(id));
        if (el) snap[id] = el.value;
    }
    snap._allow_self = $('#rm_group_allow_self_responses').prop('checked') ?? false;
    snap._hide_muted = $('#rm_group_hidemutedsprites').prop('checked') ?? false;
    snap._fav = document.getElementById('group_favorite_button')?.classList.contains('fav_on') ?? false;

    // Arrays live in groups[], mutated in place by member handlers.
    const groupId = session.context?.entityId;
    const group = groupId && groupId !== NEW_GROUP_DRAFT_KEY
        ? callbacks?.getGroups().find((x) => x.id === groupId)
        : null;

    snap._members = group ? [...(group.members ?? [])] : _newGroupMembersList();
    snap._disabled = group ? [...(group.disabled_members ?? [])] : [];
    snap._models = group ? { ...(group.member_models ?? {}) } : {};

    return snap;
}

function _restoreSnapshot(snap) {
    if (!snap) return;

    for (const id of DOM_SNAPSHOT_FIELDS) {
        if (!(id in snap)) continue;
        const el = document.getElementById(id);
        if (el) {
            /** @type {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} */ (el).value = snap[id];
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    if ('_allow_self' in snap) $('#rm_group_allow_self_responses').prop('checked', snap._allow_self).trigger('change');
    if ('_hide_muted' in snap) $('#rm_group_hidemutedsprites').prop('checked', snap._hide_muted).trigger('change');
    if ('_fav' in snap) {
        const btn = document.getElementById('group_favorite_button');
        const currentFav = btn?.classList.contains('fav_on') ?? false;
        if (btn && currentFav !== snap._fav) btn.click();
    }

    // Write arrays back into the live group object, then re-render.
    const groupId = session.context?.entityId;
    const group = groupId && groupId !== NEW_GROUP_DRAFT_KEY
        ? callbacks?.getGroups().find((x) => x.id === groupId)
        : null;

    if (group) {
        if ('_members' in snap) group.members = [...snap._members];
        if ('_disabled' in snap) group.disabled_members = [...snap._disabled];
        if ('_models' in snap) group.member_models = { ...snap._models };
        // Signal group-chats.js to re-render the member list.
        document.dispatchEvent(new CustomEvent('sb-group-reprint-members'));
    }
}

/** Re-sync select/checkbox DOM from the live group object after array-only restore. */
function _syncSelectsFromGroup(group) {
    const stratEl = document.getElementById('rm_group_activation_strategy');
    if (stratEl instanceof HTMLSelectElement) stratEl.value = String(group.activation_strategy ?? 0);
    const modeEl = document.getElementById('rm_group_generation_mode');
    if (modeEl instanceof HTMLSelectElement) modeEl.value = String(group.generation_mode ?? 0);
    $('#rm_group_allow_self_responses').prop('checked', group.allow_self_responses ?? false);
    $('#rm_group_hidemutedsprites').prop('checked', group.hideMutedSprites ?? false);
}

function _newGroupMembersList() {
    return Array.from(
        document.querySelectorAll('#rm_group_members .group_member'),
        (el) => $(el).data('id') || '',
    ).filter(Boolean);
}

// ============================================================
// Utilities
// ============================================================

function _isEditorVisible() {
    if (!session.isOpen()) return false;
    const panel = document.getElementById('right-nav-panel');
    if (!panel?.classList.contains('openDrawer')) return false;
    const menuType = panel.dataset.menuType;
    return menuType === 'group_edit' || menuType === 'group_create';
}
