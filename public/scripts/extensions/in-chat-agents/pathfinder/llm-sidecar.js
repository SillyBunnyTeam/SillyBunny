import { generateRaw } from '../../../../script.js';
import { isAbortLikeError } from '../../../util/abort-error.js';
import { extractProfileResponseText } from '../llm-utils.js';
import { runAsInternalPromptTransform } from '../agent-runner.js';
import { getSettings } from './tree-store.js';

// Throttled so a multi-stage pipeline failure doesn't stack toasts
let lastSidecarIssueToastAt = 0;
function notifySidecarIssue(message, level = 'warning') {
    const now = Date.now();
    if (now - lastSidecarIssueToastAt < 60000) {
        return;
    }
    lastSidecarIssueToastAt = now;
    globalThis.toastr?.[level]?.(message, 'Pathfinder sidecar');
}

/**
 * Generate using the default connection profile from settings
 * @param {string} prompt - User prompt
 * @param {string} [systemPrompt=''] - System prompt
 * @returns {Promise<string>}
 */
export async function sidecarGenerate(prompt, systemPrompt = '', signal = null) {
    const s = getSettings();
    const profileId = s.connectionProfile ?? '';
    return sidecarGenerateWithProfile(prompt, systemPrompt, profileId, 2048, signal);
}

/**
 * Generate using a specific connection profile
 * @param {string} prompt - User prompt
 * @param {string} [systemPrompt=''] - System prompt
 * @param {string} [profileId=''] - Connection profile ID (empty = use default/main model)
 * @param {number} [maxTokens=2048] - Maximum tokens for response
 * @param {AbortSignal?} [signal=null] - Optional abort signal
 * @returns {Promise<string>}
 */
export async function sidecarGenerateWithProfile(prompt, systemPrompt = '', profileId = '', maxTokens = 2048, signal = null) {
    signal?.throwIfAborted();
    const ctx = window?.SillyTavern?.getContext?.();

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    // Try specified profile first
    if (ctx?.ConnectionManagerRequestService && profileId) {
        const CMRS = ctx.ConnectionManagerRequestService;
        try {
            const result = await runAsInternalPromptTransform(() => CMRS.sendRequest(profileId, messages, maxTokens, {
                extractData: true,
                includePreset: true,
                stream: false,
                signal,
            }), signal);
            signal?.throwIfAborted();
            const text = typeof result === 'string' ? result : extractProfileResponseText(result);
            if (!text.trim()) throw new Error('Sidecar generation failed; Pathfinder retrieval was skipped.');
            return text;
        } catch (err) {
            if (isAbortLikeError(err, signal)) {
                throw err;
            }
            console.warn(`[Pathfinder] Sidecar via profile "${profileId}" failed:`, err);
            notifySidecarIssue('Connection profile request failed; falling back to the main model.');
        }
    }

    try {
        const result = await runAsInternalPromptTransform(() => generateRaw({
            prompt: messages,
            responseLength: maxTokens,
            trimNames: false,
            signal,
            cacheScope: 'auxiliary',
        }), signal);
        signal?.throwIfAborted();
        if (!result.trim()) throw new Error('Sidecar generation failed; Pathfinder retrieval was skipped.');
        return result;
    } catch (err) {
        if (isAbortLikeError(err, signal)) {
            throw err;
        }
        console.warn('[Pathfinder] Sidecar via main model failed:', err);
        notifySidecarIssue('Sidecar generation failed; Pathfinder retrieval was skipped.', 'error');
        throw err;
    }
}
