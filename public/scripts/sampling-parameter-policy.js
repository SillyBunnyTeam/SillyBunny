/**
 * @file Canonical sampling-parameter policy engine.
 *
 * Shared between Chat Completions and Text Completions. This module owns:
 *  - Canonical parameter descriptors
 *  - Target-key resolution
 *  - Built-in capability registry
 *  - Effective decision resolution (precedence engine)
 *  - Wire-payload sanitization
 *  - Legacy `custom_exclude_body` parsing
 *  - Safe own-property path helpers
 *
 * The module is intentionally free of I/O: it does not read settings, perform
 * network calls, or mutate presets. Callers pass immutable request contexts
 * and receive the mutated payload plus a decision log.
 *
 * @module sampling-parameter-policy
 */

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

/**
 * Current schema version for persisted `model_sampling_policies`.
 * @type {number}
 */
export const POLICY_SCHEMA_VERSION = 1;

/**
 * Sentinel used for the model portion of a target key when no model is selected.
 * @type {string}
 */
export const UNSELECTED_MODEL_SENTINEL = '__unselected__';

/**
 * Valid transmission states.
 * @type {ReadonlyArray<'inherit'|'include'|'omit'>}
 */
export const SAMPLING_TRANSMISSION_STATES = Object.freeze([
    'inherit',
    'include',
    'omit',
]);

/**
 * Segments rejected from any wire path to prevent prototype pollution.
 * @type {ReadonlySet<string>}
 */
const FORBIDDEN_PATH_SEGMENTS = new Set([
    '__proto__',
    'prototype',
    'constructor',
]);

/**
 * Canonical parameter identity.
 * @typedef {'temperature'|'top_p'|'presence_penalty'|'frequency_penalty'|'typical_p'} CanonicalParameterId
 */

/**
 * Backend family.
 * @typedef {'chat'|'text'} SamplingBackend
 */

/**
 * Transmission state.
 * @typedef {'inherit'|'include'|'omit'} SamplingTransmissionState
 */

/**
 * Resolved target identity components.
 * @typedef {Object} SamplingTargetIdentity
 * @property {string} [source]
 * @property {string} [model]
 * @property {string} [customProfileId]
 */

/**
 * Stored per-target policy.
 * @typedef {Object} TargetPolicy
 * @property {Object<string, SamplingTransmissionState>} [parameters]
 * @property {number} [updatedAt]
 */

/**
 * Stored policy root.
 * @typedef {Object} SamplingPolicySettings
 * @property {number} version
 * @property {Object<string, TargetPolicy>} targets
 */

/**
 * Immutable request context.
 * @typedef {Object} SamplingRequestContext
 * @property {SamplingBackend} backend
 * @property {string} source
 * @property {string} model
 * @property {string} [customProfileId]
 * @property {string} [adapter]
 * @property {string} [targetKey]
 * @property {Readonly<Object<string, unknown>>} activeValues
 * @property {Readonly<TargetPolicy>} policy
 * @property {ReadonlySet<string>} legacyExclusions
 */

/**
 * Effective per-parameter decision.
 * @typedef {Object} EffectiveParameterDecision
 * @property {CanonicalParameterId} parameter
 * @property {SamplingTransmissionState} storedState
 * @property {'inherit'|'include'|'omit'} action
 * @property {'provider-default'|'explicit-include'|'explicit-omit'|'legacy-exclusion'|'capability-forbidden'} reason
 * @property {string} [capabilityRuleId]
 * @property {boolean} [unresolved]
 */

// ---------------------------------------------------------------------------
// Canonical parameter descriptors
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SamplingParameterDescriptor
 * @property {CanonicalParameterId} id
 * @property {string} label
 * @property {string} valueKey
 * @property {Object<string, ReadonlyArray<string>>} wirePaths
 */

/**
 * Descriptor table. `wirePaths[backend]` is a single array of path segments.
 * A missing backend entry means the parameter is not emitted by that backend.
 *
 * @type {Readonly<Object<CanonicalParameterId, SamplingParameterDescriptor>>}
 */
