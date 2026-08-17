export function createPromiseQueue() {
    let tail = Promise.resolve();
    return function enqueue(task) {
        const operation = tail.catch(() => {}).then(task);
        tail = operation.catch(() => {});
        return operation;
    };
}

export function createLatestWinsAsyncRunner() {
    const enqueue = createPromiseQueue();
    let revision = 0;
    return function run(task) {
        const currentRevision = ++revision;
        return enqueue(() => task(() => currentRevision === revision));
    };
}

function abortError(signal, message = "Operation cancelled") {
    if (signal?.reason instanceof Error) return signal.reason;
    return new DOMException(message, "AbortError");
}

async function settleAfterAbortableOperation(operation, signal) {
    const value = await operation;
    if (signal?.aborted) throw abortError(signal);
    return value;
}

export function createAbortableSerializedRunner() {
    let tail = Promise.resolve();
    return function run(task, signal = null) {
        if (signal?.aborted) return Promise.reject(abortError(signal));
        let cancelledWhileQueued = false;
        let started = false;
        let settled = false;
        let resolveCaller;
        let rejectCaller;
        const caller = new Promise((resolve, reject) => {
            resolveCaller = resolve;
            rejectCaller = reject;
        });
        const onAbort = () => {
            if (!started) cancelledWhileQueued = true;
            if (!settled) {
                settled = true;
                rejectCaller(abortError(signal));
            }
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        const operation = tail.catch(() => {}).then(async () => {
            if (cancelledWhileQueued) return undefined;
            started = true;
            return task();
        });
        tail = operation.catch(() => {});
        operation.then(
            value => {
                if (settled) return;
                settled = true;
                resolveCaller(value);
            },
            error => {
                if (settled) return;
                settled = true;
                rejectCaller(error);
            },
        ).finally(() => signal?.removeEventListener("abort", onAbort));
        return caller;
    };
}

export function restorePropertyIfUnchanged(target, key, expectedValue, previousValue, hadPrevious = true) {
    if (!target || target[key] !== expectedValue) return false;
    if (hadPrevious) target[key] = previousValue;
    else delete target[key];
    return true;
}

function cloneRecord(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

const MUTABLE_MESSAGE_KEYS = Object.freeze(["mes", "extra", "swipes", "swipe_id"]);

export function snapshotMutableMessageState(message) {
    if (!message || typeof message !== "object") return null;
    return MUTABLE_MESSAGE_KEYS.map(key => ({
        key,
        present: Object.prototype.hasOwnProperty.call(message, key),
        value: cloneRecord(message[key]),
    }));
}

export function restoreMutableMessageState(message, snapshot) {
    if (!message || typeof message !== "object" || !Array.isArray(snapshot)) return false;
    for (const entry of snapshot) {
        if (!entry || !MUTABLE_MESSAGE_KEYS.includes(entry.key)) continue;
        if (entry.present) message[entry.key] = cloneRecord(entry.value);
        else delete message[entry.key];
    }
    return true;
}

async function sendClonedConnectionProfileRequest({
    service,
    context,
    profile,
    messages,
    maxTokens,
    signal,
}) {
    const selectedApiMap = service.validateProfile(profile);
    if (selectedApiMap.selected === "openai") {
        if (!selectedApiMap.source || typeof context?.ChatCompletionService?.processRequest !== "function") return null;
        const request = {
            stream: false,
            messages,
            max_tokens: maxTokens,
            model: profile.model,
            chat_completion_source: selectedApiMap.source,
            secret_id: profile["secret-id"],
        };
        const endpointFields = {
            custom: "custom_url",
            vertexai: "vertexai_region",
            zai: "zai_endpoint",
            siliconflow: "siliconflow_endpoint",
            minimax: "minimax_endpoint",
        };
        const endpointField = endpointFields[selectedApiMap.source];
        if (endpointField && profile["api-url"]) request[endpointField] = profile["api-url"];
        else if (!endpointField && profile["api-url"]) {
            throw new Error("This Connection Manager profile routes through an endpoint that cannot be isolated for a preset override");
        }
        return {
            supported: true,
            value: await context.ChatCompletionService.processRequest(
                request,
                { presetName: profile.preset },
                true,
                signal,
            ),
        };
    }
    if (selectedApiMap.selected === "textgenerationwebui") {
        if (!selectedApiMap.type || typeof context?.TextCompletionService?.processRequest !== "function") return null;
        return {
            supported: true,
            value: await context.TextCompletionService.processRequest({
                stream: false,
                prompt: messages,
                max_tokens: maxTokens,
                model: profile.model,
                api_type: selectedApiMap.type,
                api_server: profile["api-url"],
                secret_id: profile["secret-id"],
            }, {
                instructName: profile.instruct,
                presetName: profile.preset,
            }, true, signal),
        };
    }
    return null;
}

// Recent chat turns for a standalone Text AI request: up to `depth` messages ending at
// `throughIndex` (the scene being illustrated), oldest first, so a request made from an
// older message does not drag later chat in as "the conversation so far".
// `formatMessage` returns { role, content } or null to skip a message; skipped messages
// do not count towards `depth`.
export function buildChatHistoryMessages(chat, { depth = 0, throughIndex = null, formatMessage } = {}) {
    if (!Array.isArray(chat) || typeof formatMessage !== "function") return [];
    const count = Math.max(0, Math.trunc(Number(depth) || 0));
    if (!count || !chat.length) return [];
    const last = Number.isInteger(throughIndex) ? Math.min(chat.length - 1, Math.max(0, throughIndex)) : chat.length - 1;
    const messages = [];
    for (let index = last; index >= 0 && messages.length < count; index -= 1) {
        const formatted = formatMessage(chat[index], index);
        if (formatted) messages.push(formatted);
    }
    return messages.reverse();
}

export async function sendIsolatedConnectionManagerRequest({
    service,
    context,
    profileId,
    messages,
    maxTokens,
    preset = "",
    signal = null,
}) {
    if (!service || typeof service.sendRequest !== "function") throw new Error("Connection Manager request service is unavailable");
    if (signal?.aborted) throw abortError(signal);
    const liveProfile = service.getProfile(profileId);
    const requestedPreset = String(preset || "");
    const requestOptions = { extractData: true, includePreset: true, stream: false, signal };
    if (!requestedPreset || liveProfile?.preset === requestedPreset) {
        return settleAfterAbortableOperation(service.sendRequest(profileId, messages, maxTokens, requestOptions), signal);
    }

    const clonedProfile = cloneRecord(liveProfile);
    clonedProfile.preset = requestedPreset;
    if (typeof service.sendRequestWithProfile === "function") {
        return settleAfterAbortableOperation(service.sendRequestWithProfile(clonedProfile, messages, maxTokens, requestOptions), signal);
    }
    if (typeof service.validateProfile === "function") {
        const isolated = await settleAfterAbortableOperation(sendClonedConnectionProfileRequest({
            service,
            context,
            profile: clonedProfile,
            messages,
            maxTokens,
            signal,
        }), signal);
        if (isolated?.supported) return isolated.value;
    }
    throw new Error("This Connection Manager profile does not support an isolated preset override");
}

export function createConversationCheckpoint(chat) {
    return { chat, length: Array.isArray(chat) ? chat.length : -1, ownedInsertions: [] };
}

export function isConversationCheckpointCurrent(checkpoint, currentChat = checkpoint?.chat) {
    if (!Array.isArray(checkpoint?.chat) || currentChat !== checkpoint.chat) return false;
    const ownedInsertions = Array.isArray(checkpoint.ownedInsertions) ? checkpoint.ownedInsertions : [];
    if (checkpoint.chat.length !== checkpoint.length + ownedInsertions.length) return false;
    return ownedInsertions.every((message, index) => checkpoint.chat[checkpoint.length + index] === message);
}

export function registerConversationCheckpointInsertion(checkpoint, message) {
    if (!checkpoint || !Array.isArray(checkpoint.chat) || !isGeneratedImageMessage(message)) return false;
    const ownedInsertions = Array.isArray(checkpoint.ownedInsertions) ? checkpoint.ownedInsertions : [];
    if (checkpoint.chat.length !== checkpoint.length + ownedInsertions.length + 1) return false;
    if (!ownedInsertions.every((owned, index) => checkpoint.chat[checkpoint.length + index] === owned)) return false;
    if (checkpoint.chat[checkpoint.length + ownedInsertions.length] !== message) return false;
    checkpoint.ownedInsertions.push(message);
    return true;
}

export function unregisterConversationCheckpointInsertion(checkpoint, message) {
    const index = checkpoint?.ownedInsertions?.lastIndexOf(message) ?? -1;
    if (index < 0) return false;
    checkpoint.ownedInsertions.splice(index, 1);
    return true;
}

// A QIG "generated image message" carries generated/context media and no meaningful
// text of its own: either an empty body or QIG's placeholder caption. Ordinary
// text-bearing assistant replies keep their text even when a generated image is
// attached to them.
export function isGeneratedImageMessage(message) {
    if (!message || message.is_user) return false;
    const hasGeneratedMedia = message.extra?.inline_image === true
        || (Array.isArray(message.extra?.media) && message.extra.media.length > 0
            && message.extra.media.every(item => item?.source === "generated" || item?.source === "context-media"));
    if (!hasGeneratedMedia) return false;
    const text = String(message.mes ?? "").trim();
    return !text || /^generated image$/i.test(text);
}

export function readConstrainedNumber(value, {
    previousValue,
    min = -Infinity,
    max = Infinity,
    step = null,
    stepBase = Number.isFinite(min) ? min : 0,
} = {}) {
    const raw = String(value ?? "").trim();
    const numeric = Number(raw);
    if (!raw || !Number.isFinite(numeric)) return { valid: false, value: previousValue };
    const constrained = Math.max(min, Math.min(max, numeric));
    if (Number.isFinite(step) && step > 0) {
        const steps = (constrained - stepBase) / step;
        if (Math.abs(steps - Math.round(steps)) > 1e-9) return { valid: false, value: previousValue };
    }
    return { valid: true, value: constrained };
}

export async function materializeAndValidateProviderOutput(item, {
    materialize,
    normalize,
    verify,
    release,
}) {
    let materializedUrl = "";
    try {
        materializedUrl = await materialize(item.url);
        const safeUrl = normalize(materializedUrl);
        if (!safeUrl) throw new Error("Provider returned an unsafe or unsupported image URL");
        await verify(safeUrl);
        return { ...item, url: safeUrl };
    } catch (error) {
        if (materializedUrl) release(materializedUrl);
        if (item?.url && item.url !== materializedUrl) release(item.url);
        throw error;
    }
}

export function summarizeOperationOutcomes(outcomes) {
    const entries = Array.isArray(outcomes) ? outcomes : [];
    const succeeded = entries.filter(outcome => outcome?.success === true).length;
    return { succeeded, failed: entries.length - succeeded, total: entries.length };
}

export function hasStorageKey(storage, key) {
    try {
        return storage?.getItem?.(key) != null;
    } catch {
        return false;
    }
}

export async function applyStateBeforePersistence({ apply, persist, rollback }) {
    apply();
    try {
        const saved = await persist();
        if (saved) return true;
        rollback();
        return false;
    } catch (error) {
        rollback();
        throw error;
    }
}

export async function persistIfCurrent({
    persist,
    isCurrent = null,
    skipIfStale = false,
    staleMessage = "Persistence target changed",
    failureMessage = "Persistence reported failure",
} = {}) {
    if (typeof persist !== "function") throw new TypeError("A persistence callback is required");
    if (isCurrent != null && typeof isCurrent !== "function") {
        throw new TypeError("Persistence identity validation must be a function");
    }
    const checkCurrent = isCurrent || (() => true);
    if (!checkCurrent()) {
        if (skipIfStale) return false;
        throw new DOMException(staleMessage, "AbortError");
    }

    const saved = await persist();
    if (saved === false) throw new Error(failureMessage);
    if (!checkCurrent()) throw new DOMException(staleMessage, "AbortError");
    return true;
}

export async function rethrowAfterRollbackPersistence(error, persist, message = "Operation failed and rollback could not be persisted") {
    try {
        await persist?.();
    } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], message, { cause: error });
    }
    throw error;
}

