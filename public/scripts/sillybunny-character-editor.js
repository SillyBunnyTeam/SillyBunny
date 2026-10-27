// SillyBunny: character editor controller — explicit-save, draft backup, greeting renderer
// (Step 3b, feat/v1.9.0-ui-overhaul)
//
// Session, draft, leave-guard, header/toolbar, and preview mechanics are shared
// with the group editor through ./sillybunny-editor/. This file keeps only what
// is specific to characters: the field snapshot, greetings, the action menu,
// the token readout, and preview formatting.
//
// Public API consumed by script.js:
//   beginCharacterEditorLoad()          — flush draft before field writes
//   loadCharacterEditorGreetings(chid, mode) — render greeting lists after fields are loaded
//   openCharacterEditorSession(chid)    — open edit session (call after fields are written)
//   openCharacterEditorCreateSession()  — open create session
//   captureCharacterEditorSave(avatar)  — capture the owning session's submitted values
//   markCharacterEditorSaved(receipt, avatar?) — acknowledge only those submitted values
//   getCharacterEditorAlternateGreetings(avatar) — alternate greetings to submit for a save
//   getCharacterEditorGroupGreetings(avatar)     — group-only greetings to submit for a save
//   addAlternateGreeting()              — add a new alternate greeting row
//   addGroupGreeting()                  — add a new group-only greeting row
//   initCharacterEditor()               — bind all DOM handlers (called once at startup)

import { formatCreatorNotes, getCurrentEntityId } from './chats.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from './popup.js';
import { openActionMenu } from './sillybunny-action-menu.js';
import { power_user, setCharacterEditorQuickEdit } from './power-user.js';
import { groups } from './group-chats.js';
import { world_info, world_names } from './world-info.js';
import { eventSource, event_types } from './events.js';
import {
    characters,
    this_chid,
    create_save,
    createOrEditCharacter,
    converter,
} from '../script.js';
import { t, translate } from './i18n.js';
import { getCurrentUserHandle } from './user.js';
import { createSegmentedControl, setSegmentedControlValue } from './sillybunny-segmented-control.js';
import { DOMPurify } from '../lib.js';
import { createEditorSession } from './sillybunny-editor/session.js';
import { createEditorDraftStore } from './sillybunny-editor/drafts.js';
import { mountEditorChrome, showDraftRecoveryToast, dismissDraftRecoveryToast } from './sillybunny-editor/chrome.js';
import { registerEditorNavigation, confirmEditorLeave, discardEditorChanges } from './sillybunny-editor/navigation.js';
import { objectNavigation } from './sillybunny-editor/object-navigation.js';
import { createComboRow, createRow } from './sillybunny-editor/rows.js';
import { reconcileRows } from './sillybunny-editor/list-rows.js';
import { getFolderId, getFolders, setFolder, subscribe as subscribeFolders } from './sillybunny-folders.js';
import './sillybunny-characters-navigation.js';
import { mountEditorPreviews } from './sillybunny-editor/preview.js';
import { animateHeightFrom, animateIn, animateListChange, MOTION_EASE_OUT_QUAD, MOTION_FAST, MOTION_SLOW, prefersReducedMotion } from './sillybunny-motion.js';

// Existing users' backups live under this prefix; changing it orphans them.
const DRAFT_KEY_PREFIX = 'sb-editor-draft-';
const NEW_CHAR_DRAFT_KEY = 'new-character';

// --- Module state ---

const drafts = createEditorDraftStore({
    keyFor: avatar => `${DRAFT_KEY_PREFIX}${getCurrentUserHandle() || 'default'}-${avatar}`,
});

const session = createEditorSession({
    captureSnapshot: _captureSnapshot,
    restoreSnapshot: _restoreSnapshot,
    persist: _persist,
    drafts,
    onStateChange: _renderChrome,
    offerDraft: (draft, actions) => showDraftRecoveryToast(draft, actions, `character:${session.context.entityId}`),
});

const navigation = {
    session,
    isActive: _isEditorVisible,
    close: _navigateBack,
};

/** @type {ReturnType<typeof mountEditorChrome>|null} */
let chrome = null;
/** @type {ReturnType<typeof mountEditorPreviews>|null} */
let previews = null;
/** Header title for the open session; follows inline renames. */
let editorTitle = '';
let folderSelectRow = null;

/** @type {MutationObserver|null} */
let tokenMirrorObserver = null;
let tokenMirrorScheduled = false;
const relatedRows = new Map();
let relatedLinksDirty = true;

// Session-local greeting drafts (A.2.3). Rows edit these, never the entity, so
// Cancel/Discard can revert and unrelated autosaves cannot persist half-edits.
// draftOwner is the avatar (or NEW_CHAR_DRAFT_KEY) the drafts were loaded for.
/** @type {string[]} */
let draftAlt = [];
/** @type {string[]} */
let draftGrp = [];
/** @type {string|null} */
let draftOwner = null;
let greetingKeySeed = 0;
/** @type {string[]} */
let draftAltKeys = [];
/** @type {string[]} */
let draftGrpKeys = [];

// ============================================================
// Public API
// ============================================================

export function initCharacterEditor() {
    _mountChrome();
    _bindToolbarButtons();
    _bindExportMenu();
    _bindTokenMirror();
    previews = mountEditorPreviews(/** @type {HTMLElement} */ (document.getElementById('form_create')), _renderPreview);
    _mountRoleSegment();
    _bindGreetingAddButtons();
    _bindGreetingExpanders();
    _bindFieldDirtyListeners();
    _bindRelatedLinks();
    _mountFolderField();
    registerEditorNavigation(navigation);

    // Recapture baseline whenever the backend saves (avatar change, world link, export)
    eventSource.on(event_types.CHARACTER_EDITED, _handleExternalSave);
}

/**
 * Call immediately before script.js overwrites form fields with new character data.
 * Flushes any pending dirty draft so it isn't lost.
 */
export function beginCharacterEditorLoad() {
    session.suspend();
    dismissDraftRecoveryToast();
}

/**
 * Render greeting lists after script.js has finished writing fields.
 * @param {number|null} chid  Character index (null in create mode)
 * @param {'edit'|'create'} mode
 */
