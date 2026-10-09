/** @typedef {{mode: 'opaque', text: string}|{mode: 'parts', recipeId: string, profile: string, voice: string}} Description */
/** @typedef {{target: string, value: string|Description, before: string|Description, inputRevision: number, runId: number}} Candidate */
/** @typedef {{name: string, description: string, personality: string, scenario: string, first_mes: string, mes_example: string, alternate_greetings: string[]}} CardFields */

export const CARD_FIELDS = Object.freeze(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'alternate_greetings']);
const SCALAR_FIELDS = CARD_FIELDS.filter(field => field !== 'alternate_greetings');
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function copyDescription(value) {
    if (!isObject(value)) {
        throw new Error('Invalid description.');
    }
    if (value.mode === 'opaque' && typeof value.text === 'string') {
        return { mode: 'opaque', text: value.text };
    }
    if (value.mode === 'parts' && typeof value.recipeId === 'string' && value.recipeId
        && typeof value.profile === 'string' && typeof value.voice === 'string') {
        return { mode: 'parts', recipeId: value.recipeId, profile: value.profile, voice: value.voice };
    }
    throw new Error('Invalid description.');
}

function equal(left, right) {
    if (left === right) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((value, index) => value === right[index]);
    }
    if (isObject(left) && isObject(right)) {
        const keys = Object.keys(left);
        return keys.length === Object.keys(right).length && keys.every(key => has(right, key) && equal(left[key], right[key]));
    }
    return false;
}

function cloneField(value) {
    return Array.isArray(value) ? [...value] : value;
}

function touch(draft) {
    draft.revision++;
    draft.updatedAt = Date.now();
}

/** @returns {CardFields} */
export function normalizeCardFields(card) {
    const root = isObject(card) ? card : {};
    const data = isObject(root.data) ? root.data : {};
    const fields = {};
    for (const field of CARD_FIELDS) {
        const value = has(data, field) ? data[field] : root[field];
        fields[field] = field === 'alternate_greetings'
            ? (Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])
            : (typeof value === 'string' ? value : '');
    }
    return fields;
}

export function createDraft({ sourceAvatar = null, fields = null, recipeId = 'tld-hybrid' } = {}) {
    const baseline = normalizeCardFields(fields);
    const imported = sourceAvatar !== null || fields !== null;
    return {
        version: 1,
        sourceAvatar,
        baseline,
        recipeId,
        brief: '',
        answers: '',
        additionalInstructions: '',
        sectionMaxTokens: 4096,
        profileId: '',
        generationTargets: [],
        working: {
            ...baseline,
            description: imported
                ? { mode: 'opaque', text: baseline.description }
                : { mode: 'parts', recipeId, profile: '', voice: '' },
            alternate_greetings: baseline.alternate_greetings.map((text, index) => ({ id: index + 1, text })),
        },
        candidates: [],
        revision: 0,
        nextGreetingId: baseline.alternate_greetings.length + 1,
        updatedAt: Date.now(),
    };
}

/** @param {Description} description */
export function projectDescription(description) {
    const value = copyDescription(description);
    return value.mode === 'opaque' ? value.text : [value.profile, value.voice].filter(text => text !== '').join('\n\n');
}

/** @returns {CardFields} */
export function projectCardFields(draft) {
    const fields = {};
    for (const field of CARD_FIELDS) {
        if (field === 'description') fields[field] = projectDescription(draft.working.description);
        else if (field === 'alternate_greetings') fields[field] = draft.working.alternate_greetings.map(entry => entry.text);
        else fields[field] = draft.working[field];
    }
    return fields;
}

function resolveTarget(draft, target) {
    if (SCALAR_FIELDS.includes(target)) return { object: draft.working, key: target };
    if (target === 'profile' || target === 'voice') {
        if (draft.working.description.mode !== 'parts') {
            throw new Error('Convert the opaque description before editing its blocks.');
        }
        return { object: draft.working.description, key: target };
    }
    if (typeof target === 'string' && /^greeting:[1-9]\d*$/.test(target)) {
        const id = Number(target.slice('greeting:'.length));
        const entry = draft.working.alternate_greetings.find(greeting => greeting.id === id);
        if (entry) return { object: entry, key: 'text' };
    }
    throw new Error(`Unknown or missing draft target: ${String(target)}`);
}

/** Returns a snapshot so a later manual edit cannot mutate a captured before-value. */
export function getDraftTarget(draft, target) {
    const { object, key } = resolveTarget(draft, target);
    return target === 'description' ? copyDescription(object[key]) : object[key];
}