export const SAMPLING_PARAMETER_DESCRIPTORS = deepFreeze({
    temperature: {
        id: 'temperature',
        label: 'Temperature',
        valueKey: 'temperature',
        wirePaths: {
            chat: ['temperature'],
            text: ['temperature'],
        },
    },
    top_p: {
        id: 'top_p',
        label: 'Top P',
        valueKey: 'top_p',
        wirePaths: {
            chat: ['top_p'],
            text: ['top_p'],
        },
    },
    presence_penalty: {
        id: 'presence_penalty',
        label: 'Presence Penalty',
        valueKey: 'presence_penalty',
        wirePaths: {
            chat: ['presence_penalty'],
            text: ['presence_penalty'],
        },
    },
    frequency_penalty: {
        id: 'frequency_penalty',
        label: 'Frequency Penalty',
        valueKey: 'frequency_penalty',
        wirePaths: {
            chat: ['frequency_penalty'],
            text: ['frequency_penalty'],
        },
    },
    typical_p: {
        id: 'typical_p',
        label: 'Typical P',
        valueKey: 'typical_p',
        wirePaths: {
            text: ['typical_p'],
        },
    },
});

// ---------------------------------------------------------------------------
// Built-in capability registry
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CapabilityMatch
 * @property {SamplingBackend} [backend]
 * @property {string} [adapter]
 * @property {string} [modelFamily]
 */

/**
 * @typedef {Object} CapabilityRule
 * @property {string} id
 * @property {string} description
 * @property {CapabilityMatch} match
 * @property {ReadonlyArray<CanonicalParameterId>} forbidden
 */

/**
 * Built-in capability rules. Matching is source-agnostic for model-family
 * rules so that proxied Grok / o-series routes are protected. Only
 * adapter/backend-specific rules are scoped to a single route.
 *
 * @type {ReadonlyArray<CapabilityRule>}
 */
export const BUILTIN_SAMPLING_CAPABILITIES = deepFreeze([
    {
        id: 'grok-no-penalties',
        description:
            'Grok-family models reject presence and frequency penalties on affected APIs.',
        match: {
            modelFamily: 'grok',
        },
        forbidden: ['presence_penalty', 'frequency_penalty'],
    },
    {
        id: 'openai-o-series-restricted-sampling',
        description:
            'OpenAI o-series models reject these sampling controls.',
        match: {
            modelFamily: 'openai-o-series',
        },
        forbidden: [
            'temperature',
            'top_p',
            'presence_penalty',
            'frequency_penalty',
        ],
    },
    {
        id: 'ollama-text-no-typical-p',
        description:
            'The Ollama text-generation route rejects options.typical_p.',
        match: {
            backend: 'text',
            adapter: 'ollama',
        },
        forbidden: ['typical_p'],
    },
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Recursively freeze an object graph.
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }
    for (const name of Object.getOwnPropertyNames(obj)) {
        const value = obj[name];
        if (value !== null && typeof value === 'object') {
            deepFreeze(value);
        }
    }
    return Object.freeze(obj);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} segment
 * @returns {boolean}
 */
