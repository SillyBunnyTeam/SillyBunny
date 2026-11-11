import { localforage } from '../../lib.js';
import { getCurrentUserHandle } from '../user.js';
import { CARD_FIELDS, projectDescription } from './model.js';

let store;
let operationQueue = Promise.resolve();
// Each browser tab runs its own copy of this module against the same records. A stored updatedAt that differs
// from the one this tab last loaded or wrote means that another tab wrote the record after this tab.
const seenStamps = new Map();
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCounter = value => Number.isSafeInteger(value) && value >= 0;
const isSource = value => value === null || (typeof value === 'string' && value.length > 0);
const persistedKeys = [
    'version', 'sourceAvatar', 'baseline', 'recipeId', 'brief', 'answers', 'additionalInstructions',
    'sectionMaxTokens', 'profileId', 'generationTargets', 'working', 'candidates', 'revision',
    'nextGreetingId', 'updatedAt', 'generationRunning', 'generationInterrupted', 'creationOutcomeUnknown',
];

function database() {
    store ??= localforage.createInstance({ name: 'SillyBunny_CharacterDrafts' });
    return store;
}

function keyFor(sourceAvatar) {
    if (!isSource(sourceAvatar)) throw new Error('Invalid draft source identity.');
    return JSON.stringify([getCurrentUserHandle(), sourceAvatar]);
}

function enqueue(operation) {
    const pending = operationQueue.catch(() => {}).then(operation);
    operationQueue = pending;
    // Callers receive the rejecting promise; keep a failed operation from poisoning later saves.
    void pending.catch(() => {});
    return pending;
}

function invalid(rawDraft) {
    const error = new Error('The stored Creator draft is malformed or uses an unsupported version. Download it or explicitly discard it before saving a replacement.');
    error.rawDraft = rawDraft;
    return error;
}

function newerElsewhere(rawDraft) {
    const error = new Error('TODO(copy)');
    error.rawDraft = rawDraft;
    return error;
}

function seenByThisTab(key, record) {
    return seenStamps.has(key) && seenStamps.get(key) === record.updatedAt;
}

function validDescription(value) {
    try {
        projectDescription(value);
        return true;
    } catch {
        return false;
    }
}

function validTarget(target) {
    return typeof target === 'string' && (CARD_FIELDS.includes(target) && target !== 'alternate_greetings'
        || target === 'profile' || target === 'voice' || /^greeting:[1-9]\d*$/.test(target));
}

function validCandidate(candidate) {
    return isObject(candidate) && validTarget(candidate.target)
        && isCounter(candidate.inputRevision) && isCounter(candidate.runId)
        && (candidate.target === 'description'
            ? (typeof candidate.value === 'string' || validDescription(candidate.value)) && validDescription(candidate.before)
            : typeof candidate.value === 'string' && typeof candidate.before === 'string');
}

function validateRecord(record, sourceAvatar) {
    if (!isObject(record) || record.version !== 1 || record.sourceAvatar !== sourceAvatar
        || !isObject(record.baseline) || !isObject(record.working)
        || !isCounter(record.revision) || !Number.isSafeInteger(record.nextGreetingId) || record.nextGreetingId < 1
        || !Number.isFinite(record.updatedAt) || record.updatedAt < 0
        || !Number.isSafeInteger(record.sectionMaxTokens) || record.sectionMaxTokens < 1
        || !['recipeId', 'brief', 'answers', 'additionalInstructions', 'profileId'].every(key => typeof record[key] === 'string')
        || !record.recipeId
        || !Array.isArray(record.generationTargets) || !record.generationTargets.every(validTarget)
        || !Array.isArray(record.candidates) || !record.candidates.every(validCandidate)
        || !validDescription(record.working.description)
        || !Array.isArray(record.working.alternate_greetings)
        || !CARD_FIELDS.every(field => field === 'alternate_greetings'
            ? Array.isArray(record.baseline[field]) && record.baseline[field].every(value => typeof value === 'string')
            : typeof record.baseline[field] === 'string' && (field === 'description' || typeof record.working[field] === 'string'))
        || ['generationRunning', 'generationInterrupted', 'creationOutcomeUnknown'].some(key => key in record && typeof record[key] !== 'boolean')) {
        throw invalid(record);
    }
    const ids = new Set();
    for (const entry of record.working.alternate_greetings) {
        if (!isObject(entry) || !Number.isSafeInteger(entry.id) || entry.id < 1
            || entry.id >= record.nextGreetingId || ids.has(entry.id) || typeof entry.text !== 'string') {
            throw invalid(record);
        }
        ids.add(entry.id);
    }
    return record;
}

