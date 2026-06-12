import { describe, expect, test } from '@jest/globals';
import { parse } from 'acorn';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptSource = readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
const scriptAst = parse(scriptSource, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ranges: true,
});

function visit(node, callback) {
    if (!node || typeof node !== 'object') {
        return;
    }

    if (typeof node.type === 'string') {
        callback(node);
    }

    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                visit(item, callback);
            }
        } else if (value && typeof value.type === 'string') {
            visit(value, callback);
        }
    }
}

function findNode(node, predicate) {
    let found = null;
    visit(node, current => {
        if (!found && predicate(current)) {
            found = current;
        }
    });
    return found;
}

function findExportedFunction(name) {
    return scriptAst.body
        .find(node => node.type === 'ExportNamedDeclaration'
            && node.declaration?.type === 'FunctionDeclaration'
            && node.declaration.id?.name === name)
        ?.declaration;
}

function findFunctionDeclaration(name) {
    return scriptAst.body
        .find(node => node.type === 'FunctionDeclaration' && node.id?.name === name);
}

function findTopLevelVariable(functionNode, name) {
    for (const statement of functionNode.body.body) {
        if (statement.type !== 'VariableDeclaration') {
            continue;
        }

        const declaration = statement.declarations.find(item => item.id?.name === name);
        if (declaration) {
            return { declaration, statement };
        }
    }

    return null;
}

function getSource(node) {
    return scriptSource.slice(node.range[0], node.range[1]);
}