export function loadCharacterEditorGreetings(chid, mode) {
    if (mode === 'create') {
        draftAlt = _copyGreetings(create_save.alternate_greetings);
        draftGrp = _copyGreetings(create_save.group_only_greetings);
        draftOwner = NEW_CHAR_DRAFT_KEY;
    } else {
        const data = characters[chid]?.data;
        draftAlt = _copyGreetings(data?.alternate_greetings);
        draftGrp = _copyGreetings(data?.group_only_greetings);
        draftOwner = characters[chid]?.avatar ?? null;
    }
    draftAltKeys = draftAlt.map(() => _newGreetingKey());
    draftGrpKeys = draftGrp.map(() => _newGreetingKey());
    _renderAlternateGreetings();
    _renderGroupGreetings();
}

/**
 * Open an edit-mode session for the given character.
 * Call after loadCharacterEditorGreetings and after all fields are written.
 * @param {number} chid
 */
export function openCharacterEditorSession(chid) {
    const character = characters[chid];
    if (!character) {
        console.warn('[sb-editor] openCharacterEditorSession: character not found', chid);
        return;
    }

    editorTitle = character.name;
    _setFolderDraft(getFolderId('characters', character.avatar));
    _openSession({ mode: 'edit', entityId: character.avatar, chid });
}

/**
 * Open a create-mode session.
 * Call after loadCharacterEditorGreetings and after all fields are written.
 */
export function openCharacterEditorCreateSession() {
    editorTitle = t`Create New Character`;
    _setFolderDraft(null);
    _openSession({ mode: 'create', entityId: NEW_CHAR_DRAFT_KEY, chid: null });
}

/** @param {string|null} avatar  Null for create; otherwise the submitted avatar. */
export function captureCharacterEditorSave(avatar) {
    const context = session.context;
    if (!context) return null;
    if (avatar === null ? context.mode !== 'create' : context.mode !== 'edit' || context.entityId !== avatar) return null;
    return session.captureSaveReceipt();
}

/**
 * @param {import('./sillybunny-editor/session.js').EditorSaveReceipt|null} receipt
 * @param {string} [newAvatar]  The identity returned by a successful create.
 */
export function markCharacterEditorSaved(receipt, newAvatar) {
    if (!receipt?.isCurrent()) return false;
    if (receipt.context.mode !== 'create' || !newAvatar) {
        if (receipt.context.mode === 'edit' && receipt.context.entityId) _commitFolder(receipt, receipt.context.entityId);
        return receipt.markSaved();
    }

    const chid = characters.findIndex(character => character.avatar === newAvatar);
    if (chid < 0) throw new Error(`Created character not found: ${newAvatar}`);
    draftOwner = newAvatar;
    editorTitle = document.getElementById('character_name_pole')?.value ?? characters[chid].name;
    document.getElementById('form_create')?.setAttribute('actiontype', 'editcharacter');
    const avatarField = document.querySelector('#form_create [name="avatar_url"]');
    if (avatarField) avatarField.value = newAvatar;
    // Subsequent edits must not submit hidden chat/card metadata from the old selection.
    for (const [id, value] of [
        ['selected_chat_pole', characters[chid].chat],
        ['create_date_pole', characters[chid].create_date],
        ['character_json_data', characters[chid].json_data],
    ]) {
        const field = document.getElementById(id);
        if (field) field.value = value ?? '';
    }
    _commitFolder(receipt, newAvatar);
    return receipt.markSaved({ mode: 'edit', entityId: newAvatar, chid });
}

function folderOptions() {
    let folders = [];
    try {
        folders = getFolders('characters');
    } catch {
        folders = [];
    }
    return [{ value: '', label: t`No folder` }, ...folders.map(folder => ({ value: folder.id, label: folder.name }))];
}

function _mountFolderField() {
    const host = document.getElementById('character_folder_row');
    if (!(host instanceof HTMLElement) || folderSelectRow) return;
    const select = document.createElement('select');
    select.id = 'character_folder';
    select.setAttribute('aria-label', t`Folder`);
    folderSelectRow = createComboRow({
        label: t`Folder`,
        field: 'folder',
        options: folderOptions(),
        value: '',
        onChange: () => session.changed({ immediate: true }),
        select,
    });
    host.replaceChildren(folderSelectRow.row);
    subscribeFolders(({ scope }) => {
        if (scope && scope !== 'characters') return;
        const value = folderSelectRow.getValue();
        folderSelectRow.control.replaceChildren(...folderOptions().map(option => {
            const element = document.createElement('option');
            element.value = option.value;
            element.textContent = option.label;
            return element;
        }));
        folderSelectRow.setValue(folderOptions().some(option => option.value === value) ? value : '', { silent: true });
    });
}

function _setFolderDraft(folderId) {
    const value = folderId ? String(folderId) : '';
    folderSelectRow?.setValue(value, { silent: true });
}

function _folderDraft() {
    return String(folderSelectRow?.getValue() ?? '') || null;
}

function _commitFolder(receipt, key) {
    if (!receipt?.isCurrent() || !key) return;
    setFolder('characters', [String(key)], receipt.snapshot?._folder ?? null);
}

/** @param {import('./sillybunny-editor/session.js').EditorSaveReceipt} receipt */
function _persist(receipt) {
    return createOrEditCharacter(undefined, receipt);
}

/** Reconciles an acknowledged live favorite change without saving other editor fields. */
export function syncCharacterEditorFavorite(avatar, fav) {
    if (session.context?.mode !== 'edit' || session.context.entityId !== avatar) return false;
    const button = document.getElementById('favorite_button');
    if (!button) return false;
    const favorite = Boolean(fav);
    button.classList.toggle('fav_on', favorite);
    button.classList.toggle('fav_off', !favorite);
    _syncFavoritePressed();
    const backup = drafts.read(avatar);
    if (backup) drafts.write(avatar, { ...backup.snapshot, _fav: favorite });
    session.rebase({ ...session.readBaseline(), _fav: favorite });
    return true;
}

/** Drops only the deleted entity's session and backup; the caller owns navigation. */
export function discardCharacterEditorForEntity(avatar) {
    if (!avatar) return false;
    drafts.remove(avatar);
    dismissDraftRecoveryToast(`character:${avatar}`);
    if (session.context?.mode !== 'edit' || session.context.entityId !== avatar) return false;
    session.close();
    _renderRelatedLinks();
    if (draftOwner === avatar) {
        draftOwner = null;
        draftAlt = [];
        draftGrp = [];
        draftAltKeys = [];
        draftGrpKeys = [];
        _renderAlternateGreetings();
        _renderGroupGreetings();
    }
    previews?.reset();
    return true;
}