export function normalizeMessageSourceIdentity(value = {}, fallback = {}) {
    const chatId = typeof value?.sourceChatId === "string"
        ? value.sourceChatId
        : (typeof fallback?.sourceChatId === "string" ? fallback.sourceChatId : "");
    const messageId = typeof value?.sourceMessageId === "string"
        ? value.sourceMessageId
        : (typeof fallback?.sourceMessageId === "string" ? fallback.sourceMessageId : "");
    const signature = typeof value?.sourceMessageSignature === "string"
        ? value.sourceMessageSignature
        : (typeof fallback?.sourceMessageSignature === "string" ? fallback.sourceMessageSignature : "");
    const indexCandidate = Number.isSafeInteger(value?.sourceMessageIndex)
        ? value.sourceMessageIndex
        : fallback?.sourceMessageIndex;
    return {
        sourceMessageIndex: (messageId || signature) && Number.isSafeInteger(indexCandidate) && indexCandidate >= 0 ? indexCandidate : null,
        sourceChatId: chatId,
        sourceMessageId: messageId,
        sourceMessageSignature: signature,
    };
}

export const MAX_PROMPT_HISTORY_PROMPT_LENGTH = 16_384;
export const MAX_PROMPT_HISTORY_NEGATIVE_LENGTH = 16_384;
export const MAX_PROMPT_HISTORY_SERIALIZED_LENGTH = 256 * 1024;

