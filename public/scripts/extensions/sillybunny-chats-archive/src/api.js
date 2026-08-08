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

function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
}

async function fetchChatFiles(ctx, avatar, signal, simple = true) {
    const url = '/api/characters/chats';
    const data = await post(ctx, url, { avatar_url: avatar, simple }, signal);
    if (data?.error === true) {
        return [];
    }
    if (!Array.isArray(data)) {
        throw new Error(`${url} returned an invalid response`);
    }
    return data;
}

// The host may balance up to twice max across group and solo chats; 100 still bounds startup while covering the first list page.
export const fetchRecent = (ctx, signal) => postArray(ctx, '/api/chats/recent', { max: 100 }, signal);
export const fetchRootFiles = (ctx, signal) => fetchChatFiles(ctx, '', signal);
// Full per-file stats (previews, counts, sizes); reads each of the character's files, so call it for one character at a time.
export const fetchCharacterChatDetails = (ctx, avatar, signal) => fetchChatFiles(ctx, avatar, signal, false);
export const searchScope = (ctx, query, scope, signal) => postArray(ctx, '/api/chats/search', { query, ...scope }, signal);
export const exportChat = (ctx, body, signal) => post(ctx, '/api/chats/export', body, signal);
export const fetchDataMaidReport = (ctx, signal) => post(ctx, '/api/data-maid/report', {}, signal);
export const finalizeDataMaid = (ctx, token, signal) => post(ctx, '/api/data-maid/finalize', { token }, signal);

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
    return response.json();
}

export function saveOrganization(ctx, organization, signal) {
    const data = utf8ToBase64(JSON.stringify(organization));
    const timeout = AbortSignal.timeout(ORGANIZATION_UPLOAD_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return post(ctx, '/api/files/upload', { name: ORGANIZATION_FILE_NAME, data }, requestSignal);
}

export async function fetchCharacterFiles(ctx, avatars, signal) {
    const rows = [];
    const failedAvatars = new Set();
    let failures = 0;
    const results = new Array(avatars.length);
    let nextIndex = 0;
    const worker = async () => {
        while (!signal?.aborted) {
            const index = nextIndex++;
            if (index >= avatars.length) {
                return;
            }
            try {
                results[index] = { status: 'fulfilled', value: await fetchChatFiles(ctx, avatars[index], signal) };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(8, avatars.length) }, worker));
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }
    results.forEach((result, index) => {
        const avatar = avatars[index];
        if (result.status === 'fulfilled') {
            for (const row of result.value) {
                if (!row || typeof row !== 'object' || Array.isArray(row)) {
                    failures++;
                    failedAvatars.add(avatar);
                    continue;
                }
                rows.push({ ...row, avatar, _source: 'inventory' });
            }
        } else {
            if (result.reason?.name === 'AbortError') {
                throw result.reason;
            }
            if (!failedAvatars.has(avatar)) {
                failures++;
                failedAvatars.add(avatar);
            }
        }
    });
    return { rows, failures, failedAvatars };
}

export async function fetchDataMaidFile(ctx, token, hash, signal) {
    const query = new URLSearchParams({ token, hash });
    const response = await fetch(`/api/data-maid/view?${query}`, {
        headers: ctx.getRequestHeaders(),
        signal,
    });
    if (!response.ok) {
        throw new Error(`/api/data-maid/view failed with status ${response.status}`);
    }
    return response.text();
}
