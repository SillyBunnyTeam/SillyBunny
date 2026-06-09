export const GENERATION_LIFECYCLE_UI_STATE = Object.freeze({
    IDLE: 'idle',
    GENERATING: 'generating',
});

export const GENERATION_LIFECYCLE_ABORT_REASON = 'Clicked stop button';

const OUTPUT_INTERCEPT_EXCLUDED_TYPES = new Set(['quiet', 'impersonate', 'first_message']);

function normalizeGenerationType(type) {
    const normalizedType = String(type ?? '').trim();
    return normalizedType || null;
}

/**
 * Resolves generation UI lock state for send controls.
 * @param {object} options Options.
 * @param {boolean} [options.isGenerating=false] Whether generation controls should lock.
 * @param {boolean} [options.markBodyGenerating=isGenerating] Whether to mark the document as actively generating.
 * @returns {{state: string, shouldShowStopButton: boolean, shouldHideSwipeButtons: boolean, bodyGeneratingValue: string|null}}
 */
export function resolveGenerationUiLockState({
    isGenerating = false,
    markBodyGenerating = isGenerating,
} = {}) {
    if (!isGenerating) {
        return {
            state: GENERATION_LIFECYCLE_UI_STATE.IDLE,
            shouldShowStopButton: false,
            shouldHideSwipeButtons: false,
            bodyGeneratingValue: null,
        };
    }

    return {
        state: GENERATION_LIFECYCLE_UI_STATE.GENERATING,
        shouldShowStopButton: true,
        shouldHideSwipeButtons: true,
        bodyGeneratingValue: markBodyGenerating ? 'true' : null,
    };
}

/**
 * Resolves whether a generation unblock request may clear UI state.
 * @param {object} options Options.
 * @param {string|null} [options.type=null] Generation type being unblocked.
 * @param {boolean} [options.hasStreamingProcessor=false] Whether a stream exists.
 * @param {boolean} [options.isStreamingFinished=false] Whether that stream is finished.
 * @param {boolean} [options.forceUnblock=false] Whether to bypass stream-wait guards.
 * @returns {{shouldUnblock: boolean, shouldActivateSendButtons: boolean, shouldResetProgress: boolean, shouldFlushEphemeralState: boolean}}
 */
export function resolveGenerationUnblockState({
    type = null,
    hasStreamingProcessor = false,
    isStreamingFinished = false,
    forceUnblock = false,
} = {}) {
    const generationType = normalizeGenerationType(type);
    const shouldWaitForQuietStream = !forceUnblock
        && generationType === 'quiet'
        && Boolean(hasStreamingProcessor)
        && !isStreamingFinished;

    if (shouldWaitForQuietStream) {
        return {
            shouldUnblock: false,
            shouldActivateSendButtons: false,
            shouldResetProgress: false,
            shouldFlushEphemeralState: false,
        };
    }

    return {
        shouldUnblock: true,
        shouldActivateSendButtons: true,
        shouldResetProgress: true,
        shouldFlushEphemeralState: true,
    };
}

/**
 * Resolves how a stop-generation request should interact with active request state.
 * @param {object} options Options.
 * @param {boolean} [options.isSendPressed=false] Whether normal generation is active.
 * @param {boolean} [options.isGroupGenerating=false] Whether group generation is active.
 * @param {boolean} [options.hasStreamingProcessor=false] Whether streaming is active.
 * @param {string|null} [options.streamingType=null] Current streaming generation type.
 * @returns {{shouldStop: boolean, shouldStopStreaming: boolean, shouldAbortRequest: boolean, shouldEmitStopped: boolean, shouldClearStreamingProcessor: boolean, unblockType: string|null, abortReason: string}}
 */
export function resolveStopGenerationState({
    isSendPressed = false,
    isGroupGenerating = false,
    hasStreamingProcessor = false,
    streamingType = null,
} = {}) {
    const shouldAbortRequest = Boolean(isSendPressed || isGroupGenerating || hasStreamingProcessor);
    const shouldStopStreaming = Boolean(hasStreamingProcessor);
    const shouldStop = shouldAbortRequest || shouldStopStreaming;

    return {
        shouldStop,
        shouldStopStreaming,
        shouldAbortRequest,
        shouldEmitStopped: shouldStop,
        shouldClearStreamingProcessor: shouldStop,
        unblockType: shouldStop ? normalizeGenerationType(streamingType) : null,
        abortReason: GENERATION_LIFECYCLE_ABORT_REASON,
    };
}

/**
 * Resolves whether main generation output must be buffered before display/storage.
 * @param {object} options Options.
 * @param {string|null} [options.type=null] Generation type.
 * @param {boolean} [options.isStreaming=false] Whether the main model response is streaming.
 * @param {boolean} [options.hasPostMainInterceptors=false] Whether any post-main intercept agents are active.
 * @returns {{canInterceptMainOutput: boolean, shouldBuffer: boolean}}
 */
export function resolveGenerationOutputBufferState({
    type = null,
    isStreaming = false,
    hasPostMainInterceptors = false,
} = {}) {
    const generationType = normalizeGenerationType(type);
    const canInterceptMainOutput = !OUTPUT_INTERCEPT_EXCLUDED_TYPES.has(generationType);

    return {
        canInterceptMainOutput,
        shouldBuffer: Boolean(canInterceptMainOutput && isStreaming && hasPostMainInterceptors),
    };
}

/**
 * Creates the compatibility-facing generation lifecycle seam.
 * Runtime call sites should depend on this shape instead of individual helpers.
 * @returns {object}
 */
export function createGenerationLifecycle() {
    return {
        ui: {
            state: GENERATION_LIFECYCLE_UI_STATE,
            resolveLockState: resolveGenerationUiLockState,
            resolveUnblockState: resolveGenerationUnblockState,
        },
        stop: {
            abortReason: GENERATION_LIFECYCLE_ABORT_REASON,
            resolveState: resolveStopGenerationState,
        },
        output: {
            resolveBufferState: resolveGenerationOutputBufferState,
        },
    };
}