/**
 * Alternate greetings to submit for a save. Returns the editor draft when it
 * belongs to the character being saved, otherwise that character's stored list,
 * so a save for another card (or with no editor open) never submits [] and wipes
 * its greetings.
 * @param {string|null} targetAvatar  Avatar being saved, or null for create
 * @returns {string[]}
 */
export function getCharacterEditorAlternateGreetings(targetAvatar) {
    if (_draftBelongsTo(targetAvatar)) return [...draftAlt];
    return _copyGreetings(_storedGreetings(targetAvatar)?.alternate_greetings);
}

/**
 * Group-only greetings to submit for a save; same ownership rule as
 * getCharacterEditorAlternateGreetings().
 * @param {string|null} targetAvatar  Avatar being saved, or null for create
 * @returns {string[]}
 */
export function getCharacterEditorGroupGreetings(targetAvatar) {
    if (_draftBelongsTo(targetAvatar)) return [...draftGrp];
    return _copyGreetings(_storedGreetings(targetAvatar)?.group_only_greetings);
}

/**
 * Add a new alternate greeting row and focus its textarea.
 */
export function addAlternateGreeting() {
    if (!session.isOpen()) return;
    const newIndex = draftAlt.length;
    draftAlt.push('');
    draftAltKeys.push(_newGreetingKey());
    _renderAlternateGreetings({ animate: true });
    _commitCreateDrafts();
    session.changed({ immediate: true });
    _focusGreetingRow('.alternate_greetings_list', newIndex);
}

/**
 * Add a new group-only greeting row and focus its textarea.
 */
export function addGroupGreeting() {
    if (!session.isOpen()) return;
    const newIndex = draftGrp.length;
    draftGrp.push('');
    draftGrpKeys.push(_newGreetingKey());
    _renderGroupGreetings({ animate: true });
    _commitCreateDrafts();
    session.changed({ immediate: true });
    _focusGreetingRow('.group_only_greetings_list', newIndex);
}

// ============================================================
// Internal: session and greeting-draft helpers
// ============================================================

/** @param {{ mode: 'edit'|'create', entityId: string, chid: number|null }} context */
function _openSession(context) {
    const previous = session.context;
    previews?.reset();
    _syncRoleSegment();
    session.open(context);
    _renderRelatedLinks();
    _syncTokenReadout();
    _syncFavoritePressed();
    chrome?.scheduleOverflow();
    chrome?.reset({ scrollToTop: previous?.mode !== context.mode || previous?.entityId !== context.entityId });
}

/** @param {unknown} list */
function _copyGreetings(list) {
    return Array.isArray(list) ? list.map(value => String(value ?? '')) : [];
}

function _newGreetingKey() {
    greetingKeySeed += 1;
    return `greeting-${greetingKeySeed}`;
}

function _greetingKeys(kind) {
    return kind === 'alternate' ? draftAltKeys : draftGrpKeys;
}

function _ensureGreetingKeys(kind) {
    const greetings = kind === 'alternate' ? draftAlt : draftGrp;
    const keys = _greetingKeys(kind);
    while (keys.length < greetings.length) keys.push(_newGreetingKey());
    if (keys.length > greetings.length) keys.splice(greetings.length);
    return keys;
}

/** @param {string|null} targetAvatar */
function _draftBelongsTo(targetAvatar) {
    if (draftOwner === null) return false;
    return targetAvatar === null ? draftOwner === NEW_CHAR_DRAFT_KEY : draftOwner === targetAvatar;
}

/** @param {string|null} targetAvatar */
function _storedGreetings(targetAvatar) {
    if (targetAvatar === null) return create_save;
    return characters.find(character => character?.avatar === targetAvatar)?.data ?? null;
}

/**
 * Create mode keeps its in-progress card in create_save, which survives leaving
 * and re-entering the create panel. Mirror the drafts there so greetings persist
 * the same way the text fields do; edit mode never writes to the entity.
 */
function _commitCreateDrafts() {
    if (draftOwner !== NEW_CHAR_DRAFT_KEY) return;
    create_save.alternate_greetings = [...draftAlt];
    create_save.group_only_greetings = [...draftGrp];
}

// ============================================================
// Header and toolbar chrome
// ============================================================

function _mountChrome() {
    const root = document.getElementById('form_create');
    const header = document.getElementById('sb_character_editor_header');
    const toolbar = document.getElementById('sb_character_editor_toolbar');
    const content = root?.querySelector('.sb-editor-sheet__content');
    if (!root || !header || !toolbar || !(content instanceof HTMLElement)) return;

    const nameField = /** @type {HTMLInputElement|null} */ (document.getElementById('character_name_pole'));

    chrome = mountEditorChrome({
        root,
        header,
        toolbar,
        content,
        controls: {
            back: document.getElementById('sb_character_editor_back'),
            cancel: /** @type {HTMLButtonElement} */ (document.getElementById('sb_character_editor_cancel')),
            save: /** @type {HTMLButtonElement} */ (document.getElementById('sb_character_editor_save')),
            title: document.getElementById('sb_character_editor_title'),
            titleButton: /** @type {HTMLButtonElement|null} */ (document.getElementById('sb_character_editor_title_button')),
            dirty: document.getElementById('sb_character_editor_dirty'),
            more: document.getElementById('sb_character_editor_more'),
        },
        onBack: _handleBack,
        onCancel: () => {
            // Cancel is disabled when clean, so a click is intentional.
            if (session.isDirty()) discardEditorChanges(navigation);
        },
        onSave: () => void session.save(),
        // The sticky header's title is the rename affordance, replacing the
        // legacy #rm_button_selected_ch h2 inside the hidden #rm_PinAndTabs. It
        // writes name/data.name and keeps the avatar identity; the destructive
        // full rename (renameCharacter() → /api/characters/rename, which mints a
        // new avatar and moves the chat directory) stays in the action menu.
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
        overflowCandidates: OVERFLOW_CANDIDATES,
        getActionSections: _buildActionSections,
        actionMenuTitle: t`Character Actions`,
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
    });
    // The quick-edit toggle persists in power_user, so its pressed state must
    // follow the setting rather than only the last click.
    _syncQuickEditPressed();
}

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
        current: { kind: 'character-editor', id: characters[this_chid]?.avatar ?? null },
        fallback: _closeSafely,
    });
}

