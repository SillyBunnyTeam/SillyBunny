import { amount_gen, main_api, max_context } from '../../script.js';
import { adjustHordeGenerationParams, horde_settings, MIN_LENGTH } from '../horde.js';

/**
 * AI Horde refuses a request whose `max_length` is above the limit of every worker that serves the model.
 * A Horde request therefore asks for no more than a normal chat reply does.
 * It reads the Horde worker list when Horde adjusts the response length to the workers. It rejects when it
 * cannot read the list or when no selected Horde model is available.
 * @param {number} [responseLength] Tokens that the Conversation Mode request asks for
 * @returns {Promise<number|undefined>} Tokens to ask the active API for
 */
export async function getActiveApiResponseLength(responseLength) {
    if (main_api !== 'koboldhorde') {
        return responseLength;
    }

    const presetLength = Number(amount_gen);
    let limit = responseLength > 0 ? Math.min(responseLength, presetLength) : presetLength;

    if (horde_settings.auto_adjust_response_length) {
        const { maxLength } = await adjustHordeGenerationParams(max_context, presetLength);
        limit = Math.min(limit, maxLength);
    }

    return Math.max(limit, MIN_LENGTH);
}

/**
 * The response length that a scoped connection profile asks for when the request names none: the length in the preset of
 * the profile, which is what a normal chat with that profile asks for, and the length of the active connection when the
 * profile has no preset or its preset is gone. The profile modules are loaded on the first call, because most
 * conversations use no profile.
 * @param {{ api?: string, preset?: string }} profile
 * @returns {Promise<number|undefined>}
 */
export async function getProfileResponseLength(profile) {
    const [{ CONNECT_API_MAP }, { getPresetManager }, { oai_settings }] = await Promise.all([
        import('../slash-commands.js'),
        import('../preset-manager.js'),
        import('../openai.js'),
    ]);
    const selected = CONNECT_API_MAP[profile?.api]?.selected;
    const preset = profile?.preset ? getPresetManager(selected)?.getCompletionPresetByName(profile.preset) : null;
    const presetLength = Number(selected === 'openai' ? preset?.openai_max_tokens : preset?.genamt);
    if (presetLength > 0) {
        return presetLength;
    }

    const activeLength = Number(main_api === 'openai' ? oai_settings.openai_max_tokens : amount_gen);
    return activeLength > 0 ? activeLength : undefined;
}
