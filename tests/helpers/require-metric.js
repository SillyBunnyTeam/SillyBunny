/**
 * Reads a number from a measurement result for a budget assertion. A value that is missing, null or not finite throws
 * an error that names the metric. Without this, a failed CDP session or a renamed counter reads as a default of zero,
 * and a zero passes every upper bound.
 * @param {object | null | undefined} measurement The result of a `measure*` helper
 * @param {string} metricPath Dot path inside the measurement, for example `cdp.recalcStyleCount`
 * @param {string} label What was measured, for the error message
 * @returns {number}
 */
export function requireMetric(measurement, metricPath, label) {
    const value = metricPath.split('.').reduce((current, key) => current?.[key], measurement);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label}: metric "${metricPath}" is missing (got ${String(value)}), so its budget cannot be checked.`);
    }
    return value;
}
