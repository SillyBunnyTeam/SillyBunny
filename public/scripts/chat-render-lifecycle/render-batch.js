function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}

function assertRenderBatchOptions({
    messages,
    firstMessageId,
    batchSize,
    timeBudgetMs,
    now,
    documentRef,
    renderMessageElement,
    insertFragment,
    waitForNextFrame,
    afterBatch,
}) {
    if (!Array.isArray(messages)) {
        throw new TypeError('renderMessagesInBatches requires messages to be an array.');
    }

    if (!Number.isInteger(firstMessageId)) {
        throw new TypeError('renderMessagesInBatches requires firstMessageId to be an integer.');
    }

    if (!isPositiveInteger(batchSize)) {
        throw new TypeError('renderMessagesInBatches requires batchSize to be a positive integer.');
    }

    if (!(timeBudgetMs > 0) || typeof now !== 'function') {
        throw new TypeError('renderMessagesInBatches requires a positive timeBudgetMs and a clock.');
    }

    if (!documentRef || typeof documentRef.createDocumentFragment !== 'function') {
        throw new TypeError('renderMessagesInBatches requires documentRef.createDocumentFragment.');
    }

    if (typeof renderMessageElement !== 'function') {
        throw new TypeError('renderMessagesInBatches requires renderMessageElement.');
    }

    if (typeof insertFragment !== 'function') {
        throw new TypeError('renderMessagesInBatches requires insertFragment.');
    }

    if (typeof waitForNextFrame !== 'function') {
        throw new TypeError('renderMessagesInBatches requires waitForNextFrame.');
    }

    if (afterBatch !== undefined && typeof afterBatch !== 'function') {
        throw new TypeError('renderMessagesInBatches afterBatch must be a function when provided.');
    }
}

function unwrapRenderedElement(renderedMessageElement) {
    if (renderedMessageElement && typeof renderedMessageElement === 'object' && '0' in renderedMessageElement) {
        return renderedMessageElement[0];
    }

    return renderedMessageElement;
}

function assertRenderedElement(renderedMessageElement, messageId) {
    if (!renderedMessageElement || typeof renderedMessageElement !== 'object') {
        throw new TypeError(`renderMessageElement must return an element for message ${messageId}.`);
    }
}

function createBatchMeta({
    batchIndex,
    startOffset,
    endOffset,
    firstMessageId,
    renderedMessageIds,
    renderedMessageElements,
    fragment,
    isFinalBatch,
}) {
    return {
        batchIndex,
        startOffset,
        endOffset,
        firstMessageId: firstMessageId + startOffset,
        lastMessageId: firstMessageId + endOffset - 1,
        renderedMessageIds,
        renderedMessageElements,
        fragment,
        isFinalBatch,
    };
}

/**
 * Renders caller-selected chat messages into deterministic DOM batches.
 * @param {object} options Options.
 * @param {Array} options.messages Messages already selected by the caller.
 * @param {number} options.firstMessageId Numeric id for the first selected message.
 * @param {number} options.batchSize Positive number of messages per fragment.
 * @param {number} [options.timeBudgetMs=Infinity] Maximum synchronous render time per fragment.
 * @param {() => number} [options.now] Monotonic clock.
 * @param {() => boolean} [options.isCurrent] Whether the caller still owns the rendered chat.
 * @param {{createDocumentFragment: () => DocumentFragment}} [options.documentRef=globalThis.document] Fragment factory.
 * @param {(message: object, messageId: number) => Element|Array<Element>} options.renderMessageElement Injected renderer.
 * @param {(fragment: DocumentFragment, batchMeta: object) => void} options.insertFragment Injected insertion target.
 * @param {() => Promise<void>|void} options.waitForNextFrame Injected frame yield.
 * @param {boolean} [options.markLastMessage=false] Add `.last_mes` to the final rendered element.
 * @param {(batchMeta: object) => Promise<void>|void} [options.afterBatch] Optional post-insert callback.
 * @returns {Promise<{renderedMessageIds: number[], renderedMessageElements: Element[]}>}
 */
export async function renderMessagesInBatches({
    messages,
    firstMessageId,
    batchSize,
    timeBudgetMs = Infinity,
    now = () => performance.now(),
    isCurrent = () => true,
    documentRef = globalThis.document,
    renderMessageElement,
    insertFragment,
    waitForNextFrame,
    markLastMessage = false,
    afterBatch,
} = {}) {
    assertRenderBatchOptions({
        messages,
        firstMessageId,
        batchSize,
        timeBudgetMs,
        now,
        documentRef,
        renderMessageElement,
        insertFragment,
        waitForNextFrame,
        afterBatch,
    });

    const renderedMessageIds = [];
    const renderedMessageElements = [];
    let batchIndex = 0;

    for (let startOffset = 0; startOffset < messages.length;) {
        if (!isCurrent()) break;
        const batchStart = now();
        const batchLimit = Math.min(startOffset + batchSize, messages.length);
        let endOffset = startOffset;
        const fragment = documentRef.createDocumentFragment();
        const batchRenderedMessageIds = [];
        const batchRenderedMessageElements = [];

        for (let offset = startOffset; offset < batchLimit; offset++) {
            const messageId = firstMessageId + offset;
            const renderedMessageElement = unwrapRenderedElement(renderMessageElement(messages[offset], messageId));

            assertRenderedElement(renderedMessageElement, messageId);

            batchRenderedMessageIds.push(messageId);
            batchRenderedMessageElements.push(renderedMessageElement);
            renderedMessageIds.push(messageId);
            renderedMessageElements.push(renderedMessageElement);
            endOffset = offset + 1;
            if (now() - batchStart >= timeBudgetMs) {
                break;
            }
        }

        const isFinalBatch = endOffset >= messages.length;
        if (markLastMessage && isFinalBatch) {
            batchRenderedMessageElements.at(-1)?.classList?.add('last_mes');
        }

        for (const renderedMessageElement of batchRenderedMessageElements) {
            fragment.appendChild(renderedMessageElement);
        }

        const batchMeta = createBatchMeta({
            batchIndex,
            startOffset,
            endOffset,
            firstMessageId,
            renderedMessageIds: batchRenderedMessageIds,
            renderedMessageElements: batchRenderedMessageElements,
            fragment,
            isFinalBatch,
        });

        if (!isCurrent()) break;
        insertFragment(fragment, batchMeta);
        await afterBatch?.(batchMeta);

        if (!isFinalBatch) {
            await waitForNextFrame();
        }

        batchIndex++;
        startOffset = endOffset;
    }

    return {
        renderedMessageIds,
        renderedMessageElements,
    };
}
