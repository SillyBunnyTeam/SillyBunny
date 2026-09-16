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
