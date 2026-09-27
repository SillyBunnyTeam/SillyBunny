import { updateEntry } from './entry-manager.js';
import { accountStorage } from '../../../util/AccountStorage.js';
import { isEntryEligible, parseEntryUid } from './tree-store.js';

const STORAGE_KEY = 'pathfinder-summary-memory-state';
const listeners = new Set();
let state = loadState();

function loadState() {
    try {
        const parsed = JSON.parse(accountStorage.getItem(STORAGE_KEY) || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return {
                title: String(parsed.title || ''),
                content: String(parsed.content || ''),
                significance: String(parsed.significance || ''),
                arc: String(parsed.arc || ''),
                bookName: String(parsed.bookName || ''),
                uid: parseEntryUid(parsed.uid),
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
        try {
            listener(getSummaryMemoryState());
        } catch (error) {
            console.warn(error);
        }
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
        uid: parseEntryUid(uid),
        updatedAt: Date.now(),
        injectedAt: 0,
        injectedMode: '',
    };
    persistState();
}

export async function saveSummaryMemoryContent(content) {
    const previous = state;
    const nextContent = String(content || '').trim();
    if (previous.bookName && previous.uid !== null) {
        try {
            await updateEntry(previous.bookName, previous.uid, formatSummaryContent(nextContent, previous.significance), previous.title || undefined, {
                title: previous.title,
                content: formatSummaryContent(previous.content, previous.significance),
            });
        } catch (error) {
            if (error.code === 'PATHFINDER_ENTRY_CHANGED' && state === previous) detachSummaryMemoryBook(previous.bookName);
            throw error;
        }
        return;
    }
    state = { ...previous, content: nextContent, updatedAt: Date.now(), injectedAt: 0, injectedMode: '' };
    persistState();
}

export function detachSummaryMemoryBook(bookName) {
    if (state.bookName !== bookName) return;
    state = { ...state, bookName: '', uid: null, injectedAt: 0, injectedMode: '' };
    persistState();
}

export function renameSummaryMemoryBook(oldName, newName) {
    if (state.bookName !== oldName) return;
    state = { ...state, bookName: newName };
    persistState();
}

export function syncSummaryMemoryForBook(bookName, bookData, previousEntry = undefined) {
    if (state.bookName !== bookName || state.uid === null) return;
    const entry = Object.values(bookData?.entries || {}).find(item => item?.uid === state.uid);
    const expected = previousEntry === undefined ? entry : previousEntry;
    if (!isEntryEligible(entry) || !isSummaryMemoryEntry({ ...expected, bookName })) {
        detachSummaryMemoryBook(bookName);
        return;
    }
    if (isSummaryMemoryEntry({ ...entry, bookName })) return;
    const significance = String(entry.content || '').match(/^Significance:\s*([^\n]*)\n\n/i)?.[1] || '';
    const title = String(entry.comment || '');
    state = {
        ...state,
        title,
        content: stripSummaryContent(entry.content),
        significance,
        arc: state.arc && title.endsWith(` \u2014 ${state.arc}`) ? state.arc : '',
        updatedAt: Date.now(),
        injectedAt: 0,
        injectedMode: '',
    };
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
    return isEntryEligible(entry) && state.uid !== null
        && parseEntryUid(entry.uid) === state.uid && (entry.bookName ?? entry.world) === state.bookName
        && (entry.comment ?? entry.name ?? entry.title) === state.title
        && String(entry.content || '').trim() === formatSummaryContent(state.content, state.significance);
}

export function onSummaryMemoryChanged(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