function _closeSafely() {
    // Navigate to the characters tab. Two possible entry points exist: the
    // character panel as a drawer has data-sb-character-tab tabs, while the
    // page-hosted layout uses a settings page sidebar with data-sb-settings-tab.
    // Clicking #rm_button_back (the hidden stub) only fires the panel switch
    // without activating the correct tab, leaving the UI desynchronized. (Step 3b fix)
    const drawerTab = document.getElementById('sb_character_tab_characters');
    const settingsTab = document.querySelector('[data-sb-settings-tab="characters"]');
    const isPageMode = !drawerTab?.offsetParent && Boolean(settingsTab?.offsetParent);
    (isPageMode ? settingsTab : drawerTab)?.click();
}

function _bindToolbarButtons() {
    document.getElementById('sb_character_editor_quick_edit')
        ?.addEventListener('click', () => {
            const btn = document.getElementById('sb_character_editor_quick_edit');
            const pressed = btn?.getAttribute('aria-pressed') === 'true';
            setCharacterEditorQuickEdit(!pressed);
            // Leaving Quick Edit reveals the other sections; fade them in so the change
            // reads as a reveal. Entering it only hides content, which stays instant.
            if (pressed) {
                document.querySelectorAll('#form_create .sb-editor-section:not([data-sb-section="essentials"])').forEach(section => {
                    animateIn(/** @type {HTMLElement} */ (section), [{ opacity: 0 }, { opacity: 1 }], {
                        duration: MOTION_FAST,
                        easing: MOTION_EASE_OUT_QUAD,
                    });
                });
            }
        });

    // The favourite button is a div toggled by the fav_on/fav_off classes, which
    // the toolbar cannot use to express state. Mirror it into aria-pressed so the
    // button can render a selected fill.
    const favButton = document.getElementById('favorite_button');
    if (favButton) {
        new MutationObserver(_syncFavoritePressed)
            .observe(favButton, { attributes: true, attributeFilter: ['class'] });
        _syncFavoritePressed();
    }

    _syncQuickEditPressed();
}

/**
 * The quick-edit toggle persists in power_user, so its pressed state must follow
 * the setting rather than only the last click.
 */
function _syncQuickEditPressed() {
    const button = document.getElementById('sb_character_editor_quick_edit');
    if (!button) return;
    const sheet = document.getElementById('form_create');
    const enabled = sheet?.classList.contains('sb-editor-sheet--quick-edit') ?? false;
    button.setAttribute('aria-pressed', String(enabled));
}

function _syncFavoritePressed() {
    const favButton = document.getElementById('favorite_button');
    if (!favButton) return;
    favButton.setAttribute('aria-pressed', String(favButton.classList.contains('fav_on')));
}

// ============================================================
// Action menu
// ============================================================

/**
 * Option id -> glyph for the transport select's entries. Anything not listed
 * (for example an option an extension appended at runtime) falls back to a
 * generic glyph, so extension actions still appear in the menu.
 */
const ACTION_GLYPHS = {
    set_character_world: 'globe',
    import_character_info: 'book',
    regenerate_thumbnail: 'image',
    set_chat_character_settings: 'sliders',
    convert_to_persona: 'user-pen',
    renameCharButton: 'signature',
    character_source: 'link',
    replace_update: 'rotate',
    import_tags: 'tags',
    set_as_assistant: 'house',
};

/**
 * Toolbar buttons that may be collapsed into the overflow menu when the editor
 * panel is too narrow for the full row. Resolved inside #form_create, so the
 * group editor's own .chat_lorebook_button is never picked up.
 *
 * Ordered most-expendable first: destructive and duplicate actions are the
 * safest to tuck away, while favourite, lore and personas stay visible because
 * they are state indicators or very frequently used.
 */
const OVERFLOW_CANDIDATES = [
    '#dupe_button',
    '#export_button',
    '#char_connections_button',
    '.chat_lorebook_button',
    '#world_button',
];

/**
 * The three actions recovered from the legacy #rm_PinAndTabs titlebar, which is
 * hidden by CSS for character_edit/create. They are plain hidden transports;
 * dispatching a click on each runs its existing binding:
 *   #creators_note_styles_button    -> chats.js:2335  openGlobalStylesPreferenceDialog()
 *   #character_open_media_overrides -> chats.js:2309  delegated .open_media_overrides
 *   .rm_stats_button                -> stats.js:327   characterStatsHandler()
 */
const RECOVERED_ACTIONS = [
    { id: 'sb_action_global_styles', label: 'Global Styles', glyph: 'palette', transport: '#creators_note_styles_button' },
    { id: 'sb_action_media_overrides', label: 'External Media', glyph: 'link-slash', transport: '#character_open_media_overrides' },
    { id: 'sb_action_stats', label: 'Character Stats', glyph: 'ranking-star', transport: '.rm_stats_button' },
];

/**
 * Builds the character action menu from the live transport select, so entries
 * that extensions append at runtime stay reachable. Collapsed toolbar buttons
 * are prepended by the shared chrome.
 */
function _buildActionSections() {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('char-management-dropdown'));

    const primary = [];
    for (const option of Array.from(select?.options ?? [])) {
        const id = option.id;
        if (!id || option.disabled) continue;
        // Upstream hides entries it does not apply to (Rename in create mode,
        // Character Settings Overrides without a group) with an inline
        // `display: none`. That does NOT set option.hidden, so it has to be read
        // from the resolved style instead.
        if (option.hidden || getComputedStyle(option).display === 'none') continue;

        primary.push({
            label: option.textContent.trim(),
            icon: `fa-solid fa-${ACTION_GLYPHS[id] ?? 'circle-dot'}`,
            onSelect: () => _dispatchTransportAction(id),
        });
    }

    const recovered = RECOVERED_ACTIONS
        .filter(action => document.querySelector(action.transport))
        .map(action => ({
            label: translate(action.label),
            icon: `fa-solid fa-${action.glyph}`,
            onSelect: () => _dispatchTransportClick(action.transport),
        }));

    const danger = [];
    // Delete is only meaningful for an existing character, never a draft.
    if (session.context?.mode === 'edit') {
        danger.push({
            label: t`Delete Character`,
            icon: 'fa-solid fa-skull',
            danger: true,
            onSelect: () => _dispatchTransportClick('#delete_button'),
        });
    }

    return [{ items: primary }, { items: recovered }, { items: danger }];
}

