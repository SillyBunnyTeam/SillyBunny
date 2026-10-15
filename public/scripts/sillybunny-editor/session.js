// SillyBunny: shared explicit-save session for the scrolling-sheet editors
// (character and group). Owns the saved baseline, dirty comparison, the draft
// backup interval, and save coalescing. Knows nothing about the DOM, field
// schemas, or entities: each editor supplies snapshot capture/restore, a draft
// store, and a persist callback.

export const DIRTY_DEBOUNCE_MS = 300;
export const DRAFT_INTERVAL_MS = 5000;

/**
 * @typedef {object} EditorContext
 * @property {'create'|'edit'} mode
 * @property {string} entityId  Draft key suffix: avatar, group id, or a create sentinel.
 */

/**
 * @typedef {object} EditorState
 * @property {boolean} open
 * @property {'create'|'edit'|null} mode
 * @property {boolean} dirty
 * @property {boolean} saving
 */

/**
 * @typedef {object} EditorDraft
 * @property {number} v
 * @property {number} ts
 * @property {object} snapshot
 */

/**
 * @typedef {object} EditorSaveReceipt
 * @property {EditorContext & Record<string, unknown>} context
 * @property {object} snapshot
 * @property {() => boolean} isCurrent
 * @property {(nextContext?: Partial<EditorContext>, savedSnapshot?: object) => boolean} markSaved
 */

/**
 * @param {object} config
 * @param {() => object} config.captureSnapshot  Fresh JSON-compatible copy of the editable values.
 * @param {(snapshot: object) => void} config.restoreSnapshot  Writes a snapshot back into the editor.
 * @param {(receipt: EditorSaveReceipt) => Promise<unknown>} config.persist  Saves the editor. Must call markSaved() on success;
 *     a failed or aborted save simply leaves the session dirty.
 * @param {{ read: (id: string) => EditorDraft|null, write: (id: string, snapshot: object) => void, remove: (id: string) => void }} config.drafts
 * @param {(state: EditorState) => void} [config.onStateChange]
 * @param {(draft: EditorDraft, actions: { restore: () => void, discard: () => void }) => void} [config.offerDraft]
 * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout, setInterval: typeof setInterval, clearInterval: typeof clearInterval }} [config.timers]
 */
