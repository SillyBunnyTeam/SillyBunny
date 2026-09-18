/**
 * Helper functions for safe chat reload lifecycle barriers.
 * Guards against mid-stream overwrites, lost turns, and cross-chat splice collisions.
 */

/**
 * Checks whether generation or streaming is currently in-flight.
 * @param {object} [options]
 * @param {boolean} [options.isSendPressed=false]
 * @param {boolean} [options.hasActiveGenerationRun=false]
 * @returns {boolean}
 */
export function shouldAbortReloadForActiveGeneration({ isSendPressed = false, hasActiveGenerationRun = false } = {}) {
    return Boolean(isSendPressed || hasActiveGenerationRun);
}

/**
 * Evaluates whether the cooperative abort deadline has been reached.
 * @param {object} [options]
 * @param {number} [options.elapsedMs=0]
 * @param {number} [options.timeoutMs=2500]
 * @returns {boolean}
 */
export function isAbortTimeoutExceeded({ elapsedMs = 0, timeoutMs = 2500 } = {}) {
    return elapsedMs >= timeoutMs;
}

/**
 * Determines whether chat navigation occurred during an asynchronous reload fetch.
 * @param {object} [options]
 * @param {string|null} options.initialChatId
 * @param {string|null} options.currentChatId
 * @returns {boolean}
 */
export function shouldDiscardReloadTarget({ initialChatId, currentChatId } = {}) {
    return initialChatId !== currentChatId;
}

/**
 * Fetches raw character chat data from the server without touching live state or DOM.
 * @param {object} options
 * @param {string} options.characterName
 * @param {string} options.fileName
 * @param {string} [options.avatarUrl]
 * @param {boolean} [options.allowCreate=false]
 * @param {object} [options.headers={}]
 * @param {typeof fetch} [options.fetchImpl=fetch]
 * @returns {Promise<{ messages: object[], metadata: object }>}
 */
export async function fetchChatRaw({
    characterName,
    fileName,
    avatarUrl = '',
    allowCreate = false,
    headers = {},
    fetchImpl = globalThis.fetch,
} = {}) {
    if (!characterName || !fileName) {
        throw new Error('characterName and fileName are required to fetch chat');
    }

    const response = await fetchImpl('/api/chats/get', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headers,
        },
        cache: 'no-cache',
        body: JSON.stringify({
            ch_name: characterName,
            file_name: fileName,
            avatar_url: avatarUrl,
            allow_create: allowCreate,
        }),
    });

    if (!response.ok) {
        throw new Error(`Chat could not be loaded: HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
        throw new Error('Invalid chat payload: expected array');
    }

    const payload = Array.from(data);
    let metadata = {};
    if (payload.length > 0 && Object.hasOwn(payload[0], 'chat_metadata')) {
        const header = payload.shift();
        const rawMetadata = header?.chat_metadata;
        if (rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) {
            metadata = rawMetadata;
        }
    }

    return {
        messages: payload,
        metadata,
    };
}

/**
 * Fetches raw group chat data from the server without touching live state or DOM.
 * @param {object} options
 * @param {string} options.chatId
 * @param {boolean} [options.allowCreate=false]
 * @param {object} [options.headers={}]
 * @param {typeof fetch} [options.fetchImpl=fetch]
 * @returns {Promise<{ messages: object[], metadata: object }>}
 */
export async function fetchGroupChatRaw({
    chatId,
    allowCreate = false,
    headers = {},
    fetchImpl = globalThis.fetch,
} = {}) {
    if (!chatId) {
        throw new Error('chatId is required to fetch group chat');
    }

    const response = await fetchImpl('/api/chats/group/get', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headers,
        },
        cache: 'no-cache',
        body: JSON.stringify({ id: chatId, allow_create: allowCreate }),
    });

    if (!response.ok) {
        throw new Error(`Could not load group chat ${chatId}: HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
        throw new Error(`Invalid group chat data for ${chatId}: expected array`);
    }

    const payload = Array.from(data);
    let metadata = {};
    if (payload.length > 0 && Object.hasOwn(payload[0], 'chat_metadata')) {
        const header = payload.shift();
        const rawMetadata = header?.chat_metadata;
        if (rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) {
            metadata = rawMetadata;
        }
    }

    return {
        messages: payload,
        metadata,
    };
}

/**
 * Synchronously commits an isolated staging chat into the live target chat array and metadata object.
 * @param {object} options
 * @param {{ messages: object[], metadata: object }} options.staging
 * @param {object[]} options.targetChat
 * @param {object} options.targetMetadata
 * @returns {boolean}
 */
export function commitChatStaging({ staging, targetChat, targetMetadata } = {}) {
    if (!staging || !Array.isArray(staging.messages) || !Array.isArray(targetChat)) {
        return false;
    }

    targetChat.splice(0, targetChat.length, ...staging.messages);

    if (targetMetadata && typeof targetMetadata === 'object' && !Array.isArray(targetMetadata)) {
        for (const key of Object.keys(targetMetadata)) {
            delete targetMetadata[key];
        }
        const newMetadata =
            staging.metadata && typeof staging.metadata === 'object' && !Array.isArray(staging.metadata)
                ? staging.metadata
                : {};
        Object.assign(targetMetadata, newMetadata);
    }

    return true;
}