/**
 * Runs a transport-select entry by selecting it and firing change, so the
 * upstream dispatcher at script.js:18707 stays the single implementation of
 * every one of these actions.
 * @param {string} optionId
 */
function _dispatchTransportAction(optionId) {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('char-management-dropdown'));
    if (!select) return;

    const option = Array.from(select.options).find(candidate => candidate.id === optionId);
    if (!option) return;

    select.value = option.value;
    select.selectedIndex = option.index;
    $(select).trigger('change');
}

/**
 * Runs an action whose handler is bound to another element, by forwarding a
 * click. Used for the recovered titlebar controls.
 * @param {string} selector
 */
function _dispatchTransportClick(selector) {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) return;
    element.click();
}

function _bindRelatedLinks() {
    const heading = document.getElementById('sb_character_section_related');
    // HUMAN: replace — Related section heading.
    if (heading) heading.textContent = t`lorum ipsum`;
    for (const type of [
        event_types.WORLDINFO_SETTINGS_UPDATED, event_types.SETTINGS_UPDATED,
        event_types.CHARACTER_EDITED, event_types.CHARACTER_PAGE_LOADED,
        event_types.GROUP_UPDATED, event_types.GROUP_CHAT_CREATED, event_types.GROUP_CHAT_DELETED,
        event_types.PERSONA_UPDATED, event_types.PERSONA_CREATED, event_types.PERSONA_DELETED, event_types.PERSONA_RENAMED,
    ]) {
        eventSource.on(type, _renderRelatedLinks);
    }
    document.getElementById('world_button')?.addEventListener('click', event => {
        if (event.shiftKey || event.altKey || session.context?.mode !== 'edit') return;
        const character = characters.find(character => character.avatar === session.context.entityId);
        const book = character?.data?.extensions?.world;
        if (!book || !world_names.includes(book)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void objectNavigation.navigate({ kind: 'world-info', id: book }, {
            from: { kind: 'character-editor', id: character.avatar },
        });
    }, { capture: true });
    _renderRelatedLinks();
    const panel = document.getElementById('right-nav-panel');
    if (panel) {
        new MutationObserver(() => {
            if (relatedLinksDirty && _isEditorVisible()) _renderRelatedLinks();
        }).observe(panel, { attributes: true, attributeFilter: ['class', 'data-menu-type', 'aria-hidden'] });
    }
}

function _relatedEntries(character) {
    const avatar = character.avatar;
    const primary = character.data?.extensions?.world;
    // Upstream charLore uses getCharaFilename's extensionless key; keep full-avatar compatibility too.
    const filename = avatar.replace(/\.[^/.]+$/, '');
    const books = new Set([primary, ...(world_info.charLore ?? [])
        .filter(entry => entry.name === avatar || entry.name === filename)
        .flatMap(entry => entry.extraBooks ?? [])].filter(Boolean));
    const entries = [...books].map(book => ({
        kind: 'world-info', id: book, label: book, glyph: 'book',
        subtitle: book === primary ? t`Primary Lorebook` : t`Additional Lorebooks`,
    }));
    if (!books.size) entries.push({ kind: 'link-lorebook', id: avatar, label: t`Link to World Info`, glyph: 'book' });
    for (const group of groups.filter(group => group.members?.includes(avatar))) {
        entries.push({ kind: 'group-editor', id: String(group.id), label: group.name, subtitle: t`Groups`, glyph: 'users' });
    }
    for (const [id, descriptor] of Object.entries(power_user.persona_descriptions ?? {})) {
        if (!Object.hasOwn(power_user.personas ?? {}, id)) continue;
        if (!descriptor?.connections?.some(connection => connection.type === 'character' && connection.id === avatar)) continue;
        entries.push({ kind: 'persona-editor', id, label: power_user.personas[id], subtitle: t`Persona`, glyph: 'user' });
    }
    return entries;
}

function _renderRelatedLinks() {
    if (!_isEditorVisible()) {
        relatedLinksDirty = true;
        return;
    }
    relatedLinksDirty = false;
    const section = document.getElementById('sb_character_related');
    const container = document.getElementById('sb_character_related_rows');
    if (!section || !container) return;
    const character = session.isOpen() && session.context?.mode === 'edit'
        ? characters.find(character => character.avatar === session.context.entityId) : null;
    section.hidden = !character?.avatar;
    section.classList.toggle('displayNone', section.hidden);
    reconcileRows({
        container, cache: relatedRows, entries: character ? _relatedEntries(character) : [],
        key: entry => `${entry.kind}:${entry.id}`,
        signature: entry => `${entry.kind}:${entry.id}`,
        create: entry => {
            const glyph = document.createElement('i');
            glyph.className = `fa-solid fa-${entry.glyph}`;
            glyph.setAttribute('aria-hidden', 'true');
            const view = createRow({
                label: entry.label, subtitle: entry.subtitle, field: 'related', prefix: glyph, activatable: true,
                onActivate: () => {
                    if (session.context?.mode !== 'edit') return;
                    if (entry.kind === 'link-lorebook') return _dispatchTransportAction('set_character_world');
                    void objectNavigation.navigate({ kind: entry.kind, id: entry.id }, {
                        from: { kind: 'character-editor', id: session.context.entityId },
                    });
                },
            });
            view.row.classList.add('ds-row-button');
            view.row.dataset.relatedKind = entry.kind;
            view.row.dataset.targetId = entry.id;
            return view.row;
        },
        update: (row, entry) => {
            const label = row.querySelector('.ds-row-label');
            if (label.textContent !== entry.label) label.textContent = entry.label;
            const subtitle = row.querySelector('.ds-row-subtitle');
            if (subtitle && subtitle.textContent !== entry.subtitle) subtitle.textContent = entry.subtitle;
        },
    });
}

function _bindExportMenu() {
    const trigger = document.getElementById('export_button');
    if (!trigger) return;
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', event => {
        // The upstream Popper popup sits behind the page-hosted editor. Reuse the
        // shell menu, but keep its format nodes as the save-and-download transport.
        event.preventDefault();
        event.stopImmediatePropagation();
        const formats = document.querySelectorAll('#export_format_popup .export_format[data-format]');
        openActionMenu({
            trigger,
            title: t`Export Character`,
            keyboard: event.detail === 0,
            sections: [{
                items: Array.from(formats, format => ({
                    label: format.textContent.trim(),
                    icon: 'fa-solid fa-download',
                    onSelect: () => /** @type {HTMLElement} */ (format).click(),
                })),
            }],
        });
    }, { capture: true });
}

