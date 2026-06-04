/**
 * Determines whether a prompt-ready chat payload needs a post-mutation budget recount.
 *
 * @param {object} eventData CHAT_COMPLETION_PROMPT_READY event payload.
 * @returns {boolean}
 */
export function shouldCheckPostInterceptChatBudget(eventData) {
    return eventData?.chatChanged === true;
}

/**
 * Recounts a finalized chat-completion payload against the prompt budget.
 *
 * @param {object[]} chat Final chat-completion messages.
 * @param {object} userSettings Chat-completion settings.
 * @param {(chat: object[]) => Promise<number>|number} countTokens Token counter for the payload.
 * @returns {Promise<{promptTokens: number, promptTokenBudget: number, exceeded: boolean}>}
 */
export async function checkPostInterceptChatBudget(chat, userSettings = {}, countTokens) {
    if (!Array.isArray(chat)) {
        throw new TypeError('Post-intercept chat payload must be an array.');
    }

    if (typeof countTokens !== 'function') {
        throw new TypeError('Post-intercept chat budget check requires a token counter.');
    }

    const promptTokenBudget = Number(userSettings?.openai_max_context) - Number(userSettings?.openai_max_tokens);
    const promptTokens = await countTokens(chat);

    return {
        promptTokens,
        promptTokenBudget,
        exceeded: Number.isFinite(promptTokenBudget) && Number.isFinite(promptTokens) && promptTokens > promptTokenBudget,
    };
}
