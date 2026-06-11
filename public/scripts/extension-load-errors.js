const UNKNOWN_EXTENSION_LOAD_ERROR = 'Unknown extension load error';

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function getErrorTargetUrl(error) {
    const target = error?.target ?? error?.currentTarget;
    const url = target?.src ?? target?.href;

    return isNonEmptyString(url) ? url.trim() : '';
}

function stringifyObjectError(error) {
    if (!error || typeof error !== 'object') {
        return '';
    }

    try {
        const seen = new WeakSet();
        const json = JSON.stringify(error, (_, value) => {
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) {
                    return '[Circular]';
                }

                seen.add(value);
            }

            if (typeof value === 'function') {
                return `[Function ${value.name || 'anonymous'}]`;
            }

            return value;
        });

        return json && json !== '{}' ? json : '';
    } catch {
        return '';
    }
}

export function formatExtensionLoadError(error) {
    if (error instanceof Error && isNonEmptyString(error.message)) {
        return error.message.trim();
    }

    if (isNonEmptyString(error)) {
        return error.trim();
    }

    if (isNonEmptyString(error?.message)) {
        return error.message.trim();
    }

    if (error?.reason !== undefined && error.reason !== error) {
        const reason = formatExtensionLoadError(error.reason);

        if (reason !== UNKNOWN_EXTENSION_LOAD_ERROR) {
            return reason;
        }
    }

    const targetUrl = getErrorTargetUrl(error);

    if (targetUrl) {
        return `Load failed for ${targetUrl}`;
    }

    if (isNonEmptyString(error?.type)) {
        return `Load failed (${error.type.trim()})`;
    }

    const jsonError = stringifyObjectError(error);

    if (jsonError) {
        return jsonError;
    }

    const stringified = String(error ?? '').trim();

    if (stringified && stringified !== '[object Object]') {
        return stringified;
    }

    return UNKNOWN_EXTENSION_LOAD_ERROR;
}

export function createExtensionScriptLoadError(name, url, event) {
    const targetUrl = getErrorTargetUrl(event) || (isNonEmptyString(url) ? url.trim() : '');
    const extensionName = isNonEmptyString(name) ? ` for "${name.trim()}"` : '';
    const source = targetUrl ? `: ${targetUrl}` : '';
    const error = new Error(`Could not load extension script${extensionName}${source}`);

    error.cause = event;
    error.extensionName = name;
    error.extensionScriptUrl = targetUrl;

    return error;
}