// ============================================================
// Token readout
// ============================================================

/**
 * Mirrors the legacy #result_info counters into the editor header. Those nodes
 * live inside the hidden #rm_PinAndTabs, but RA_CountCharTokens() still updates
 * them, so reading them keeps one implementation of the counting and keeps
 * extensions that read #result_info working.
 */
function _syncTokenReadout() {
    const readout = document.getElementById('sb_character_editor_tokens');
    const value = document.getElementById('sb_character_editor_tokens_value');
    const warning = document.getElementById('sb_character_editor_token_warning');
    if (!readout || !value) return;

    const total = document.getElementById('result_info_total_tokens')?.textContent?.trim() ?? '';
    const permanent = document.getElementById('result_info_permanent_tokens')?.textContent?.trim() ?? '';

    if (!total || /^calculating/i.test(total) || total === '...') {
        readout.hidden = true;
        return;
    }

    readout.hidden = false;
    value.textContent = permanent
        ? `${total} ${t`Tokens`} (${permanent} ${t`Permanent`})`
        : `${total} ${t`Tokens`}`;

    // RA_CountCharTokens() classifies the card by toggling neutral_warning on the
    // legacy wrapper. Drive the new readout from that single source of truth:
    // inline display, so it matches how upstream shows/hides its own warning.
    const warn = document.getElementById('result_info_text')?.classList.contains('neutral_warning') ?? false;
    readout.classList.toggle('is-over-budget', warn);
    if (warning instanceof HTMLElement) {
        warning.style.display = warn ? '' : 'none';
    }
}

function _bindTokenMirror() {
    // Counting is debounced upstream (1000ms on form input, 200ms on title
    // mutation), so poll briefly after a session opens rather than racing it.
    const timers = [120, 600, 1400];
    _syncTokenReadout();
    timers.forEach(delay => setTimeout(() => {
        if (session.isOpen()) _syncTokenReadout();
    }, delay));

    tokenMirrorObserver?.disconnect();
    tokenMirrorObserver = new MutationObserver(() => {
        if (tokenMirrorScheduled) return;
        tokenMirrorScheduled = true;
        requestAnimationFrame(() => {
            tokenMirrorScheduled = false;
            if (session.isOpen()) _syncTokenReadout();
        });
    });

    for (const id of ['result_info_total_tokens', 'result_info_permanent_tokens', 'result_info_text']) {
        const target = document.getElementById(id);
        if (target) {
            tokenMirrorObserver.observe(target, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        }
    }
}

// ============================================================
// Preview rendering
// ============================================================

/**
 * Which IDs use formatCreatorNotes (runs substituteParams) vs raw Markdown.
 * Tags get chip rendering; mes_example gets <START> escaping first.
 */
const PREVIEW_KIND = /** @type {const} */ ({
    creator_notes_textarea: 'creator-notes',
    tags_textarea: 'tags',
    mes_example_textarea: 'mes-example',
});

/**
 * Render preview HTML for a textarea into its pane.
 * @param {HTMLTextAreaElement} textarea
 * @param {HTMLElement} pane
 */
function _renderPreview(textarea, pane) {
    const id = textarea.id;
    const text = textarea.value || '';
    const kind = PREVIEW_KIND[id] ?? 'markdown';

    if (!text.trim()) {
        pane.innerHTML = `<em class="sb-preview-empty">${t`(empty)`}</em>`;
        return;
    }

    if (kind === 'creator-notes') {
        const avatarId = getCurrentEntityId() || '';
        pane.innerHTML = formatCreatorNotes(text, avatarId);
        return;
    }

    if (kind === 'tags') {
        pane.innerHTML = '';
        text.split(',').map(tag => tag.trim()).filter(Boolean).forEach(tag => {
            const chip = document.createElement('span');
            chip.className = 'sb-preview-tag-chip';
            chip.textContent = tag;
            pane.append(chip);
        });
        return;
    }

    // For mes_example, escape <START> markers so they don't become stray HTML
    const safeText = kind === 'mes-example'
        ? text.replace(/<START>/gi, '&lt;START&gt;')
        : text;

    const raw = converter.makeHtml(safeText);
    pane.innerHTML = DOMPurify.sanitize(raw, { RETURN_TRUSTED_TYPE: false });
}

// ============================================================
// Depth-prompt role segmented control
// ============================================================

/** Mounted role segment, kept for sync. @type {HTMLElement|null} */
let _roleSegment = null;

function _mountRoleSegment() {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('depth_prompt_role'));
    if (!select) return;

    const choices = /** @type {Array<[string, string]>} */ (
        Array.from(select.options).map(opt => [opt.value, opt.text])
    );
    const initialValue = select.value || 'system';

    _roleSegment = createSegmentedControl(
        t`Role`,
        choices,
        initialValue,
        (value) => {
            select.value = value;
            // Notify script.js input handlers that listen on the select
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
        },
        { compact: true, detachFromForm: true },
    );

    // Insert the segment immediately before the hidden select
    select.before(_roleSegment);
}

/**
 * Sync the role segmented control to the current select value.
 * Called on session open and snapshot restore.
 */
function _syncRoleSegment() {
    if (!_roleSegment) return;
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('depth_prompt_role'));
    if (!select) return;
    setSegmentedControlValue(_roleSegment, select.value || 'system');
}

// ============================================================
// Greeting add buttons
// ============================================================

function _bindGreetingAddButtons() {
    // Upstream delegates .open_alternate_greetings on document (script.js:18654)
    // and registers first, so a second delegated handler could never stop it:
    // one click added two greetings, one written straight into the entity. A
    // listener on the button itself runs before anything delegated on document.
    document.querySelectorAll('#form_create .open_alternate_greetings').forEach(button => {
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            addAlternateGreeting();
        });
    });

    document.getElementById('sb_character_add_group_greeting')
        ?.addEventListener('click', (event) => {
            event.stopImmediatePropagation();
            addGroupGreeting();
        });
}

