const REDACTED = '[REDACTED]';

const SECRET_HEADER_NAMES = new Set(['authorization', 'x-goog-api-key', 'api-key', 'x-api-key', 'cookie', 'proxy-authorization']);
const SECRET_QUERY_NAMES = ['key', 'api_key', 'apikey', 'access_token', 'token'];

// Shapes of credentials that may appear in text the relay echoes back.
const SECRET_SHAPES = [
    /\bBearer\s+[^\s"',;]+/gi,
    /\b(?:authorization|x-goog-api-key|x-api-key|api-key)\s*[:=]\s*[^\s"',;]+/gi,
    /([?&](?:key|api_key|apikey|access_token|token)=)[^&\s"']+/gi,
    /\bAIza[0-9A-Za-z_-]{20,}/g,
    /\bsk-[0-9A-Za-z_-]{16,}/g,
];

/** @param {Record<string, string>} headers */
export function redactHeaders(headers) {
    return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
        name,
        SECRET_HEADER_NAMES.has(name.toLowerCase()) ? REDACTED : value,
    ]));
}

/** @param {string} value */
export function redactUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        return value;
    }
    for (const name of SECRET_QUERY_NAMES) {
        if (url.searchParams.has(name)) {
            url.searchParams.set(name, REDACTED);
        }
    }
    url.username = '';
    url.password = '';
    return url.toString();
}

/**
 * Removes every known secret value and every credential-shaped string.
 * @param {string} text
 * @param {Array<string | undefined>} knownSecrets Literal values to remove; empty entries are skipped.
 */
export function redactText(text, knownSecrets = []) {
    let shown = String(text);
    for (const secret of knownSecrets) {
        if (secret) {
            shown = shown.split(secret).join(REDACTED);
        }
    }
    for (const shape of SECRET_SHAPES) {
        shown = shown.replace(shape, (match, queryPrefix) => (queryPrefix ? `${queryPrefix}${REDACTED}` : REDACTED));
    }
    return shown;
}
