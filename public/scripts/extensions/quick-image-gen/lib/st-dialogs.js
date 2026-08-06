export const DEFAULT_DIALOG_TITLE = "Quick Image Gen";

function identityEscape(value) {
    return value == null ? "" : String(value);
}

function buildDialogContent(message, title, escapeHtml) {
    const body = `<div class="qig-dialog-text">${escapeHtml(message == null ? "" : String(message))}</div>`;
    if (!title) return body;
    return `<h3 class="qig-dialog-title">${escapeHtml(String(title))}</h3>${body}`;
}

/**
 * Wraps SillyTavern's Popup API so QIG can ask questions and show notices with
 * native-looking, themeable dialogs instead of `window.confirm` / `window.alert`.
 *
 * Every dependency is injected so the host can be exercised without SillyTavern,
 * and so a failed Popup import degrades to the browser dialogs rather than
 * silently dropping a confirmation the user needs to see.
 */
export function createDialogHost({
    callGenericPopup = null,
    popupType = null,
    popupResult = null,
    escapeHtml = identityEscape,
    nativeConfirm = null,
    nativeAlert = null,
    nativePrompt = null,
    onError = null,
} = {}) {
    const escape = typeof escapeHtml === "function" ? escapeHtml : identityEscape;
    const affirmative = popupResult?.AFFIRMATIVE;

    function supportsPopup() {
        return typeof callGenericPopup === "function"
            && Number.isFinite(popupType?.CONFIRM)
            && Number.isFinite(popupType?.TEXT)
            && Number.isFinite(popupType?.INPUT)
            && affirmative !== undefined;
    }

    function reportFallback(error) {
        if (typeof onError === "function") onError(error);
    }

    function fallbackConfirm(message) {
        if (typeof nativeConfirm !== "function") return false;
        return Boolean(nativeConfirm(message == null ? "" : String(message)));
    }

    function fallbackAlert(message) {
        if (typeof nativeAlert !== "function") return;
        nativeAlert(message == null ? "" : String(message));
    }

    function fallbackPrompt(message, defaultValue) {
        if (typeof nativePrompt !== "function") return null;
        const value = nativePrompt(message == null ? "" : String(message), defaultValue ?? "");
        return value == null ? null : String(value);
    }

    /**
     * SillyTavern's INPUT popup treats an empty string as a successful empty answer
     * and every other falsy value as a dismissal. Callers get "" or null, never false.
     */
    function normalizeInputResult(value) {
        if (value === "") return "";
        return value ? String(value) : null;
    }

    /**
     * Asks a yes/no question. Resolves true only on explicit confirmation, so an
     * Escape, a backdrop dismiss, or a popup failure all leave the action undone.
     */
    async function confirmDialog(message, { title = "", okButton = "OK", cancelButton = "Cancel", wide = false } = {}) {
        if (!supportsPopup()) return fallbackConfirm(message);
        try {
            const result = await callGenericPopup(
                buildDialogContent(message, title, escape),
                popupType.CONFIRM,
                "",
                { okButton, cancelButton, wide },
            );
            return result === affirmative;
        } catch (error) {
            reportFallback(error);
            return fallbackConfirm(message);
        }
    }

    /** Shows a notice or a multi-line report and resolves once it is dismissed. */
    async function messageDialog(message, { title = "", okButton = "OK", wide = false, large = false } = {}) {
        if (!supportsPopup()) {
            fallbackAlert(message);
            return;
        }
        try {
            await callGenericPopup(
                buildDialogContent(message, title, escape),
                popupType.TEXT,
                "",
                { okButton, cancelButton: false, wide, large },
            );
        } catch (error) {
            reportFallback(error);
            fallbackAlert(message);
        }
    }

    /**
     * Asks for a single line of text. Resolves the entered string, "" for a
     * deliberate empty answer, or null when the user backs out.
     */
    async function inputDialog(message, { title = "", defaultValue = "", okButton = "Save", cancelButton = "Cancel", placeholder = "", rows = 1 } = {}) {
        if (!supportsPopup()) return fallbackPrompt(message, defaultValue);
        try {
            const result = await callGenericPopup(
                buildDialogContent(message, title, escape),
                popupType.INPUT,
                defaultValue == null ? "" : String(defaultValue),
                { okButton, cancelButton, placeholder, rows },
            );
            return normalizeInputResult(result);
        } catch (error) {
            reportFallback(error);
            return fallbackPrompt(message, defaultValue);
        }
    }

    /**
     * Offers a small set of named actions as buttons instead of asking the user to
     * type a menu number. Resolves the chosen option's index, or null on dismissal.
     */
    async function choiceDialog(message, choices, { title = "", cancelButton = "Cancel" } = {}) {
        const labels = (Array.isArray(choices) ? choices : []).map((choice) => String(choice));
        if (!labels.length) return null;
        if (!supportsPopup()) {
            const numbered = `${message}\n${labels.map((label, index) => `${index + 1}) ${label}`).join("\n")}`;
            const answer = fallbackPrompt(numbered, "");
            if (answer == null) return null;
            const picked = Number.parseInt(answer, 10);
            return Number.isInteger(picked) && picked >= 1 && picked <= labels.length ? picked - 1 : null;
        }
        try {
            const result = await callGenericPopup(
                buildDialogContent(message, title, escape),
                popupType.TEXT,
                "",
                { okButton: false, cancelButton, customButtons: labels },
            );
            // String customButtons are assigned results counting up from 2.
            const index = Number(result) - 2;
            return Number.isInteger(index) && index >= 0 && index < labels.length ? index : null;
        } catch (error) {
            reportFallback(error);
            return null;
        }
    }

    return { confirmDialog, messageDialog, inputDialog, choiceDialog, supportsPopup };
}
