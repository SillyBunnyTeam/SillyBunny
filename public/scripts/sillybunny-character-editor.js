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
//   markCharacterEditorSaved()          — recapture baseline after a successful save
//   getCharacterEditorAlternateGreetings(avatar) — alternate greetings to submit for a save
//   getCharacterEditorGroupGreetings(avatar)     — group-only greetings to submit for a save
//   addAlternateGreeting()              — add a new alternate greeting row
//   addGroupGreeting()                  — add a new group-only greeting row
//   initCharacterEditor()               — bind all DOM handlers (called once at startup)

import { formatCreatorNotes, getCurrentEntityId } from './chats.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from './popup.js';
import { openActionMenu } from './sillybunny-action-menu.js';
import { setCharacterEditorQuickEdit } from './power-user.js';
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
import { mountEditorPreviews } from './sillybunny-editor/preview.js';

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
    // script.js calls markCharacterEditorSaved() on success, which moves the
    // baseline; a failed or user-aborted save leaves the editor dirty.
    persist: () => createOrEditCharacter(),
    drafts,
    onStateChange: _renderChrome,
    offerDraft: showDraftRecoveryToast,
});

const navigation = {
    session,
    isActive: _isEditorVisible,
    close: _closeSafely,
};

/** @type {ReturnType<typeof mountEditorChrome>|null} */
let chrome = null;
/** @type {ReturnType<typeof mountEditorPreviews>|null} */
let previews = null;
/** Header title for the open session; follows inline renames. */
let editorTitle = '';

/** @type {MutationObserver|null} */
let tokenMirrorObserver = null;
let tokenMirrorScheduled = false;

// Session-local greeting drafts (A.2.3). Rows edit these, never the entity, so
// Cancel/Discard can revert and unrelated autosaves cannot persist half-edits.
// draftOwner is the avatar (or NEW_CHAR_DRAFT_KEY) the drafts were loaded for.
/** @type {string[]} */
let draftAlt = [];
/** @type {string[]} */
let draftGrp = [];
/** @type {string|null} */
let draftOwner = null;

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
    _bindFieldDirtyListeners();
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
    _openSession({ mode: 'edit', entityId: character.avatar, chid });
}

/**
 * Open a create-mode session.
 * Call after loadCharacterEditorGreetings and after all fields are written.
 */
export function openCharacterEditorCreateSession() {
    editorTitle = t`Create New Character`;
    _openSession({ mode: 'create', entityId: NEW_CHAR_DRAFT_KEY, chid: null });
}

/**
 * Recapture baseline after a successful createOrEditCharacter call.
 * Removes the stored draft for this session.
 */
export function markCharacterEditorSaved() {
    session.markSaved();
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
    _renderAlternateGreetings();
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
    _renderGroupGreetings();
    _commitCreateDrafts();
    session.changed({ immediate: true });
    _focusGreetingRow('.group_only_greetings_list', newIndex);
}

// ============================================================
// Internal: session and greeting-draft helpers
// ============================================================

/** @param {{ mode: 'edit'|'create', entityId: string, chid: number|null }} context */
function _openSession(context) {
    previews?.reset();
    _syncRoleSegment();
    session.open(context);
    _syncTokenReadout();
    _syncFavoritePressed();
    chrome?.scheduleOverflow();
    chrome?.reset();
}

/** @param {unknown} list */
function _copyGreetings(list) {
    return Array.isArray(list) ? list.map(value => String(value ?? '')) : [];
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
    _closeSafely();
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
        });

    // The favourite button is a div toggled by the fav_on/fav_off classes, which
    // the toolbar cannot use to express state. Mirror it into aria-pressed so the
    // button can render a selected fill the way DESIGN.md expects.
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

function _handleExternalSave() {
    // Avatar change, world link, export etc. all call saveCharacterDebounced which fires this event.
    // Recapture baseline so the dirty indicator reflects the new saved state.
    const context = session.context;
    if (!context || context.mode !== 'edit') return;
    if (context.chid !== this_chid) return;
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

function _renderAlternateGreetings() {
    const list = document.querySelector('.alternate_greetings_list');
    if (!list) return;
    list.innerHTML = '';
    draftAlt.forEach((g, i) => list.appendChild(_createGreetingRow(g, i, 'alternate')));
}

function _renderGroupGreetings() {
    const list = document.querySelector('.group_only_greetings_list');
    if (!list) return;
    list.innerHTML = '';
    draftGrp.forEach((g, i) => list.appendChild(_createGreetingRow(g, i, 'group')));

    const badge = document.getElementById('sb_character_group_greetings_count');
    if (badge) badge.textContent = draftGrp.length > 0 ? String(draftGrp.length) : '';
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
 */
function _createGreetingRow(greeting, index, kind) {
    const greetingsRef = kind === 'alternate' ? draftAlt : draftGrp;
    // Upstream's maximize editor and extensions address greetings by these ids.
    const textareaId = kind === 'alternate' ? `alternate_greeting_inline_${index}` : `group_greeting_inline_${index}`;

    const row = document.createElement('details');
    row.className = 'ds-row-expander sb-greeting-row alternate_greeting';
    row.dataset.index = String(index);
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
        const popup = new Popup(t`Delete this greeting?`, POPUP_TYPE.CONFIRM);
        if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) return;
        greetingsRef.splice(index, 1);
        _reRenderKind(kind);
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
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    _reRenderKind(kind);
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

function _reRenderKind(kind) {
    if (kind === 'alternate') _renderAlternateGreetings();
    else _renderGroupGreetings();
}

function _focusGreetingRow(listSelector, index) {
    requestAnimationFrame(() => {
        const row = document.querySelector(`${listSelector} > .sb-greeting-row[data-index="${index}"]`);
        if (!(row instanceof HTMLDetailsElement)) return;
        row.open = true;
        row.scrollIntoView({ block: 'nearest', behavior: _prefersReducedMotion() ? 'auto' : 'smooth' });
        row.querySelector('textarea')?.focus({ preventScroll: true });
    });
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

function _prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
