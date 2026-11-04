// Pure on purpose: the server reads upstream failures with the same rules as the browser.

const MAX_PLAIN_TEXT_LENGTH = 300;
const MAX_NESTING_DEPTH = 3;

/**
 * @param {string} text
 * @returns {boolean} True for a body that is a web page, such as the error page of a proxy.
 */
function isMarkup(text) {
    return /^\s*<(!doctype|html|head|body|\?xml)/i.test(text);
}

/**
 * Finds the sentence a provider wrote about its own failure.
 * Providers differ in where they put it, so this checks the usual places in order, and
 * parses JSON that arrives as a string, because the text completion route forwards the upstream body that way.
 * @param {unknown} body A response body as text, or the parsed body.
 * @param {number} [depth] How many levels of nesting were entered already.
 * @returns {string} The provider's message, or an empty string when the body has none worth showing.
 */
export function extractProviderMessage(body, depth = 0) {
    if (body === null || body === undefined || depth > MAX_NESTING_DEPTH) {
        return '';
    }

    if (typeof body === 'string') {
        const text = body.trim();
        if (!text) {
            return '';
        }
        if (/^[{[]/.test(text)) {
            try {
                return extractProviderMessage(JSON.parse(text), depth + 1);
            } catch {
                // A whole body that looks like JSON but does not parse is cut off, so it says nothing. A sentence inside
                // a parsed body can start with a bracket, as in "[429] Too Many Requests", and is plain text.
                if (depth === 0) {
                    return '';
                }
            }
        }
        return isMarkup(text) ? '' : text.replace(/\s+/g, ' ').slice(0, MAX_PLAIN_TEXT_LENGTH);
    }

    if (Array.isArray(body)) {
        return extractProviderMessage(body[0], depth + 1);
    }

    if (typeof body !== 'object') {
        return '';
    }

    const places = [
        body.error?.message,
        body.error,
        body.message,
        body.detail?.error?.message,
        body.detail?.message,
        body.detail,
        // Only an error body carries the upstream text here, because the same key holds the generated text in other payloads.
        body.error ? body.response : undefined,
    ];
    for (const place of places) {
        const message = extractProviderMessage(place, depth + 1);
        if (message) {
            return message;
        }
    }
    return '';
}
