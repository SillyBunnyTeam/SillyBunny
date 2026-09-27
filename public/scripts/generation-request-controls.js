import { isKimiK3Model } from './openai-model-capabilities.js';

function positiveLimit(value) {
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 0;
}

export function requestUsesReasoning(data) {
    if (Array.isArray(data.model)) {
        return data.model.some(model => typeof model === 'string' && requestUsesReasoning({ ...data, model }));
    }
    const model = String(data.model ?? '').toLowerCase();
    const effort = String(data.reasoning?.effort ?? data.reasoning_effort ?? '').toLowerCase();
    const thinking = data.thinking;
    const thinkingConfig = data.thinkingConfig ?? data.generationConfig?.thinkingConfig;

    if (thinking === false || thinking?.type === 'disabled' || data.reasoning === false || data.reasoning?.enabled === false || data.think === false
        || thinkingConfig?.thinkingBudget === 0 || data.enable_thinking === false) {
        return false;
    }
    if (thinking === true || data.think === true || data.reasoning === true || ['enabled', 'adaptive'].includes(thinking?.type)
        || positiveLimit(thinking?.budget_tokens) || data.reasoning?.enabled === true
        || positiveLimit(data.reasoning?.max_tokens) || data.enable_thinking === true
        || thinkingConfig?.thinkingBudget > 0 || thinkingConfig?.thinkingBudget === -1 || thinkingConfig?.thinkingLevel) {
        return true;
    }
    if (/non[-_ ]?(?:reasoning|thinking)|gpt-5(?:\.\d+)?-chat/.test(model)) {
        return false;
    }

    // These models reason even when the host's default effort is 'none' (unsent).
    if (isKimiK3Model(model) || /(?:^|[/:])o[134](?:[-/:]|$)|gpt-6-astra|gpt-oss|grok-(?:3-mini|4|code)|deepseek[-_](?:r1|reasoner|v4)|qwq|qvq|magistral|(?:^|[-_/:])(?:reasoner|reasoning|thinking)(?:[-_/:]|$)/.test(model)) {
        return true;
    }
    if (/gemini-(?:2\.5|3)/.test(model)) {
        return !(effort === 'min' && /gemini-2\.5-flash/.test(model));
    }
    if (data.chat_completion_source === 'moonshot' && /kimi-k2\.5/.test(model)) {
        return Boolean(data.include_reasoning);
    }
    if (data.chat_completion_source === 'zai' && /glm-(?:4\.[5-9]|5)/.test(model)) {
        return /glm-5\.3/.test(model) || Boolean(data.include_reasoning);
    }
    if (effort === 'none' || effort === 'disabled') {
        return false;
    }
    if (/(?:^|[/:])gpt-5|(?:reasoner|reasoning|thinking)|qwen3(?!.*instruct)|glm-(?:4\.[5-9]|5)|kimi-k2\.5/.test(model)) {
        return true;
    }

    // include_reasoning alone only controls visibility, not a model's thinking budget.
    const ordinaryModel = /(?:^|[/:])gpt-[34]|deepseek-chat|claude-(?:3-[0-5]|instant|2)/.test(model);
    return !ordinaryModel && ['min', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort);
}

export function applyGenerationRequestControls(data, { maxOutputTokens, responseLength, preserveReasoningBudget = false, model = data.model, reasoning } = {}) {
    const cap = positiveLimit(maxOutputTokens);
    const response = positiveLimit(responseLength);
    if (!cap && !response) {
        return data;
    }
    reasoning ??= requestUsesReasoning({ ...data, model: data.model || model });
    const override = !preserveReasoningBudget || !reasoning ? response : 0;
    const limit = reasoning ? 0 : cap;
    if (!override && !limit) {
        return data;
    }

    const result = { ...data };
    const fields = ['max_tokens', 'max_completion_tokens', 'max_new_tokens', 'max_length', 'n_predict', 'num_predict', 'max_output_tokens'];
    const present = fields.filter(key => Object.hasOwn(data, key) && data[key] !== undefined);
    if (!present.length) {
        present.push('max_tokens');
    }
    for (const key of present) {
        const budget = override || positiveLimit(Number(data[key]));
        result[key] = limit ? Math.min(budget || limit, limit) : budget;
    }
    if (data.options && Object.hasOwn(data.options, 'num_predict')) {
        const budget = override || positiveLimit(Number(data.options.num_predict));
        result.options = { ...data.options, num_predict: limit ? Math.min(budget || limit, limit) : budget };
    }
    const max = Math.min(...present.map(key => result[key]));
    for (const key of ['min_tokens', 'min_length', 'minimum_message_content_tokens']) {
        if (Number(data[key]) > max) {
            result[key] = max;
        }
    }
    return result;
}

export function isGenerationLengthFinish(data) {
    const choice = Array.isArray(data?.choices) ? data.choices.find(choice => choice && !choice.index) : null;
    const reason = choice?.finish_reason
        ?? data?.delta?.stop_reason ?? data?.stop_reason
        ?? data?.candidates?.[0]?.finishReason ?? data?.done_reason;
    return ['length', 'max_tokens', 'MAX_TOKENS'].includes(reason) || data?.stopped_limit === true;
}

export function limitGenerationProse(text, maxOutputTokens, template, reasoningPrefix = '', isStreaming = false) {
    const cap = positiveLimit(maxOutputTokens);
    if (!cap) {
        return { text, reasoning: '', limited: false };
    }

    const templates = [template, ...['think', 'thinking', 'thought'].map(tag => ({ prefix: `<${tag}>`, suffix: `</${tag}>` }))]
        .filter(item => item?.prefix && item?.suffix);
    let content = reasoningPrefix + text;
    const reasoning = [];
    while (content) {
        const next = templates.map(item => ({ ...item, index: content.indexOf(item.prefix) }))
            .filter(item => item.index >= 0).sort((a, b) => a.index - b.index)[0];
        if (!next) {
            break;
        }
        const end = content.indexOf(next.suffix, next.index + next.prefix.length);
        if (end < 0) {
            // Match ReasoningHandler's incomplete-block handling without regexing every thinking token.
            reasoning.push(content.slice(next.index + next.prefix.length));
            content = content.slice(0, next.index);
            break;
        }
        // Keep whitespace until continuation prefixes have been removed by the caller.
        reasoning.push(content.slice(next.index + next.prefix.length, end));
        content = content.slice(0, next.index) + content.slice(end + next.suffix.length);
    }
    // A partially received opening tag is not prose yet.
    let partialTagLength = 0;
    for (const { prefix } of templates) {
        for (let length = isStreaming ? Math.min(prefix.length - 1, content.length) : 0; length > 0; length--) {
            if (content.endsWith(prefix.slice(0, length))) {
                partialTagLength = Math.max(partialTagLength, length);
                break;
            }
        }
    }
    if (partialTagLength) {
        content = content.slice(0, -partialTagLength);
    }

    // SillyBunny/ponytail: four characters per prose token; use a local tokenizer if exact accounting is needed.
    const maxCharacters = cap * 4;
    let accepted = content.slice(0, maxCharacters);
    if (accepted.length < content.length && /[\uD800-\uDBFF]$/.test(accepted)) {
        accepted = accepted.slice(0, -1);
    }
    return { text: accepted, reasoning: reasoning.filter(Boolean).join('\n\n'), limited: content.length >= maxCharacters };
}
