export const MAX_BATCH_COUNT = 10;
const RESULT_FAILURES = Symbol("qigResultFailures");

export function attachResultFailures(results, failures) {
    if (!Array.isArray(results) || !Array.isArray(failures) || !failures.length) return results;
    Object.defineProperty(results, RESULT_FAILURES, {
        value: failures,
        configurable: true,
    });
    return results;
}

export function getResultFailures(results) {
    return Array.isArray(results) && Array.isArray(results[RESULT_FAILURES])
        ? results[RESULT_FAILURES]
        : [];
}

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
            if (Array.isArray(result)) {
                results.push(...result.filter(item => item != null));
                for (const failure of getResultFailures(result)) {
                    const error = failure?.error || failure;
                    errors.push({ index, outputIndex: failure?.index, error });
                    if (typeof onError === "function") onError(error, index, batchCount);
                }
            } else if (result != null) results.push(result);
        } catch (error) {
            if (error?.name === "AbortError") throw error;
            errors.push({ index, error });
            if (typeof onError === "function") onError(error, index, batchCount);
        }
    }

    if (results.length === 0 && errors.length > 0) throw errors[0].error;
    return { results, errors };
}

export async function collectSequentialResults(items, task) {
    const results = [];
    const errors = [];
    for (const [index, item] of items.entries()) {
        try {
            const result = await task(item, index);
            if (result != null) results.push(result);
        } catch (error) {
            if (error?.name === "AbortError") throw error;
            errors.push({ index, error });
        }
    }
    return { results, errors };
}