export function createAccountStorageScope(syncCacheId) {
    if (typeof syncCacheId !== "string" || !syncCacheId || syncCacheId.length > 512) return null;
    let namespace = "";
    for (let index = 0; index < syncCacheId.length; index++) {
        namespace += syncCacheId.charCodeAt(index).toString(16).padStart(4, "0");
    }
    return Object.freeze({
        galleryDbName: `qig-gallery-account-${namespace}`,
        galleryManifestKey: `qig_gallery_manifest_v2:${namespace}`,
        galleryLegacyKey: `qig_gallery:${namespace}`,
        promptHistoryKey: `qig_prompt_history:${namespace}`,
    });
}

export function normalizePromptHistory(value, maxEntries = 50) {
    if (!Array.isArray(value)) return [];
    const limit = Number.isSafeInteger(maxEntries) && maxEntries >= 0 ? maxEntries : 50;
    if (limit === 0) return [];
    const normalized = [];
    let serializedLength = 2;
    for (const entry of value) {
        if (!entry || typeof entry !== "object" || typeof entry.prompt !== "string") continue;
        const prompt = entry.prompt.slice(0, MAX_PROMPT_HISTORY_PROMPT_LENGTH);
        if (!prompt.trim()) continue;
        const normalizedEntry = {
            prompt,
            negative: typeof entry.negative === "string"
                ? entry.negative.slice(0, MAX_PROMPT_HISTORY_NEGATIVE_LENGTH)
                : "",
            time: typeof entry.time === "string" ? entry.time.slice(0, 128) : "",
        };
        const entryLength = JSON.stringify(normalizedEntry).length;
        const nextLength = serializedLength + entryLength + (normalized.length ? 1 : 0);
        if (nextLength > MAX_PROMPT_HISTORY_SERIALIZED_LENGTH) break;
        normalized.push(normalizedEntry);
        serializedLength = nextLength;
        if (normalized.length >= limit) break;
    }
    return normalized;
}

