export const PERSONA_POSITION = Object.freeze({ IN_PROMPT: 0, AFTER_CHAR: 1, TOP_AN: 2, BOTTOM_AN: 3, AT_DEPTH: 4, NONE: 9 });
export const PERSONA_ROLE = Object.freeze({ SYSTEM: 0, USER: 1, ASSISTANT: 2 });
export const DEFAULT_DEPTH = 2;
export const DEFAULT_ROLE = 0;
export const MAX_DEPTH = 9999;

export const POSITION_OPTIONS = Object.freeze([
    { value: '9', label: 'None (disabled)', i18n: 'None (disabled)' },
    { value: '0', label: 'In Story String / Prompt Manager', i18n: 'In Story String / Prompt Manager' },
    { value: '2', label: 'Top of Author\'s Note', i18n: 'Top of Author\'s Note' },
    { value: '3', label: 'Bottom of Author\'s Note', i18n: 'Bottom of Author\'s Note' },
    { value: '4', label: 'In-chat @ Depth', i18n: 'In-chat @ Depth' },
]);

export const ROLE_OPTIONS = Object.freeze([
    { value: '0', label: 'System', i18n: 'System' },
    { value: '1', label: 'User', i18n: 'User' },
    { value: '2', label: 'Assistant', i18n: 'Assistant' },
]);

export const DRAFT_KEYS = Object.freeze(['name', 'title', 'description', 'position', 'depth', 'role', 'appendices']);

function parseNumber(raw) {
    if ((typeof raw !== 'string' && typeof raw !== 'number') || String(raw).trim() === '') return NaN;
    return Number(raw);
}

