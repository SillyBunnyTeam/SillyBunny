// SillyBunny: character editor controller — explicit-save, draft backup, greeting renderer
// (Step 3b, feat/v1.9.0-ui-overhaul)
//
/* global moment */
// Public API consumed by script.js:
//   beginCharacterEditorLoad()          — flush draft before field writes
//   loadCharacterEditorGreetings(chid, mode) — render greeting lists after fields are loaded
//   openCharacterEditorSession(chid)    — open edit session (call after fields are written)
//   openCharacterEditorCreateSession()  — open create session
//   markCharacterEditorSaved()          — recapture baseline after a successful save
//   getCharacterEditorGroupGreetings()  — read current group-only draft for FormData
//   addAlternateGreeting()              — add a new alternate greeting row
//   addGroupGreeting()                  — add a new group-only greeting row
//   initCharacterEditor()               — bind all DOM handlers (called once at startup)

import { formatCreatorNotes, getCurrentEntityId } from './chats.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from './popup.js';
import { openActionMenu, closeActionMenu } from './sillybunny-action-menu.js';
import { setCharacterEditorQuickEdit } from './power-user.js';
import { eventSource, event_types } from './events.js';
import {
    characters,
    this_chid,
    create_save,
    createOrEditCharacter,
} from '../script.js';
import { t, translate } from './i18n.js';
import { getCurrentUserHandle } from './user.js';

const DRAFT_KEY_PREFIX = 'sb-editor-draft-';
const DRAFT_INTERVAL_MS = 5000;
const NEW_CHAR_DRAFT_KEY = 'new-character';

// --- Module state ---

/** @type {{ mode: 'edit'|'create', chid: number|null, avatar: string, baseline: object }|null} */
let currentSession = null;
let draftTimerId = null;
/** @type {MutationObserver|null} */
let tokenMirrorObserver = null;
let tokenMirrorScheduled = false;

// ============================================================
// Public API
// ============================================================

export function initCharacterEditor() {
    _bindHeaderButtons();
    _bindToolbarButtons();
    _bindActionMenu();
    _bindTokenMirror();
    _bindToolbarOverflowObserver();
    _bindPreviewToggles();
    _bindGreetingAddButtons();
    _bindFieldDirtyListeners();
    _bindKeyboardShortcuts();
    _bindNavigationGuards();
    _bindDraftPersistence();

    // Recapture baseline whenever the backend saves (avatar change, world link, export)
    eventSource.on(event_types.CHARACTER_EDITED, _handleExternalSave);
}

/**
 * Call immediately before script.js overwrites form fields with new character data.
 * Flushes any pending dirty draft so it isn't lost.
 */
export function beginCharacterEditorLoad() {
    if (currentSession && _isDirty()) {
        _saveDraftNow();
    }
    _closeDraftTimer();
}

/**
 * Render greeting lists after script.js has finished writing fields.
 * @param {number|null} chid  Character index (null in create mode)
 * @param {'edit'|'create'} mode
 */
export function loadCharacterEditorGreetings(chid, mode) {
    // Stash the chid/mode so the renderers know where to read from
    _sessionChid = chid;
    _sessionMode = mode;
    _renderAlternateGreetings();
    _renderGroupGreetings();
}

/**
 * Open an edit-mode session for the given character.
 * Call after loadCharacterEditorGreetings and after all fields are written.
 * @param {number} chid
 */
export function openCharacterEditorSession(chid) {
    _closeDraftTimer();

    const character = characters[chid];
    if (!character) {
        console.warn('[sb-editor] openCharacterEditorSession: character not found', chid);
        return;
    }

    currentSession = {
        mode: 'edit',
        chid,
        avatar: character.avatar,
        baseline: _captureSnapshot(),
    };

    _updateHeaderTitle(character.name);
    _updateHeaderButtons();
    _resetPreviewToggles();
    _checkDraftRestore();
    _startDraftTimer();
    _syncTokenReadout();
    _syncFavoritePressed();
    _scheduleToolbarOverflow();
}

/**
 * Open a create-mode session.
 * Call after loadCharacterEditorGreetings and after all fields are written.
 */
