export const conversationState = {
    initialized: false,
    autoWorkerIntervalId: null,
    autoWorkerAbortController: null,
    autoWorkerBusy: false,
    generationActive: false,
    conversationReplyBusy: false,
    conversationUploadActive: false,
    sendQueueProcessing: false,
    sendQueueNeedsProcessing: false,
    conversationProfileSwitchQueue: Promise.resolve(),
    scheduleGenerationBusy: false,
    conversationWorkspaceOpen: false,
    conversationSelectedAvatar: null,
    conversationSelectedGroupId: null,
    conversationTimelineChannel: 'main',
    conversationTimelineSearchQuery: '',
    imageGenerationActive: false,
    imageGenerationAbortController: null,
    lastRenderedAvatar: null,
    lastRenderedMessageCount: 0,
    lastTimelineFingerprint: '',
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
