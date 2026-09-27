const feedItems = [];
const MAX_FEED_ITEMS = 50;

export function initActivityFeed() {
    feedItems.length = 0;
}

export function clearFeed() {
    feedItems.length = 0;
}

export function getFeedItems() {
    return [...feedItems];
}

function addFeedItem(item) {
    feedItems.unshift({ ...item, timestamp: Date.now() });
    if (feedItems.length > MAX_FEED_ITEMS) feedItems.length = MAX_FEED_ITEMS;
}

export function logToolCallStarted(toolName, args, isSidecar = false) {
    addFeedItem({
        type: 'tool_call_started',
        toolName,
        args,
        isSidecar,
    });
}

export function logToolCallCompleted(toolName, result, isSidecar = false) {
    addFeedItem({
        type: 'tool_call_completed',
        toolName,
        result,
        isSidecar,
    });
}

export function logToolCallError(toolName, error) {
    addFeedItem({
        type: 'tool_call_error',
        toolName,
        error: String(error),
    });
}

export function logSidecarWrite(action, details = '') {
    addFeedItem({
        type: 'sidecar_write',
        action,
        details,
    });
}

export function logSidecarRetrieval(nodeIds, entryCount) {
    addFeedItem({
        type: 'sidecar_retrieval',
        nodeIds,
        entryCount,
    });
}

export function logPathfinderRetrievalDetail(detail) {
    addFeedItem({
        type: 'pathfinder_retrieval_detail',
        mode: detail?.mode || 'unknown',
        books: Array.isArray(detail?.books) ? detail.books : [],
        selectedEntries: Array.isArray(detail?.selectedEntries) ? detail.selectedEntries : [],
        stageResults: Array.isArray(detail?.stageResults) ? detail.stageResults : [],
        injectedPrompt: detail?.injectedPrompt || '',
        metadata: detail?.metadata || {},
    });
}

// Pipeline logging functions

export function logPipelineStart(pipelineName, stageCount) {
    addFeedItem({
        type: 'pipeline_start',
        pipelineName,
        stageCount,
    });
}

export function logPipelineStageStart(pipelineName, stageName, stageIndex, totalStages) {
    addFeedItem({
        type: 'pipeline_stage_start',
        pipelineName,
        stageName,
        stageIndex,
        totalStages,
    });
}

export function logPipelineStageComplete(pipelineName, stageName, entriesFound) {
    addFeedItem({
        type: 'pipeline_stage_complete',
        pipelineName,
        stageName,
        entriesFound,
    });
}

export function logPipelineComplete(pipelineName, totalEntries, stageResults) {
    addFeedItem({
        type: 'pipeline_complete',
        pipelineName,
        totalEntries,
        stageResults: stageResults?.length ?? 0,
    });
}

export function logPipelineError(pipelineName, stageName, error) {
    addFeedItem({
        type: 'pipeline_error',
        pipelineName,
        stageName,
        error: String(error),
    });
}