// ============================================================
// Field dirty listeners
// ============================================================

function _bindFieldDirtyListeners() {
    // One delegated handler covers every field in #form_create. Bound through
    // jQuery so programmatic .trigger('input') writes (maximize editor, upstream
    // field setters) are counted as well as native typing.
    $('#form_create').on('input', () => {
        session.changed();
    });

    // Favorite button toggle
    document.getElementById('favorite_button')?.addEventListener('click', () => {
        // State update happens inside the upstream handler; we re-check after it runs
        requestAnimationFrame(() => session.changed());
    });
}

// ============================================================
// External save handler
// ============================================================

function _handleExternalSave(event, receipt) {
    // Form saves already acknowledge their receipt, including avatar/world/export saves.
    // Only legacy external notifications need to adopt the current form here.
    if (receipt) return;
    const context = session.context;
    if (!context || context.mode !== 'edit') return;
    if (event?.detail?.character?.avatar !== context.entityId) return;
    session.rebase();
}

// ============================================================
// Snapshot: capture / restore
// ============================================================

const SNAPSHOT_FIELDS = [
    'character_name_pole',
    'character_nickname_pole',
    'description_textarea',
    'personality_textarea',
    'scenario_pole',
    'firstmessage_textarea',
    'system_prompt_textarea',
    'post_history_instructions_textarea',
    'depth_prompt_prompt',
    'depth_prompt_depth',
    'depth_prompt_role',
    'talkativeness_slider',
    'mes_example_textarea',
    'creator_textarea',
    'character_version_textarea',
    'creator_notes_textarea',
    'tags_textarea',
];

function _captureSnapshot() {
    const snap = {};
    for (const id of SNAPSHOT_FIELDS) {
        const el = /** @type {HTMLInputElement|HTMLTextAreaElement|null} */ (document.getElementById(id));
        if (el) snap[id] = el.value;
    }
    // Read favorite state from DOM class since fav_ch_checked is not exported
    snap._fav = document.getElementById('favorite_button')?.classList.contains('fav_on') ?? false;
    snap._folder = _folderDraft();
    snap._alt = [...draftAlt];
    snap._grp = [...draftGrp];
    return snap;
}

function _restoreSnapshot(snap) {
    if (!snap) return;

    for (const id of SNAPSHOT_FIELDS) {
        if (!(id in snap)) continue;
        const el = document.getElementById(id);
        if (el) {
            /** @type {HTMLInputElement|HTMLTextAreaElement} */ (el).value = snap[id];
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    // Restore favorite state via DOM (avoids needing the unexported fav_ch_checked)
    if ('_fav' in snap) {
        const btn = document.getElementById('favorite_button');
        const currentFav = btn?.classList.contains('fav_on') ?? false;
        if (btn && currentFav !== snap._fav) {
            $(btn).trigger('click');
        }
    }

    if ('_folder' in snap) _setFolderDraft(snap._folder);

    if ('_alt' in snap) {
        draftAlt.splice(0, draftAlt.length, ...(snap._alt || []));
        _renderAlternateGreetings();
    }

    if ('_grp' in snap) {
        draftGrp.splice(0, draftGrp.length, ...(snap._grp || []));
        _renderGroupGreetings();
    }

    _commitCreateDrafts();
    _syncRoleSegment();
}

// ============================================================
// Greeting renderers
// ============================================================

function _renderAlternateGreetings({ animate = false } = {}) {
    const list = document.querySelector('.alternate_greetings_list');
    if (!list) return;
    const render = () => _renderGreetingList(list, draftAlt, 'alternate');
    if (!animate) return render();
    return animateListChange(list, render, { key: element => element.dataset.greetingId });
}

function _renderGroupGreetings({ animate = false } = {}) {
    const list = document.querySelector('.group_only_greetings_list');
    if (!list) return;
    const render = () => _renderGreetingList(list, draftGrp, 'group');
    if (animate) {
        animateListChange(list, render, { key: element => element.dataset.greetingId });
    } else {
        render();
    }

    const badge = document.getElementById('sb_character_group_greetings_count');
    if (badge) badge.textContent = draftGrp.length > 0 ? String(draftGrp.length) : '';
}

function _renderGreetingList(list, greetings, kind) {
    const keys = _ensureGreetingKeys(kind);
    list.innerHTML = '';
    greetings.forEach((greeting, index) => {
        list.appendChild(_createGreetingRow(greeting, index, kind, keys[index]));
    });
}

const GREETING_SNIPPET_LENGTH = 80;

function _greetingSnippet(text) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!flat) return t`(empty)`;
    return flat.length > GREETING_SNIPPET_LENGTH ? `${flat.slice(0, GREETING_SNIPPET_LENGTH)}…` : flat;
}

/**
 * One greeting as an AdwExpanderRow: the summary carries the label and a
 * one-line snippet, the body carries the editor and the row's actions. Actions
 * live in the body, not the summary, because <summary> is itself the toggle
 * button and must not contain other interactive content.
 * @param {string} greeting
 * @param {number} index
 * @param {'alternate'|'group'} kind
 * @param {string} greetingId
 */