export function openCharacterEditorCreateSession() {
    _closeDraftTimer();

    currentSession = {
        mode: 'create',
        chid: null,
        avatar: NEW_CHAR_DRAFT_KEY,
        baseline: _captureSnapshot(),
    };

    _updateHeaderTitle(t`Create New Character`);
    _updateHeaderButtons();
    _resetPreviewToggles();
    _checkDraftRestore();
    _startDraftTimer();
    _syncTokenReadout();
    _syncFavoritePressed();
    _scheduleToolbarOverflow();
}

/**
 * Runs the toolbar overflow pass after the browser has laid the panel out, since
 * the pass measures real widths and so cannot run before the drawer is sized.
 */
function _scheduleToolbarOverflow() {
    requestAnimationFrame(() => {
        if (currentSession) _applyToolbarOverflow();
    });
}

/**
 * Recapture baseline after a successful createOrEditCharacter call.
 * Removes the stored draft for this session.
 */
export function markCharacterEditorSaved() {
    if (!currentSession) return;
    currentSession.baseline = _captureSnapshot();
    _updateDirtyIndicator();
    _updateHeaderButtons();
    _removeDraft(currentSession.avatar);
}

/**
 * Return the current group-only greeting array for use in FormData.
 * @returns {string[]}
 */
export function getCharacterEditorGroupGreetings() {
    return _getEditableGroupGreetings() ?? [];
}

/**
 * Add a new alternate greeting row and focus its textarea.
 */
export function addAlternateGreeting() {
    const greetings = _getEditableAlternateGreetings();
    if (!greetings) return;

    const newIndex = greetings.length;
    greetings.push('');
    _renderAlternateGreetings();
    _markDirty();
    if (currentSession?.mode === 'create') create_save.alternate_greetings = greetings;
    _focusGreetingRow('.alternate_greetings_list', newIndex);
}

/**
 * Add a new group-only greeting row and focus its textarea.
 */
export function addGroupGreeting() {
    const greetings = _getEditableGroupGreetings();
    if (!greetings) return;

    const newIndex = greetings.length;
    greetings.push('');
    _renderGroupGreetings();
    _markDirty();
    if (currentSession?.mode === 'create') create_save.group_only_greetings = greetings;
    _focusGreetingRow('.group_only_greetings_list', newIndex);
}

// ============================================================
// Internal: per-render session context (populated by loadCharacterEditorGreetings)
// ============================================================

let _sessionChid = null;
let _sessionMode = 'edit';

// ============================================================
// Header buttons
// ============================================================

function _bindHeaderButtons() {
    document.getElementById('sb_character_editor_back')
        ?.addEventListener('click', _handleBack);
    document.getElementById('sb_character_editor_cancel')
        ?.addEventListener('click', _handleCancel);
    document.getElementById('sb_character_editor_save')
        ?.addEventListener('click', _handleSave);
    document.getElementById('sb_character_editor_title_button')
        ?.addEventListener('click', _handleRenameTrigger);
}

/**
 * The sticky header's title is the rename affordance, replacing the legacy
 * #rm_button_selected_ch h2 click target that now sits inside the hidden
 * #rm_PinAndTabs.
 *
 * This focuses the Name field rather than calling renameCharacter(): the two are
 * not the same operation. Saving the Name field rewrites name/data.name while
 * preserving the character's avatar identity; renameCharacter() posts
 * /api/characters/rename, mints a NEW avatar identity and moves the chat
 * directory. Renaming by editing the field is the reversible, in-editor action,
 * so it is what the title offers. The destructive full rename stays reachable
 * from the action menu as its own entry.
 */
function _handleRenameTrigger(event) {
    event.preventDefault();
    if (!currentSession) return;

    const nameField = document.getElementById('character_name_pole');
    if (!(nameField instanceof HTMLInputElement)) return;

    nameField.focus({ preventScroll: false });
    nameField.select();
}

async function _handleBack(event) {
    if (!await _allowLeave()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }
    // Navigate to the characters tab — clicking the shell tab button
    // triggers the full navigation path including syncCharacterShellTabs.
    // The hidden #rm_button_back stub only fires the panel switch without
    // activating the correct tab, leaving the UI desynchronized. (Step 3b fix)
    document.getElementById('sb_character_tab_characters')?.click();
}

function _handleCancel() {
    if (!currentSession || !_isDirty()) return;
    // Direct revert — Cancel is disabled when clean, so a click is intentional
    _restoreSnapshot(currentSession.baseline);
    _removeDraft(currentSession.avatar);
}

