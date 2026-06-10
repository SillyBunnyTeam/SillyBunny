import { describe, expect, test } from '@jest/globals';

import {
    createGenerationLifecycle,
    GENERATION_LIFECYCLE_ABORT_REASON,
    GENERATION_LIFECYCLE_UI_STATE,
    resolveGenerationOutputBufferState,
    resolveGenerationUiLockState,
    resolveGenerationUnblockState,
    resolveStopGenerationState,
} from '../public/scripts/generation-lifecycle/index.js';

describe('generation lifecycle helper', () => {
    test('resolves idle UI lock state without DOM mutation', () => {
        expect(resolveGenerationUiLockState({ isGenerating: false })).toEqual({
            state: GENERATION_LIFECYCLE_UI_STATE.IDLE,
            shouldShowStopButton: false,
            shouldHideSwipeButtons: false,
            bodyGeneratingValue: null,
        });
    });

    test('resolves generating UI lock state without DOM mutation', () => {
        expect(resolveGenerationUiLockState({ isGenerating: true })).toEqual({
            state: GENERATION_LIFECYCLE_UI_STATE.GENERATING,
            shouldShowStopButton: true,
            shouldHideSwipeButtons: true,
            bodyGeneratingValue: 'true',
        });
    });

    test('allows generation UI lock state without marking the body as generating', () => {
        expect(resolveGenerationUiLockState({ isGenerating: true, markBodyGenerating: false })).toEqual({
            state: GENERATION_LIFECYCLE_UI_STATE.GENERATING,
            shouldShowStopButton: true,
            shouldHideSwipeButtons: true,
            bodyGeneratingValue: null,
        });
    });

    test('keeps quiet generation blocked while its stream is still active', () => {
        expect(resolveGenerationUnblockState({
            type: 'quiet',
            hasStreamingProcessor: true,
            isStreamingFinished: false,
        })).toEqual({
            shouldUnblock: false,
            shouldActivateSendButtons: false,
            shouldResetProgress: false,
            shouldFlushEphemeralState: false,
        });
    });

    test('allows forced quiet generation unblock while its stream is still active', () => {
        expect(resolveGenerationUnblockState({
            type: 'quiet',
            hasStreamingProcessor: true,
            isStreamingFinished: false,
            forceUnblock: true,
        })).toEqual({
            shouldUnblock: true,
            shouldActivateSendButtons: true,
            shouldResetProgress: true,
            shouldFlushEphemeralState: true,
        });
    });

    test('allows normal and finished quiet generation unblock cleanup', () => {
        expect(resolveGenerationUnblockState({
            type: 'normal',
            hasStreamingProcessor: true,
            isStreamingFinished: false,
        })).toEqual({
            shouldUnblock: true,
            shouldActivateSendButtons: true,
            shouldResetProgress: true,
            shouldFlushEphemeralState: true,
        });

        expect(resolveGenerationUnblockState({
            type: 'quiet',
            hasStreamingProcessor: true,
            isStreamingFinished: true,
        })).toMatchObject({
            shouldUnblock: true,
            shouldResetProgress: true,
        });
    });

    test('does not stop when no generation request is active', () => {
        expect(resolveStopGenerationState()).toEqual({
            shouldStop: false,
            shouldStopStreaming: false,
            shouldAbortRequest: false,
            shouldEmitStopped: false,
            shouldClearStreamingProcessor: false,
            unblockType: null,
            abortReason: GENERATION_LIFECYCLE_ABORT_REASON,
        });
    });

    test('stops streaming and preserves its generation type for unblock', () => {
        expect(resolveStopGenerationState({
            isSendPressed: false,
            isGroupGenerating: false,
            hasStreamingProcessor: true,
            streamingType: ' continue ',
        })).toEqual({
            shouldStop: true,
            shouldStopStreaming: true,
            shouldAbortRequest: true,
            shouldEmitStopped: true,
            shouldClearStreamingProcessor: true,
            unblockType: 'continue',
            abortReason: GENERATION_LIFECYCLE_ABORT_REASON,
        });
    });

    test('aborts non-streaming sends and group generations', () => {
        expect(resolveStopGenerationState({
            isSendPressed: true,
            isGroupGenerating: false,
            hasStreamingProcessor: false,
        })).toMatchObject({
            shouldStop: true,
            shouldStopStreaming: false,
            shouldAbortRequest: true,
            unblockType: null,
        });

        expect(resolveStopGenerationState({
            isSendPressed: false,
            isGroupGenerating: true,
            hasStreamingProcessor: false,
        })).toMatchObject({
            shouldStop: true,
            shouldAbortRequest: true,
        });
    });

    test('buffers only streaming main output that has post-main interceptors', () => {
        expect(resolveGenerationOutputBufferState({
            type: 'normal',
            isStreaming: true,
            hasPostMainInterceptors: true,
        })).toEqual({
            canInterceptMainOutput: true,
            shouldBuffer: true,
        });

        expect(resolveGenerationOutputBufferState({
            type: 'normal',
            isStreaming: false,
            hasPostMainInterceptors: true,
        })).toMatchObject({
            canInterceptMainOutput: true,
            shouldBuffer: false,
        });

        expect(resolveGenerationOutputBufferState({
            type: 'normal',
            isStreaming: true,
            hasPostMainInterceptors: false,
        })).toMatchObject({
            canInterceptMainOutput: true,
            shouldBuffer: false,
        });
    });

    test('does not intercept auxiliary output types', () => {
        for (const type of ['quiet', 'impersonate', 'first_message']) {
            expect(resolveGenerationOutputBufferState({
                type,
                isStreaming: true,
                hasPostMainInterceptors: true,
            })).toEqual({
                canInterceptMainOutput: false,
                shouldBuffer: false,
            });
        }
    });

    test('creates a stable lifecycle seam for future runtime wiring', () => {
        const lifecycle = createGenerationLifecycle();

        expect(lifecycle.ui.state).toBe(GENERATION_LIFECYCLE_UI_STATE);
        expect(lifecycle.ui.resolveLockState).toBe(resolveGenerationUiLockState);
        expect(lifecycle.ui.resolveUnblockState).toBe(resolveGenerationUnblockState);
        expect(lifecycle.stop.abortReason).toBe(GENERATION_LIFECYCLE_ABORT_REASON);
        expect(lifecycle.stop.resolveState).toBe(resolveStopGenerationState);
        expect(lifecycle.output.resolveBufferState).toBe(resolveGenerationOutputBufferState);
    });
});
