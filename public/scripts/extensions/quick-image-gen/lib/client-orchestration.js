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
    return JSON.parse(JSON.stringify(value));
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

export function isGeneratedImageMessage(message) {
    if (!message || message.is_user) return false;
    if (message.extra?.inline_image === true) return true;
    const media = message.extra?.media;
    return Array.isArray(media) && media.length > 0
        && media.every(item => item?.source === "generated" || item?.source === "context-media");
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

export function normalizePromptHistory(value, maxEntries = 50) {
    if (!Array.isArray(value)) return [];
    const limit = Number.isSafeInteger(maxEntries) && maxEntries >= 0 ? maxEntries : 50;
    return value
        .filter(entry => entry && typeof entry === "object" && typeof entry.prompt === "string" && entry.prompt.trim())
        .map(entry => ({
            prompt: entry.prompt,
            negative: typeof entry.negative === "string" ? entry.negative : "",
            time: typeof entry.time === "string" ? entry.time : "",
        }))
        .slice(0, limit);
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
