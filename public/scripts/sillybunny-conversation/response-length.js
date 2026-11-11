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
