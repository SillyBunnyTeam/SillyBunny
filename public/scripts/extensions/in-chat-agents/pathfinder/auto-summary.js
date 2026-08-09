import { getSettings, normalizeAutoSummaryInterval } from './tree-store.js';
import { getWritableBooks } from './pathfinder-tool-bridge.js';

let autoSummaryCount = 0;
let autoSummaryEventSource = null;
let autoSummaryEventTypes = null;
let autoSummaryMessageReceivedHandler = null;
let autoSummaryMessageSentHandler = null;

export function initAutoSummary(eventSource, eventTypes) {
    deinitAutoSummary();
    autoSummaryCount = 0;

    autoSummaryEventSource = eventSource;
    autoSummaryEventTypes = eventTypes;
    autoSummaryMessageReceivedHandler = () => {
        const s = getSettings();
        if (!s.autoSummary) return;
        autoSummaryCount++;
    };

    autoSummaryMessageSentHandler = () => {
        const s = getSettings();
        if (!s.autoSummary) return;
        autoSummaryCount++;
    };

    eventSource.on(eventTypes.MESSAGE_RECEIVED, autoSummaryMessageReceivedHandler);
    eventSource.on(eventTypes.MESSAGE_SENT, autoSummaryMessageSentHandler);
}

export function deinitAutoSummary() {
    if (autoSummaryEventSource && autoSummaryEventTypes) {
        if (autoSummaryMessageReceivedHandler) {
            autoSummaryEventSource.removeListener(autoSummaryEventTypes.MESSAGE_RECEIVED, autoSummaryMessageReceivedHandler);
        }
        if (autoSummaryMessageSentHandler) {
            autoSummaryEventSource.removeListener(autoSummaryEventTypes.MESSAGE_SENT, autoSummaryMessageSentHandler);
        }
    }

    autoSummaryEventSource = null;
    autoSummaryEventTypes = null;
    autoSummaryMessageReceivedHandler = null;
    autoSummaryMessageSentHandler = null;
    autoSummaryCount = 0;
}

export function markAutoSummaryComplete() {
    autoSummaryCount = 0;
}

export function getAutoSummaryCount() {
    return autoSummaryCount;
}

export function resetAutoSummaryCount() {
    autoSummaryCount = 0;
}

export function shouldAutoSummarize() {
    const s = getSettings();
    if (!s.autoSummary) return false;
    // The Summarize tool writes an entry, so a writable book is required;
    // read-only books would nudge the model into a tool call that always fails.
    if (getWritableBooks().length === 0) return false;
    const interval = normalizeAutoSummaryInterval(s.autoSummaryInterval);
    return autoSummaryCount >= interval;
}
