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
import { setCharacterEditorQuickEdit } from './power-user.js';
import { eventSource, event_types } from './events.js';
import {
    characters,
    this_chid,
    create_save,
    createOrEditCharacter,
} from '../script.js';
import { t } from './i18n.js';
import { getCurrentUserHandle } from './user.js';

const DRAFT_KEY_PREFIX = 'sb-editor-draft-';
const DRAFT_INTERVAL_MS = 5000;
const NEW_CHAR_DRAFT_KEY = 'new-character';

// --- Module state ---

/** @type {{ mode: 'edit'|'create', chid: number|null, avatar: string, baseline: object }|null} */
let currentSession = null;
let draftTimerId = null;

// ============================================================
// Public API
// ============================================================

export function initCharacterEditor() {
    _bindHeaderButtons();
    _bindToolbarButtons();
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
    if (el) el.hidden = !_isDirty();
}

function _updateHeaderButtons() {
    const save = document.getElementById('sb_character_editor_save');
    const cancel = document.getElementById('sb_character_editor_cancel');
    const dirty = _isDirty();
    const isCreate = currentSession?.mode === 'create';

    if (save) {
        save.textContent = isCreate ? t`Create` : t`Save`;
        /** @type {HTMLButtonElement} */ (save).disabled = !isCreate && !dirty;
    }
    if (cancel) {
        /** @type {HTMLButtonElement} */ (cancel).disabled = !dirty;
    }
}

function _updateHeaderTitle(title) {
    const el = document.getElementById('sb_character_editor_title');
    if (el) el.textContent = title;
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
