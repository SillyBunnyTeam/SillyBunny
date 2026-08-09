import { updateEntry } from './entry-manager.js';
import { accountStorage } from '../../../util/AccountStorage.js';

const STORAGE_KEY = 'pathfinder-summary-memory-state';
const listeners = new Set();
let state = loadState();

function loadState() {
    try {
        const parsed = JSON.parse(accountStorage.getItem(STORAGE_KEY) || '{}');
        if (parsed && typeof parsed === 'object') {
            return {
                title: String(parsed.title || ''),
                content: String(parsed.content || ''),
                significance: String(parsed.significance || ''),
                arc: String(parsed.arc || ''),
                bookName: String(parsed.bookName || ''),
                uid: Number.isFinite(Number(parsed.uid)) ? Number(parsed.uid) : null,
                updatedAt: Number(parsed.updatedAt || 0),
                injectedAt: Number(parsed.injectedAt || 0),
                injectedMode: String(parsed.injectedMode || ''),
            };
        }
    } catch {
        // Ignore invalid persisted state.
    }

    return {
        title: '',
        content: '',
        significance: '',
        arc: '',
        bookName: '',
        uid: null,
        updatedAt: 0,
        injectedAt: 0,
        injectedMode: '',
    };
}

function persistState() {
    try {
        accountStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        // Persistence failure leaves the current in-memory summary available.
    }
    for (const listener of listeners) {
        listener(getSummaryMemoryState());
    }
}

function formatSummaryContent(content, significance = '') {
    const trimmedContent = String(content || '').trim();
    const trimmedSignificance = String(significance || '').trim();
    return trimmedSignificance ? `Significance: ${trimmedSignificance}\n\n${trimmedContent}` : trimmedContent;
}

function stripSummaryContent(content) {
    return String(content || '').replace(/^Significance:\s*[^\n]*\n\n/i, '').trim();
}

export function getSummaryMemoryState() {
    return { ...state };
}

export function setSummaryMemoryCreated({ title, content, significance, arc, bookName, uid }) {
    state = {
        title: String(title || ''),
        content: stripSummaryContent(content),
        significance: String(significance || ''),
        arc: String(arc || ''),
        bookName: String(bookName || ''),
        uid: Number.isFinite(Number(uid)) ? Number(uid) : null,
        updatedAt: Date.now(),
        injectedAt: 0,
        injectedMode: '',
    };
    persistState();
}

export async function saveSummaryMemoryContent(content) {
    state = {
        ...state,
        content: String(content || '').trim(),
        updatedAt: Date.now(),
        injectedAt: 0,
        injectedMode: '',
    };

    if (state.bookName && state.uid !== null) {
        await updateEntry(state.bookName, state.uid, formatSummaryContent(state.content, state.significance), state.title || undefined);
    }

    persistState();
}

export function markSummaryMemoryInjected({ mode = '' } = {}) {
    if (state.uid === null) {
        return;
    }

    state = {
        ...state,
        injectedAt: Date.now(),
        injectedMode: String(mode || ''),
    };
    persistState();
}

export function isSummaryMemoryEntry(entry) {
    if (!entry || state.uid === null) {
        return false;
    }

    return Number(entry.uid) === Number(state.uid) && (!state.bookName || entry.bookName === state.bookName);
}

export function onSummaryMemoryChanged(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
