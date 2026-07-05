export const conversationState = {
    initialized: false,
    autoWorkerStarted: false,
    conversationCssLoaded: false,
    autoWorkerIntervalId: null,
    autoWorkerAbortController: null,
    autoWorkerBusy: false,
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
