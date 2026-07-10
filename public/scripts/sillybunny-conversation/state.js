export const conversationState = {
    initialized: false,
    autoWorkerStarted: false,
    conversationCssLoaded: false,
    autoWorkerIntervalId: null,
    autoWorkerAbortController: null,
    autoWorkerBusy: false,
    externalGenerationActive: false,
    generationActive: false,
    conversationReplyBusy: false,
    conversationUploadActive: false,
    sendQueueProcessing: false,
    sendQueueNeedsProcessing: false,
    scheduleGenerationBusy: false,
    conversationWorkspaceOpen: false,
    conversationSelectedAvatar: null,
    conversationSelectedGroupId: null,
    conversationUnavailableGroupId: null,
    conversationTimelineChannel: 'main',
    conversationTimelineSearchQuery: '',
    conversationReplyTarget: null,
    imageGenerationActive: false,
    imageGenerationAbortController: null,
    lastRenderedAvatar: null,
    lastRenderedThreadKey: '',
    lastRenderedMessageCount: 0,
    lastTimelineFingerprint: '',
    timelineBottomScrollPending: false,
    lastPalsRailFingerprint: '',
    originalDocumentTitle: typeof document !== 'undefined' ? document.title : '',
    originalFaviconHref: '',
    faviconUpdateToken: 0,
};

export const sendQueue = [];
export const runtimeStatusOverrides = new Map();
export const memorySummaryBusyAvatars = new Set();
export const memorySummaryTimers = new Map();
export const activeTypingParticipants = new Map();
export const partnerReplyBusyKeys = new Set();
export const groupAsideBusyKeys = new Set();
export const groupAsideLastSent = new Map();
export const conversationTimeouts = new Set();
export const activeConversationGenerationOperations = new Set();
export const activeConversationReplyOperations = new Set();
export const regenerationBusyKeys = new Set();

function syncConversationBusyState() {
    conversationState.conversationReplyBusy = activeConversationReplyOperations.size > 0;
    conversationState.generationActive = conversationState.externalGenerationActive || activeConversationGenerationOperations.size > 0;
}

export function beginConversationGenerationOperation({ reply = true } = {}) {
    const operation = Symbol('conversation-generation');
    activeConversationGenerationOperations.add(operation);
    if (reply) {
        activeConversationReplyOperations.add(operation);
    }
    syncConversationBusyState();
    return operation;
}

export function endConversationGenerationOperation(operation) {
    activeConversationGenerationOperations.delete(operation);
    activeConversationReplyOperations.delete(operation);
    syncConversationBusyState();
}

export function setExternalConversationGenerationActive(active) {
    conversationState.externalGenerationActive = Boolean(active);
    syncConversationBusyState();
}