async function _handleSave() {
    if (!currentSession) return;
    if (currentSession.mode === 'edit' && !_isDirty()) return;

    // createOrEditCharacter is called here; script.js calls markCharacterEditorSaved() on success
    await createOrEditCharacter();
}

// ============================================================
// Toolbar buttons
// ============================================================

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
    const enabled = sheet?.classList.contains('sb-character-sheet--quick-edit') ?? false;
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
 * panel is too narrow for the full row, lowest priority first. Each entry is the
 * live button; clicking the menu item forwards a click to it, so no handler
 * moves and no ID changes.
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
 * Toolbar buttons that had to collapse into the overflow menu. Recomputed on
 * every layout pass so the menu reflects the current panel width.
 * @type {Array<{id: string, label: string, icon: string, selector: string}>}
 */
let collapsedToolbarActions = [];

/**
 * Collapses toolbar buttons into the overflow menu until the row fits the panel.
 *
 * The toolbar is `flex-wrap: nowrap` with `overflow: hidden`, so without this the
 * trailing buttons — including the ⋯ trigger itself — are simply clipped off the
 * panel edge at narrow widths and become unreachable. Buttons that collapse are
 * forwarded to from the menu via a synthetic click, so their handlers and IDs are
 * untouched.
 */
function _applyToolbarOverflow() {
    const toolbar = document.getElementById('sb_character_editor_toolbar');
    const more = document.getElementById('sb_character_editor_more');
    if (!(toolbar instanceof HTMLElement) || !(more instanceof HTMLElement)) return;

    const candidates = OVERFLOW_CANDIDATES.map(selector => ({
        selector,
        element: /** @type {HTMLElement|null} */ (document.querySelector(selector)),
    }));

    const restore = () => {
        for (const { element } of candidates) {
            // Class only: create mode's own inline display:none for edit-only
            // actions must survive the restore.
            if (element instanceof HTMLElement) {
                element.classList.remove('sb-editor-toolbar-collapsed');
            }
        }
    };

    restore();
    collapsedToolbarActions = [];

    // Everything already fits; nothing to move into the menu.
    if (toolbar.scrollWidth <= toolbar.clientWidth + 1) return;

    for (const { selector, element } of candidates) {
        if (!(element instanceof HTMLElement)) continue;
        // Only collapse what is actually showing; create mode hides several of
        // these already, and a hidden button occupies no width.
        if (element.getBoundingClientRect().width === 0) continue;

        // Tooltips can carry a second line of usage hints (e.g. the world
        // button's "Shift/Alt-click ..." line); the menu label takes the first.
        const tooltip = element.getAttribute('title') ?? element.getAttribute('data-sttt--title');
        const label = tooltip?.split('\n')[0]?.trim()
            || element.getAttribute('aria-label')
            || selector;
        const icon = Array.from(element.classList).find(cls => cls.startsWith('fa-')) ?? 'fa-circle-dot';

        element.classList.add('sb-editor-toolbar-collapsed');
        collapsedToolbarActions.push({ id: element.id || selector, label, icon: `fa-solid ${icon}`, selector });

        if (toolbar.scrollWidth <= toolbar.clientWidth + 1) break;
    }
}

/**
 * Re-runs the overflow pass when the panel changes width. Debounced to the next
 * frame so a resize drag does not thrash layout.
 */
function _bindToolbarOverflowObserver() {
    const panel = document.getElementById('right-nav-panel');
    if (!(panel instanceof HTMLElement) || panel.dataset.sbToolbarOverflowBound === 'true') return;
    panel.dataset.sbToolbarOverflowBound = 'true';

    let scheduled = false;
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            if (currentSession) _applyToolbarOverflow();
        });
    };

    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(schedule).observe(panel);
    } else {
        window.addEventListener('resize', schedule);
    }
}

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

function _bindActionMenu() {
    const trigger = document.getElementById('sb_character_editor_more');
    if (!trigger) return;

    trigger.addEventListener('click', () => {
        if (trigger.getAttribute('aria-expanded') === 'true') {
            closeActionMenu({ restoreFocus: true });
            return;
        }
        _openEditorActionMenu(trigger);
    });
}

/**
 * Builds the character action menu from the live transport select, so entries
 * that extensions append at runtime stay reachable.
 */
