/**
 * Tiny DOM helpers shared by the UI module. No SillyBunny imports.
 * Trimmed copy of the MacroEnhanced helpers.
 */

export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

export function button(className, text, onActivate) {
    const node = el('button', className, text);
    node.type = 'button';
    node.addEventListener('click', onActivate);
    return node;
}

/**
 * Copies text, falling back to the legacy path when the async clipboard is
 * unavailable (insecure origin, or permission denied).
 *
 * @returns {Promise<boolean>} Whether the copy succeeded.
 */
export async function copyToClipboard(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Insecure origin or permission denied — try the legacy path.
    }
    const activeElement = document.activeElement;
    const selection = document.getSelection?.();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index)) : [];
    const scratch = document.createElement('textarea');
    try {
        scratch.value = text;
        scratch.style.position = 'fixed';
        scratch.style.opacity = '0';
        document.body.appendChild(scratch);
        scratch.select();
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        scratch.remove();
        try {
            activeElement?.focus?.({ preventScroll: true });
            selection?.removeAllRanges();
            for (const range of ranges) selection?.addRange(range);
        } catch {
            // The previous target or range may no longer exist.
        }
    }
}

/**
 * Briefly swaps a button's label to confirm an action, then puts it back.
 * Re-entrant: a second flash before the first expires still restores the
 * original text.
 */
export function flashButtonText(node, text, revertMs = 1500) {
    if (node.dataset.flashTimer) {
        clearTimeout(Number(node.dataset.flashTimer));
    } else {
        node.dataset.originalText = node.textContent;
    }
    node.textContent = text;
    node.dataset.flashTimer = String(setTimeout(() => {
        node.textContent = node.dataset.originalText ?? text;
        delete node.dataset.flashTimer;
        delete node.dataset.originalText;
    }, revertMs));
}
