import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptSource = readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');

function getFunctionSource(name, { exported = false } = {}) {
    const markers = [
        `${exported ? 'export ' : ''}function ${name}(`,
        `${exported ? 'export ' : ''}async function ${name}(`,
    ];
    const marker = markers.find(candidate => scriptSource.includes(candidate));
    const start = marker ? scriptSource.indexOf(marker) : -1;

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = scriptSource.indexOf(') {', start) + 2;
    let depth = 0;

    for (let index = bodyStart; index < scriptSource.length; index++) {
        const char = scriptSource[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return scriptSource.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

function getSourceBetween(startMarker, endMarker) {
    const start = scriptSource.indexOf(startMarker);
    expect(start).toBeGreaterThanOrEqual(0);

    const end = scriptSource.indexOf(endMarker, start + startMarker.length);
    expect(end).toBeGreaterThan(start);

    return scriptSource.slice(start, end);
}

describe('generation lifecycle wiring', () => {
    test('imports generation lifecycle decisions into the script adapter', () => {
        expect(scriptSource).toContain('resolveGenerationUiLockState');
        expect(scriptSource).toContain('resolveGenerationOutputBufferState');
        expect(scriptSource).toContain('resolveGenerationUnblockState');
        expect(scriptSource).toContain('resolveStopGenerationState');
    });

    test('routes send-button activation through lifecycle lock state', () => {
        const activateSource = getFunctionSource('activateSendButtons', { exported: true });

        expect(activateSource).toContain('resolveGenerationUiLockState({ isGenerating: false })');
        expect(activateSource).toContain('lockState.shouldShowStopButton');
        expect(activateSource).toContain('lockState.shouldHideSwipeButtons');
        expect(activateSource).toContain('lockState.bodyGeneratingValue');
    });

    test('routes send-button deactivation through lifecycle lock state', () => {
        const deactivateSource = getFunctionSource('deactivateSendButtons', { exported: true });

        expect(deactivateSource).toContain('markBodyGenerating = true');
        expect(deactivateSource).toContain('resolveGenerationUiLockState({ isGenerating: true, markBodyGenerating })');
        expect(deactivateSource).toContain('lockState.shouldShowStopButton');
        expect(deactivateSource).toContain('lockState.shouldHideSwipeButtons');
        expect(deactivateSource).toContain('lockState.bodyGeneratingValue');
        expect(deactivateSource).not.toContain('document.body.dataset.generating = \'true\';');
    });

    test('routes stop-generation decisions through lifecycle stop state', () => {
        const stopSource = getFunctionSource('stopGeneration', { exported: true });

        expect(stopSource).toContain('resolveStopGenerationState({');
        expect(stopSource).toContain('isSendPressed: is_send_press');
        expect(stopSource).toContain('isGroupGenerating: is_group_generating');
        expect(stopSource).toContain('hasStreamingProcessor: Boolean(activeStreamingProcessor)');
        expect(stopSource).toContain('streamingType: activeStreamingProcessor?.type');
        expect(stopSource).toContain('activeStreamingProcessor.onStopStreaming();');
        expect(stopSource).toContain('abortController.abort(stopState.abortReason);');
        expect(stopSource).toContain('unblockGeneration(stopState.unblockType, { emitGenerationEnded: false, force: true });');
        expect(stopSource).not.toContain('Clicked stop button');
    });

    test('routes unblock cleanup decisions through lifecycle unblock state', () => {
        const unblockSource = getFunctionSource('unblockGeneration');

        expect(unblockSource).toContain('resolveGenerationUnblockState({');
        expect(unblockSource).toContain('type');
        expect(unblockSource).toContain('hasStreamingProcessor: Boolean(streamingProcessor)');
        expect(unblockSource).toContain('isStreamingFinished: Boolean(streamingProcessor?.isFinished)');
        expect(unblockSource).toContain('forceUnblock: force');
        expect(unblockSource).toContain('unblockState.shouldActivateSendButtons');
        expect(unblockSource).toContain('unblockState.shouldResetProgress');
        expect(unblockSource).toContain('unblockState.shouldFlushEphemeralState');
        expect(unblockSource).not.toContain('type === \'quiet\' && streamingProcessor && !streamingProcessor.isFinished');
    });

    test('routes provider-error cleanup through stopped lifecycle semantics', () => {
        expect(scriptSource).toContain('this.markUIGenStopped({ emitGenerationEnded: false, emitGenerationStopped: true });');
        expect(scriptSource).toContain('eventSource.emit(event_types.GENERATION_STOPPED);');
        expect(scriptSource).toContain('unblockGeneration(type, { emitGenerationEnded: false });');
    });

    test('routes post-main buffering decisions through lifecycle output state', () => {
        const bufferSource = getFunctionSource('shouldBufferMainGenerationOutput');

        expect(bufferSource).toContain('event_types.GENERATION_OUTPUT_BUFFERING_DECISION');
        expect(bufferSource).toContain('resolveGenerationOutputBufferState({');
        expect(bufferSource).toContain('hasPostMainInterceptors: Boolean(eventData.hasPostMainInterceptors)');
        expect(scriptSource).toContain('await shouldBufferMainGenerationOutput({ type, isStreaming: true })');
        expect(scriptSource).toContain('await activeStreamingProcessor.generateBuffered()');
    });

    test('keeps buffered streaming output hidden until post-main intercept completes', () => {
        const bufferedSource = getSourceBetween('async generateBuffered() {', 'async generate() {');
        const generateSource = getFunctionSource('Generate', { exported: true });
        const normalizedGenerateSource = generateSource.replace(/\r\n/g, '\n');

        expect(bufferedSource).toContain('for await (const { text, swipes, logprobs, toolCalls, state } of this.generator())');
        expect(bufferedSource).toContain('this.result = text;');
        expect(bufferedSource).not.toContain('this.onStartStreaming');
        expect(bufferedSource).not.toContain('this.onProgressStreaming');
        expect(bufferedSource).not.toContain('this.onFinishStreaming');

        expect(generateSource).toContain('const shouldBufferOutput = await shouldBufferMainGenerationOutput({ type, isStreaming: true });');
        expect(generateSource).toContain('await activeStreamingProcessor.generateBuffered()');
        expect(normalizedGenerateSource).toContain('const interceptResult = await applyMainGenerationOutputInterceptors({\n                            type,\n                            text: getMessage,\n                            isStreaming: true,');
        expect(generateSource).toContain('const saveReplyType = originalType !== \'continue\' ? type : \'appendFinal\';');
        expect(generateSource).toContain('type: saveReplyType,');
        expect(generateSource).toContain('!shouldBufferOutput && hasToolCalls && !shouldDeleteMessage');
    });

    test('runs main output intercept event before saveReply stores non-streaming replies', () => {
        const generateSource = getFunctionSource('Generate', { exported: true });
        const interceptIndex = generateSource.indexOf('await applyMainGenerationOutputInterceptors({');
        const saveIndex = generateSource.indexOf('await saveReply({ type, getMessage, title, swipes, reasoning, imageUrls, reasoningSignature, reasoningTokens: data.reasoningTokens })');

        expect(interceptIndex).toBeGreaterThanOrEqual(0);
        expect(saveIndex).toBeGreaterThanOrEqual(0);
        expect(interceptIndex).toBeLessThan(saveIndex);
    });
});
