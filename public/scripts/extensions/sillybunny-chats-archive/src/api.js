// The extension's entire network surface.

async function post(ctx, url, body, signal) {
    const response = await fetch(url, {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify(body),
        signal,
    });
    if (response.status === 204) {
        return null;
    }
    if (!response.ok) {
        let message;
        try {
            message = (await response.json())?.message;
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw error;
            }
        }
        const error = new Error(message || `${url} failed with status ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

async function postArray(ctx, url, body, signal) {
    const data = await post(ctx, url, body, signal);
    if (!Array.isArray(data)) {
        throw new Error(`${url} returned an invalid response`);
    }
    return data;
}

export const ORGANIZATION_FILE_NAME = '_sbca_organization.json';
const ORGANIZATION_UPLOAD_TIMEOUT_MS = 15_000;
const ARCHIVE_RELEASE_TIMEOUT_MS = 15_000;
export const ARCHIVE_PAGE_SIZE = 250;
const ARCHIVE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
}

function base64ToUtf8(value) {
    const binary = atob(value.trim());
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

function parseOrganizationResponse(text) {
    try {
        return JSON.parse(text);
    } catch (error) {
        try {
            return JSON.parse(base64ToUtf8(text));
        } catch {
            throw error;
        }
    }
}

export const searchScope = (ctx, query, scope, signal) => postArray(ctx, '/api/chats/search', { query, ...scope }, signal);
export const exportChat = (ctx, body, signal) => post(ctx, '/api/chats/export', body, signal);

function abortReason(signal) {
    return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export function createTimedSignal(signal, timeoutMs) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortReason(signal));
    const timer = setTimeout(() => {
        controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
        onAbort();
    }
    return {
        signal: controller.signal,
        cleanup() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        },
    };
}

function parseArchivePage(data, expectedToken, expectedTotal) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.rows)) {
        throw new Error('/api/chats/archive/inventory returned an invalid response');
    }
    if (data.cursor !== null && (typeof data.cursor !== 'string' || !ARCHIVE_TOKEN_PATTERN.test(data.cursor))) {
        throw new Error('/api/chats/archive/inventory returned an invalid cursor');
    }
    if (data.read_token !== null
        && data.read_token !== undefined
        && (typeof data.read_token !== 'string' || !ARCHIVE_TOKEN_PATTERN.test(data.read_token))) {
        throw new Error('/api/chats/archive/inventory returned an invalid read token');
    }
    if (expectedToken && data.read_token !== expectedToken) {
        throw new Error('/api/chats/archive/inventory changed read tokens mid-scan');
    }
    if (!Number.isSafeInteger(data.errors) || data.errors < 0) {
        throw new Error('/api/chats/archive/inventory returned an invalid error count');
    }
    if (!Number.isSafeInteger(data.total) || data.total < data.rows.length) {
        throw new Error('/api/chats/archive/inventory returned an invalid total');
    }
    if (expectedTotal !== null && data.total !== expectedTotal) {
        throw new Error('/api/chats/archive/inventory changed totals mid-scan');
    }
    return data;
}

export async function* iterateArchiveInventoryPages(ctx, scope, signal) {
    if (!['archive', 'orphans'].includes(scope)) {
        throw new TypeError(`Unsupported archive inventory scope: ${String(scope)}`);
    }

    let cursor = null;
    let readToken = null;
    let total = null;
    let loaded = 0;
    let errors = 0;
    let pages = 0;
    let complete = false;
    try {
        do {
            if (signal?.aborted) {
                throw abortReason(signal);
            }
            const body = { scope, page_size: ARCHIVE_PAGE_SIZE };
            if (cursor) {
                body.cursor = cursor;
            }
            const page = parseArchivePage(
                await post(ctx, '/api/chats/archive/inventory', body, signal),
                readToken,
                total,
            );
            readToken ??= page.read_token ?? null;
            total ??= page.total;
            cursor = page.cursor;
            if (scope === 'orphans' && !readToken) {
                throw new Error('/api/chats/archive/inventory omitted the orphan read token');
            }
            if (scope === 'archive' && readToken) {
                throw new Error('/api/chats/archive/inventory exposed a read token for linked chats');
            }
            if (signal?.aborted) {
                throw abortReason(signal);
            }
            loaded += page.rows.length;
            errors += page.errors;
            pages++;
            if (loaded > total) {
                throw new Error('/api/chats/archive/inventory exceeded its declared total');
            }
            if (cursor && page.rows.length === 0) {
                throw new Error('/api/chats/archive/inventory returned an empty partial page');
            }
            if (pages > 100_000) {
                throw new Error('/api/chats/archive/inventory exceeded the page limit');
            }
            yield {
                rows: page.rows,
                loaded,
                errors,
                pageErrors: page.errors,
                cursor,
                readToken,
                total,
            };
        } while (cursor);
        if (loaded !== total) {
            throw new Error('/api/chats/archive/inventory completed before its declared total');
        }
        complete = true;
    } catch (error) {
        if (readToken && error && typeof error === 'object') {
            error.archiveReadToken = readToken;
        }
        if (cursor && error && typeof error === 'object') {
            error.archiveCursor = cursor;
        }
        throw error;
    } finally {
        if (!complete && (readToken || cursor)) {
            try {
                await releaseArchiveSession(ctx, { token: readToken, cursor });
            } catch {
                // The server also discards an inventory when its request is aborted.
            }
        }
    }
}

export async function fetchArchiveInventory(ctx, scope, signal, onPage = null) {
    const rows = [];
    let errors = 0;
    let readToken = null;
    for await (const page of iterateArchiveInventoryPages(ctx, scope, signal)) {
        rows.push(...page.rows);
        errors = page.errors;
        readToken = page.readToken;
        onPage?.(page);
    }
    return { rows, errors, readToken };
}

export async function fetchOrganization(ctx, signal) {
    const url = `/user/files/${ORGANIZATION_FILE_NAME}`;
    const response = await fetch(url, {
        method: 'GET',
        headers: ctx.getRequestHeaders(),
        cache: 'no-store',
        signal,
    });
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`${url} failed with status ${response.status}`);
    }
    return parseOrganizationResponse(await response.text());
}

export async function saveOrganization(ctx, organization, signal) {
    const data = utf8ToBase64(JSON.stringify(organization));
    const request = createTimedSignal(signal, ORGANIZATION_UPLOAD_TIMEOUT_MS);
    try {
        return await post(ctx, '/api/files/upload', { name: ORGANIZATION_FILE_NAME, data }, request.signal);
    } finally {
        request.cleanup();
    }
}

export async function fetchArchiveFile(ctx, token, hash, signal) {
    const query = new URLSearchParams({ token, hash });
    const response = await fetch(`/api/chats/archive/view?${query}`, {
        headers: ctx.getRequestHeaders(),
        signal,
    });
    if (!response.ok) {
        const error = new Error(`/api/chats/archive/view failed with status ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return response.text();
}

export async function releaseArchiveSession(ctx, { token = null, cursor = null } = {}, signal) {
    if (!token && !cursor) {
        return;
    }
    const request = createTimedSignal(signal, ARCHIVE_RELEASE_TIMEOUT_MS);
    try {
        await post(ctx, '/api/chats/archive/release', {
            ...(token ? { token } : {}),
            ...(cursor ? { cursor } : {}),
        }, request.signal);
    } finally {
        request.cleanup();
    }
}
