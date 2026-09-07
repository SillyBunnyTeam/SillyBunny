/* eslint-disable playwright/no-standalone-expect */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const classSource = source.slice(source.indexOf('class StreamingProcessor {'), source.indexOf('\n/**', source.indexOf('\n}\n', source.indexOf('class StreamingProcessor {'))));

function replacement() {
    return { mes: 'different chat', name: 'Other', extra: {}, swipe_id: 0, swipes: ['untouched'], swipe_info: [{ extra: { keep: true } }] };
}

async function stream(type = 'normal') {
    const writes = [];
    const reasoningDomWrite = jest.fn();
    class Element {
        isConnected = true;
        classList = { toggle() {} };
        querySelector() { return this; }
        getAttribute() { return '0'; }
    }
    const element = new Element();
    const context = vm.createContext({
        console, AbortController, structuredClone,
        chat: [], chatId: 'original', chatGeneration: 1, activeGenerationRun: {}, streamingProcessor: null,
        document: { querySelector: () => element }, HTMLElement: Element,
        power_user: { streaming_fps: 30 }, main_api: 'openai', scrollLock: false, scrollLockImmunityUntil: 0,
        IN_CHAT_AGENT_TRANSFORM_HISTORY_KEY: 'history', IN_CHAT_AGENT_PRE_GENERATION_INTERCEPT_HISTORY_KEY: 'intercept',
        ReasoningHandler: class {
            reasoning = '';
            process = async () => {};
            updateDom = reasoningDomWrite;
            updateReasoning() {}
            hasReasoningContent() { return false; }
            getDuration() { return 0; }
        },
        event_types: { STREAM_TOKEN_RECEIVED: 'token' }, eventSource: { emit: jest.fn(async () => {}) },
        delay: async () => {}, Stopwatch: class { async tick(callback) { await callback(); } },
        getStoppingStrings: () => [], getStreamingUpdateInterval: () => 1,
        cleanUpMessage: ({ getMessage }) => getMessage,
        shouldReduceStreamingDomWork: () => false, shouldGuardMobileChatScroll: () => false,
        shouldPinMobileChatToBottom: () => false, isMobileChatManualScrollSuppressionActive: () => false,
        isAndroidStreamingPlatform: () => false, shouldUsePlainTextStreamingPreview: () => false,
        getPositiveTokenCount: value => Number(value) || 0,
        updateMessageTokenAccounting: jest.fn(async () => ({ outputTokens: 1, reasoningTokens: 0 })),
        balanceStreamingMarkdown: value => value, messageFormatting: value => value,
        formatGenerationTimer: () => ({}), deactivateSendButtons() {}, hideSwipeButtons() {}, unblockGeneration() {},
        scrollStartedStreamingMessageThroughLifecycle() {}, scrollChatToBottom: jest.fn(),
        CHAT_RENDER_LIFECYCLE_ROUTE: { STREAM_PROGRESS: 'stream' },
        isChatRenderLifecycleRolloutEnabled: () => true,
        getStreamingVisibleWriteBuffer: () => ({ queue: (...args) => writes.push(args) }),
        updateMessageMetaBadges: jest.fn(),
    });
    context.getCurrentChatId = () => context.chatId;
    context.saveReply = async () => { context.chat.push({ ...replacement(), mes: 'original', swipes: ['original'] }); };
    vm.runInContext(classSource + '\nthis.StreamingProcessor = StreamingProcessor;', context);
    const apply = source.match(/^function applyStreamingVisibleWrite\([\s\S]*?^}$/m)[0];
    vm.runInContext(apply, context);
    const processor = new context.StreamingProcessor(type, false, new Date(), '', { prefixReasoning: '', removePrefix: text => text });
    context.streamingProcessor = processor;
    processor.messageId = await processor.onStartStreaming('original');
    processor.generator = async function* () { yield { text: 'stale output', swipes: [], toolCalls: [], state: {} }; };
    return { context, processor, writes, reasoningDomWrite };
}

