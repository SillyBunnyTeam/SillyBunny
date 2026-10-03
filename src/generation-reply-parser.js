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
 * @returns {{ text: string, reasoning: string, error: boolean, index: number }} `index` above 0 is an extra swipe
 */
function parseStreamEvent(data) {
    const empty = { text: '', reasoning: '', error: false, index: 0 };
    if (!data || typeof data !== 'object') {
        return empty;
    }
    if (data.error) {
        return { ...empty, error: true };
    }

    if (Array.isArray(data.choices)) {
        const choice = data.choices[0];
        if (!choice) {
            return empty;
        }
        const index = Math.max(0, Math.trunc(Number(choice.index) || 0));
        const delta = choice.delta ?? {};
        const content = delta.content ?? choice.message?.content ?? choice.text ?? '';
        return {
            text: partsText(content),
            reasoning: String(delta.reasoning_content ?? delta.reasoning ?? choice.message?.reasoning ?? choice.reasoning ?? choice.thinking ?? '')
                + thinkingPartsText(Array.isArray(content) ? content : null),
            error: false,
            index,
        };
    }
    if (Array.isArray(data.candidates)) {
        const parts = data.candidates[0]?.content?.parts;
        return { ...empty, text: geminiPartsText(parts, false), reasoning: geminiPartsText(parts, true) };
    }
    if (data.delta && typeof data.delta === 'object') {
        // Anthropic content_block_delta, Cohere content-delta.
        return { ...empty, text: String(data.delta.text ?? data.delta.message?.content?.text ?? ''), reasoning: String(data.delta.thinking ?? '') };
    }
    if (typeof data.token === 'string') {
        return { ...empty, text: data.token };
    }
    if (typeof data.content === 'string') {
        // llama.cpp numbers its parallel completions; the extras are swipes.
        return { ...empty, text: data.content, reasoning: String(data.thinking ?? ''), index: Math.max(0, Math.trunc(Number(data.index) || 0)) };
    }
    return empty;
}

/**
 * @typedef {{ text: string, reasoning: string, error: boolean, swipes: string[] }} ParsedGenerationReply
 * `swipes` are the extra completions of a multi-swipe request, after the first one.
 */

/**
 * @param {string} body Server-sent events
 * @returns {ParsedGenerationReply}
 */
function parseEventStream(body) {
    let text = '';
    let reasoning = '';
    let error = false;
    /** @type {string[]} */
    const swipes = [];
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
        error ||= event.error;
        if (event.index > 0) {
            // As in the browser, an extra swipe keeps its text only, not its reasoning.
            swipes[event.index - 1] = (swipes[event.index - 1] ?? '') + event.text;
            continue;
        }
        text += event.text;
        reasoning += event.reasoning;
    }
    return { text, reasoning, error, swipes: Array.from(swipes, swipe => swipe ?? '') };
}

/**
 * @param {any} data Complete response JSON
 * @returns {ParsedGenerationReply}
 */
function parseCompleteResponse(data) {
    // llama.cpp answers a multi-swipe request with one object per completion.
    const extras = Array.isArray(data) ? data.slice(1).map(item => partsText(item?.content)) : null;
    if (Array.isArray(data)) {
        data = data[0];
    }
    if (!data || typeof data !== 'object') {
        return { text: typeof data === 'string' ? data : '', reasoning: '', error: false, swipes: extras ?? [] };
    }
    if (data.error) {
        return { text: '', reasoning: '', error: true, swipes: [] };
    }
    const swipes = extras ?? (Array.isArray(data.choices) ? data.choices.slice(1).map(choice => partsText(choice?.message?.content) || partsText(choice?.text)) : []);

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
    return { text, reasoning, error: false, swipes };
}

/**
 * Extracts the reply from what a generation endpoint wrote.
 * @param {Buffer} body Every byte the endpoint wrote
 * @param {string|null} contentType Response content type
 * @returns {ParsedGenerationReply}
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
        return { text: '', reasoning: '', error: true, swipes: [] };
    }
}
