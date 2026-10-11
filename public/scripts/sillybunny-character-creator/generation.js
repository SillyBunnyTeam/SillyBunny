import { yaml } from '../../lib.js';
import { getConnectionManagerRequestService, listConnectionProfiles } from '../extensions/in-chat-agents/profile-utils.js';
import { extractProfileResponseText } from '../extensions/in-chat-agents/llm-utils.js';
import { isAbortLikeError } from '../util/abort-error.js';
import { buildCreatorMessages } from './recipes.js';

function abortError() {
    return new DOMException('Creator generation stopped.', 'AbortError');
}

function checkAbort(signal) {
    if (signal?.aborted) throw abortError();
}

function stripOuterFence(raw) {
    const text = raw.trim();
    const lines = text.split(/\r?\n/);
    const opening = /^(`{3,}|~{3,})[^`~]*$/.exec(lines[0]);
    if (!opening || lines.length < 3) return text;
    const fence = opening[1];
    const closing = new RegExp(`^${fence[0]}{${fence.length},}\\s*$`);
    const closeIndex = lines.findIndex((line, index) => index > 0 && closing.test(line));
    if (closeIndex !== lines.length - 1) return text;
    const firstNewline = text.indexOf('\n');
    const lastNewline = text.lastIndexOf('\n');
    return text.slice(firstNewline + 1, lastNewline).trim();
}

function validateOutput(rawOutput, recipeId, target) {
    const text = stripOuterFence(rawOutput);
    try {
        if (!text) throw new Error('The selected profile returned no section text.');
        if (target === 'profile' || target === 'description') {
            if (recipeId === 'json') {
                const value = JSON.parse(text);
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                    throw new Error('A JSON character profile must be an object mapping.');
                }
            } else if (recipeId === 'yaml') {
                const document = yaml.parseDocument(text);
                if (document.errors.length) throw document.errors[0];
                if (!yaml.isMap(document.contents)) {
                    throw new Error('A YAML character profile must be a mapping.');
                }
                // Alias resolution errors are deferred until conversion by the YAML parser.
                document.toJS();
            }
        }
    } catch (cause) {
        const error = new Error(`Invalid generated section: ${cause.message}`, { cause });
        error.rawOutput = rawOutput;
        throw error;
    }
    return text;
}

/**
 * Generate one text section without accepting it or changing the active connection/chat.
 * The controller owns queue order, frozen draft context, candidates and run identity.
 * @param {object} options
 * @param {object} options.draft
 * @param {string} options.target
 * @param {string} [options.instruction]
 * @param {object|null} [options.runContext]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>}
 */
export async function generateCreatorTarget({ draft, target, instruction = '', runContext = null, signal }) {
    checkAbort(signal);
    const profileId = draft.profileId;
    const service = getConnectionManagerRequestService();
    if (!service || typeof service.sendRequest !== 'function') {
        throw new Error('Connection Manager is unavailable. Configure a saved connection profile to generate.');
    }
    const profile = listConnectionProfiles().find(item => item.id === profileId);
    if (!profileId || !profile) {
        throw new Error('Select an available saved connection profile. The previous profile may have been deleted or become unsupported.');
    }
    if (typeof service.isProfileSupported === 'function' && !service.isProfileSupported(profile)) {
        throw new Error('This connection profile does not support Chat Completion or Text Completion.');
    }
    if (typeof service.validateProfile === 'function') service.validateProfile(profile);
    const maxTokens = target === 'name' ? 256 : target === 'questions' ? 1024 : draft.sectionMaxTokens;
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
        throw new Error('The section output ceiling must be a positive integer.');
    }
    const recipeId = draft.recipeId;
    const messages = buildCreatorMessages({ draft, target, instruction, runContext });
    let response;
    try {
        checkAbort(signal);
        response = await service.sendRequest(profileId, messages, maxTokens, {
            stream: false,
            signal,
            extractData: true,
            includePreset: true,
            includeInstruct: true,
        });
    } catch (error) {
        if (isAbortLikeError(error, signal)) throw abortError();
        throw error;
    }
    // A provider may resolve despite cancellation; never turn its late output into a proposal.
    checkAbort(signal);
    const rawOutput = typeof response === 'string' ? response : extractProfileResponseText(response);
    return validateOutput(rawOutput, recipeId, target);
}