function _openEditorActionMenu(trigger) {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('char-management-dropdown'));
    if (!select) return;

    const primary = [];
    for (const option of Array.from(select.options)) {
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

    // Toolbar buttons that did not fit the panel width, so every action stays
    // reachable instead of being clipped off the narrow panel edge.
    const overflow = collapsedToolbarActions.map(action => ({
        label: action.label,
        icon: action.icon,
        onSelect: () => _dispatchTransportClick(action.selector),
    }));

    const recovered = RECOVERED_ACTIONS
        .filter(action => document.querySelector(action.transport))
        .map(action => ({
            label: translate(action.label),
            icon: `fa-solid fa-${action.glyph}`,
            onSelect: () => _dispatchTransportClick(action.transport),
        }));

    const danger = [];
    // Delete is only meaningful for an existing character, never a draft.
    if (currentSession?.mode === 'edit') {
        danger.push({
            label: t`Delete Character`,
            icon: 'fa-solid fa-skull',
            danger: true,
            onSelect: () => _dispatchTransportClick('#delete_button'),
        });
    }

    openActionMenu({
        trigger,
        title: t`Character Actions`,
        sections: [
            { items: overflow },
            { items: primary },
            { items: recovered },
            { items: danger },
        ].filter(section => section.items.length > 0),
        onClose: () => trigger.setAttribute('aria-expanded', 'false'),
    });
    trigger.setAttribute('aria-expanded', 'true');
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
 * click. Used for the recovered titlebar controls and for toolbar buttons that
 * collapsed into the overflow menu.
 * @param {string} selector
 */
function _dispatchTransportClick(selector) {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) return;
    element.click();
}

// ============================================================
// Token readout
// ============================================================

/**
 * Mirrors the legacy #result_info counters into the editor header. Those nodes
 * live inside the hidden #rm_PinAndTabs, but RA_CountCharTokens() still updates
 * them, so reading them keeps one implementation of the counting and keeps
 * extensions that read #result_info working.
 *
 * Read rather than observed: counting is triggered by editor load and by form
 * input, both of which are moments the controller already knows about, so a
 * MutationObserver would cost more than it earns.
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
        if (currentSession) _syncTokenReadout();
    }, delay));

    _stopTokenMirror();
    tokenMirrorObserver = new MutationObserver(() => {
        if (tokenMirrorScheduled) return;
        tokenMirrorScheduled = true;
        requestAnimationFrame(() => {
            tokenMirrorScheduled = false;
            if (currentSession) _syncTokenReadout();
        });
    });

    for (const id of ['result_info_total_tokens', 'result_info_permanent_tokens', 'result_info_text']) {
        const target = document.getElementById(id);
        if (target) {
            tokenMirrorObserver.observe(target, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        }
    }
}

function _stopTokenMirror() {
    tokenMirrorObserver?.disconnect();
    tokenMirrorObserver = null;
}

// ============================================================
// Preview toggles
// ============================================================

function _bindPreviewToggles() {
    document.querySelectorAll('.sb-preview-toggle[data-sb-preview-for]').forEach(toggle => {
        const textareaId = /** @type {HTMLElement} */ (toggle).dataset.sbPreviewFor;
        const textarea = /** @type {HTMLTextAreaElement|null} */ (document.getElementById(textareaId));
        const pane = document.querySelector(`.sb-preview-pane[data-sb-preview-pane="${textareaId}"]`);
        if (!textarea || !pane) return;

        toggle.addEventListener('click', () => {
            const expanded = toggle.getAttribute('aria-expanded') === 'true';
            const next = !expanded;
            toggle.setAttribute('aria-expanded', String(next));
            /** @type {HTMLElement} */ (pane).hidden = !next;
            textarea.hidden = next;
            if (next) _renderPreview(textarea, /** @type {HTMLElement} */ (pane));
        });

        textarea.addEventListener('input', () => {
            if (toggle.getAttribute('aria-expanded') === 'true') {
                _renderPreview(textarea, /** @type {HTMLElement} */ (pane));
            }
        });
    });
}

function _renderPreview(textarea, pane) {
    const text = textarea.value || '';
    const avatarId = getCurrentEntityId() || '';
    const html = formatCreatorNotes(text, avatarId);
    pane.innerHTML = html || `<em style="color:var(--sb-muted-fg);">${t`(empty)`}</em>`;
}

