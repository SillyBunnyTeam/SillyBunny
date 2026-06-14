/**
 * Pure helper functions for the Expressions Agent bridge.
 *
 * Kept in a separate file so they can be imported and tested without dragging in
 * browser-only modules.
 */

/**
 * Clean the raw text returned by the expressions agent down to a single lowercase
 * expression label.
 * @param {string} raw
 * @param {string[]} allowedExpressions
 * @returns {string|null}
 */
export function normalizeAgentExpressionLabel(raw, allowedExpressions) {
    if (typeof raw !== 'string' || !raw.trim()) return null;

    // Strip Markdown, quotes, punctuation and extraneous whitespace.
    let label = raw
        .replace(/<[^>]+>/g, '')
        .replace(/["'`]/g, '')
        .replace(/[.*,:;!?()[\]{}]/g, ' ')
        .trim()
        .split(/\s+/)[0]
        .toLowerCase();

    if (!label) return null;

    // Accept only labels the user actually has configured.
    if (Array.isArray(allowedExpressions) && allowedExpressions.length > 0) {
        const exact = allowedExpressions.find((e) => e.toLowerCase() === label);
        if (exact) return exact;

        // Allow a leading prefix match for numbered variants such as desire1/desire2.
        const prefix = allowedExpressions.find((e) => label.startsWith(e.toLowerCase()));
        if (prefix) return prefix;
    }

    return null;
}