function _createGreetingRow(greeting, index, kind, greetingId) {
    const greetingsRef = kind === 'alternate' ? draftAlt : draftGrp;
    // Upstream's maximize editor and extensions address greetings by these ids.
    const textareaId = kind === 'alternate' ? `alternate_greeting_inline_${index}` : `group_greeting_inline_${index}`;

    const row = document.createElement('details');
    row.className = 'ds-row-expander sb-greeting-row alternate_greeting';
    row.dataset.index = String(index);
    row.dataset.greetingId = greetingId;
    row.setAttribute('role', 'listitem');

    const summary = document.createElement('summary');
    summary.className = 'ds-row';

    const text = document.createElement('span');
    text.className = 'ds-row-text';
    const title = document.createElement('span');
    title.className = 'ds-row-label';
    title.textContent = kind === 'alternate'
        ? t`Alternate greeting #${index + 1}`
        : t`Group greeting #${index + 1}`;
    const subtitle = document.createElement('span');
    subtitle.className = 'ds-row-subtitle sb-greeting-row__snippet';
    subtitle.textContent = _greetingSnippet(greeting);
    text.append(title, subtitle);
    summary.append(text);

    const body = document.createElement('div');
    body.className = 'ds-row-expander-content sb-greeting-row__body';

    const textarea = document.createElement('textarea');
    textarea.id = textareaId;
    textarea.className = 'text_pole alternate_greeting_text sb-greeting-row__textarea';
    textarea.rows = 6;
    textarea.dataset.macros = '';
    textarea.value = greeting;
    textarea.setAttribute('aria-label', title.textContent);
    // jQuery binding: the maximize editor writes back with jQuery .trigger('input'),
    // which does not reach addEventListener listeners.
    $(textarea).on('input', () => {
        greetingsRef[index] = textarea.value;
        subtitle.textContent = _greetingSnippet(textarea.value);
        _commitCreateDrafts();
        session.changed();
    });

    const actions = document.createElement('div');
    actions.className = 'sb-greeting-row__actions';
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', title.textContent);

    const upButton = _createGreetingButton('fa-arrow-up', t`Move up`, () => _moveGreeting(kind, index, -1));
    upButton.disabled = index === 0;
    const downButton = _createGreetingButton('fa-arrow-down', t`Move down`, () => _moveGreeting(kind, index, 1));
    downButton.disabled = index >= greetingsRef.length - 1;
    const expandButton = _createGreetingButton('fa-maximize', t`Expand the editor`, null);
    // Delegated upstream handler (.editor_maximize[data-for]) opens the large editor
    // and writes back through an input event, which the listener above picks up.
    expandButton.classList.add('editor_maximize');
    expandButton.dataset.for = textareaId;

    const spacer = document.createElement('span');
    spacer.className = 'sb-greeting-row__spacer';

    const deleteButton = _createGreetingButton('fa-trash-can', t`Delete`, async () => {
        const popup = new Popup(t`Delete this greeting?`, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Delete`,
            defaultResult: POPUP_RESULT.NEGATIVE,
            onOpen: currentPopup => currentPopup.okButton.classList.add('is-destructive'),
        });
        if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return;
        greetingsRef.splice(index, 1);
        _greetingKeys(kind).splice(index, 1);
        _reRenderKind(kind, { animate: true });
        _commitCreateDrafts();
        session.changed({ immediate: true });
    });
    deleteButton.classList.add('sb-greeting-row__delete');

    actions.append(upButton, downButton, expandButton, spacer, deleteButton);
    body.append(textarea, actions);
    row.append(summary, body);

    // AdwExpanderRow lists keep one row open, so a long list stays scannable.
    row.addEventListener('toggle', () => {
        if (!row.open) return;
        row.parentElement?.querySelectorAll(':scope > details[open]').forEach(other => {
            if (other !== row) /** @type {HTMLDetailsElement} */ (other).open = false;
        });
        _animateExpanderContent(row);
    });

    return row;
}

/**
 * @param {string} icon
 * @param {string} label
 * @param {(() => void)|null} handler  null leaves the click to a delegated handler
 */
function _createGreetingButton(icon, label, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sb-greeting-row__btn';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    const glyph = document.createElement('i');
    glyph.className = `fa-solid ${icon}`;
    glyph.setAttribute('aria-hidden', 'true');
    btn.appendChild(glyph);
    if (handler) {
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            handler();
        });
    }
    return btn;
}

/**
 * @param {'alternate'|'group'} kind
 * @param {number} index
 * @param {-1|1} delta
 */
function _moveGreeting(kind, index, delta) {
    const list = kind === 'alternate' ? draftAlt : draftGrp;
    const keys = _greetingKeys(kind);
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    [keys[index], keys[target]] = [keys[target], keys[index]];
    _reRenderKind(kind, { animate: true });
    _commitCreateDrafts();
    session.changed({ immediate: true });

    // Keep the moved row open and its control focused so repeated moves work
    // from the keyboard without hunting for the row again.
    const selector = kind === 'alternate' ? '.alternate_greetings_list' : '.group_only_greetings_list';
    const row = document.querySelector(`${selector} > .sb-greeting-row[data-index="${target}"]`);
    if (row instanceof HTMLDetailsElement) {
        row.open = true;
        const button = row.querySelector(`.sb-greeting-row__btn[aria-label="${CSS.escape(delta < 0 ? t`Move up` : t`Move down`)}"]`);
        const fallback = row.querySelector('textarea');
        (button instanceof HTMLButtonElement && !button.disabled ? button : fallback)?.focus({ preventScroll: true });
    }
}

function _reRenderKind(kind, options = {}) {
    if (kind === 'alternate') _renderAlternateGreetings(options);
    else _renderGroupGreetings(options);
}

function _focusGreetingRow(listSelector, index) {
    requestAnimationFrame(() => {
        const row = document.querySelector(`${listSelector} > .sb-greeting-row[data-index="${index}"]`);
        if (!(row instanceof HTMLDetailsElement)) return;
        row.open = true;
        row.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        row.querySelector('textarea')?.focus({ preventScroll: true });
    });
}

function _bindGreetingExpanders() {
    document.querySelectorAll('.sb-greetings-expander').forEach(expander => {
        if (!(expander instanceof HTMLDetailsElement) || expander.dataset.motionBound) return;
        expander.dataset.motionBound = 'true';
        expander.addEventListener('toggle', () => {
            if (expander.open) _animateExpanderContent(expander);
        });
    });
}

function _animateExpanderContent(expander) {
    if (!(expander instanceof HTMLDetailsElement) || !expander.open) return;
    const content = expander.querySelector(':scope > .ds-row-expander-content');
    if (!(content instanceof HTMLElement)) return;
    animateHeightFrom(content, 0, { duration: MOTION_SLOW });
}

// ============================================================
// Utilities
// ============================================================

/**
 * A.2.8: gate on the shell's authoritative state rather than a layout read,
 * which gave false negatives mid-animation. setMenuType() mirrors menu_type into
 * data-menu-type, and the drawer is open while it carries .openDrawer.
 */
function _isEditorVisible() {
    if (!session.isOpen()) return false;
    const panel = document.getElementById('right-nav-panel');
    if (!panel?.classList.contains('openDrawer')) return false;
    const menuType = panel.dataset.menuType;
    return menuType === 'character_edit' || menuType === 'create';
}
