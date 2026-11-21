/**
 * Applicability of the composer Options menu's backend-specific items (DESIGN.md, Menus and Popovers, Items: omit an
 * item that does not apply). Upstream shows both items for every backend; the menu hid neither.
 */

/** Chat Completion sources that request logprobs (`logprobsSupportedSources` in `openai.js`; a unit test keeps the two lists equal). */
export const LOGPROBS_CHAT_SOURCES = Object.freeze([
    'openai', 'azure_openai', 'openrouter', 'custom', 'deepseek', 'xai', 'aimlapi', 'chutes',
]);

/**
 * @param {object} state
 * @param {string} state.mainApi `main_api`: 'textgenerationwebui', 'openai', 'novel', 'kobold' or 'koboldhorde'.
 * @param {string} [state.chatSource] `oai_settings.chat_completion_source`.
 * @param {string} [state.textgenType] `textgenerationwebui_settings.type`.
 * @param {string[]} [state.cfgTypes] The text completion types whose sampling tab has a CFG block (`data-tg-type` of `#cfg_block_ooba`).
 * @returns {{ cfg: boolean, tokenProbabilities: boolean }}
 */
export function getOptionsApplicability({ mainApi, chatSource = '', textgenType = '', cfgTypes = [] }) {
    return {
        // The CFG values reach only a text completion server that has the guidance scale (the CFG block of its sampling tab).
        cfg: mainApi === 'textgenerationwebui' && cfgTypes.includes(textgenType),
        // Every text completion request asks for logprobs, NovelAI does, and a Chat Completion source does when it is in the list.
        tokenProbabilities: mainApi === 'textgenerationwebui'
            || mainApi === 'novel'
            || (mainApi === 'openai' && LOGPROBS_CHAT_SOURCES.includes(chatSource)),
    };
}

/**
 * Shows or hides CFG Scale and Token Probabilities for the backend that is selected now.
 * @param {ParentNode} root The document or the menu.
 * @param {{ mainApi: string, chatCompletionSettings?: { chat_completion_source?: string }, textCompletionSettings?: { type?: string } }|null} context `SillyTavern.getContext()`.
 */
export function syncOptionsMenu(root, context) {
    if (!context) return;
    const cfgTypes = String(root.querySelector('#cfg_block_ooba')?.getAttribute('data-tg-type') ?? '')
        .split(',').map(type => type.trim()).filter(Boolean);
    const applies = getOptionsApplicability({
        mainApi: context.mainApi,
        chatSource: context.chatCompletionSettings?.chat_completion_source,
        textgenType: context.textCompletionSettings?.type,
        cfgTypes,
    });
    for (const [id, applicable] of [['option_toggle_CFG', applies.cfg], ['option_toggle_logprobs', applies.tokenProbabilities]]) {
        const item = root.querySelector(`#${id}`);
        if (item instanceof HTMLElement) item.style.display = applicable ? '' : 'none';
    }
}
