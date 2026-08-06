import { persistIfCurrent } from "./client-orchestration.js";

export async function rethrowAfterTransactionRollback(error, {
    rollback = null,
    persistRollback = null,
    message = "Operation failed and its rollback could not be completed",
} = {}) {
    const rollbackErrors = [];
    if (typeof rollback === "function") {
        try {
            await rollback();
        } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
        }
    }
    if (typeof persistRollback === "function") {
        try {
            await persistRollback();
        } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
        }
    }
    if (rollbackErrors.length) {
        throw new AggregateError([error, ...rollbackErrors], message, { cause: error });
    }
    throw error;
}

export async function runDurableTransaction({
    mutate,
    persist,
    validate = null,
    rollback,
    persistRollback,
    rollbackFailureMessage,
}) {
    if (typeof mutate !== "function" || typeof persist !== "function" || typeof rollback !== "function") {
        throw new TypeError("Durable transactions require mutate, persist, and rollback callbacks");
    }
    if (validate != null && typeof validate !== "function") {
        throw new TypeError("Durable transaction validation must be a function");
    }
    const compensate = persistRollback === undefined ? persist : persistRollback;

    try {
        const result = await mutate();
        await persist();
        await validate?.();
        return result;
    } catch (error) {
        await rethrowAfterTransactionRollback(error, {
            rollback,
            persistRollback: compensate,
            message: rollbackFailureMessage,
        });
    }
}

export function removeInsertedMessage(chat, message, expectedIndex) {
    if (!Array.isArray(chat)) return -1;
    const index = chat[expectedIndex] === message ? expectedIndex : chat.lastIndexOf(message);
    if (index < 0) return -1;
    chat.splice(index, 1);
    return index;
}

export async function persistLockedBackgroundState(context, {
    cssUrl,
    path = "",
    validate = null,
    isCurrent = null,
} = {}) {
    const metadata = context?.chatMetadata;
    if (!metadata || typeof metadata !== "object") {
        throw new Error("No active chat metadata available");
    }
    if (typeof context.saveMetadata !== "function") {
        throw new Error("Immediate chat metadata persistence is unavailable");
    }
    if (isCurrent != null && typeof isCurrent !== "function") {
        throw new TypeError("Locked background identity validation must be a function");
    }
    const checkCurrent = isCurrent || (() => true);
    const staleMessage = "Locked background chat changed";
    if (!checkCurrent()) throw new DOMException(staleMessage, "AbortError");

    const previous = ["custom_background", "chat_backgrounds"].map(key => ({
        key,
        present: Object.prototype.hasOwnProperty.call(metadata, key),
        value: metadata[key],
    }));
    const persist = (skipIfStale = false) => persistIfCurrent({
        persist: () => context.saveMetadata(),
        isCurrent: checkCurrent,
        skipIfStale,
        staleMessage,
        failureMessage: "Chat metadata persistence reported failure",
    });

    return runDurableTransaction({
        mutate: () => {
            metadata.custom_background = cssUrl;
            if (path) {
                const backgrounds = Array.isArray(metadata.chat_backgrounds) ? [...metadata.chat_backgrounds] : [];
                if (!backgrounds.includes(path)) backgrounds.push(path);
                metadata.chat_backgrounds = backgrounds;
            }
            return true;
        },
        persist: () => persist(),
        validate: () => {
            if (!checkCurrent()) throw new DOMException(staleMessage, "AbortError");
            return validate?.();
        },
        rollback: () => {
            for (const entry of previous) {
                if (entry.present) metadata[entry.key] = entry.value;
                else delete metadata[entry.key];
            }
        },
        persistRollback: () => persist(true),
        rollbackFailureMessage: "Locked background metadata failed and its rollback could not be persisted",
    });
}
