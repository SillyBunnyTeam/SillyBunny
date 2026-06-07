export const TOOL_CALL_RECURSE_LIMIT_DEFAULT = 5;
export const TOOL_CALL_RECURSE_LIMIT_MIN = 1;
export const TOOL_CALL_RECURSE_LIMIT_MAX = 50;

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function normalizeToolCallRecurseLimit(value, fallback = TOOL_CALL_RECURSE_LIMIT_DEFAULT) {
    const parsed = Number.parseInt(String(value), 10);
    const fallbackValue = Number.isFinite(fallback) ? fallback : TOOL_CALL_RECURSE_LIMIT_DEFAULT;
    const nextValue = Number.isFinite(parsed) ? parsed : fallbackValue;

    return Math.min(TOOL_CALL_RECURSE_LIMIT_MAX, Math.max(TOOL_CALL_RECURSE_LIMIT_MIN, nextValue));
}
