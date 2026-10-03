/**
 * SillyBunny: turns the bytes a generation endpoint sent to the browser back into reply text, for
 * replies the server commits itself (see generation-commit.js). Parsing goes by payload shape, not
 * by the selected source, because one source can relay several wire formats.
 *
 * Mirrors the browser parsers: getStreamingReply (openai.js), the text-completions/Kobold/NovelAI
 * stream readers, extractMessageFromData (script.js) and extractReasoningFromData (reasoning.js).
 */

/**
 * @param {unknown} value Text, or an array of text parts
 * @returns {string}
 */
function partsText(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(part => typeof part === 'string' ? part : (part?.type === 'thinking' ? '' : typeof part?.text === 'string' ? part.text : '')).join('');
    }
    return '';
}

/**
 * @param {unknown} value Mistral-style content array
 * @returns {string}
 */
function thinkingPartsText(value) {
    if (!Array.isArray(value)) {
        return '';
    }
    return value
        .filter(part => part?.type === 'thinking')
        .map(part => Array.isArray(part.thinking) ? part.thinking.map(x => x?.text ?? '').join('') : String(part.thinking ?? ''))
        .join('');
}

/**
 * @param {any} parts Gemini content parts
 * @param {boolean} thought Whether to collect thought parts
 * @returns {string}
 */
function geminiPartsText(parts, thought) {
    if (!Array.isArray(parts)) {
        return '';
    }
    return parts.filter(part => Boolean(part?.thought) === thought && typeof part?.text === 'string').map(part => part.text).join('');
}

/**
 * @param {any} data One parsed stream event
 * @returns {{ text: string, reasoning: string, error: boolean }}
 */
function parseStreamEvent(data) {
    const empty = { text: '', reasoning: '', error: false };
    if (!data || typeof data !== 'object') {
        return empty;
    }
    if (data.error) {
        return { ...empty, error: true };
    }

    if (Array.isArray(data.choices)) {
        const choice = data.choices[0];
        // Extra choices are extra swipes; the committed reply is the first one.
        if (!choice || Number(choice.index) > 0) {
            return empty;
        }
        const delta = choice.delta ?? {};
        const content = delta.content ?? choice.message?.content ?? choice.text ?? '';
        return {
            text: partsText(content),
            reasoning: String(delta.reasoning_content ?? delta.reasoning ?? choice.message?.reasoning ?? choice.reasoning ?? choice.thinking ?? '')
                + thinkingPartsText(Array.isArray(content) ? content : null),
            error: false,
        };
    }
    if (Array.isArray(data.candidates)) {
        const parts = data.candidates[0]?.content?.parts;
        return { text: geminiPartsText(parts, false), reasoning: geminiPartsText(parts, true), error: false };
    }
    if (data.delta && typeof data.delta === 'object') {
        // Anthropic content_block_delta, Cohere content-delta.
        return {
            text: String(data.delta.text ?? data.delta.message?.content?.text ?? ''),
            reasoning: String(data.delta.thinking ?? ''),
            error: false,
        };
    }
    if (typeof data.token === 'string') {
        return { text: data.token, reasoning: '', error: false };
    }
    if (typeof data.content === 'string' && !(Number(data.index) > 0)) {
        return { text: data.content, reasoning: String(data.thinking ?? ''), error: false };
    }
    return empty;
}

/**
 * @param {string} body Server-sent events
 * @returns {{ text: string, reasoning: string, error: boolean }}
 */
function parseEventStream(body) {
    let text = '';
    let reasoning = '';
    let error = false;
    for (const line of body.split(/\r?\n/)) {
        if (!line.startsWith('data:')) {
            continue;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') {
            continue;
        }
        let data;
        try {
            data = JSON.parse(payload);
        } catch {
            continue;
        }
        const event = parseStreamEvent(data);
        text += event.text;
        reasoning += event.reasoning;
        error ||= event.error;
    }
    return { text, reasoning, error };
}

/**
 * @param {any} data Complete response JSON
 * @returns {{ text: string, reasoning: string, error: boolean }}
 */
function parseCompleteResponse(data) {
    if (Array.isArray(data)) {
        data = data[0];
    }
    if (!data || typeof data !== 'object') {
        return { text: typeof data === 'string' ? data : '', reasoning: '', error: false };
    }
    if (data.error) {
        return { text: '', reasoning: '', error: true };
    }

    const message = data.choices?.[0]?.message;
    const geminiParts = data.responseContent?.parts ?? data.candidates?.[0]?.content?.parts;
    const contentBlocks = Array.isArray(data.content) ? data.content : null;
    const text = (contentBlocks ? contentBlocks.filter(part => part?.type === 'text').map(part => part.text).join('\n\n') : '')
        || partsText(message?.content)
        || partsText(data.choices?.[0]?.text)
        || partsText(data.results?.[0]?.text)
        || partsText(data.output)
        || partsText(data.text)
        || partsText(data.message?.content)
        || partsText(data.message?.tool_plan)
        || geminiPartsText(geminiParts, false)
        || partsText(typeof data.content === 'string' ? data.content : '')
        || partsText(data.response);
    const reasoning = String(message?.reasoning_content ?? message?.reasoning ?? data.choices?.[0]?.reasoning ?? data.thinking ?? '')
        || (contentBlocks ? contentBlocks.filter(part => part?.type === 'thinking').map(part => part.thinking).join('\n\n') : '')
        || thinkingPartsText(message?.content)
        || geminiPartsText(geminiParts, true);
    return { text, reasoning, error: false };
}

/**
 * Extracts the reply from what a generation endpoint wrote.
 * @param {Buffer} body Every byte the endpoint wrote
 * @param {string|null} contentType Response content type
 * @returns {{ text: string, reasoning: string, error: boolean }}
 */
export function parseGenerationReply(body, contentType) {
    const serialized = body.toString('utf8');
    const trimmed = serialized.trimStart();
    if (String(contentType ?? '').includes('text/event-stream') || trimmed.startsWith('data:') || trimmed.startsWith('event:')) {
        return parseEventStream(serialized);
    }
    try {
        return parseCompleteResponse(JSON.parse(serialized));
    } catch {
        return { text: '', reasoning: '', error: true };
    }
}