function isValidPathSegment(segment) {
    if (typeof segment !== 'string') {
        return false;
    }
    if (segment.length === 0) {
        return false;
    }
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Model and target-key normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a model identifier. Model identity is preserved verbatim except
 * for leading/trailing whitespace. Namespace separators (`/`), casing, and
 * punctuation are intentionally retained.
 *
 * @param {unknown} model
 * @returns {string}
 */
export function normalizeModelId(model) {
    if (typeof model !== 'string') {
        return '';
    }
    return model.trim();
}

/**
 * Create a canonical target key for a resolved route/model tuple.
 *
 * Returns `null` when the identity is unstable — that is, when there is
 * neither a stable source nor a custom profile ID.
 *
 * @param {SamplingTargetIdentity} [identity]
 * @returns {string|null}
 */
export function createSamplingTargetKey(identity = {}) {
    const rawSource = typeof identity.source === 'string' ? identity.source.trim() : '';
    const rawProfile = typeof identity.customProfileId === 'string'
        ? identity.customProfileId.trim()
        : '';
    const normalizedModel = normalizeModelId(identity.model);

    const hasSource = rawSource.length > 0;
    const hasProfile = rawProfile.length > 0;
    const sourceIsCustom = rawSource.toLowerCase() === 'custom';

    // Custom routes require a profile ID in the key.
    if (sourceIsCustom && !hasProfile) {
        return null;
    }

    if (!hasSource && !hasProfile) {
        return null;
    }

    const modelPart = normalizedModel.length > 0
        ? normalizedModel
        : UNSELECTED_MODEL_SENTINEL;

    if (hasProfile && (sourceIsCustom || !hasSource)) {
        return `custom:${rawProfile}:${modelPart}`;
    }

    return `${rawSource.toLowerCase()}:${modelPart}`;
}

// ---------------------------------------------------------------------------
// Stored policy normalization
// ---------------------------------------------------------------------------

/**
 * Coerce arbitrary input into a valid transmission state.
 * Anything other than `'include'` or `'omit'` degrades to `'inherit'`.
 *
 * @param {unknown} value
 * @returns {SamplingTransmissionState}
 */
export function normalizeTransmissionState(value) {
    if (value === 'include' || value === 'omit' || value === 'inherit') {
        return value;
    }
    return 'inherit';
}

/**
 * Sanitize a persisted policy map. Malformed target entries and invalid state
 * values are dropped, but valid siblings are preserved.
 *
 * @param {unknown} rawSettings
 * @returns {SamplingPolicySettings}
 */
export function normalizeStoredSamplingPolicies(rawSettings) {
    /** @type {SamplingPolicySettings} */
    const result = { version: POLICY_SCHEMA_VERSION, targets: {} };

    if (!isPlainObject(rawSettings)) {
        return result;
    }

    const rawTargets = rawSettings.targets;
    if (!isPlainObject(rawTargets)) {
        return result;
    }

    for (const [targetKey, rawTarget] of Object.entries(rawTargets)) {
        if (typeof targetKey !== 'string' || targetKey.length === 0) {
            continue;
        }
        if (!isPlainObject(rawTarget)) {
            continue;
        }

        /** @type {Record<string, SamplingTransmissionState>} */
        const parameters = {};
        const rawParams = rawTarget.parameters;
        if (isPlainObject(rawParams)) {
            for (const [paramId, rawState] of Object.entries(rawParams)) {
                if (!Object.prototype.hasOwnProperty.call(SAMPLING_PARAMETER_DESCRIPTORS, paramId)) {
                    // Unknown parameter entries are retained in storage but
                    // ignored by the resolver. We drop them here because the
                    // engine only emits known IDs.
                    continue;
                }
                const state = normalizeTransmissionState(rawState);
                if (state !== 'inherit') {
                    parameters[paramId] = state;
                }
            }
        }

        /** @type {TargetPolicy} */
        const normalizedTarget = { parameters };
        if (typeof rawTarget.updatedAt === 'number' && Number.isFinite(rawTarget.updatedAt)) {
            normalizedTarget.updatedAt = rawTarget.updatedAt;
        }
        result.targets[targetKey] = normalizedTarget;
    }

    return result;
}

/**
 * Read the detached policy object for a target key.
 * An unknown key yields an empty policy rather than a shared singleton.
 *
 * @param {SamplingPolicySettings|undefined|null} policySettings
 * @param {string|null|undefined} targetKey
 * @returns {TargetPolicy}
 */
export function getTargetSamplingPolicy(policySettings, targetKey) {
    if (!targetKey || !isPlainObject(policySettings)) {
        return { parameters: {} };
    }
    const targets = policySettings.targets;
    if (!isPlainObject(targets)) {
        return { parameters: {} };
    }
    const target = targets[targetKey];
    if (!isPlainObject(target) || !isPlainObject(target.parameters)) {
        return { parameters: {} };
    }
    return {
        parameters: { ...target.parameters },
        ...(typeof target.updatedAt === 'number' ? { updatedAt: target.updatedAt } : {}),
    };
}

/**
 * Mutate a stored policy map to reflect a single parameter state change.
 *
 * When `state === 'inherit'`, the explicit entry is removed. When the final
 * explicit entry is removed, the target is pruned. Pruning never touches
 * sibling targets.
 *
 * @param {SamplingPolicySettings} policySettings
 * @param {string} targetKey
 * @param {CanonicalParameterId} parameterId
 * @param {SamplingTransmissionState} state
 * @returns {boolean} Whether the mutation occurred.
 */
export function setTargetParameterState(policySettings, targetKey, parameterId, state) {
    if (!isPlainObject(policySettings)) {
        return false;
    }
    if (typeof targetKey !== 'string' || targetKey.length === 0) {
        return false;
    }
    if (!Object.prototype.hasOwnProperty.call(SAMPLING_PARAMETER_DESCRIPTORS, parameterId)) {
        return false;
    }
    const normalized = normalizeTransmissionState(state);

    if (!isPlainObject(policySettings.targets)) {
        policySettings.targets = {};
    }
    const targets = policySettings.targets;

    /** @type {TargetPolicy} */
    let target = isPlainObject(targets[targetKey])
        ? targets[targetKey]
        : { parameters: {} };
    if (!isPlainObject(target.parameters)) {
        target.parameters = {};
    }

    if (normalized === 'inherit') {
        delete target.parameters[parameterId];
    } else {
        target.parameters[parameterId] = normalized;
    }

    if (Object.keys(target.parameters).length === 0) {
        delete targets[targetKey];
    } else {
        target.updatedAt = Date.now();
        targets[targetKey] = target;
    }

    return true;
}

// ---------------------------------------------------------------------------
// Descriptor + wire path resolution
// ---------------------------------------------------------------------------

/**
 * @param {string} parameterId
 * @returns {SamplingParameterDescriptor|undefined}
 */
export function getSamplingParameterDescriptor(parameterId) {
    return SAMPLING_PARAMETER_DESCRIPTORS[parameterId];
}

/**
 * Resolve the wire path for a canonical parameter in the request context.
 * Returns `null` when the parameter is not emitted by the backend.
 *
 * @param {CanonicalParameterId} parameterId
 * @param {Partial<SamplingRequestContext>|null|undefined} requestContext
 * @returns {ReadonlyArray<string>|null}
 */
export function getWirePath(parameterId, requestContext) {
    const descriptor = SAMPLING_PARAMETER_DESCRIPTORS[parameterId];
    if (!descriptor) {
        return null;
    }
    const backend = requestContext && requestContext.backend;
    if (!backend) {
        return null;
    }
    const candidate = descriptor.wirePaths[backend];
    if (!candidate || candidate.length === 0) {
        return null;
    }
    return candidate;
}

// ---------------------------------------------------------------------------
// Capability matching
// ---------------------------------------------------------------------------

/**
 * Match a model family identifier against a model string using anchored
 * segment matching. Source is intentionally not consulted.
 *
 * @param {string} family
 * @param {string} model
 * @returns {boolean}
 */
function matchModelFamily(family, model) {
    if (typeof model !== 'string' || model.length === 0) {
        return false;
    }
    switch (family) {
        case 'grok':
            return /(?:^|[/:_-])grok(?:$|[/:_-])/i.test(model);
        case 'openai-o-series':
            return /(?:^|[/:_-])o[134](?:-mini|-preview)?(?:$|[/:_-])/i.test(model);
        default:
            return false;
    }
}

/**
 * @param {CapabilityRule} rule
 * @param {Partial<SamplingRequestContext>} requestContext
 * @returns {boolean}
 */
function matchCapabilityRule(rule, requestContext) {
    const match = rule.match || {};

    if (match.backend && match.backend !== requestContext.backend) {
        return false;
    }

    if (match.adapter) {
        const ctxAdapter = typeof requestContext.adapter === 'string'
            ? requestContext.adapter.toLowerCase()
            : '';
        if (ctxAdapter !== String(match.adapter).toLowerCase()) {
            return false;
        }
    }

    if (match.modelFamily) {
        if (!matchModelFamily(match.modelFamily, requestContext.model || '')) {
            return false;
        }
    }

    return true;
}

/**
 * Return every built-in rule that matches the request context. Multiple
 * matching rules are unioned by the resolver.
 *
 * @param {Partial<SamplingRequestContext>|null|undefined} requestContext
 * @returns {CapabilityRule[]}
 */
export function getMatchingCapabilityRules(requestContext) {
    if (!requestContext) {
        return [];
    }
    const matched = [];
    for (const rule of BUILTIN_SAMPLING_CAPABILITIES) {
        if (matchCapabilityRule(rule, requestContext)) {
            matched.push(rule);
        }
    }
    return matched;
}

/**
 * @param {CanonicalParameterId} parameterId
 * @param {Partial<SamplingRequestContext>|null|undefined} requestContext
 * @returns {{ forbidden: boolean, ruleId?: string }}
 */
function isForbiddenByCapability(parameterId, requestContext) {
    const rules = getMatchingCapabilityRules(requestContext);
    for (const rule of rules) {
        if (rule.forbidden && rule.forbidden.includes(parameterId)) {
            return { forbidden: true, ruleId: rule.id };
        }
    }
    return { forbidden: false };
}

// ---------------------------------------------------------------------------
// Precedence resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the effective transmission decision for a single parameter.
 *
 * Precedence:
 *   1. built-in capability forbid
 *   2. explicit omit
 *   3. explicit include
 *   4. legacy exclusion
 *   5. inherit (provider default)
 *
 * @param {CanonicalParameterId} parameterId
 * @param {Partial<SamplingRequestContext>|null|undefined} requestContext
 * @returns {EffectiveParameterDecision}
 */
export function resolveEffectiveParameterDecision(parameterId, requestContext) {
    const ctx = requestContext || {};
    const storedState = normalizeTransmissionState(
        ctx.policy && ctx.policy.parameters
            ? ctx.policy.parameters[parameterId]
            : undefined,
    );

    const capability = isForbiddenByCapability(parameterId, ctx);
    if (capability.forbidden) {
        return {
            parameter: parameterId,
            storedState,
            action: 'omit',
            reason: 'capability-forbidden',
            capabilityRuleId: capability.ruleId,
        };
    }

    if (storedState === 'omit') {
        return {
            parameter: parameterId,
            storedState,
            action: 'omit',
            reason: 'explicit-omit',
        };
    }

    if (storedState === 'include') {
        return {
            parameter: parameterId,
            storedState,
            action: 'include',
            reason: 'explicit-include',
        };
    }

    const legacy = ctx.legacyExclusions;
    if (legacy && typeof legacy.has === 'function' && legacy.has(parameterId)) {
        return {
            parameter: parameterId,
            storedState,
            action: 'omit',
            reason: 'legacy-exclusion',
        };
    }

    return {
        parameter: parameterId,
        storedState,
        action: 'inherit',
        reason: 'provider-default',
    };
}

// ---------------------------------------------------------------------------
// Safe path helpers
// ---------------------------------------------------------------------------

/**
 * Read a value at `path` when every segment is an own property on an object.
 * Returns `undefined` for a missing path or a prototype-sensitive segment.
 *
 * @param {unknown} object
 * @param {ReadonlyArray<string>} path
 * @returns {unknown}
 */
export function getOwnPath(object, path) {
    if (!isPlainObject(object) && typeof object !== 'object') {
        return undefined;
    }
    if (!Array.isArray(path) || path.length === 0) {
        return undefined;
    }
    let current = object;
    for (const segment of path) {
        if (!isValidPathSegment(segment)) {
            return undefined;
        }
        if (current === null || typeof current !== 'object') {
            return undefined;
        }
        if (!Object.prototype.hasOwnProperty.call(current, segment)) {
            return undefined;
        }
        current = current[segment];
    }
    return current;
}

/**
 * Set a value at `path`, materializing intermediate plain object containers
 * when they do not exist. Rejects any forbidden or non-string segment.
 *
 * @param {Record<string, unknown>} object
 * @param {ReadonlyArray<string>} path
 * @param {unknown} value
 * @returns {boolean}
 */
export function setOwnPath(object, path, value) {
    if (!isPlainObject(object)) {
        return false;
    }
    if (!Array.isArray(path) || path.length === 0) {
        return false;
    }
    for (const segment of path) {
        if (!isValidPathSegment(segment)) {
            return false;
        }
    }

    let current = object;
    for (let i = 0; i < path.length - 1; i += 1) {
        const segment = path[i];
        if (!Object.prototype.hasOwnProperty.call(current, segment)) {
            current[segment] = {};
        }
        const next = current[segment];
        if (!isPlainObject(next)) {
            return false;
        }
        current = next;
    }
    current[path[path.length - 1]] = value;
    return true;
}

/**
 * Delete the terminal own property at `path`. Missing intermediates are a
 * silent no-op. Inherited properties are never traversed or deleted.
 *
 * @param {Record<string, unknown>} object
 * @param {ReadonlyArray<string>} path
 * @returns {boolean} `true` when a property was deleted.
 */
export function deleteOwnPath(object, path) {
    if (!isPlainObject(object)) {
        return false;
    }
    if (!Array.isArray(path) || path.length === 0) {
        return false;
    }
    for (const segment of path) {
        if (!isValidPathSegment(segment)) {
            return false;
        }
    }

    let current = object;
    for (let i = 0; i < path.length - 1; i += 1) {
        const segment = path[i];
        if (!Object.prototype.hasOwnProperty.call(current, segment)) {
            return false;
        }
        const next = current[segment];
        if (!isPlainObject(next)) {
            return false;
        }
        current = next;
    }

    const terminal = path[path.length - 1];
    if (!Object.prototype.hasOwnProperty.call(current, terminal)) {
        return false;
    }
    delete current[terminal];
    return true;
}

// ---------------------------------------------------------------------------
// Request context builder
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CreateSamplingContextInput
 * @property {SamplingBackend} backend
 * @property {string} [source]
 * @property {string} [model]
 * @property {string} [customProfileId]
 * @property {string} [adapter]
 * @property {Object<string, unknown>} [activeValues]
 * @property {TargetPolicy} [policy]
 * @property {Iterable<string>|ReadonlySet<string>} [legacyExclusions]
 */

/**
 * Build an immutable request context. Once created, later changes to settings
 * cannot leak into a request already under construction.
 *
 * @param {CreateSamplingContextInput} input
 * @returns {SamplingRequestContext}
 */
export function createSamplingRequestContext(input) {
    const safeInput = input || {};
    const descriptor = SAMPLING_PARAMETER_DESCRIPTORS;

    const activeValuesSource = isPlainObject(safeInput.activeValues)
        ? safeInput.activeValues
        : {};
    const activeValues = Object.create(null);
    for (const id of Object.keys(descriptor)) {
        const key = descriptor[id].valueKey;
        if (Object.prototype.hasOwnProperty.call(activeValuesSource, key)) {
            activeValues[id] = activeValuesSource[key];
        }
    }

    const policySource = isPlainObject(safeInput.policy)
        ? safeInput.policy
        : { parameters: {} };
    const parameters = {};
    if (isPlainObject(policySource.parameters)) {
        for (const [id, state] of Object.entries(policySource.parameters)) {
            if (!Object.prototype.hasOwnProperty.call(descriptor, id)) {
                continue;
            }
            const normalized = normalizeTransmissionState(state);
            if (normalized !== 'inherit') {
                parameters[id] = normalized;
            }
        }
    }
    const policy = Object.freeze({ parameters: Object.freeze(parameters) });

    const legacySource = safeInput.legacyExclusions;
    const legacyExclusions = legacySource instanceof Set
        ? new Set(legacySource)
        : new Set(Array.isArray(legacySource) ? legacySource : []);

    const targetKey = createSamplingTargetKey({
        source: safeInput.source,
        model: safeInput.model,
        customProfileId: safeInput.customProfileId,
    }) || '';

    return Object.freeze({
        backend: safeInput.backend,
        source: safeInput.source || '',
        model: normalizeModelId(safeInput.model),
        customProfileId: safeInput.customProfileId || undefined,
        adapter: safeInput.adapter || undefined,
        targetKey,
        activeValues: Object.freeze(activeValues),
        policy,
        legacyExclusions,
    });
}

// ---------------------------------------------------------------------------
// Final policy application
// ---------------------------------------------------------------------------

/**
 * Apply the resolved policy to a newly-constructed payload. Mutates only
 * `payload`; never touches presets, settings, or live form controls.
 *
 * @param {Record<string, unknown>} payload
 * @param {SamplingRequestContext} requestContext
 * @returns {{ payload: Record<string, unknown>, decisions: EffectiveParameterDecision[] }}
 */
export function applySamplingParameterPolicy(payload, requestContext) {
    /** @type {EffectiveParameterDecision[]} */
    const decisions = [];

    if (!isPlainObject(payload)) {
        return { payload, decisions };
    }

    const ctx = requestContext || {};
    const parameterIds = Object.keys(SAMPLING_PARAMETER_DESCRIPTORS);

    for (const parameterId of parameterIds) {
        const decision = resolveEffectiveParameterDecision(parameterId, ctx);
        const wirePath = getWirePath(parameterId, ctx);
        if (!wirePath || wirePath.length === 0) {
            decisions.push(decision);
            continue;
        }

        if (decision.action === 'omit') {
            deleteOwnPath(payload, wirePath);
            if (parameterId === 'typical_p' && ctx.backend === 'text') {
                // SillyBunny: text backends also consume the legacy flat alias.
                deleteOwnPath(payload, ['typical']);
            }
            decisions.push(decision);
            continue;
        }

        if (decision.action === 'include') {
            const activeValue = ctx.activeValues
                ? ctx.activeValues[parameterId]
                : undefined;

            // `null` and `undefined` are not valid active values. Do NOT
            // invent a default; the caller must observe the unresolved flag.
            if (activeValue === undefined || activeValue === null) {
                decisions.push({ ...decision, unresolved: true });
                continue;
            }

            setOwnPath(payload, wirePath, activeValue);
            if (parameterId === 'typical_p' && ctx.backend === 'text' && Object.hasOwn(payload, 'typical')) {
                setOwnPath(payload, ['typical'], activeValue);
            }
            decisions.push(decision);
            continue;
        }

        // inherit: leave the payload untouched.
        decisions.push(decision);
    }

    return { payload, decisions };
}

// ---------------------------------------------------------------------------
// Legacy exclusions
// ---------------------------------------------------------------------------

/**
 * Map a legacy string entry to a canonical parameter ID.
 * Returns `null` for arbitrary or prototype-sensitive entries.
 *
 * @param {string} raw
 * @returns {CanonicalParameterId|null}
 */
function mapLegacyExclusionToCanonicalId(raw) {
    if (typeof raw !== 'string') {
        return null;
    }
    const cleaned = raw.trim();
    if (cleaned.length === 0) {
        return null;
    }
    // Reject prototype-sensitive segments anywhere in the entry.
    for (const segment of cleaned.split('.')) {
        if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
            return null;
        }
    }
    if (Object.prototype.hasOwnProperty.call(SAMPLING_PARAMETER_DESCRIPTORS, cleaned)) {
        return /** @type {CanonicalParameterId} */ (cleaned);
    }
    if (cleaned === 'options.typical_p') {
        return 'typical_p';
    }
    return null;
}