function isStorageQuotaError(error) {
    return error?.name === "QuotaExceededError"
        || error?.name === "NS_ERROR_DOM_QUOTA_REACHED"
        || error?.code === 22
        || error?.code === 1014;
}

export function persistPromptHistory(storage, key, value) {
    const history = normalizePromptHistory(value);
    if (typeof key !== "string" || !key) {
        return { saved: false, history, error: new Error("Prompt history storage identity is unavailable") };
    }
    if (!history.length) {
        return { saved: true, history, error: null };
    }

    let candidate = history;
    let lastError = null;
    while (candidate.length > 0) {
        try {
            storage.setItem(key, JSON.stringify(candidate));
            return { saved: true, history: candidate, error: null };
        } catch (error) {
            lastError = error;
            if (!isStorageQuotaError(error)) break;
            candidate = candidate.slice(0, -1);
        }
    }

    // Do not write an empty array after a non-empty candidate fails: setItem is atomic,
    // so leaving the key untouched preserves the last successfully stored history.
    return { saved: false, history, error: lastError };
}

const CHARACTER_REFERENCE_ARRAY_KEYS = Object.freeze({
    proxy: "proxyRefImages",
    custom: "customApiRefImages",
    nanobanana: "nanobananaRefImages",
    nanogpt: "nanogptRefImages",
});

export function normalizeCharacterReferenceRecord(value, legacyProvider = "") {
    if (Array.isArray(value)) {
        const key = CHARACTER_REFERENCE_ARRAY_KEYS[legacyProvider];
        return key && value.length ? { [key]: [...value] } : {};
    }
    if (!value || typeof value !== "object") return {};

    const normalized = {};
    for (const key of Object.values(CHARACTER_REFERENCE_ARRAY_KEYS)) {
        if (Array.isArray(value[key]) && value[key].length) normalized[key] = [...value[key]];
    }
    if (typeof value.localRefImage === "string" && value.localRefImage) {
        normalized.localRefImage = value.localRefImage;
    }
    return normalized;
}

export function getCharacterProviderReferences(record, provider) {
    const normalized = normalizeCharacterReferenceRecord(record);
    if (provider === "local") return normalized.localRefImage || "";
    const key = CHARACTER_REFERENCE_ARRAY_KEYS[provider];
    return key ? [...(normalized[key] || [])] : [];
}

export function hasCharacterReferenceOverrides(record) {
    return Object.keys(normalizeCharacterReferenceRecord(record)).length > 0;
}

export function setCharacterProviderReferences(record, provider, references) {
    const normalized = normalizeCharacterReferenceRecord(record);
    if (provider === "local") {
        const value = typeof references === "string" ? references : "";
        if (value) normalized.localRefImage = value;
        else delete normalized.localRefImage;
        return normalized;
    }

    const key = CHARACTER_REFERENCE_ARRAY_KEYS[provider];
    if (!key) return normalized;
    const values = Array.isArray(references) ? [...references] : [];
    if (values.length) normalized[key] = values;
    else delete normalized[key];
    return normalized;
}