export function parseDepth(raw, fallback = DEFAULT_DEPTH) {
    const value = parseNumber(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.floor(Math.min(MAX_DEPTH, Math.max(0, value)));
}

export function parseRole(raw, fallback = DEFAULT_ROLE) {
    const value = parseNumber(raw);
    return Object.values(PERSONA_ROLE).includes(value) ? value : fallback;
}

export function parsePosition(raw, fallback = PERSONA_POSITION.IN_PROMPT) {
    const value = parseNumber(raw);
    if (value === PERSONA_POSITION.AFTER_CHAR) return PERSONA_POSITION.IN_PROMPT;
    return Object.values(PERSONA_POSITION).includes(value) ? value : fallback;
}

export function personaToDraft({ name, descriptor } = {}) {
    return {
        name: String(name ?? ''),
        title: String(descriptor?.title ?? ''),
        description: String(descriptor?.description ?? ''),
        position: parsePosition(descriptor?.position),
        depth: parseDepth(descriptor?.depth),
        role: parseRole(descriptor?.role),
        appendices: structuredClone(descriptor?.appendices ?? []),
    };
}

export function createAppendixId(name = 'appendix', now = Date.now()) {
    const slug = String(name || 'appendix')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'appendix';
    return `${slug}-${now}`;
}

function canonicalAppendices(appendices) {
    const usedIds = new Set();
    return (Array.isArray(appendices) ? appendices : []).map((appendix, index) => {
        // Match normalizePersonaAppendices so active projection cannot invalidate rollback receipts.
        const name = String(appendix?.name || `Scenario Note ${index + 1}`).trim() || `Scenario Note ${index + 1}`;
        const fallbackId = `${createAppendixId(name)}-${index}`;
        let id = String(appendix?.id || fallbackId).trim() || fallbackId;
        while (usedIds.has(id)) id = `${id}-${index}`;
        usedIds.add(id);
        return { id, name, description: String(appendix?.description ?? '') };
    });
}

export function validateDraft(draft) {
    const errors = String(draft?.name ?? '').trim() ? {} : { name: 'required' };
    for (const [index, appendix] of (draft?.appendices ?? []).entries()) {
        if (String(appendix?.name ?? '').trim()) continue;
        (errors.appendices ??= {})[index] = 'required';
    }
    return { ok: Object.keys(errors).length === 0, errors };
}

const sameValue = (before, after) => JSON.stringify(before) === JSON.stringify(after);

export function changedKeys(before, after, keys = DRAFT_KEYS) {
    return keys.filter(key => !sameValue(before?.[key], after?.[key]));
}

function createDescriptor() {
    return {
        description: '',
        position: PERSONA_POSITION.IN_PROMPT,
        depth: DEFAULT_DEPTH,
        role: DEFAULT_ROLE,
        lorebook: '',
        connections: [],
        title: '',
        appendices: [],
        activeAppendices: {},
    };
}

// Keep detached rollback receipts private, including scope-level pruning outside the draft keys.
const appliedSnapshots = new WeakMap();

export function applyDraft(state, avatarId, baseline, draft) {
    const keys = changedKeys(baseline, draft);
    const previous = {};
    const written = {};
    const prunedScopes = [];
    const oldDescriptor = state.persona_descriptions[avatarId];
    for (const key of keys) {
        previous[key] = structuredClone(key === 'name' ? state.personas[avatarId] : oldDescriptor?.[key]);
        written[key] = structuredClone(key === 'name' ? draft.name.trim() : draft[key]);
        if (key === 'appendices') {
            if (previous[key] !== undefined) previous[key] = canonicalAppendices(previous[key]);
            written[key] = canonicalAppendices(written[key]);
        }
    }

    for (const key of keys) {
        if (key === 'name') {
            state.personas[avatarId] = structuredClone(written[key]);
            continue;
        }
        const descriptor = state.persona_descriptions[avatarId] ??= createDescriptor();
        descriptor[key] = structuredClone(written[key]);
    }

    if (keys.includes('appendices')) {
        const descriptor = state.persona_descriptions[avatarId];
        const appendixIds = new Set(descriptor.appendices.map(appendix => appendix.id));
        for (const [scope, ids] of Object.entries(descriptor.activeAppendices ?? {})) {
            if (!Array.isArray(ids)) continue;
            const pruned = ids.filter(id => appendixIds.has(id));
            if (sameValue(ids, pruned)) continue;
            prunedScopes.push({ scope, previous: structuredClone(ids), written: structuredClone(pruned) });
            descriptor.activeAppendices[scope] = structuredClone(pruned);
        }
    }

    const renamed = keys.includes('name') && previous.name !== written.name
        ? { oldName: previous.name, newName: written.name }
        : null;
    const applied = { keys, previous, renamed };
    appliedSnapshots.set(applied, { written, prunedScopes });
    return applied;
}

export function revertDraft(state, avatarId, applied) {
    const snapshot = appliedSnapshots.get(applied);
    if (!snapshot) return [];
    const reverted = [];
    for (const key of applied.keys) {
        const target = key === 'name' ? state.personas : state.persona_descriptions[avatarId];
        const targetKey = key === 'name' ? avatarId : key;
        if (!target || !sameValue(target[targetKey], snapshot.written[key])) continue;
        if (applied.previous[key] === undefined) delete target[targetKey];
        else target[targetKey] = structuredClone(applied.previous[key]);
        reverted.push(key);
    }

    if (reverted.includes('appendices')) {
        const selections = state.persona_descriptions[avatarId]?.activeAppendices;
        for (const { scope, previous, written } of snapshot.prunedScopes) {
            if (selections && sameValue(selections[scope], written)) selections[scope] = structuredClone(previous);
        }
    }
    appliedSnapshots.delete(applied);
    return reverted;
}

export function rebaseKey(liveDraft, baseline, draft, key) {
    const clean = sameValue(baseline[key], draft[key]);
    const assign = target => {
        if (liveDraft?.[key] === undefined) delete target[key];
        else target[key] = structuredClone(liveDraft[key]);
    };
    assign(baseline);
    if (clean) assign(draft);
    return clean;
}

export function externalChanges(liveDraft, baseline) {
    return changedKeys(baseline, liveDraft);
}

export function fingerprint(snapshot) {
    const sorted = value => {
        if (Array.isArray(value)) return value.map(sorted);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
    };
    return JSON.stringify(sorted(snapshot));
}

export async function commit(deps, avatarId, baseline, draft) {
    const validation = validateDraft(draft);
    if (!validation.ok) return { ok: false, reason: 'invalid', errors: validation.errors };
    const applied = applyDraft(deps.state, avatarId, baseline, draft);
    if (!applied.keys.length) return { ok: true, keys: [] };

    if (deps.isActive(avatarId)) {
        deps.project();
        if (applied.renamed) deps.setUserName(applied.renamed.newName);
    }

    let saved = false;
    let saveError;
    try {
        saved = await deps.save();
    } catch (error) {
        saveError = error;
    }
    if (!saved) {
        revertDraft(deps.state, avatarId, applied);
        if (deps.isActive(avatarId)) {
            deps.project();
            if (applied.renamed) deps.setUserName(applied.renamed.oldName);
        }
        return { ok: false, reason: 'save', ...(saveError === undefined ? {} : { error: saveError }) };
    }

    appliedSnapshots.delete(applied);
    const events = [[deps.events.PERSONA_UPDATED, avatarId]];
    if (applied.renamed) events.push([deps.events.PERSONA_RENAMED, { avatarId, ...applied.renamed }]);
    for (const [event, payload] of events) {
        try {
            await deps.emit(event, payload);
        } catch (error) {
            console.warn('Persona settings saved, but a persona event listener failed', error);
        }
    }
    return { ok: true, keys: applied.keys, renamed: applied.renamed };
}
