const ROLE_HEADER_RE = /^\s*\[(system|user|assistant)\]\s*$/i;
const VALID_ROLES = new Set(['system', 'user', 'assistant']);

function normalizeRole(value) {
    const role = String(value ?? '').trim().toLowerCase();
    return VALID_ROLES.has(role) ? role : 'assistant';
}

function normalizeContent(value) {
    return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/**
 * Parses textarea role blocks into chat-style helper messages.
 *
 * @param {string} value
 * @returns {{role: 'system'|'user'|'assistant', content: string}[]}
 */
export function parseHelperPrefillMessages(value = '') {
    const lines = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const messages = [];
    let currentRole = 'assistant';
    let currentLines = [];

    const flush = () => {
        const content = normalizeContent(currentLines.join('\n'));
        if (content) {
            messages.push({ role: currentRole, content });
        }
        currentLines = [];
    };

    for (const line of lines) {
        const roleMatch = line.match(ROLE_HEADER_RE);
        if (roleMatch) {
            flush();
            currentRole = normalizeRole(roleMatch[1]);
            continue;
        }

        currentLines.push(line);
    }

    flush();
    return messages;
}

/**
 * Appends configured helper prefill messages to a synthetic helper prompt.
 *
 * @param {object[]} messages
 * @param {string} prefillText
 * @returns {object[]}
 */
export function appendHelperPrefillMessages(messages, prefillText = '') {
    const baseMessages = Array.isArray(messages)
        ? messages.filter(message => message && typeof message === 'object').map(message => ({ ...message }))
        : [];
    const prefillMessages = parseHelperPrefillMessages(prefillText);

    if (prefillMessages.length === 0) {
        return baseMessages;
    }

    return [...baseMessages, ...prefillMessages];
}

/**
 * Converts helper prefill messages to labeled prompt text for prompt-only paths.
 *
 * @param {{role?: string, content?: unknown}[]} messages
 * @returns {string}
 */
export function serializeHelperPrefillForPrompt(messages = []) {
    return (Array.isArray(messages) ? messages : [])
        .map(message => {
            const content = normalizeContent(message?.content);
            if (!content) {
                return '';
            }

            return `${normalizeRole(message?.role).toUpperCase()}:\n${content}`;
        })
        .filter(Boolean)
        .join('\n\n');
}