describe('chat render lifecycle script wiring', () => {
    test('printMessages routes initial-load bottom landing through the lifecycle gate', () => {
        const printMessages = findExportedFunction('printMessages');
        const source = getSource(printMessages);

        expect(source).toContain('const count = getChatRenderWindowSize(power_user.chat_truncation);');
        expect(source).toContain('const startIndex = getChatRenderWindowStartIndex(chat.length, count);');
        expect(source).toContain('removeRenderedChatMessages();');
        expect(source).toContain('beginChatLoadBottomLock();');
        expect(source).toContain('await redisplayChat({ startIndex, fade: false, pinBottomDuringRender: true });');
        expect(source).toContain('syncChatHistoryWindowControls();');
        expect(source).toContain('scrollLoadedChatToBottomThroughLifecycle();');
        expect(source).toContain('delay(debounce_timeout.short).then(() => scrollOnMediaLoad({ force: true }));');

        const lifecycleGate = findFunctionDeclaration('scrollLoadedChatToBottomThroughLifecycle');
        expect(lifecycleGate).toBeTruthy();

        const lifecycleGateSource = getSource(lifecycleGate);
        expect(lifecycleGateSource).toContain('isChatRenderLifecycleRolloutEnabled(CHAT_RENDER_LIFECYCLE_ROUTE.INITIAL_LOAD)');
        expect(lifecycleGateSource).toContain('const transition = resolveChatScrollStateTransition({');
        expect(lifecycleGateSource).toContain('state: chatScrollState');
        expect(lifecycleGateSource).toContain('intent: CHAT_SCROLL_INTENT.INITIAL_LOAD');
        expect(lifecycleGateSource).toContain('chatScrollState = transition.state;');
        expect(lifecycleGateSource).toContain('const action = transition.action;');
        expect(lifecycleGateSource).toContain('shouldApplyChatBottomScrollAction(action)');
        expect(lifecycleGateSource).toContain('scrollLoadedChatToBottom();');
        expect(lifecycleGateSource).not.toContain('resolveChatScrollAction({');
    });

    test('redisplayChat delegates selected messages to the guarded redisplay renderer', () => {
        const redisplayChat = findExportedFunction('redisplayChat');
        const source = getSource(redisplayChat);

        expect(source).toContain('const shouldReplaceRenderedWindow = renderedMessageCount > 0');
        expect(source).toContain('const windowSize = getChatRenderWindowSize();');
        expect(source).toContain('const endIndex = Math.min(targetChat.length, startIndex + windowSize);');
        expect(source).toContain('const messages = targetChat.slice(startIndex, endIndex);');
        expect(source).toContain('const renderedMessageIds = await renderRedisplayChatMessages({ messages, startIndex, pinBottomDuringRender });');
        expect(source).toContain('applyCharacterTagsToMessageDivs({ mesIds: renderedMessageIds });');
        expect(source).toContain('syncChatHistoryWindowControls();');
        expect(source).toContain('refreshSwipeButtons(false, fade);');
        expect(source).toContain('applyStylePins();');
        expect(source).toContain('updateEditArrowClasses();');
    });

    test('redisplayChat keeps render-batch routing behind the lifecycle rollout guard', () => {
        const renderRedisplayChatMessages = findFunctionDeclaration('renderRedisplayChatMessages');
        const source = getSource(renderRedisplayChatMessages);

        expect(source).toContain('const batchSize = getMobileChatRenderBatchSize(messages.length);');
        expect(source).toContain('if (isChatRenderLifecycleRolloutEnabled(CHAT_RENDER_LIFECYCLE_ROUTE.REDISPLAY_BATCH))');
        expect(source).toContain('return renderRedisplayChatMessagesThroughLifecycle({ messages, startIndex, batchSize, pinBottomDuringRender });');
        expect(source).toContain('return renderRedisplayChatMessagesLegacy({ messages, startIndex, batchSize, pinBottomDuringRender });');
    });

    test('guard-on redisplayChat delegates batch mechanics to the lifecycle render batch helper', () => {
        const renderRedisplayChatMessagesThroughLifecycle = findFunctionDeclaration('renderRedisplayChatMessagesThroughLifecycle');
        const source = getSource(renderRedisplayChatMessagesThroughLifecycle);

        expect(source).toContain('renderMessagesInBatches({');
        expect(source).toContain('messages,');
        expect(source).toContain('firstMessageId: startIndex');
        expect(source).toContain('batchSize,');
        expect(source).toContain('renderMessageElement: (message, messageId) => updateMessageElement(message, { messageId })');
        expect(source).toContain('insertFragment: fragment => chatElement[0].appendChild(fragment)');
        expect(source).toContain('waitForNextFrame,');
        expect(source).toContain('markLastMessage: true');
        expect(source).toContain('afterBatch: pinBottomDuringRender ? () => beginChatLoadBottomLock() : undefined');
    });

    test('guard-off redisplayChat keeps legacy inline batching', () => {
        const renderRedisplayChatMessagesLegacy = findFunctionDeclaration('renderRedisplayChatMessagesLegacy');
        const source = getSource(renderRedisplayChatMessagesLegacy);

        expect(source).not.toContain('renderMessagesInBatches');
        expect(source).toContain('const renderedMessageIds = lodash.range(startIndex, startIndex + messages.length, 1);');
        expect(source).toContain('const fragment = document.createDocumentFragment();');
        expect(source).toContain('const messageElement = updateMessageElement(message, { messageId });');
        expect(source).toContain('newMessageElements.at(-1).classList.add(\'last_mes\');');
        expect(source).toContain('chatElement[0].appendChild(fragment);');
        expect(source).toContain('if (pinBottomDuringRender)');
        expect(source).toContain('beginChatLoadBottomLock();');
        expect(source).toContain('await waitForNextFrame();');
        expect(source).toContain('return renderedMessageIds;');
    });

    test('showMoreMessages delegates selected history messages to the guarded show-more renderer', () => {
        const showMoreMessages = findExportedFunction('showMoreMessages');
        const source = getSource(showMoreMessages);

        expect(source).toContain('const requestedWindowSize = messagesToLoad ?? power_user.chat_truncation;');
        expect(source).toContain('const windowSize = getChatRenderWindowSize(requestedWindowSize);');
        expect(source).toContain('preserveAnchor: messagesToLoad === null');
        expect(source).toContain('const firstId = clamp(messageId - count, 0, Infinity);');
        expect(source).toContain('const messages = chat.slice(firstId, messageId);');
        expect(source).toContain('const anchor = captureVisibleChatMessageAnchor();');
        expect(source).toContain('await renderShowMoreMessages({');
        expect(source).toContain('pruneRenderedChatMessagesToWindow({ windowSize, pruneFrom: \'end\' });');
        expect(source).toContain('syncChatHistoryWindowControls();');
        expect(source).toContain('refreshSwipeButtons();');
        expect(source).toContain('showMoreButton.remove();');
        expect(source).toContain('applyStylePins();');
        expect(source).toContain('updateEditArrowClasses();');
        expect(source).toContain('await settleVisibleChatMessageAnchor(anchor);');
        expect(source).toContain('await eventSource.emit(event_types.MORE_MESSAGES_LOADED);');
    });

    test('showNewerMessages appends newer history through the bounded redisplay renderer', () => {
        const showNewerMessages = findExportedFunction('showNewerMessages');
        const source = getSource(showNewerMessages);

        expect(source).toContain('const { renderedMessageCount, lastMessageId } = getRenderedChatMessageWindow();');
        expect(source).toContain('const requestedWindowSize = messagesToLoad ?? power_user.chat_truncation;');
        expect(source).toContain('const windowSize = getChatRenderWindowSize(requestedWindowSize);');
        expect(source).toContain('preserveAnchor: messagesToLoad === null');
        expect(source).toContain('const firstId = Number.isInteger(lastMessageId) ? lastMessageId + 1 : 0;');
        expect(source).toContain('const messages = chat.slice(firstId, lastId);');
        expect(source).toContain('const renderedMessageIds = await renderRedisplayChatMessages({ messages, startIndex: firstId });');
        expect(source).toContain('pruneRenderedChatMessagesToWindow({ windowSize, pruneFrom: \'start\' });');
        expect(source).toContain('syncRenderedChatLastMessageClass();');
        expect(source).toContain('syncChatHistoryWindowControls();');
        expect(source).toContain('applyCharacterTagsToMessageDivs({ mesIds: renderedMessageIds });');
        expect(source).toContain('refreshSwipeButtons();');
        expect(source).toContain('applyStylePins();');
        expect(source).toContain('updateEditArrowClasses();');
        expect(source).toContain('await eventSource.emit(event_types.MORE_MESSAGES_LOADED);');
    });

    test('showMoreMessages keeps render-batch routing behind the lifecycle rollout guard', () => {
        const renderShowMoreMessages = findFunctionDeclaration('renderShowMoreMessages');
        const source = getSource(renderShowMoreMessages);

        expect(source).toContain('const batchSize = getMobileChatRenderBatchSize(messages.length);');
        expect(source).toContain('if (isChatRenderLifecycleRolloutEnabled(CHAT_RENDER_LIFECYCLE_ROUTE.SHOW_MORE_BATCH))');
        expect(source).toContain('await renderShowMoreMessagesThroughLifecycle(renderOptions);');
        expect(source).toContain('await renderShowMoreMessagesLegacy(renderOptions);');
    });

    test('guard-on showMoreMessages delegates batch insertion to the lifecycle render batch helper', () => {
        const renderShowMoreMessagesThroughLifecycle = findFunctionDeclaration('renderShowMoreMessagesThroughLifecycle');
        const source = getSource(renderShowMoreMessagesThroughLifecycle);

        expect(source).toContain('renderMessagesInBatches({');
        expect(source).toContain('messages,');
        expect(source).toContain('firstMessageId: firstId');
        expect(source).toContain('batchSize,');
        expect(source).toContain('renderMessageElement: (message, messageId) => updateMessageElement(message, { messageId })');
        expect(source).toContain('insertFragment: fragment => insertShowMoreFragment(insertionReference, fragment)');
        expect(source).toContain('waitForNextFrame: async () =>');
        expect(source).toContain('await waitForNextFrame();');
        expect(source).toContain('afterBatch: restoreAnchorIfNeeded');
    });

    test('guard-off showMoreMessages keeps legacy inline batching and anchor restores', () => {
        const renderShowMoreMessagesLegacy = findFunctionDeclaration('renderShowMoreMessagesLegacy');
        const source = getSource(renderShowMoreMessagesLegacy);

        expect(source).not.toContain('renderMessagesInBatches');
        expect(source).toContain('const fragment = document.createDocumentFragment();');
        expect(source).toContain('const batch = messages.slice(offset, offset + batchSize);');
        expect(source).toContain('const messageElement = updateMessageElement(message, { messageId: firstId + offset + id });');
        expect(source).toContain('insertShowMoreFragment(insertionReference, fragment);');
        expect(source).toContain('restoreVisibleChatMessageAnchor(anchor);');
        expect(source).toContain('await waitForNextFrame();');
    });

    test('addOneMessage passes pre-mutation bottom state into lifecycle bottom scroll', () => {
        const addOneMessage = findExportedFunction('addOneMessage');
        expect(addOneMessage).toBeTruthy();

        const tailAppendState = findTopLevelVariable(addOneMessage, 'tailAppendIsNearBottom');
        expect(tailAppendState).toBeTruthy();
        expect(tailAppendState.declaration.init?.type).toBe('ConditionalExpression');
        expect(findNode(tailAppendState.declaration.init.test, node => node.type === 'Identifier' && node.name === 'isTailAppend')).toBeTruthy();
        expect(findNode(tailAppendState.declaration.init.test, node => node.type === 'Identifier' && node.name === 'scroll')).toBeTruthy();
        expect(tailAppendState.declaration.init.consequent?.callee?.name).toBe('isChatScrolledNearBottom');
        expect(tailAppendState.declaration.init.alternate?.value).toBe(true);

        const firstRenderWork = findNode(addOneMessage, node => node.type === 'CallExpression'
            && node.callee?.name === 'updateMessageElement');
        expect(firstRenderWork).toBeTruthy();
        expect(tailAppendState.statement.range[0]).toBeLessThan(firstRenderWork.range[0]);

        const bottomScrollCall = findNode(addOneMessage, node => node.type === 'CallExpression'
            && node.callee?.name === 'scrollChatToBottom');
        expect(bottomScrollCall).toBeTruthy();

        const scrollOptions = bottomScrollCall.arguments[0];
        expect(scrollOptions?.type).toBe('ObjectExpression');
        expect(scrollOptions.properties).toEqual(expect.arrayContaining([
            expect.objectContaining({
                key: expect.objectContaining({ name: 'waitForFrame' }),
                value: expect.objectContaining({ value: true }),
            }),
            expect.objectContaining({
                key: expect.objectContaining({ name: 'isNearBottom' }),
                value: expect.objectContaining({ name: 'tailAppendIsNearBottom' }),
            }),
        ]));
    });

    test('addOneMessage preserves mobile bottom pin as platform policy', () => {
        const addOneMessage = findExportedFunction('addOneMessage');
        const mobilePinBranch = findNode(addOneMessage, node => node.type === 'IfStatement'
            && node.test?.name === 'shouldPinMobileBottom');

        expect(mobilePinBranch).toBeTruthy();
        expect(findNode(mobilePinBranch.consequent, node => node.type === 'CallExpression'
            && node.callee?.name === 'pinMobileChatToBottom')).toBeTruthy();
        expect(findNode(mobilePinBranch.alternate, node => node.type === 'CallExpression'
            && node.callee?.name === 'scrollChatToBottom')).toBeTruthy();
    });

    test('scrollChatToBottom keeps bottom-scroll routing behind its route gate', () => {
        const scrollChatToBottom = findExportedFunction('scrollChatToBottom');
        const source = getSource(scrollChatToBottom);

        expect(source).toContain('if (isChatRenderLifecycleRolloutEnabled(CHAT_RENDER_LIFECYCLE_ROUTE.BOTTOM_SCROLL))');
        expect(source).toContain('resolveChatBottomScrollAction({');
        expect(source).toContain('shouldApplyChatBottomScrollAction(action)');
        expect(source).toContain('scrollChatElementToBottom();');
    });

    test('addOneMessage keeps compatibility follow-up hooks in place', () => {
        const addOneMessage = findExportedFunction('addOneMessage');
        const source = getSource(addOneMessage);

        expect(source).toContain('const renderedWindowBeforeAdd = getRenderedChatMessageWindow();');
        expect(source).toContain('const shouldResetForTailGap = isTailAppend');
        expect(source).toContain('removeRenderedChatMessages();');
        expect(source).toContain('querySelector(\'.mes.last_mes\')?.classList.remove(\'last_mes\')');
        expect(source).toContain('lastMessageElement?.classList.add(\'last_mes\')');
        expect(source).toContain('pruneRenderedChatMessagesToWindow({ windowSize: getChatRenderWindowSize(), pruneFrom: \'start\' });');
        expect(source).toContain('syncChatHistoryWindowControls();');
        expect(source).toContain('if (showSwipes) refreshSwipeButtons();');
        expect(source).toContain('applyCharacterTagsToMessageDivs({ mesIds: messageId });');
        expect(source).toContain('updateEditArrowClasses();');
    });

    test('addOneMessage keeps returning the rendered jQuery element', () => {
        const addOneMessage = findExportedFunction('addOneMessage');
        const returnStatement = addOneMessage.body.body.find(node => node.type === 'ReturnStatement');

        expect(returnStatement?.argument).toEqual(expect.objectContaining({
            type: 'Identifier',
            name: 'messageElement',
        }));
    });

    test('updateMessageBlock keeps lifecycle update routing behind the rollout guard', () => {
        const updateMessageBlock = findExportedFunction('updateMessageBlock');
        const source = getSource(updateMessageBlock);

        expect(source).toContain('if (shouldDeferMobileMessageUpdates())');
        expect(source).toContain('queueMobileMessageBlockUpdate(messageId, message, { rerenderMessage });');
        expect(source).toContain('if (isChatRenderLifecycleRolloutEnabled(CHAT_RENDER_LIFECYCLE_ROUTE.MESSAGE_UPDATE))');
        expect(source).toContain('updateMessageBlockThroughLifecycle(messageId, message, { rerenderMessage });');
        expect(source).toContain('applyMessageBlockUpdate(messageId, message, { rerenderMessage });');
    });

    test('guard-on updateMessageBlock delegates queue mechanics to the lifecycle update queue helper', () => {
        expect(scriptSource).toContain('createMessageUpdateQueue,');

        const getMessageUpdateQueue = findFunctionDeclaration('getMessageUpdateQueue');
        const getQueueSource = getSource(getMessageUpdateQueue);

        expect(getQueueSource).toContain('createMessageUpdateQueue({');
        expect(getQueueSource).toContain('applyUpdate: applyMessageBlockUpdate');

        const updateMessageBlockThroughLifecycle = findFunctionDeclaration('updateMessageBlockThroughLifecycle');
        const lifecycleSource = getSource(updateMessageBlockThroughLifecycle);

        expect(lifecycleSource).toContain('const queue = getMessageUpdateQueue();');
        expect(lifecycleSource).toContain('queue.queue(messageId, message, { rerenderMessage });');
        expect(lifecycleSource).toContain('queue.flush();');
    });

    test('mobile-deferred message updates use the lifecycle update queue without changing scheduling policy', () => {
        expect(scriptSource).not.toContain('pendingMobileMessageUpdates = new Map');
        expect(scriptSource).not.toContain('pendingMobileMessageUpdates.set');

        const getMobileMessageUpdateQueue = findFunctionDeclaration('getMobileMessageUpdateQueue');
        const getMobileQueueSource = getSource(getMobileMessageUpdateQueue);

        expect(getMobileQueueSource).toContain('createMessageUpdateQueue({');
        expect(getMobileQueueSource).toContain('applyUpdate: applyMessageBlockUpdate');

        const flushPendingMobileMessageUpdates = findFunctionDeclaration('flushPendingMobileMessageUpdates');
        const flushSource = getSource(flushPendingMobileMessageUpdates);

        expect(flushSource).toContain('pendingMobileMessageUpdateFrame = 0;');
        expect(flushSource).toContain('pendingMobileMessageUpdateTimer = 0;');
        expect(flushSource).toContain('getMobileMessageUpdateQueue().flush();');

        const queueMobileMessageBlockUpdate = findFunctionDeclaration('queueMobileMessageBlockUpdate');
        const queueSource = getSource(queueMobileMessageBlockUpdate);

        expect(queueSource).toContain('getMobileMessageUpdateQueue().queue(messageId, message, { rerenderMessage });');
        expect(queueSource).toContain('if (pendingMobileMessageUpdateFrame || pendingMobileMessageUpdateTimer)');
        expect(queueSource).toContain('pendingMobileMessageUpdateTimer = window.setTimeout(() =>');
        expect(queueSource).toContain('pendingMobileMessageUpdateFrame = requestAnimationFrame(flushPendingMobileMessageUpdates);');
        expect(queueSource).toContain('scheduleMobileMessageUpdateFlushTimeout();');

        const timeoutSource = getSource(findFunctionDeclaration('scheduleMobileMessageUpdateFlushTimeout'));
        expect(timeoutSource).toContain('pendingMobileMessageUpdateFlushTimeout = window.setTimeout(() =>');
        expect(timeoutSource).toContain('flushPendingMobileMessageUpdates();');
    });

    test('streaming start keeps viewport routing behind the lifecycle rollout guard', () => {
        const onStartStreaming = findNode(scriptAst, node => node.type === 'MethodDefinition'
            && node.key?.name === 'onStartStreaming');
        const source = getSource(onStartStreaming.value);

        expect(source).toContain('hideSwipeButtons({ hideCounters: true });');
        expect(source).toContain('scrollLock = false;');
        expect(source).toContain('scrollLockImmunityUntil = Date.now() + 500;');
        expect(source).toContain('scrollStartedStreamingMessageThroughLifecycle();');
        expect(source).not.toContain('scrollChatToBottom({ waitForFrame: true });');
    });

    test('guard-on streaming start resolves viewport intent through lifecycle scroll rules', () => {
        const scrollStartedStreamingMessageThroughLifecycle = findFunctionDeclaration('scrollStartedStreamingMessageThroughLifecycle');
        const source = getSource(scrollStartedStreamingMessageThroughLifecycle);

        expect(source).toContain('if (!isChatRenderLifecycleRolloutEnabled(CHAT_RENDER_LIFECYCLE_ROUTE.STREAM_START))');
        expect(source).toContain('scrollChatToBottom({ waitForFrame: true });');
        expect(source).toContain('const action = resolveStreamingProgressScrollAction();');
        expect(source).toContain('shouldApplyChatBottomScrollAction(action)');
        expect(source).toContain('scrollChatElementToBottom();');

        const resolveStreamingProgressScrollAction = findFunctionDeclaration('resolveStreamingProgressScrollAction');
        const resolverSource = getSource(resolveStreamingProgressScrollAction);

        expect(resolverSource).toContain('resolveChatScrollStateTransition({');
        expect(resolverSource).toContain('state: chatScrollState');
        expect(resolverSource).toContain('intent: CHAT_SCROLL_INTENT.STREAM_PROGRESS');
        expect(resolverSource).toContain('autoScrollEnabled: power_user.auto_scroll_chat_to_bottom');
        expect(resolverSource).toContain('chatScrollState = transition.state;');
        expect(resolverSource).toContain('return transition.action;');
    });

    test('streaming progress keeps visible DOM write routing behind the lifecycle rollout guard', () => {
        const onProgressStreaming = findNode(scriptAst, node => node.type === 'MethodDefinition'
            && node.key?.name === 'onProgressStreaming');
        const source = getSource(onProgressStreaming.value);

        expect(source).toContain('await this.#checkDomElements(messageId);');
        expect(source).toContain('await updateMessageTokenAccounting(chat[messageId],');
        expect(source).toContain('shouldUpdateMetaBadges: !shouldReduceIntermediateStreamingWork');
        expect(source).toContain('this.setFirstSwipe(messageId);');
        expect(source).toContain('this.#queueStreamingVisibleWrite({');
        expect(source).toContain('formattedText,');
        expect(source).toContain('timePassed,');
        expect(source).toContain('currentTokenCount,');
        expect(source).toContain('isFinal,');
    });

    test('streaming progress throttles mobile bottom pins through the streaming scheduler', () => {
        const onProgressStreaming = findNode(scriptAst, node => node.type === 'MethodDefinition'
            && node.key?.name === 'onProgressStreaming');
        const source = getSource(onProgressStreaming.value);

        expect(source).toContain('const shouldUseMobileStreamingPin = !isImpersonate && shouldGuardMobileChatScroll();');
        expect(source).toContain('const shouldPinMobileBottom = shouldUseMobileStreamingPin && shouldPinMobileChatToBottom();');
        expect(source).toContain('if (shouldPinMobileBottom && shouldPinMobileChatToBottom())');
        expect(source).toContain('scheduleMobileStreamingBottomPin({ isFinal });');
        expect(source).toContain('if (!isChatRenderLifecycleRolloutEnabled(CHAT_RENDER_LIFECYCLE_ROUTE.STREAM_PROGRESS))');
        expect(source).toContain('scrollChatToBottom({');
        expect(source).toContain('const action = resolveStreamingProgressScrollAction({');
        expect(source).toContain('isNearBottom: shouldUseMobileStreamingPin ? shouldPinMobileBottom : true');
        expect(source).toContain('isManualScrollSuppressed: shouldUseMobileStreamingPin');
        expect(source).toContain('shouldApplyChatBottomScrollAction(action)');
        expect(source).not.toContain('pinMobileChatToBottom({ waitForFrame: true, settle: isFinal });');
    });

    test('mobile streaming bottom pin scheduling coalesces smooth intermediate pins', () => {
        expect(scriptSource).toContain('const MOBILE_STREAMING_SCROLL_MIN_INTERVAL_MS = 750;');
        expect(scriptSource).toContain('let mobileStreamingBottomPinFrame = 0;');
        expect(scriptSource).toContain('let mobileStreamingBottomPinTimer = 0;');

        const requestFrame = findFunctionDeclaration('requestMobileStreamingBottomPinFrame');
        const requestFrameSource = getSource(requestFrame);
        expect(requestFrameSource).toContain('requestAnimationFrame(() =>');
        expect(requestFrameSource).toContain('const behavior = getMobileStreamingBottomPinBehavior({');
        expect(requestFrameSource).toContain('if (!shouldPinMobileChatToBottom())');
        expect(requestFrameSource).toContain('pinMobileChatToBottom({');
        expect(requestFrameSource).toContain('waitForFrame: false');
        expect(requestFrameSource).toContain('behavior,');

        const scheduler = findFunctionDeclaration('scheduleMobileStreamingBottomPin');
        const schedulerSource = getSource(scheduler);
        expect(schedulerSource).toContain('clearMobileStreamingBottomPinTimer();');
        expect(schedulerSource).toContain('elapsed >= MOBILE_STREAMING_SCROLL_MIN_INTERVAL_MS');
        expect(schedulerSource).toContain('mobileStreamingBottomPinTimer = setTimeout(() =>');
    });

    test('guard-on streaming progress delegates visible DOM writes to the lifecycle stream buffer', () => {
        expect(scriptSource).toContain('createStreamWriteBuffer,');

        const getStreamingVisibleWriteBuffer = findFunctionDeclaration('getStreamingVisibleWriteBuffer');
        const getBufferSource = getSource(getStreamingVisibleWriteBuffer);

        expect(getBufferSource).toContain('createStreamWriteBuffer({');
        expect(getBufferSource).toContain('applyWrite: applyStreamingVisibleWrite');

        const applyStreamingVisibleWrite = findFunctionDeclaration('applyStreamingVisibleWrite');
        const applySource = getSource(applyStreamingVisibleWrite);

        expect(applySource).toContain('applyStreamFadeIn(messageTextDom, formattedText,');
        expect(applySource).toContain('messageTextDom.innerHTML = formattedText;');
        expect(applySource).toContain('messageTokenCounterDom.textContent = `${currentTokenCount}t`;');
        expect(applySource).toContain('messageTimerDom.textContent = timePassed.timerValue;');
        expect(applySource).toContain('messageTimerDom.title = timePassed.timerTitle;');

        const queueStreamingVisibleWrite = findNode(scriptAst, node => node.type === 'MethodDefinition'
            && node.key?.name === 'queueStreamingVisibleWrite');
        const queueSource = getSource(queueStreamingVisibleWrite.value);

        expect(queueSource).toContain('if (!isChatRenderLifecycleRolloutEnabled(CHAT_RENDER_LIFECYCLE_ROUTE.STREAM_PROGRESS))');
        expect(queueSource).toContain('applyStreamingVisibleWrite(messageId, write, { isFinal });');
        expect(queueSource).toContain('getStreamingVisibleWriteBuffer().queue(messageId, write, { isFinal });');
    });

    test('swipe replacement keeps viewport routing behind the lifecycle rollout guard', () => {
        const getSwipeReplacementViewportUpdate = findFunctionDeclaration('getSwipeReplacementViewportUpdate');
        const source = getSource(getSwipeReplacementViewportUpdate);

        expect(source).toContain('if (!useLifecycleRoute || !isChatRenderLifecycleRolloutEnabled(CHAT_RENDER_LIFECYCLE_ROUTE.REPLACE_MESSAGE))');
        expect(source).toContain('const anchor = isLastMessageSwipe && !isChatScrolledNearBottom()');
        expect(source).toContain('captureVisibleChatMessageAnchor()');
        expect(source).toContain('scrollWithAddOneMessage: isLastMessageSwipe && !anchor');
        expect(source).toContain('const transition = resolveChatScrollStateTransition({');
        expect(source).toContain('state: chatScrollState');
        expect(source).toContain('intent: CHAT_SCROLL_INTENT.REPLACE_MESSAGE');
        expect(source).toContain('autoScrollEnabled: power_user.auto_scroll_chat_to_bottom');
        expect(source).toContain('isNearBottom,');
        expect(source).toContain('hasAnchor: Boolean(anchor)');
        expect(source).toContain('isManualScrollSuppressed: shouldSuppressMobileChatAutoScroll()');
        expect(source).toContain('chatScrollState = transition.state;');
        expect(source).toContain('action: transition.action');
        expect(source).toContain('scrollWithAddOneMessage: false');
        expect(source).not.toContain('const action = resolveChatScrollAction({');
    });

    test('guard-on swipe replacement applies bottom or anchor lifecycle actions', () => {
        const applySwipeReplacementViewportUpdate = findFunctionDeclaration('applySwipeReplacementViewportUpdate');
        const applySource = getSource(applySwipeReplacementViewportUpdate);

        expect(applySource).toContain('shouldApplyChatBottomScrollAction(viewportUpdate?.action)');
        expect(applySource).toContain('requestAnimationFrame(() =>');
        expect(applySource).toContain('scrollChatElementToBottom();');
        expect(applySource).toContain('await settleSwipeReplacementAnchor(viewportUpdate);');

        const shouldSettleSwipeReplacementAnchor = findFunctionDeclaration('shouldSettleSwipeReplacementAnchor');
        const settleSource = getSource(shouldSettleSwipeReplacementAnchor);

        expect(settleSource).toContain('Boolean(viewportUpdate?.anchor)');
        expect(settleSource).toContain('viewportUpdate.action.action === CHAT_SCROLL_ACTION.PRESERVE_ANCHOR');
    });

    test('display-only swipe replacement delegates viewport handling without touching generation flow', () => {
        const swipe = findExportedFunction('swipe');
        const source = getSource(swipe);

        expect(source).toContain('let swipeViewportUpdate = null;');
        expect(source).toContain('let isOverswipeReplacement = false;');
        expect(source).toContain('const useLifecycleRoute = source !== SWIPE_SOURCE.DELETE && source !== SWIPE_SOURCE.BACK && !isOverswipeReplacement;');
        expect(source).toContain('swipeViewportUpdate = getSwipeReplacementViewportUpdate({ isLastMessageSwipe, useLifecycleRoute });');
        expect(source).toContain('isOverswipeReplacement = true;');
        expect(source).toContain('addOneMessage(chat[mesId], { type: \'swipe\', forceId: mesId, scroll: swipeViewportUpdate.scrollWithAddOneMessage, showSwipes: false });');
        expect(source).toContain('await applySwipeReplacementViewportUpdate(swipeViewportUpdate);');
        expect(source).toContain('await settleSwipeReplacementAnchor(swipeViewportUpdate);');

        const runGenerateBlock = source.slice(source.indexOf('if (run_generate) {'), source.indexOf('} else {', source.indexOf('if (run_generate) {')));
        expect(runGenerateBlock).not.toContain('getSwipeReplacementViewportUpdate');
        expect(runGenerateBlock).not.toContain('addOneMessage');
    });

    test('guard-on message rendering registers delegated resize observation', () => {
        expect(scriptSource).toContain('createDelegatedResizeObserver,');
        expect(scriptSource).toContain('let chatMessageResizeObserver = null;');
        expect(scriptSource).toContain('const chatMessageResizeStates = new Map();');

        const updateMessageElement = findExportedFunction('updateMessageElement');
        expect(getSource(updateMessageElement)).toContain('observeChatMessageResize(messageElement);');

        const observeChatMessageResize = findFunctionDeclaration('observeChatMessageResize');
        const observeSource = getSource(observeChatMessageResize);

        expect(observeSource).toContain('if (!isChatRenderLifecycleRolloutEnabled(CHAT_RENDER_LIFECYCLE_ROUTE.MEDIA_RESIZE) || !canObserveChatMessageResize())');
        expect(observeSource).toContain('const messageBlock = getMessageBlockElement(messageElement);');
        expect(observeSource).toContain('requestAnimationFrame(() =>');
        expect(observeSource).toContain('const observer = getChatMessageResizeObserver();');
        expect(observeSource).toContain('unobserveChatMessageResizeBlock(messageBlock);');
        expect(observeSource).toContain('const metadata = captureChatMessageResizeState(messageBlock);');
        expect(observeSource).toContain('observer.observe(messageBlock, metadata)');
        expect(observeSource).toContain('chatMessageResizeStates.set(messageBlock, metadata);');

        const getMessageBlockElement = findFunctionDeclaration('getMessageBlockElement');
        expect(getSource(getMessageBlockElement)).toContain('element.matches(\'.mes_block\') ? element : element.querySelector(\'.mes_block\')');

        const getChatMessageResizeObserver = findFunctionDeclaration('getChatMessageResizeObserver');
        expect(getSource(getChatMessageResizeObserver)).toContain('createDelegatedResizeObserver({');
        expect(getSource(getChatMessageResizeObserver)).toContain('onResize: onChatMessageResize');
    });

    test('guard-on message resize resolves media-resize intent through lifecycle scroll rules', () => {
        const isActiveStreamingMessageResizeBlock = findFunctionDeclaration('isActiveStreamingMessageResizeBlock');
        const streamingResizeSource = getSource(isActiveStreamingMessageResizeBlock);

        expect(streamingResizeSource).toContain('!streamingProcessor || streamingProcessor.isFinished');
        expect(streamingResizeSource).toContain('const streamingMessageId = Number(streamingProcessor.messageId);');
        expect(streamingResizeSource).toContain('element?.closest?.(\'.mes\')');
        expect(streamingResizeSource).toContain('messageElement?.getAttribute(\'mesid\')');

        const applyChatMessageResizeAction = findFunctionDeclaration('applyChatMessageResizeAction');
        const source = getSource(applyChatMessageResizeAction);

        expect(source).toContain('if (!isChatRenderLifecycleRolloutEnabled(CHAT_RENDER_LIFECYCLE_ROUTE.MEDIA_RESIZE))');
        expect(source).toContain('const resizeState = metadata ?? captureChatMessageResizeState(element, entry);');
        expect(source).toContain('if (isActiveStreamingMessageResizeBlock(element))');
        expect(source).toContain('refreshChatMessageResizeState(element, metadata, entry);');
        expect(source).toContain('const transition = resolveChatScrollStateTransition({');
        expect(source).toContain('state: chatScrollState');
        expect(source).toContain('intent: CHAT_SCROLL_INTENT.MEDIA_RESIZE');
        expect(source).toContain('autoScrollEnabled: power_user.auto_scroll_chat_to_bottom');
        expect(source).toContain('isNearBottom: Boolean(resizeState.isNearBottom)');
        expect(source).toContain('hasAnchor: Boolean(resizeState.anchor)');
        expect(source).toContain('isManualScrollSuppressed: shouldSuppressMobileChatAutoScroll()');
        expect(source).toContain('chatScrollState = transition.state;');
        expect(source).toContain('const action = transition.action;');
        expect(source).toContain('shouldApplyChatBottomScrollAction(action)');
        expect(source).toContain('scrollChatToBottom({ waitForFrame: true, isNearBottom: true });');
        expect(source).toContain('action.action === CHAT_SCROLL_ACTION.PRESERVE_ANCHOR');
        expect(source).toContain('await settleVisibleChatMessageAnchor(resizeState.anchor);');
        expect(source).toContain('refreshChatMessageResizeState(element, metadata, entry);');
        expect(source).not.toContain('const action = resolveChatScrollAction({');
    });

    test('message resize metadata refreshes viewport anchors on chat scroll', () => {
        const refreshObservedChatMessageResizeViewportStates = findFunctionDeclaration('refreshObservedChatMessageResizeViewportStates');
        const source = getSource(refreshObservedChatMessageResizeViewportStates);

        expect(source).toContain('if (chatMessageResizeStates.size === 0)');
        expect(source).toContain('const viewportState = captureChatMessageResizeViewportState();');
        expect(source).toContain('for (const [element, metadata] of chatMessageResizeStates)');
        expect(source).toContain('unobserveChatMessageResizeBlock(element);');
        expect(source).toContain('Object.assign(metadata, viewportState);');

        expect(scriptSource).toContain('const chatScrollHandler = function () {');
        expect(scriptSource).toContain('refreshObservedChatMessageResizeViewportStates();');
    });

    test('message resize observer cleans up on chat removal paths', () => {
        const unobserveChatMessageResize = findFunctionDeclaration('unobserveChatMessageResize');
        const unobserveSource = getSource(unobserveChatMessageResize);

        expect(unobserveSource).toContain('messageElement.toArray().forEach(unobserveChatMessageResize);');
        expect(unobserveSource).toContain('unobserveChatMessageResizeBlock(messageBlock);');

        const disposeChatMessageResizeObserver = findFunctionDeclaration('disposeChatMessageResizeObserver');
        const disposeSource = getSource(disposeChatMessageResizeObserver);

        expect(disposeSource).toContain('chatMessageResizeObserver?.dispose();');
        expect(disposeSource).toContain('chatMessageResizeObserver = null;');
        expect(disposeSource).toContain('chatMessageResizeStates.clear();');

        expect(getSource(findExportedFunction('redisplayChat'))).toContain('unobserveChatMessageResize(removedMessageElements);');
        expect(getSource(findExportedFunction('clearChat'))).toContain('disposeChatMessageResizeObserver();');
        const deleteLastMessageSource = getSource(findExportedFunction('deleteLastMessage'));
        expect(deleteLastMessageSource).toContain('const deletedMessageId = chat.length - 1;');
        expect(deleteLastMessageSource).toContain('chatElement.find(`.mes[mesid="${deletedMessageId}"]`)');
        expect(deleteLastMessageSource).toContain('unobserveChatMessageResize(messageElement);');
        expect(getSource(findExportedFunction('deleteMessage'))).toContain('unobserveChatMessageResize(messageElement);');
        expect(scriptSource).toContain('$(window).on(\'beforeunload\', () => {');
        expect(scriptSource).toContain('disposeChatMessageResizeObserver();');

        const onChatMessageResize = findFunctionDeclaration('onChatMessageResize');
        expect(getSource(onChatMessageResize)).toContain('unobserveChatMessageResizeBlock(element);');
    });

    test('guard-on mobile viewport events route through the lifecycle observer helper', () => {
        expect(scriptSource).toContain('createMobileViewportObserver,');
        expect(scriptSource).toContain('let mobileChatViewportObserver = null;');

        const setupMobileChatViewportObserver = findFunctionDeclaration('setupMobileChatViewportObserver');
        const setupSource = getSource(setupMobileChatViewportObserver);

        expect(setupSource).toContain('if (!isChatRenderLifecycleRolloutEnabled(CHAT_RENDER_LIFECYCLE_ROUTE.MOBILE_VIEWPORT))');
        expect(setupSource).toContain('window.visualViewport?.addEventListener(\'scroll\', onViewportChange, { passive: true });');
        expect(setupSource).toContain('window.visualViewport?.addEventListener(\'resize\', onViewportChange, { passive: true });');
        expect(setupSource).toContain('disposeMobileChatViewportObserver();');
        expect(setupSource).toContain('mobileChatViewportObserver = createMobileViewportObserver({');
        expect(setupSource).toContain('onViewportChange,');
        expect(setupSource).toContain('onViewportSettle: onViewportChange');
        expect(setupSource).toContain('mobileChatViewportObserver.start();');

        const initSource = scriptSource.slice(scriptSource.indexOf('const chatElementScroll = document.getElementById(\'chat\');'));
        expect(initSource).toContain('const markMobileViewportScroll = getMobileViewportScrollHandler();');
        expect(scriptSource).toContain('const CHAT_SHELL_WHEEL_SURFACE_SELECTOR = \'#sheld, #chat_wrapper, #form_sheld, #top-bar, #send_form\';');
        expect(scriptSource).toContain('const shellBoundary = getChatShellWheelBoundary(event.target);');
        expect(scriptSource).toContain('hasScrollableWheelTarget(event.target, shellBoundary)');
        expect(initSource).toContain('document.addEventListener(\'wheel\', routeShellWheelToChat, { passive: false, capture: true });');
        expect(initSource).toContain('setupMobileChatViewportObserver(markMobileViewportScroll);');
    });

    test('initial chat load keeps bottom pin settling across late layout passes', () => {
        expect(scriptSource).toContain('const CHAT_SCROLL_BOTTOM_THRESHOLD_PX = 24;');
        expect(scriptSource).toContain('const CHAT_LOAD_BOTTOM_LOCK_EXTRA_MS = 250;');
        expect(scriptSource).toContain('const CHAT_LOAD_SCROLL_SETTLE_DELAYS_MS = Object.freeze([80, 250, MOBILE_CHAT_LOAD_SCROLL_SETTLE_MS, 900, 1600, 2400]);');
        expect(scriptSource).toContain('history.scrollRestoration = \'manual\';');

        const beginChatLoadBottomLock = findFunctionDeclaration('beginChatLoadBottomLock');
        const lockSource = getSource(beginChatLoadBottomLock);
        expect(lockSource).toContain('chatLoadBottomLockUntil = Math.max(chatLoadBottomLockUntil, Date.now() + durationMs);');
        expect(lockSource).toContain('scrollLockImmunityUntil = Math.max(scrollLockImmunityUntil, chatLoadBottomLockUntil);');
        expect(lockSource).toContain('pinChatLoadToBottom();');

        const pinChatLoadToBottom = findFunctionDeclaration('pinChatLoadToBottom');
        const pinSource = getSource(pinChatLoadToBottom);
        expect(pinSource).toContain('if (!isChatLoadBottomLockActive())');
        expect(pinSource).toContain('scrollChatElementToBottom();');

        const scrollLoadedChatToBottom = findFunctionDeclaration('scrollLoadedChatToBottom');
        const source = getSource(scrollLoadedChatToBottom);
        expect(source).toContain('const latestSettleDelay = Math.max(...CHAT_LOAD_SCROLL_SETTLE_DELAYS_MS);');
        expect(source).toContain('const bottomLockDurationMs = latestSettleDelay + CHAT_LOAD_BOTTOM_LOCK_EXTRA_MS;');
        expect(source).toContain('beginChatLoadBottomLock({ durationMs: bottomLockDurationMs });');
        expect(source).toContain('scrollLockImmunityUntil = Math.max(scrollLockImmunityUntil, chatLoadBottomLockUntil);');
        expect(source).toContain('requestMobileChatBottomPin({ requireNearBottom: false, durationMs: bottomLockDurationMs + MOBILE_SEND_SCROLL_SETTLE_MS });');
        expect(source).toContain('for (const delayMs of CHAT_LOAD_SCROLL_SETTLE_DELAYS_MS)');
        expect(source).toContain('if (!isChatLoadBottomLockActive())');
        expect(source).toContain('scrollChatToBottom({ waitForFrame: true, force: true });');

        const initSource = scriptSource.slice(scriptSource.indexOf('const chatElementScroll = document.getElementById(\'chat\');'));
        expect(initSource).toContain('clearChatLoadBottomLock();');
        expect(initSource).toContain('if (isChatLoadBottomLockActive() && !isChatScrolledNearBottom())');
        expect(initSource).toContain('pinChatLoadToBottom();');
    });

    test('mobile viewport lifecycle route preserves existing scroll suppression policy', () => {
        const getMobileViewportScrollHandler = findFunctionDeclaration('getMobileViewportScrollHandler');
        const handlerSource = getSource(getMobileViewportScrollHandler);

        expect(handlerSource).toContain('if (mobileChatTouchScrolling || Date.now() < mobileChatManualScrollSuppressedUntil)');
        expect(handlerSource).toContain('markMobileChatManualScroll({ suppressMs: MOBILE_CHAT_VIEWPORT_SCROLL_SUPPRESS_MS });');

        const markMobileChatManualScroll = findFunctionDeclaration('markMobileChatManualScroll');
        const markSource = getSource(markMobileChatManualScroll);

        expect(markSource).toContain('resolveChatScrollStateTransition({');
        expect(markSource).toContain('state: chatScrollState');
        expect(markSource).toContain('intent: CHAT_SCROLL_INTENT.MANUAL_SCROLL');
        expect(markSource).toContain('}).state;');

        const pinMobileChatToBottom = findFunctionDeclaration('pinMobileChatToBottom');
        expect(getSource(pinMobileChatToBottom)).toContain('chatScrollState = CHAT_SCROLL_STATE.PINNED_BOTTOM;');

        const markChatScrollStateForUserScroll = findFunctionDeclaration('markChatScrollStateForUserScroll');
        const scrollStateSource = getSource(markChatScrollStateForUserScroll);

        expect(scrollStateSource).toContain('chatScrollState = CHAT_SCROLL_STATE.PINNED_BOTTOM;');
        expect(scrollStateSource).toContain('intent: CHAT_SCROLL_INTENT.MANUAL_SCROLL');

        const resetMobileViewportScrollState = findFunctionDeclaration('resetMobileViewportScrollState');
        const resetSource = getSource(resetMobileViewportScrollState);

        expect(resetSource).toContain('mobileChatTouchScrolling = false;');
        expect(resetSource).toContain('mobileChatManualScrollSuppressedUntil = 0;');
        expect(resetSource).toContain('mobileChatBottomPinUntil = 0;');

        const initSource = scriptSource.slice(scriptSource.indexOf('const chatElementScroll = document.getElementById(\'chat\');'));
        expect(initSource).toContain('const scrollIsAtBottom = isChatScrolledNearBottom();');
        expect(initSource).toContain('markChatScrollStateForUserScroll({ isNearBottom: scrollIsAtBottom });');
    });

    test('mobile viewport lifecycle observer resets on chat clear and disposes on unload', () => {
        const disposeMobileChatViewportObserver = findFunctionDeclaration('disposeMobileChatViewportObserver');
        const disposeSource = getSource(disposeMobileChatViewportObserver);

        expect(disposeSource).toContain('mobileChatViewportObserver?.dispose();');
        expect(disposeSource).toContain('mobileChatViewportObserver = null;');

        const resetMobileChatViewportLifecycle = findFunctionDeclaration('resetMobileChatViewportLifecycle');
        const resetSource = getSource(resetMobileChatViewportLifecycle);

        expect(resetSource).toContain('if (!isChatRenderLifecycleRolloutEnabled(CHAT_RENDER_LIFECYCLE_ROUTE.MOBILE_VIEWPORT))');
        expect(resetSource).toContain('resetMobileViewportScrollState();');
        expect(resetSource).toContain('setupMobileChatViewportObserver(getMobileViewportScrollHandler());');

        expect(getSource(findExportedFunction('clearChat'))).toContain('resetMobileChatViewportLifecycle();');
        expect(scriptSource).toContain('$(window).on(\'beforeunload\', () => {');
        expect(scriptSource).toContain('disposeMobileChatViewportObserver();');
    });
});