/** Reset all preview toggles to Edit mode. Called on session open. */
function _resetPreviewToggles() {
    document.querySelectorAll('.sb-preview-toggle[data-sb-preview-for]').forEach(toggle => {
        const textareaId = /** @type {HTMLElement} */ (toggle).dataset.sbPreviewFor;
        const textarea = document.getElementById(textareaId);
        const pane = document.querySelector(`.sb-preview-pane[data-sb-preview-pane="${textareaId}"]`);
        toggle.setAttribute('aria-expanded', 'false');
        if (pane) /** @type {HTMLElement} */ (pane).hidden = true;
        if (textarea) /** @type {HTMLElement} */ (textarea).hidden = false;
    });
}

// ============================================================
// Greeting add buttons
// ============================================================

function _bindGreetingAddButtons() {
    // Intercept the upstream delegated handler for .open_alternate_greetings
    $(document).on('click', '.open_alternate_greetings', (event) => {
        event.stopImmediatePropagation();
        addAlternateGreeting();
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
    // All text fields inside #form_create dispatch 'input' — one delegated handler covers them all
    document.getElementById('form_create')?.addEventListener('input', () => {
        _markDirty();
    });

    // Favorite button toggle
    document.getElementById('favorite_button')?.addEventListener('click', () => {
        // State update happens inside the upstream handler; we re-check after it runs
        requestAnimationFrame(() => _markDirty());
    });
}

// ============================================================
// Keyboard shortcuts
// ============================================================

function _bindKeyboardShortcuts() {
    // Cmd/Ctrl+S — save
    document.addEventListener('keydown', (event) => {
        if (!(event.metaKey || event.ctrlKey) || event.key !== 's') return;
        if (!_isEditorVisible()) return;
        event.preventDefault();
        _handleSave();
    }, { capture: true });

    // Escape — dirty guard (skip when a popup is open or focus is in a text input)
    document.addEventListener('keydown', async (event) => {
        if (event.key !== 'Escape') return;
        if (!_isEditorVisible()) return;
        if (_isPopupOpen()) return;

        const active = document.activeElement;
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return;

        if (!_isDirty()) return;

        event.preventDefault();
        event.stopImmediatePropagation();

        if (await _allowLeave()) {
            // Navigate to the characters list
            document.querySelector('[data-sb-character-tab="characters"]')?.click();
        }
    }, { capture: true });
}

// ============================================================
// Navigation guards
// ============================================================

function _bindNavigationGuards() {
    document.addEventListener('click', async (event) => {
        if (!event.isTrusted) return;
        if (!_isDirty()) return;

        const target = /** @type {HTMLElement} */ (event.target);
        const tab = target.closest('[data-sb-character-tab]:not([data-sb-character-tab="editor"])');
        if (!tab) return;

        event.preventDefault();
        event.stopImmediatePropagation();

        if (await _allowLeave()) {
            // Re-dispatch as synthetic (isTrusted=false bypasses this guard)
            tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
    }, { capture: true });
}

// ============================================================
// Unsaved changes popup
// ============================================================

async function _allowLeave() {
    if (!currentSession || !_isDirty()) return true;

    const popup = new Popup(
        t`Unsaved changes`,
        POPUP_TYPE.CONFIRM,
        '',
        {
            okButton: t`Save`,
            cancelButton: t`Cancel`,
            customButtons: [{ text: t`Discard`, result: 2 }],
            defaultResult: POPUP_RESULT.NEGATIVE,
        },
    );

    const result = await popup.show();

    if (result === POPUP_RESULT.AFFIRMATIVE) {
        await _handleSave();
        return true;
    }

    if (result === 2) {
        _restoreSnapshot(currentSession.baseline);
        _removeDraft(currentSession.avatar);
        return true;
    }

    return false;
}

// ============================================================
// External save handler
// ============================================================

function _handleExternalSave() {
    // Avatar change, world link, export etc. all call saveCharacterDebounced which fires this event.
    // Recapture baseline so the dirty indicator reflects the new saved state.
    if (!currentSession || currentSession.mode !== 'edit') return;
    if (currentSession.chid !== this_chid) return;
    currentSession.baseline = _captureSnapshot();
    _updateDirtyIndicator();
    _updateHeaderButtons();
}

// ============================================================
// Draft persistence
// ============================================================

function _bindDraftPersistence() {
    window.addEventListener('pagehide', () => {
        if (currentSession && _isDirty()) _saveDraftNow();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden && currentSession && _isDirty()) _saveDraftNow();
    });

    window.addEventListener('beforeunload', (event) => {
        if (currentSession && _isDirty()) {
            _saveDraftNow();
            event.preventDefault();
            // SillyBunny: preventDefault() alone does not arm the browser's
            // "leave site?" prompt — the spec requires a truthy returnValue.
            // Without this the dirty guard silently did nothing on reload/close.
            event.returnValue = '';
        }
    });
}

function _startDraftTimer() {
    _closeDraftTimer();
    draftTimerId = setInterval(() => {
        if (_isDirty()) _saveDraftNow();
    }, DRAFT_INTERVAL_MS);
}

function _closeDraftTimer() {
    if (draftTimerId !== null) {
        clearInterval(draftTimerId);
        draftTimerId = null;
    }
}

function _saveDraftNow() {
    if (!currentSession) return;
    const draft = { v: 1, ts: Date.now(), snapshot: _captureSnapshot() };
    try {
        localStorage.setItem(_draftKey(currentSession.avatar), JSON.stringify(draft));
    } catch (err) {
        console.warn('[sb-editor] Failed to write draft', err);
    }
}

function _removeDraft(avatar) {
    try {
        localStorage.removeItem(_draftKey(avatar));
    } catch (err) {
        console.warn('[sb-editor] Failed to remove draft', err);
    }
}

function _draftKey(avatar) {
    const user = getCurrentUserHandle() || 'default';
    return `${DRAFT_KEY_PREFIX}${user}-${avatar}`;
}

function _checkDraftRestore() {
    if (!currentSession) return;

    let draft;
    try {
        const raw = localStorage.getItem(_draftKey(currentSession.avatar));
        if (!raw) return;
        draft = JSON.parse(raw);
    } catch {
        return;
    }

    if (!draft?.v || !draft.snapshot) return;

    const currentSnap = _captureSnapshot();
    if (JSON.stringify(draft.snapshot) === JSON.stringify(currentSnap)) {
        _removeDraft(currentSession.avatar);
        return;
    }

    _showDraftRestoreToast(draft);
}

function _showDraftRestoreToast(draft) {
    const sessionAvatar = currentSession?.avatar;
    const relTime = typeof moment !== 'undefined' ? moment(draft.ts).fromNow() : new Date(draft.ts).toLocaleTimeString();

    // <!-- HUMAN: replace toast body text -->
    const body = `<div>lorum ipsum ${relTime}</div>
        <div style="margin-top:0.5rem;display:flex;gap:0.5rem;">
            <button type="button" id="sb_draft_restore_btn" class="menu_button">${t`Restore`}</button>
            <button type="button" id="sb_draft_discard_btn" class="menu_button">${t`Discard`}</button>
        </div>`;

    toastr.info(body, '', {
        timeOut: 0,
        extendedTimeOut: 0,
        closeButton: true,
        escapeHtml: false,
        onShown() {
            document.getElementById('sb_draft_restore_btn')?.addEventListener('click', () => {
                if (currentSession?.avatar !== sessionAvatar) return;
                _restoreSnapshot(draft.snapshot);
                toastr.clear();
            });
            document.getElementById('sb_draft_discard_btn')?.addEventListener('click', () => {
                _removeDraft(sessionAvatar);
                toastr.clear();
            });
        },
    });
}

// ============================================================
// Dirty tracking
// ============================================================

function _isDirty() {
    if (!currentSession) return false;
    return JSON.stringify(_captureSnapshot()) !== JSON.stringify(currentSession.baseline);
}

function _markDirty() {
    _updateDirtyIndicator();
    _updateHeaderButtons();
}

function _updateDirtyIndicator() {
    const el = document.getElementById('sb_character_editor_dirty');
    if (!el) return;

    const dirty = _isDirty();
    const wasHidden = el.hidden;
    el.hidden = !dirty;
    if (dirty === !wasHidden) return;

    if (dirty) {
        // DESIGN.md: state reveals are a fade with a small scale, no movement.
        el.animate(
            [{ opacity: 0, transform: 'scale(0.7)' }, { opacity: 1, transform: 'none' }],
            { duration: 200, easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)' },
        );
    }
}

function _updateHeaderButtons() {
    const save = document.getElementById('sb_character_editor_save');
    const cancel = document.getElementById('sb_character_editor_cancel');
    const dirty = _isDirty();
    const isCreate = currentSession?.mode === 'create';

    if (save instanceof HTMLButtonElement) {
        save.textContent = isCreate ? t`Create` : t`Save`;
        save.disabled = !isCreate && !dirty;
    }
    if (cancel instanceof HTMLButtonElement) {
        cancel.disabled = !dirty;
    }

    // The quick-edit toggle persists in power_user, so its pressed state must
    // follow the setting rather than only the last click.
    _syncQuickEditPressed();
}

function _updateHeaderTitle(title) {
    const el = document.getElementById('sb_character_editor_title');
    if (el) el.textContent = title;

    // Renaming a draft is meaningless until it exists, so the title only offers
    // the affordance for a saved character.
    const button = document.getElementById('sb_character_editor_title_button');
    const canRename = currentSession?.mode === 'edit';
    if (button instanceof HTMLButtonElement) {
        button.disabled = !canRename;
        button.classList.toggle('is-static', !canRename);
    }
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
    snap._alt = [...(_getEditableAlternateGreetings() ?? [])];
    snap._grp = [...(_getEditableGroupGreetings() ?? [])];
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
        const arr = _getEditableAlternateGreetings();
        if (arr) {
            arr.splice(0, arr.length, ...(snap._alt || []));
            _renderAlternateGreetings();
        }
    }

    if ('_grp' in snap) {
        const arr = _getEditableGroupGreetings();
        if (arr) {
            arr.splice(0, arr.length, ...(snap._grp || []));
            _renderGroupGreetings();
        }
    }

    _markDirty();
}

// ============================================================
// Greeting data access
// ============================================================

function _getEditableAlternateGreetings() {
    const mode = currentSession?.mode ?? _sessionMode;
    if (mode === 'create') {
        if (!Array.isArray(create_save.alternate_greetings)) create_save.alternate_greetings = [];
        return create_save.alternate_greetings;
    }
    const chid = currentSession?.chid ?? _sessionChid;
    if (chid == null || !characters[chid]) return null;
    characters[chid].data ??= {};
    if (!Array.isArray(characters[chid].data.alternate_greetings)) {
        characters[chid].data.alternate_greetings = [];
    }
    return characters[chid].data.alternate_greetings;
}

function _getEditableGroupGreetings() {
    const mode = currentSession?.mode ?? _sessionMode;
    if (mode === 'create') {
        if (!Array.isArray(create_save.group_only_greetings)) create_save.group_only_greetings = [];
        return create_save.group_only_greetings;
    }
    const chid = currentSession?.chid ?? _sessionChid;
    if (chid == null || !characters[chid]) return null;
    characters[chid].data ??= {};
    if (!Array.isArray(characters[chid].data.group_only_greetings)) {
        characters[chid].data.group_only_greetings = [];
    }
    return characters[chid].data.group_only_greetings;
}

// ============================================================
// Greeting renderers
// ============================================================

function _renderAlternateGreetings() {
    const list = document.querySelector('.alternate_greetings_list');
    if (!list) return;

    const greetings = _getEditableAlternateGreetings() ?? [];
    list.innerHTML = '';
    greetings.forEach((g, i) => list.appendChild(_createGreetingRow(g, i, 'alternate', greetings)));

    const hint = list.closest('.sb-greetings-editor')?.querySelector('.alternate_grettings_hint');
    if (hint) hint.style.display = greetings.length === 0 ? '' : 'none';
}

function _renderGroupGreetings() {
    const list = document.querySelector('.group_only_greetings_list');
    if (!list) return;

    const greetings = _getEditableGroupGreetings() ?? [];
    list.innerHTML = '';
    greetings.forEach((g, i) => list.appendChild(_createGreetingRow(g, i, 'group', greetings)));

    const badge = document.getElementById('sb_character_group_greetings_count');
    if (badge) badge.textContent = greetings.length > 0 ? String(greetings.length) : '';
}

/**
 * @param {string} greeting
 * @param {number} index
 * @param {'alternate'|'group'} kind
 * @param {string[]} greetingsRef  live array reference for mutations
 */
function _createGreetingRow(greeting, index, kind, greetingsRef) {
    const row = document.createElement('div');
    row.className = 'sb-greeting-row alternate_greeting';
    row.dataset.index = String(index);

    const snippet = greeting.length > 70 ? greeting.slice(0, 70) + '…' : greeting || t`(empty)`;

    row.innerHTML = `
        <details class="sb-greeting-row__details">
            <summary class="sb-greeting-row__summary">
                <span class="sb-greeting-row__index">${index + 1}</span>
                <span class="sb-greeting-row__snippet">${_esc(snippet)}</span>
                <span class="sb-greeting-row__actions" role="group">
                    <button type="button" class="menu_button menu_button_icon sb-greeting-row__btn"
                        data-action="up" aria-label="${t`Move up`}" title="${t`Move up`}">
                        <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="menu_button menu_button_icon sb-greeting-row__btn"
                        data-action="down" aria-label="${t`Move down`}" title="${t`Move down`}">
                        <i class="fa-solid fa-arrow-down" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="menu_button menu_button_icon sb-greeting-row__btn"
                        data-action="delete" aria-label="${t`Delete`}" title="${t`Delete`}">
                        <i class="fa-solid fa-trash" aria-hidden="true"></i>
                    </button>
                </span>
            </summary>
            <div class="sb-greeting-row__body">
                <textarea class="text_pole alternate_greeting_text sb-greeting-row__textarea"
                    data-macros rows="6">${_esc(greeting)}</textarea>
            </div>
        </details>
    `;

    const textarea = /** @type {HTMLTextAreaElement} */ (row.querySelector('textarea'));

    textarea.addEventListener('input', () => {
        greetingsRef[index] = textarea.value;
        const snippet_el = row.querySelector('.sb-greeting-row__snippet');
        if (snippet_el) {
            const t2 = textarea.value;
            snippet_el.textContent = t2.length > 70 ? t2.slice(0, 70) + '…' : t2 || t`(empty)`;
        }
        _markDirty();
        if (currentSession?.mode === 'create') {
            if (kind === 'alternate') create_save.alternate_greetings = greetingsRef;
            else create_save.group_only_greetings = greetingsRef;
        }
    });

    row.querySelectorAll('.sb-greeting-row__btn').forEach(btn => {
        btn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const action = /** @type {HTMLElement} */ (btn).dataset.action;

            if (action === 'up') {
                if (index === 0) return;
                [greetingsRef[index - 1], greetingsRef[index]] = [greetingsRef[index], greetingsRef[index - 1]];
                _reRenderKind(kind);
                _markDirty();
            } else if (action === 'down') {
                if (index >= greetingsRef.length - 1) return;
                [greetingsRef[index], greetingsRef[index + 1]] = [greetingsRef[index + 1], greetingsRef[index]];
                _reRenderKind(kind);
                _markDirty();
            } else if (action === 'delete') {
                const pop = new Popup(t`Delete this greeting?`, POPUP_TYPE.CONFIRM);
                if (await pop.show() !== POPUP_RESULT.AFFIRMATIVE) return;
                greetingsRef.splice(index, 1);
                _reRenderKind(kind);
                _markDirty();
                if (currentSession?.mode === 'create') {
                    if (kind === 'alternate') create_save.alternate_greetings = greetingsRef;
                    else create_save.group_only_greetings = greetingsRef;
                }
            }
        });
    });

    return row;
}

function _reRenderKind(kind) {
    if (kind === 'alternate') _renderAlternateGreetings();
    else _renderGroupGreetings();
}

function _focusGreetingRow(listSelector, index) {
    requestAnimationFrame(() => {
        const row = document.querySelector(`${listSelector} .sb-greeting-row[data-index="${index}"]`);
        if (!(row instanceof HTMLElement)) return;
        row.scrollIntoView({ block: 'nearest', behavior: _prefersReducedMotion() ? 'auto' : 'smooth' });
        const details = row.querySelector('details');
        if (details) details.open = true;
        row.querySelector('textarea')?.focus({ preventScroll: true });
    });
}

// ============================================================
// Utilities
// ============================================================

function _isEditorVisible() {
    const panel = document.getElementById('rm_ch_create_block');
    return !!panel && panel.style.display !== 'none' && panel.getBoundingClientRect().width > 0;
}

function _isPopupOpen() {
    return !!document.querySelector('dialog.popup[open]');
}

function _prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function _esc(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}
