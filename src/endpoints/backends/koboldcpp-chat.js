import { randomUUID } from 'node:crypto';
import fetch from 'node-fetch';

import { TEXTGEN_TYPES } from '../../constants.js';
import { setAdditionalHeadersByType } from '../../additional-headers.js';
import { embedOpenRouterMedia } from '../../prompt-converters.js';
import { toWireReasoningEffort } from '../../reasoning-effort.js';
import { excludeKeysByYaml, mergeObjectWithYaml } from '../../util.js';
import { applyGenerationRequestControls } from '../../../public/scripts/generation-request-controls.js';
import { getKoboldCppBaseUrl } from './koboldcpp-admin.js';

const ABORT_TIMEOUT_MS = 5_000;

/**
 * @typedef {object} KoboldCppChatConnection
 * @property {string} baseUrl KoboldCpp base URL
 * @property {string} apiUrl Base URL of KoboldCpp's OpenAI-compatible API
 * @property {Record<string, string>} headers Request headers, with the KoboldCpp API key when one is saved
 */

/**
 * @typedef {KoboldCppChatConnection & { bodyParams: Record<string, any>, abort: () => Promise<void> }} KoboldCppChatRequest
 */

/**
 * @param {import('express').Request} request Chat Completion status or generate request
 * @returns {KoboldCppChatConnection|null} Connection, or null when the KoboldCpp URL is not valid
 */
export function getKoboldCppChatConnection(request) {
    const baseUrl = getKoboldCppBaseUrl(request.body?.koboldcpp_url);
    if (!baseUrl) {
        return null;
    }

    /** @type {Record<string, string>} */
    const headers = {};
    setAdditionalHeadersByType(headers, TEXTGEN_TYPES.KOBOLDCPP, baseUrl, request.user.directories, request.body.secret_id ?? null);
    mergeObjectWithYaml(headers, request.body.koboldcpp_include_headers);
    return { baseUrl, apiUrl: `${baseUrl}/v1`, headers };
}

/**
 * KoboldCpp turns thinking off for "none" and caps it for minimal, low, medium and high. Every other effort it
 * receives removes the cap. "none" and "auto" are left unsent, so KoboldCpp keeps the effort set at launch.
 * @param {unknown} effort Normalized reasoning effort
 * @returns {string|undefined} Effort to send
 */
function getReasoningEffort(effort) {
    if (typeof effort !== 'string' || !effort || effort === 'none' || effort === 'auto') {
        return undefined;
    }
    return toWireReasoningEffort(effort);
}

/**
 * @param {KoboldCppChatConnection} connection KoboldCpp connection
 * @param {string} genkey Generation key sent with the request
 * @returns {() => Promise<void>} Asks KoboldCpp once to stop the generation with this key
 */
function createAbort({ baseUrl, headers }, genkey) {
    let sent = false;
    return async () => {
        if (sent) {
            return;
        }
        sent = true;

        try {
            const result = await fetch(`${baseUrl}/api/extra/abort`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ genkey }),
                signal: AbortSignal.timeout(ABORT_TIMEOUT_MS),
            });
            if (!result.ok) {
                console.warn('KoboldCpp abort request failed:', result.status, result.statusText);
            }
        } catch (error) {
            console.warn('KoboldCpp abort request failed:', error.message);
        }
    };
}

/**
 * Builds the KoboldCpp parts of a Chat Completion request.
 * @param {import('express').Request} request Chat Completion generate request
 * @returns {KoboldCppChatRequest|null} Request parts, or null when the KoboldCpp URL is not valid
 */
export function getKoboldCppChatRequest(request) {
    const connection = getKoboldCppChatConnection(request);
    if (!connection) {
        return null;
    }

    const { body } = request;
    /** @type {Record<string, any>} */
    const bodyParams = {
        // In router mode KoboldCpp loads the model file that a request names, so requests name none.
        model: undefined,
        // Sent when 0 as well, because 0 turns top-k off and a missing top-k means 100.
        top_k: body.top_k,
        min_p: body.min_p,
        top_a: body.top_a,
        repetition_penalty: body.repetition_penalty,
        reasoning_effort: getReasoningEffort(body.reasoning_effort),
    };
    mergeObjectWithYaml(bodyParams, body.koboldcpp_include_body);

    // KoboldCpp's abort stops the generation with this key, so cancelling never stops another client's generation.
    const genkey = `sillybunny-${randomUUID()}`;
    bodyParams.genkey = genkey;
    embedOpenRouterMedia(body.messages, { audio: true, video: false });

    return { ...connection, bodyParams, abort: createAbort(connection, genkey) };
}

/**
 * Applies the KoboldCpp exclude list, then the response limits that SillyBunny owns.
 * @param {Record<string, any>} requestBody Request body for KoboldCpp
 * @param {any} body Chat Completion generate request body
 * @returns {Record<string, any>} Final request body
 */
export function finalizeKoboldCppChatBody(requestBody, body) {
    excludeKeysByYaml(requestBody, body.koboldcpp_exclude_body);
    delete requestBody.request_controls;
    // The request names no model, so the model the client reported decides whether the response reasons.
    return applyGenerationRequestControls(requestBody, { ...body.request_controls, model: body.model });
}