/**
 * Parse legacy `custom_exclude_body` input into a fresh Set of canonical IDs.
 * Supports arrays, JSON arrays, YAML-style lists, and comma/newline lists.
 *
 * @param {unknown} rawValue
 * @returns {Set<CanonicalParameterId>}
 */
export function parseLegacySamplingExclusions(rawValue) {
    /** @type {Set<CanonicalParameterId>} */
    const result = new Set();
    if (rawValue === null || rawValue === undefined) {
        return result;
    }

    /** @type {unknown[]} */
    let candidates = [];

    if (Array.isArray(rawValue)) {
        candidates = rawValue;
    } else if (typeof rawValue === 'string') {
        const trimmed = rawValue.trim();
        if (trimmed.length === 0) {
            return result;
        }

        if (trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    candidates = parsed;
                }
            } catch (_err) {
                // fall through to other parsers
            }
        }

        if (candidates.length === 0) {
            const lines = trimmed.split(/\r?\n/);
            const yamlCandidates = [];
            let yamlCompatible = true;
            for (const line of lines) {
                const lineTrimmed = line.trim();
                if (lineTrimmed.length === 0) {
                    continue;
                }
                if (lineTrimmed.startsWith('-')) {
                    yamlCandidates.push(lineTrimmed.slice(1).trim());
                } else {
                    yamlCompatible = false;
                    break;
                }
            }
            if (yamlCompatible && yamlCandidates.length > 0) {
                candidates = yamlCandidates;
            } else {
                candidates = trimmed
                    .split(/[,\n]+/)
                    .map(entry => entry.trim())
                    .filter(entry => entry.length > 0);
            }
        }
    } else {
        return result;
    }

    for (const candidate of candidates) {
        if (typeof candidate !== 'string') {
            continue;
        }
        const canonical = mapLegacyExclusionToCanonicalId(candidate);
        if (canonical) {
            result.add(canonical);
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// UI subscription primitives
// ---------------------------------------------------------------------------

/** @type {Set<(payload: { targetKey: string, parameterId?: CanonicalParameterId }) => void>} */
const policySubscribers = new Set();

/**
 * Subscribe to policy target changes. Returns an unsubscribe function.
 *
 * @param {(payload: { targetKey: string, parameterId?: CanonicalParameterId }) => void} callback
 * @returns {() => void}
 */
export function subscribeToSamplingPolicyTargetChanges(callback) {
    if (typeof callback !== 'function') {
        return () => {};
    }
    policySubscribers.add(callback);
    return () => {
        policySubscribers.delete(callback);
    };
}

/**
 * Notify subscribers of a change. Safe to call even when there are none.
 *
 * @param {{ targetKey: string, parameterId?: CanonicalParameterId }} payload
 */
export function notifySamplingPolicyTargetChange(payload) {
    for (const callback of policySubscribers) {
        try {
            callback(payload);
        } catch (err) {
            // Bounded: never let a subscriber throw into engine code.
            console.error('[sampling-policy] subscriber error', err);
        }
    }
}