describe('streaming message origin', () => {
    test('continues updating the original message and swipe through normal stream completion', async () => {
        const { context, processor } = await stream();
        await processor.generate();
        await processor.onProgressStreaming(0, 'final output', true);
        expect(context.chat[0].mes).toBe('final output');
        expect(context.chat[0].swipes[0]).toBe('final output');
    });

    test.each(['chat switch', 'Stop'])('rechecks after token listeners before progress writes on %s', async reason => {
        const { context, processor } = await stream();
        context.eventSource.emit.mockImplementationOnce(async () => {
            if (reason === 'Stop') processor.onStopStreaming();
            else { context.chat = [replacement()]; context.chatGeneration++; }
        });
        const before = reason === 'Stop' ? structuredClone(context.chat[0]) : replacement();
        await processor.generate();
        expect(context.chat[0]).toEqual(before);
    });

    test('does not write through a reused index after the DOM lookup await', async () => {
        const { context, processor } = await stream();
        const pending = processor.onProgressStreaming(0, 'stale output', false);
        context.chat = [replacement()];
        context.chatGeneration++;
        await pending;
        expect(context.chat[0]).toEqual(replacement());
    });

    test('honours the originating host run guard before updating an otherwise unchanged message', async () => {
        const { context, processor } = await stream();
        const before = structuredClone(context.chat[0]);
        processor.isCurrentGeneration = () => false;
        await processor.onProgressStreaming(0, 'cancelled output', false);
        expect(context.chat[0]).toEqual(before);
    });

    test('does not update replacement swipe metadata after token accounting', async () => {
        const { context, processor } = await stream('continue');
        let release;
        let started;
        const accounting = new Promise(resolve => { started = resolve; });
        context.updateMessageTokenAccounting.mockImplementationOnce(() => { started(); return new Promise(resolve => { release = resolve; }); });
        const pending = processor.onProgressStreaming(0, 'stale output', true);
        await accounting;
        context.chat[0] = replacement();
        release({ outputTokens: 1, reasoningTokens: 0 });
        await pending;
        expect(context.chat[0]).toEqual(replacement());
    });

    test('does not let cancellation cleanup change a different message', async () => {
        const { context, processor } = await stream();
        context.chat[0] = replacement();
        processor.onStopStreaming();
        processor.setFirstSwipe(0);
        expect(context.chat[0]).toEqual(replacement());
    });

    test('guards the real initial saveReply after its token-count await', async () => {
        const { context } = await stream();
        context.chat = [];
        Object.assign(context, {
            name2: 'Assistant', generation_started: new Date(), selected_group: null,
            getMessageTimeStamp: () => 'now', getGeneratingApi: () => 'openai', getGeneratingModel: () => 'model', getCurrentReasoningEffort: () => null,
            processImageAttachment: async () => {}, addOneMessage: jest.fn(), statMesProcess() {},
        });
        vm.runInContext(source.match(/^export (async function saveReply\([\s\S]*?^})/m)[1], context);
        const processor = new context.StreamingProcessor('normal', false, new Date(), '', {});
        context.streamingProcessor = processor;
        let release;
        let started;
        const counting = new Promise(resolve => { started = resolve; });
        context.updateMessageTokenAccounting.mockImplementationOnce(() => { started(); return new Promise(resolve => { release = resolve; }); });
        const pending = processor.onStartStreaming('initial');
        await counting;
        context.chat = [replacement()];
        context.chatGeneration++;
        release({ outputTokens: 1, reasoningTokens: 0 });
        await pending;
        expect(context.chat[0]).toEqual(replacement());
        expect(context.addOneMessage).not.toHaveBeenCalled();
    });

    test('does not let delayed reasoning completion repaint a different chat', async () => {
        const { context, processor, reasoningDomWrite } = await stream();
        let release;
        let started;
        const processing = new Promise(resolve => { started = resolve; });
        processor.reasoningHandler.process = async () => {
            started();
            await new Promise(resolve => { release = resolve; });
            processor.reasoningHandler.updateDom(0);
        };
        const pending = processor.onProgressStreaming(0, 'valid output', false);
        await processing;
        context.chat = [replacement()];
        context.chatGeneration++;
        release();
        await pending;
        expect(context.chat[0]).toEqual(replacement());
        expect(reasoningDomWrite).not.toHaveBeenCalled();
    });

    test('rejects a queued DOM write after a chat switch', async () => {
        const { context, processor, writes } = await stream();
        await processor.onProgressStreaming(0, 'valid output', false);
        expect(writes).toHaveLength(1);
        context.chat = [replacement()];
        context.chatGeneration++;
        context.applyStreamingVisibleWrite(...writes[0]);
        expect(context.updateMessageMetaBadges).not.toHaveBeenCalled();
    });

    test('rejects a queued write when the renderer reused its DOM node for a different message', async () => {
        const { context, processor, writes } = await stream();
        await processor.onProgressStreaming(0, 'valid output', false);
        writes[0][1].messageDom.getAttribute = () => 'another-message';
        context.applyStreamingVisibleWrite(...writes[0]);
        expect(context.updateMessageMetaBadges).not.toHaveBeenCalled();
    });
});
