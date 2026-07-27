// SillyBunny: keep user-visible OOC notes readable while excluding them from prompt context.
const OOC_BLOCK_PLACEHOLDER_PREFIX = '\uE000SBOOCBLOCK';
const OOC_BLOCK_PLACEHOLDER_SUFFIX = '\uE001';

/**
 * Normalizes prompt-context retention settings.
 * -1 preserves every context message, 0 preserves the active turn, N preserves through depth N.
 * @param {number|string} value Retention setting value.
 * @returns {number} Normalized context depth.
 */
export function normalizeContextRetentionDepth(value) {
    if (value === null || value === undefined || value === '') {
        return -1;
    }

    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return -1;
    }

    return Math.max(-1, Math.floor(numericValue));
}

/**
 * Checks whether OOC or HTML tags should be retained for a prompt-context message.
 * @param {number} messageDepth Zero-based distance from the latest context message.
 * @param {number|string} retentionDepth Retention setting value.
 * @returns {boolean} True when the message should keep the relevant content.
 */
export function shouldRetainContextAtDepth(messageDepth, retentionDepth) {
    const normalizedDepth = normalizeContextRetentionDepth(retentionDepth);
    if (normalizedDepth < 0) {
        return true;
    }

    return Math.max(0, Number(messageDepth) || 0) <= normalizedDepth;
}

/**
 * Replaces balanced OOC blocks with the supplied replacement.
 * @param {string} value Source text.
 * @param {(content: string, index: number) => string} replacer Replacement callback.
 * @returns {string} Text with balanced OOC blocks replaced.
 */
function replaceBalancedOocBlocks(value, replacer) {
    const source = String(value ?? '');
    let output = '';
    let cursor = 0;
    let blockStart = -1;
    let contentStart = -1;
    let depth = 0;
    let blockIndex = 0;

    for (let index = 0; index < source.length;) {
        const token = source.slice(index, index + 2);

        if (token === '((') {
            if (depth === 0) {
                output += source.slice(cursor, index);
                blockStart = index;
                contentStart = index + 2;
            }
            depth++;
            index += 2;
            continue;
        }

        if (token === '))' && depth > 0) {
            depth--;

            if (depth === 0) {
                output += replacer(source.slice(contentStart, index), blockIndex);
                blockIndex++;
                index += 2;
                cursor = index;
                blockStart = -1;
                contentStart = -1;
                continue;
            }

            index += 2;
            continue;
        }

        index++;
    }

    if (depth > 0 && blockStart !== -1) {
        return output + source.slice(blockStart);
    }

    return output + source.slice(cursor);
}

/**
 * Escapes text for safe HTML rendering.
 * @param {string} value Source text.
 * @returns {string} Escaped text.
 */
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Removes user-visible out-of-character blocks from text before prompt assembly.
 * @param {string} text Source text.
 * @param {boolean} [preserve=false] Whether to keep OOC blocks in this context message.
 * @returns {string} Text without balanced ((...)) blocks.
 */
export function stripOocBlocksFromContext(text, preserve = false) {
    if (preserve) {
        return String(text ?? '');
    }

    return replaceBalancedOocBlocks(text, () => '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Strips raw HTML tags from older prompt-context messages.
 * @param {string} text Source text.
 * @param {boolean} [preserve=false] Whether to keep HTML tags in this context message.
 * @returns {string} Text with HTML tags removed unless preserved.
 */
export function stripHtmlTagsFromContext(text, preserve = false) {
    const source = String(text ?? '');
    if (preserve) {
        return source;
    }

    return source
        .replace(/<\/?[a-z][a-z0-9:-]*(?:\s[^>]*)?>/gi, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Replaces raw OOC blocks with placeholders so markdown and quote formatting ignore their contents.
 * @param {string} text Source text.
 * @param {string[]} blocks Mutable list of extracted OOC block contents.
 * @returns {string} Text with placeholders replacing balanced OOC blocks.
 */
export function extractOocBlocksForDisplay(text, blocks) {
    return replaceBalancedOocBlocks(text, (content) => {
        const index = blocks.push(content) - 1;
        return `${OOC_BLOCK_PLACEHOLDER_PREFIX}${index}${OOC_BLOCK_PLACEHOLDER_SUFFIX}`;
    });
}

/**
 * Restores extracted OOC blocks as collapsible, sanitized chat UI sections.
 * @param {string} html Message HTML.
 * @param {string[]} blocks Extracted OOC block contents.
 * @returns {string} Message HTML with OOC placeholders restored.
 */
export function restoreOocBlocksForDisplay(html, blocks) {
    if (!Array.isArray(blocks) || !blocks.length) {
        return html;
    }

    let result = html;
    blocks.forEach((content, index) => {
        const placeholder = `${OOC_BLOCK_PLACEHOLDER_PREFIX}${index}${OOC_BLOCK_PLACEHOLDER_SUFFIX}`;
        result = result.replaceAll(placeholder, renderOocBlock(content));
    });
    return result;
}

/**
 * Renders a single OOC block as a collapsed details box.
 * @param {string} content OOC content.
 * @returns {string} HTML string.
 */
export function renderOocBlock(content) {
    const normalizedContent = String(content ?? '').trim().replace(/\r\n?/g, '\n') || '(empty)';
    const safeContent = escapeHtml(normalizedContent).replace(/\n/g, '<br />');
    return `<details class="ooc_block"><summary><span class="ooc_label">Out-of-Character</span></summary><div class="ooc_content">${safeContent}</div></details>`;
}

/**
 * Checks whether a prompt message still carries text or non-text payload after OOC text is removed.
 * @param {string} text Message text.
 * @param {unknown[]} payloads Candidate payload arrays.
 * @returns {boolean} True if the prompt item should remain in context.
 */
export function hasTextOrArrayPayload(text, payloads = []) {
    return String(text ?? '').trim().length > 0
        || payloads.some(payload => Array.isArray(payload) && payload.length > 0);
}

/**
 * Checks whether a prompt message still carries payload after OOC text is removed.
 * @param {object} chatItem Message history item.
 * @param {boolean} [includeReasoning=false] Whether reasoning can retain the message.
 * @returns {boolean} True if the prompt item should remain in context.
 */
export function hasPromptPayload(chatItem, includeReasoning = false) {
    return hasTextOrArrayPayload(chatItem?.mes, [
        chatItem?.extra?.media,
        chatItem?.extra?.files,
        chatItem?.extra?.tool_invocations,
    ]) || (includeReasoning && String(chatItem?.extra?.reasoning ?? '').trim().length > 0);
}