function validateTargetValue(target, value) {
    if (target === 'description') {
        return typeof value === 'string' ? { mode: 'opaque', text: value } : copyDescription(value);
    }
    if (typeof value !== 'string') throw new Error(`The ${target} target requires text.`);
    return value;
}

export function setDraftTarget(draft, target, value) {
    const { object, key } = resolveTarget(draft, target);
    const validated = validateTargetValue(target, value);
    object[key] = validated;
    touch(draft);
    return draft;
}

/** @param {Candidate} candidate */
export function acceptCandidate(draft, candidate) {
    if (!isObject(candidate) || !draft.candidates.includes(candidate)) {
        throw new Error('This proposal is no longer staged.');
    }
    if (!Number.isSafeInteger(candidate.inputRevision) || candidate.inputRevision < 0
        || !Number.isSafeInteger(candidate.runId) || candidate.runId < 0) {
        throw new Error('Invalid proposal revision or run.');
    }
    const current = getDraftTarget(draft, candidate.target);
    validateTargetValue(candidate.target, candidate.value);
    if (!equal(current, candidate.before)) {
        const error = new Error('The target changed after generation. Reconcile the current and proposed values before accepting.');
        error.current = current;
        error.proposed = candidate.value;
        throw error;
    }
    setDraftTarget(draft, candidate.target, candidate.value);
    draft.candidates.splice(draft.candidates.indexOf(candidate), 1);
    return draft;
}

export function buildCharacterPatch(draft, selectedFields, latestFields) {
    const selected = new Set(selectedFields);
    for (const field of selected) {
        if (!CARD_FIELDS.includes(field)) throw new Error(`Unknown character field: ${String(field)}`);
    }
    const latest = normalizeCardFields(latestFields);
    const proposed = projectCardFields(draft);
    const patch = { avatar: draft.sourceAvatar, data: {} };
    const conflicts = [];
    const changedFields = [];
    const alreadySavedFields = [];
    for (const field of CARD_FIELDS) {
        if (!selected.has(field) || equal(proposed[field], draft.baseline[field])) continue;
        if (equal(latest[field], proposed[field])) {
            alreadySavedFields.push(field);
        } else if (!equal(latest[field], draft.baseline[field])) {
            conflicts.push({ field, baseline: cloneField(draft.baseline[field]), current: cloneField(latest[field]), proposed: cloneField(proposed[field]) });
        } else {
            changedFields.push(field);
            patch.data[field] = cloneField(proposed[field]);
            if (field !== 'alternate_greetings') patch[field] = proposed[field];
        }
    }
    return { patch, conflicts, changedFields, alreadySavedFields };
}

function replaceProjectedField(draft, field, value) {
    if (field === 'description') {
        draft.working.description = { mode: 'opaque', text: value };
    } else if (field === 'alternate_greetings') {
        const old = draft.working.alternate_greetings;
        const used = new Set();
        // Match unchanged text first, including moved slots; reuse remaining positions for changed text.
        const matches = value.map(text => {
            const entry = old.find(item => !used.has(item.id) && item.text === text);
            if (entry) used.add(entry.id);
            return entry;
        });
        draft.working.alternate_greetings = value.map((text, index) => {
            const entry = matches[index] || old.find(item => !used.has(item.id));
            if (entry) used.add(entry.id);
            return { id: entry ? entry.id : draft.nextGreetingId++, text };
        });
    } else {
        draft.working[field] = value;
    }
}

/** Only submitted keys acknowledge a save; dirty unselected baselines retain their conflict history. */
export function reconcileSavedFields(draft, submittedFields, latestFields) {
    const latest = normalizeCardFields(latestFields);
    const current = projectCardFields(draft);
    for (const field of Object.keys(submittedFields)) {
        if (!CARD_FIELDS.includes(field)) throw new Error(`Unknown submitted field: ${field}`);
        const value = submittedFields[field];
        if (field === 'alternate_greetings' ? !Array.isArray(value) || value.some(item => typeof item !== 'string') : typeof value !== 'string') {
            throw new Error(`Invalid submitted field: ${field}`);
        }
    }
    for (const field of CARD_FIELDS) {
        if (has(submittedFields, field)) {
            draft.baseline[field] = cloneField(submittedFields[field]);
        } else if (equal(current[field], draft.baseline[field])) {
            if (!equal(current[field], latest[field])) replaceProjectedField(draft, field, latest[field]);
            draft.baseline[field] = cloneField(latest[field]);
        }
    }
    touch(draft);
    return draft;
}
