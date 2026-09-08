import { normalizeSavedImagePath } from "./generated-image.js";
import { MAX_IMAGE_BYTES } from "./security.js";

export const MAX_BATCH_COUNT = 10;

function outputLimitError(message) {
    const error = new Error(message);
    error.code = "GENERATION_OUTPUT_LIMIT";
    return error;
}

export function reserveGenerationOutput(budget) {
    if (budget.error) throw budget.error;
    if (budget.bytes >= MAX_IMAGE_BYTES) {
        budget.error = outputLimitError(`Generation run reached the ${MAX_IMAGE_BYTES / 1024 / 1024} MiB total output limit`);
        throw budget.error;
    }
    if (budget.count >= MAX_BATCH_COUNT) {
        throw outputLimitError(`Generation run reached the ${MAX_BATCH_COUNT} output limit`);
    }
    budget.count++;
    return { budget, bytes: 0 };
}

export function accountGenerationOutputBytes(output, byteLength) {
    const additionalBytes = Math.max(0, byteLength - output.bytes);
    // Converting an already downloaded image to a data/blob URL is not another output.
    if (!additionalBytes) return;
    const { budget } = output;
    if (budget.error) throw budget.error;
    if (additionalBytes > MAX_IMAGE_BYTES - budget.bytes) {
        budget.error = outputLimitError(`Generation run outputs exceed the ${MAX_IMAGE_BYTES / 1024 / 1024} MiB total output limit`);
        throw budget.error;
    }
    budget.bytes += additionalBytes;
    output.bytes = byteLength;
}

export function limitGenerationOutputResponse(response, output) {
    if (output.budget.error) throw output.budget.error;
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (declaredLength > MAX_IMAGE_BYTES - output.budget.bytes) {
        void response.body?.cancel?.("Generation output budget exceeded").catch(() => {});
        accountGenerationOutputBytes(output, output.bytes + declaredLength);
    }
    const body = response.body?.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            accountGenerationOutputBytes(output, output.bytes + chunk.byteLength);
            controller.enqueue(chunk);
        },
    }));
    return new Response(body, {
        headers: {
            "content-type": response.headers?.get?.("content-type") || "",
            "content-length": response.headers?.get?.("content-length") || "",
        },
        status: response.status,
        statusText: response.statusText,
    });
}

/**
 * A quiet run is one another extension (or a Quick Reply) asks for and wants the picture
 * back from: one image from the given prompt, saved to the server so the path stays valid,
 * no confirmation dialog, nothing inserted into the chat and no result dialog.
 */
export function getQuietSlashOverrides(prompt) {
    return {
        prompt: String(prompt ?? ""),
        useLastMessage: false,
        autoInsert: false,
        confirmBeforeGenerate: false,
        reviewBeforeGenerate: false,
        enableParagraphPicker: false,
        batchCount: 1,
        saveToServer: true,
        __qigQuiet: true,
    };
}

/** What a quiet slash run hands back through the pipe: the saved image path, or a "QIG ..." line saying why not. */
export function formatQuietSlashResult(outcome) {
    if (outcome?.status === "busy") return "QIG: generation is already running.";
    if (outcome?.status === "cancelled") return "QIG: generation cancelled.";
    const url = Array.isArray(outcome?.urls) ? outcome.urls.map(normalizeSavedImagePath).find(Boolean) : "";
    if (url && ["success", "partial"].includes(outcome?.status)) return url;
    return `QIG failed: ${outcome?.message || "no image was produced"}`;
}
const RESULT_FAILURES = Symbol("qigResultFailures");

export function attachResultFailures(results, failures) {
    if (!results || typeof results !== "object" || !Array.isArray(failures) || !failures.length) return results;
    Object.defineProperty(results, RESULT_FAILURES, {
        value: failures,
        configurable: true,
    });
    return results;
}

export function getResultFailures(results) {
    return Array.isArray(results?.[RESULT_FAILURES])
        ? results[RESULT_FAILURES]
        : [];
}

export function createResultFailureError(failures) {
    const first = failures[0]?.error;
    const error = new AggregateError(failures.map(failure => failure.error), first?.message || String(first), { cause: first });
    if (first?.code) error.code = first.code;
    error.failedCount = failures.length;
    return attachResultFailures(error, failures);
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
            const failures = getResultFailures(error);
            for (const failure of failures.length ? failures : [{ error }]) {
                const cause = failure.error || failure;
                errors.push({
                    index,
                    ...(failure.outputIndex != null || failure.index != null ? { outputIndex: failure.outputIndex ?? failure.index } : {}),
                    error: cause,
                });
                if (typeof onError === "function") onError(cause, index, batchCount);
            }
        }
    }

    if (results.length === 0 && errors.length > 0) {
        throw createResultFailureError(errors);
    }
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
            errors.push({ index: Number.isInteger(item?.outputIndex) && item.outputIndex >= 0 ? item.outputIndex : index, error });
        }
    }
    return { results, errors };
}
