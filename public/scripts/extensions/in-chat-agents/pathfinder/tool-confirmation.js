import { escapeHtml } from '../../../utils.js';
import { CONFIRMABLE_TOOLS } from './pathfinder-tool-bridge.js';
import { getSettings } from './tree-store.js';

const MAX_ARG_PREVIEW_LENGTH = 300;

/**
 * Whether a tool call must be confirmed by the user before executing.
 * Only data-modifying tools are confirmable, and each has its own opt-in.
 * @param {string} toolName
 * @returns {boolean}
 */
export function shouldConfirmToolCall(toolName) {
    if (!CONFIRMABLE_TOOLS.has(toolName)) {
        return false;
    }

    const confirmTools = getSettings().confirmTools;
    return confirmTools?.[toolName] === true;
}

/**
 * Compact single-value-per-line preview of the tool arguments.
 * @param {object} args
 * @returns {string}
 */
export function formatToolArgsPreview(args) {
    return Object.entries(args ?? {})
        .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
        .map(([key, value]) => {
            const text = String(value).replace(/\s+/g, ' ').trim();
            const clipped = text.length > MAX_ARG_PREVIEW_LENGTH ? `${text.slice(0, MAX_ARG_PREVIEW_LENGTH)}…` : text;
            return `${key}: ${clipped}`;
        })
        .join('\n');
}

/**
 * Ask the user to approve a tool call. Fails closed: the user asked for
 * confirmation on this tool, so no dialog available means no execution.
 * The popup API is resolved through the live context instead of an import
 * so this module stays loadable in dependency-light environments.
 * @param {string} displayName - Human-readable tool name
 * @param {object} args - Tool call arguments from the model
 * @returns {Promise<boolean>} true when the user approved the call
 */
export async function confirmToolCall(displayName, args) {
    const ctx = globalThis.window?.SillyTavern?.getContext?.();
    const Popup = ctx?.Popup;
    const popupType = ctx?.POPUP_TYPE;
    if (typeof Popup !== 'function' || !popupType) {
        console.warn('[Pathfinder] Tool confirmation is enabled but no popup API is available; declining the call.');
        return false;
    }

    const preview = formatToolArgsPreview(args);
    const content = `
        <h4>Allow ${escapeHtml(String(displayName ?? ''))}?</h4>
        ${preview ? `<pre class="justifyLeft">${escapeHtml(preview)}</pre>` : ''}
    `;

    try {
        const result = await new Popup(content, popupType.CONFIRM, '', { okButton: 'Allow', cancelButton: 'Deny' }).show();
        return result === (ctx.POPUP_RESULT?.AFFIRMATIVE ?? 1);
    } catch (err) {
        console.warn('[Pathfinder] Tool confirmation dialog failed; declining the call.', err);
        return false;
    }
}
