/**
 * Removes request parameters that are unsupported by the selected Claude model.
 *
 * @param {Record<string, any>} generateData Chat Completion request data
 * @param {object} [options] Constraint options
 * @param {boolean} [options.preserveReasoning=false] Keep reasoning fields for native Claude handlers
 * @returns {Record<string, any>} The request data
 */
export function applyClaudeModelParameterConstraints(generateData, { preserveReasoning = false } = {}) {
    const model = String(generateData?.model ?? '').trim().toLowerCase();
    const hasRestrictedSampling = /(?:^|[/:])claude-(?:fable|opus-5|sonnet-5)(?:[-./:]|$)/.test(model);

    if (!hasRestrictedSampling) {
        return generateData;
    }

    delete generateData.temperature;
    delete generateData.top_p;
    delete generateData.top_k;
    delete generateData.frequency_penalty;
    delete generateData.presence_penalty;
    if (!preserveReasoning) {
        delete generateData.reasoning_effort;
        delete generateData.custom_reasoning_param_name;
    }

    return generateData;
}
