export const MAX_BATCH_COUNT = 10;

export function clampChatMessageIndex(index, chatLength) {
    if (!Number.isFinite(chatLength) || chatLength <= 0) return null;
    if (index == null || (typeof index === "string" && index.trim() === "")) return null;
    const numeric = Number(index);
    if (!Number.isFinite(numeric)) return null;
    return Math.max(0, Math.min(Math.trunc(numeric), chatLength - 1));
}

export function normalizeBatchCount(value, max = MAX_BATCH_COUNT) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 1;
    return Math.max(1, Math.min(Math.trunc(numeric), max));
}

export async function collectBatchResults(count, task, onError = null) {
    const results = [];
    const errors = [];
    const batchCount = normalizeBatchCount(count);

    for (let index = 0; index < batchCount; index++) {
        try {
            const result = await task(index, batchCount);
            if (result != null) results.push(result);
        } catch (error) {
            if (error?.name === "AbortError") throw error;
            errors.push({ index, error });
            if (typeof onError === "function") onError(error, index, batchCount);
        }
    }

    if (results.length === 0 && errors.length > 0) throw errors[0].error;
    return { results, errors };
}