export function createEditorSession(config) {
    const {
        captureSnapshot,
        restoreSnapshot,
        persist,
        drafts,
        onStateChange = () => {},
        offerDraft = () => {},
        timers = globalThis,
    } = config;

    /** @type {(EditorContext & Record<string, unknown>)|null} */
    let context = null;
    // Bumped on every open/close so late callbacks (toast buttons, in-flight
    // saves) can tell they belong to a session that no longer exists.
    let token = 0;
    let baselineJson = '';
    /** @type {object|null} */
    let baseline = null;
    let draftTimerId = null;
    let dirtyTimerId = null;
    /** @type {{ token: number, promise: Promise<boolean> }|null} */
    let inflightSave = null;

    function isOpen() {
        return context !== null;
    }

    /** Exact comparison; guards call this so they never act on a stale debounced value. */
    function isDirty() {
        if (!context) return false;
        return JSON.stringify(captureSnapshot()) !== baselineJson;
    }

    function getState() {
        return {
            open: context !== null,
            mode: context?.mode ?? null,
            dirty: isDirty(),
            saving: inflightSave !== null && inflightSave.token === token,
        };
    }

    function notify() {
        clearDirtyDebounce();
        onStateChange(getState());
    }

    function clearDirtyDebounce() {
        if (dirtyTimerId === null) return;
        timers.clearTimeout(dirtyTimerId);
        dirtyTimerId = null;
    }

    function stopDraftTimer() {
        if (draftTimerId === null) return;
        timers.clearInterval(draftTimerId);
        draftTimerId = null;
    }

    function writeDraft() {
        if (!context) return;
        drafts.write(context.entityId, captureSnapshot());
    }

    function captureBaseline() {
        baseline = captureSnapshot();
        baselineJson = JSON.stringify(baseline);
    }

    /**
     * Start a session. Call after every field and editor-local list has been
     * written for the entity, so the baseline reflects its saved state.
     * @param {EditorContext & Record<string, unknown>} nextContext  Extra keys are kept for the editor's own use.
     */
    function open(nextContext) {
        stopDraftTimer();
        clearDirtyDebounce();
        token++;
        context = { ...nextContext };
        captureBaseline();
        draftTimerId = timers.setInterval(() => {
            if (isDirty()) writeDraft();
        }, DRAFT_INTERVAL_MS);
        offerStoredDraft();
        notify();
    }

    /**
     * Call immediately before the editor's fields are overwritten with another
     * entity: backs up a dirty draft under the outgoing key, then ends the
     * session so the field writes are not read as edits.
     */
    function suspend() {
        if (context && isDirty()) writeDraft();
        close();
    }

    function close() {
        stopDraftTimer();
        clearDirtyDebounce();
        if (context === null) return;
        token++;
        context = null;
        baseline = null;
        baselineJson = '';
        notify();
    }

    /**
     * Report an edit. Typing uses the trailing debounce so long fields are not
     * serialized on every keystroke; structural edits pass { immediate: true }.
     * @param {{ immediate?: boolean }} [options]
     */
    function changed(options = {}) {
        if (!context) return;
        if (options.immediate) {
            notify();
            return;
        }
        clearDirtyDebounce();
        dirtyTimerId = timers.setTimeout(() => {
            dirtyTimerId = null;
            notify();
        }, DIRTY_DEBOUNCE_MS);
    }

    /**
     * Recapture the baseline after a successful save and drop its backup.
     * @param {{ entityId?: string, mode?: 'create'|'edit' } & Record<string, unknown>} [nextContext]
     *     Pass when the save gave the entity a new identity (create → edit).
     */
    function markSaved(nextContext) {
        if (!context) return;
        const previousId = context.entityId;
        if (nextContext) context = { ...context, ...nextContext };
        captureBaseline();
        drafts.remove(previousId);
        if (context.entityId !== previousId) drafts.remove(context.entityId);
        notify();
    }

    /** Capture before dispatch; only this session may accept the submitted values. */
    function captureSaveReceipt() {
        if (!context) return null;
        const savingToken = token;
        const submittedContext = { ...context };
        const snapshot = captureSnapshot();
        const isCurrent = () => token === savingToken && context?.entityId === submittedContext.entityId;
        return {
            context: submittedContext,
            snapshot,
            isCurrent,
            markSaved(nextContext, savedSnapshot = snapshot) {
                if (!isCurrent()) return false;
                const previousId = context.entityId;
                if (nextContext) context = { ...context, ...nextContext };
                baseline = structuredClone(savedSnapshot);
                baselineJson = JSON.stringify(baseline);
                if (context.entityId !== previousId) drafts.remove(previousId);
                if (isDirty()) writeDraft();
                else drafts.remove(context.entityId);
                notify();
                return true;
            },
        };
    }

    /**
     * Rebase without touching the draft store: a save made outside the editor
     * (avatar upload, linked lorebook) changed the stored entity.
     * @param {object} [nextSnapshot]  The adopted values. Use when the editor
     *     reconciled its own state with an external change and needs the new
     *     state to become the baseline (three-way merge on reselect).
     */
    function rebase(nextSnapshot) {
        if (!context) return;
        if (nextSnapshot) {
            baseline = nextSnapshot;
            baselineJson = JSON.stringify(baseline);
        } else {
            captureBaseline();
        }
        notify();
    }

    /** Revert to the saved baseline and drop its backup. The session stays open. */
    function discard() {
        if (!context || !baseline) return;
        restoreSnapshot(baseline);
        drafts.remove(context.entityId);
        notify();
    }

    /**
     * Save through the editor's persist callback. Concurrent calls (a double
     * click, Ctrl+S during a save) share one request.
     * @returns {Promise<boolean>} true when nothing unsaved remains afterwards
     */
    function save() {
        if (!context) return Promise.resolve(true);
        if (inflightSave && inflightSave.token === token) return inflightSave.promise;
        if (context.mode === 'edit' && !isDirty()) return Promise.resolve(true);

        const savingToken = token;
        const receipt = captureSaveReceipt();
        // Registered before persist() runs, so a markSaved() it calls
        // synchronously already sees the session as saving.
        const operation = { token: savingToken, promise: null };
        operation.promise = Promise.resolve()
            .then(() => receipt.isCurrent() ? persist(receipt) : undefined)
            .catch(error => console.error('[sb-editor] Save failed', error))
            // Creating a character reopens the editor on the new card before
            // persist() resolves, so judge whatever session is open now: a
            // clean successor means the save landed, a dirty one must not be
            // waved through by a save that never covered it.
            .then(() => !isDirty())
            .finally(() => {
                if (inflightSave !== operation) return;
                inflightSave = null;
                if (token === savingToken) notify();
            });
        inflightSave = operation;
        notify();
        return operation.promise;
    }

    /** Synchronous best-effort backup for pagehide / unload. */
    function flushDraft() {
        if (context && isDirty()) writeDraft();
    }

    function offerStoredDraft() {
        if (!context) return;
        const entityId = context.entityId;
        const draft = drafts.read(entityId);
        if (!draft) return;

        // A draft is only worth offering if it differs from the saved state.
        if (JSON.stringify(draft.snapshot) === baselineJson) {
            drafts.remove(entityId);
            return;
        }

        const offeredToken = token;
        offerDraft(draft, {
            restore: () => {
                // markSaved() can re-key a create session without reopening it.
                if (token !== offeredToken || context?.entityId !== entityId) return;
                restoreSnapshot(draft.snapshot);
                notify();
            },
            discard: () => drafts.remove(entityId),
        });
    }

    return {
        open,
        suspend,
        close,
        changed,
        markSaved,
        captureSaveReceipt,
        rebase,
        discard,
        save,
        flushDraft,
        isDirty,
        isOpen,
        getState,
        /** Snapshot the editor was opened with (or last rebased to). @returns {object|null} */
        readBaseline() {
            return baseline;
        },
        /** @returns {(EditorContext & Record<string, unknown>)|null} */
        get context() {
            return context;
        },
    };
}