function snapshotDescription(value) {
    if (typeof value === 'string') return value;
    return value.mode === 'opaque'
        ? { mode: 'opaque', text: value.text }
        : { mode: 'parts', recipeId: value.recipeId, profile: value.profile, voice: value.voice };
}

function snapshotRecord(draft) {
    validateRecord(draft, draft.sourceAvatar);
    const snapshot = {};
    for (const key of persistedKeys) {
        if (Object.prototype.hasOwnProperty.call(draft, key)) snapshot[key] = draft[key];
    }
    // Persist only the draft schema, never runtime controllers, promises, or surrounding settings.
    snapshot.baseline = Object.fromEntries(CARD_FIELDS.map(field => [field, draft.baseline[field]]));
    snapshot.working = Object.fromEntries(CARD_FIELDS.map(field => [field, draft.working[field]]));
    snapshot.working.description = snapshotDescription(draft.working.description);
    snapshot.working.alternate_greetings = draft.working.alternate_greetings.map(({ id, text }) => ({ id, text }));
    snapshot.candidates = draft.candidates.map(({ target, value, before, inputRevision, runId }) => ({
        target,
        value: target === 'description' ? snapshotDescription(value) : value,
        before: target === 'description' ? snapshotDescription(before) : before,
        inputRevision,
        runId,
    }));
    return structuredClone(snapshot);
}

export function loadDraft(sourceAvatar) {
    const key = keyFor(sourceAvatar);
    return enqueue(async () => {
        const raw = await database().getItem(key);
        if (raw === null || raw === undefined) {
            seenStamps.delete(key);
            return null;
        }
        validateRecord(raw, sourceAvatar);
        const draft = snapshotRecord(raw);
        seenStamps.set(key, raw.updatedAt);
        if (draft.generationRunning) {
            draft.generationRunning = false;
            draft.generationInterrupted = true;
        }
        return draft;
    });
}

export function saveDraft(draft) {
    const key = keyFor(draft.sourceAvatar);
    // Capture both account and content before waiting, not when IndexedDB becomes available.
    const snapshot = snapshotRecord(draft);
    return enqueue(async () => {
        const existing = await database().getItem(key);
        if (existing !== null && existing !== undefined) {
            validateRecord(existing, snapshot.sourceAvatar);
            if (!seenByThisTab(key, existing)) throw newerElsewhere(existing);
        }
        await database().setItem(key, snapshot);
        seenStamps.set(key, snapshot.updatedAt);
    });
}

export function discardDraft(sourceAvatar) {
    const key = keyFor(sourceAvatar);
    return enqueue(async () => {
        await database().removeItem(key);
        seenStamps.delete(key);
    });
}

/** Re-keys the stored draft of a renamed card. A draft that is already stored under the new identity stays as it is. */
export function moveDraft(oldAvatar, newAvatar) {
    const from = keyFor(oldAvatar);
    const to = keyFor(newAvatar);
    return enqueue(async () => {
        const raw = await database().getItem(from);
        if (raw === null || raw === undefined) return;
        validateRecord(raw, oldAvatar);
        const occupant = await database().getItem(to);
        if (occupant !== null && occupant !== undefined) return;
        await database().setItem(to, { ...snapshotRecord(raw), sourceAvatar: newAvatar });
        await database().removeItem(from);
        if (seenStamps.has(from)) seenStamps.set(to, seenStamps.get(from));
        seenStamps.delete(from);
    });
}

/** Unlike discardDraft, keeps a record that another tab wrote after this tab last loaded or wrote it. */
export function discardDraftIfSeen(sourceAvatar) {
    const key = keyFor(sourceAvatar);
    return enqueue(async () => {
        const existing = await database().getItem(key);
        if (existing !== null && existing !== undefined && !seenByThisTab(key, existing)) return;
        await database().removeItem(key);
        seenStamps.delete(key);
    });
}

export function flushDraftSaves() {
    return operationQueue;
}
