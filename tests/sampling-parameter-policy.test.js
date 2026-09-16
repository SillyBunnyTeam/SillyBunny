/**
 * @jest-environment node
 */

import {
    BUILTIN_SAMPLING_CAPABILITIES,
    POLICY_SCHEMA_VERSION,
    SAMPLING_PARAMETER_DESCRIPTORS,
    UNSELECTED_MODEL_SENTINEL,
    applySamplingParameterPolicy,
    createSamplingRequestContext,
    createSamplingTargetKey,
    deleteOwnPath,
    getMatchingCapabilityRules,
    getOwnPath,
    getSamplingParameterDescriptor,
    getTargetSamplingPolicy,
    getWirePath,
    normalizeModelId,
    normalizeStoredSamplingPolicies,
    normalizeTransmissionState,
    parseLegacySamplingExclusions,
    resolveEffectiveParameterDecision,
    setOwnPath,
    setTargetParameterState,
} from '../public/scripts/sampling-parameter-policy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {Partial<import('../public/scripts/sampling-parameter-policy.js').SamplingRequestContext>} overrides */
function makeContext(overrides = {}) {
    const base = createSamplingRequestContext({
        backend: overrides.backend || 'chat',
        source: overrides.source ?? 'openai',
        model: overrides.model ?? 'gpt-4.1',
        customProfileId: overrides.customProfileId,
        adapter: overrides.adapter,
        activeValues: overrides.activeValues || {},
        policy: overrides.policy || { parameters: {} },
        legacyExclusions: overrides.legacyExclusions || new Set(),
    });
    return base;
}

// ---------------------------------------------------------------------------
// normalizeModelId
// ---------------------------------------------------------------------------

describe('normalizeModelId', () => {
    test('trims and preserves meaningful characters', () => {
        expect(normalizeModelId('  x-ai/grok-2  ')).toBe('x-ai/grok-2');
        expect(normalizeModelId('openai/o3-mini')).toBe('openai/o3-mini');
    });
    test('coerces non-strings to empty', () => {
        expect(normalizeModelId(null)).toBe('');
        expect(normalizeModelId(undefined)).toBe('');
        expect(normalizeModelId(42)).toBe('');
    });
});

// ---------------------------------------------------------------------------
// createSamplingTargetKey
// ---------------------------------------------------------------------------

describe('createSamplingTargetKey', () => {
    test('standard source + model', () => {
        expect(createSamplingTargetKey({ source: 'openai', model: 'gpt-4.1' }))
            .toBe('openai:gpt-4.1');
    });
    test('namespaced model preserved', () => {
        expect(createSamplingTargetKey({ source: 'openrouter', model: 'x-ai/grok-2' }))
            .toBe('openrouter:x-ai/grok-2');
    });
    test('custom profile isolation', () => {
        const a = createSamplingTargetKey({ source: 'custom', model: 'model-x', customProfileId: 'p1' });
        const b = createSamplingTargetKey({ source: 'custom', model: 'model-x', customProfileId: 'p2' });
        expect(a).toBe('custom:p1:model-x');
        expect(b).toBe('custom:p2:model-x');
        expect(a).not.toBe(b);
    });
    test('empty model uses sentinel', () => {
        expect(createSamplingTargetKey({ source: 'openai', model: '' }))
            .toBe(`openai:${UNSELECTED_MODEL_SENTINEL}`);
        expect(createSamplingTargetKey({ source: 'custom', model: '   ', customProfileId: 'p1' }))
            .toBe(`custom:p1:${UNSELECTED_MODEL_SENTINEL}`);
    });
    test('unstable identity returns null', () => {
        expect(createSamplingTargetKey({ source: '', model: 'gpt-4.1' })).toBeNull();
        expect(createSamplingTargetKey({ source: 'custom', model: 'x' })).toBeNull();
    });
    test('whitespace does not create accidental duplicates', () => {
        const a = createSamplingTargetKey({ source: ' openai ', model: ' gpt-4.1 ' });
        const b = createSamplingTargetKey({ source: 'openai', model: 'gpt-4.1' });
        expect(a).toBe(b);
    });
});

// ---------------------------------------------------------------------------
// Policy storage
// ---------------------------------------------------------------------------

describe('normalizeStoredSamplingPolicies', () => {
    test('missing input yields empty versioned policy', () => {
        expect(normalizeStoredSamplingPolicies(undefined))
            .toEqual({ version: POLICY_SCHEMA_VERSION, targets: {} });
    });
    test('invalid state values degrade to inherit (dropped)', () => {
        const raw = {
            version: 1,
            targets: {
                'openai:gpt-4.1': {
                    parameters: {
                        temperature: 'BOGUS',
                        top_p: 'omit',
                    },
                },
            },
        };
        const normalized = normalizeStoredSamplingPolicies(raw);
        expect(normalized.targets['openai:gpt-4.1'].parameters).toEqual({ top_p: 'omit' });
    });
    test('unknown parameter ids are ignored', () => {
        const normalized = normalizeStoredSamplingPolicies({
            targets: {
                'openai:gpt-4.1': {
                    parameters: { made_up: 'omit', top_p: 'omit' },
                },
            },
        });
        expect(Object.keys(normalized.targets['openai:gpt-4.1'].parameters))
            .toEqual(['top_p']);
    });
});

describe('getTargetSamplingPolicy / setTargetParameterState', () => {
    test('unknown target yields empty policy (no shared mutable singleton)', () => {
        const settings = { version: 1, targets: {} };
        const a = getTargetSamplingPolicy(settings, 'openai:gpt-4.1');
        const b = getTargetSamplingPolicy(settings, 'openai:gpt-4.1');
        a.parameters.temperature = 'omit';
        expect(b.parameters.temperature).toBeUndefined();
    });
    test('sparse storage prunes empty entries', () => {
        const settings = { version: 1, targets: {} };
        setTargetParameterState(settings, 'openai:gpt-4.1', 'temperature', 'omit');
        expect(settings.targets['openai:gpt-4.1'].parameters).toEqual({ temperature: 'omit' });
        setTargetParameterState(settings, 'openai:gpt-4.1', 'temperature', 'inherit');
        expect(settings.targets['openai:gpt-4.1']).toBeUndefined();
    });
    test('invalid state degrades to inherit', () => {
        const settings = { version: 1, targets: {} };
        setTargetParameterState(settings, 'openai:gpt-4.1', 'temperature', 'lol');
        expect(settings.targets['openai:gpt-4.1']).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe('path helpers', () => {
    test('getOwnPath requires own properties', () => {
        const obj = { options: { typical_p: 0.95 } };
        expect(getOwnPath(obj, ['options', 'typical_p'])).toBe(0.95);
        expect(getOwnPath(obj, ['options', 'missing'])).toBeUndefined();
        expect(getOwnPath(obj, ['missing', 'typical_p'])).toBeUndefined();
    });
    test('setOwnPath materializes containers', () => {
        const obj = {};
        expect(setOwnPath(obj, ['options', 'typical_p'], 0.9)).toBe(true);
        expect(obj).toEqual({ options: { typical_p: 0.9 } });
    });
    test('deleteOwnPath removes own terminal property only', () => {
        const obj = { presence_penalty: 0, temperature: 1 };
        expect(deleteOwnPath(obj, ['presence_penalty'])).toBe(true);
        expect(Object.hasOwn(obj, 'presence_penalty')).toBe(false);
        expect(obj.temperature).toBe(1);
    });
    test('deleteOwnPath handles nested', () => {
        const obj = { options: { typical_p: 0.9, other: 1 } };
        expect(deleteOwnPath(obj, ['options', 'typical_p'])).toBe(true);
        expect(Object.hasOwn(obj.options, 'typical_p')).toBe(false);
        expect(obj.options.other).toBe(1);
    });
    test('deleteOwnPath tolerates missing intermediates', () => {
        expect(deleteOwnPath({}, ['options', 'typical_p'])).toBe(false);
    });
    test('prototype-sensitive segments rejected', () => {
        const obj = {};
        expect(setOwnPath(obj, ['__proto__', 'x'], 1)).toBe(false);
        expect(setOwnPath(obj, ['constructor', 'prototype'], 1)).toBe(false);
        expect(setOwnPath(obj, ['prototype'], 1)).toBe(false);
        expect(deleteOwnPath({}, ['__proto__'])).toBe(false);
        expect(getOwnPath({}, ['__proto__'])).toBeUndefined();
        expect(Object.prototype.x).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Capability matching
// ---------------------------------------------------------------------------

describe('capability matching', () => {
    const grokPositives = [
        'grok-2',
        'grok-2-latest',
        'x-ai/grok-2',
        'openrouter/x-ai/grok-2',
    ];
    const grokNegatives = [
        'gpt-4.1',
        'gpt-4o',
        'claude-3-sonnet',
        'grokking-test',
    ];
    test.each(grokPositives)('grok positive: %s', model => {
        const rules = getMatchingCapabilityRules({ backend: 'chat', model });
        expect(rules.map(r => r.id)).toContain('grok-no-penalties');
    });
    test.each(grokNegatives)('grok negative: %s', model => {
        const rules = getMatchingCapabilityRules({ backend: 'chat', model });
        expect(rules.map(r => r.id)).not.toContain('grok-no-penalties');
    });

    const oSeriesPositives = [
        'o1',
        'o1-mini',
        'o3',
        'openai/o3-mini',
        'o4-mini',
    ];
    const oSeriesNegatives = [
        'gpt-4o',
        'gpt-4.1',
        'claude-3-sonnet',
    ];
    test.each(oSeriesPositives)('o-series positive: %s', model => {
        const rules = getMatchingCapabilityRules({ backend: 'chat', model });
        expect(rules.map(r => r.id))
            .toContain('openai-o-series-restricted-sampling');
    });
    test.each(oSeriesNegatives)('o-series negative: %s', model => {
        const rules = getMatchingCapabilityRules({ backend: 'chat', model });
        expect(rules.map(r => r.id))
            .not.toContain('openai-o-series-restricted-sampling');
    });

    test('Ollama text route matches, other text adapters do not', () => {
        const ollama = getMatchingCapabilityRules({
            backend: 'text',
            adapter: 'ollama',
            model: 'llama-3.1-8b',
        });
        expect(ollama.map(r => r.id)).toContain('ollama-text-no-typical-p');

        const llamaCpp = getMatchingCapabilityRules({
            backend: 'text',
            adapter: 'llamacpp',
            model: 'llama-3.1-8b',
        });
        expect(llamaCpp.map(r => r.id)).not.toContain('ollama-text-no-typical-p');
    });
});

// ---------------------------------------------------------------------------
// Resolver precedence
// ---------------------------------------------------------------------------

describe('resolveEffectiveParameterDecision — precedence', () => {
    test('capability forbidden overrides explicit include', () => {
        const ctx = makeContext({
            model: 'o1-mini',
            policy: { parameters: { temperature: 'include' } },
        });
        const decision = resolveEffectiveParameterDecision('temperature', ctx);
        expect(decision.action).toBe('omit');
        expect(decision.reason).toBe('capability-forbidden');
        expect(decision.storedState).toBe('include');
        expect(decision.capabilityRuleId).toBe('openai-o-series-restricted-sampling');
    });
    test('explicit omit wins over legacy exclusion', () => {
        const ctx = makeContext({
            policy: { parameters: { temperature: 'omit' } },
            legacyExclusions: new Set(['temperature']),
        });
        const decision = resolveEffectiveParameterDecision('temperature', ctx);
        expect(decision.reason).toBe('explicit-omit');
    });
    test('explicit include overrides legacy exclusion', () => {
        const ctx = makeContext({
            policy: { parameters: { temperature: 'include' } },
            legacyExclusions: new Set(['temperature']),
        });
        const decision = resolveEffectiveParameterDecision('temperature', ctx);
        expect(decision.reason).toBe('explicit-include');
    });
    test('legacy exclusion applies when state is inherit', () => {
        const ctx = makeContext({
            legacyExclusions: new Set(['presence_penalty']),
        });
        const decision = resolveEffectiveParameterDecision('presence_penalty', ctx);
        expect(decision.action).toBe('omit');
        expect(decision.reason).toBe('legacy-exclusion');
    });
    test('inherit preserves provider default', () => {
        const decision = resolveEffectiveParameterDecision('temperature', makeContext());
        expect(decision.action).toBe('inherit');
        expect(decision.reason).toBe('provider-default');
    });
});

// ---------------------------------------------------------------------------
// Wire sanitization
// ---------------------------------------------------------------------------

describe('applySamplingParameterPolicy — payload behavior', () => {
    test('omit deletes flat path regardless of value', () => {
        for (const value of [0, 1, false, null, undefined, 0.42]) {
            const payload = { presence_penalty: value };
            const ctx = makeContext({
                policy: { parameters: { presence_penalty: 'omit' } },
            });
            applySamplingParameterPolicy(payload, ctx);
            expect(Object.hasOwn(payload, 'presence_penalty')).toBe(false);
        }
    });
    test('include materializes active value even if serializer suppressed it', () => {
        const payload = {};
        const ctx = makeContext({
            activeValues: { temperature: 0.42 },
            policy: { parameters: { temperature: 'include' } },
        });
        applySamplingParameterPolicy(payload, ctx);
        expect(payload.temperature).toBe(0.42);
    });
    test('include with unresolved value does not write null/undefined', () => {
        const payload = {};
        const ctx = makeContext({
            activeValues: { temperature: null },
            policy: { parameters: { temperature: 'include' } },
        });
        const result = applySamplingParameterPolicy(payload, ctx);
        expect(Object.hasOwn(payload, 'temperature')).toBe(false);
        const decision = result.decisions.find(d => d.parameter === 'temperature');
        expect(decision.unresolved).toBe(true);
    });
    test('inherit leaves serializer output unchanged', () => {
        const payload = { temperature: 0.7, top_p: 0.9 };
        const ctx = makeContext();
        applySamplingParameterPolicy(payload, ctx);
        expect(payload).toEqual({ temperature: 0.7, top_p: 0.9 });
    });
    test('nested typical_p for text omits via options.typical_p', () => {
        const payload = { options: { typical_p: 0.9, other: 1 } };
        const ctx = makeContext({
            backend: 'text',
            adapter: 'ollama',
            model: 'llama-3.1-8b',
            source: 'textgenerationwebui',
        });
        applySamplingParameterPolicy(payload, ctx);
        expect(Object.hasOwn(payload.options, 'typical_p')).toBe(false);
        expect(payload.options.other).toBe(1);
    });
    test('Grok proxy path omits penalties via capability', () => {
        const payload = { presence_penalty: 0.5, frequency_penalty: 0.5, temperature: 0.7 };
        const ctx = makeContext({
            source: 'openrouter',
            model: 'x-ai/grok-2',
        });
        applySamplingParameterPolicy(payload, ctx);
        expect(Object.hasOwn(payload, 'presence_penalty')).toBe(false);
        expect(Object.hasOwn(payload, 'frequency_penalty')).toBe(false);
        expect(payload.temperature).toBe(0.7);
    });
});

// ---------------------------------------------------------------------------
// I1 — Zero preset mutation
// ---------------------------------------------------------------------------

describe('I1: Zero preset mutation', () => {
    test('deep-frozen preset survives policy, parsing and payload building', () => {
        const preset = deepFreeze({
            name: 'test-preset',
            custom_exclude_body: '- presence_penalty\n- frequency_penalty\n',
            temperature: 0.5,
        });

        const exclusions = parseLegacySamplingExclusions(preset.custom_exclude_body);
        expect(exclusions.has('presence_penalty')).toBe(true);
        expect(exclusions.has('frequency_penalty')).toBe(true);

        const settings = { version: 1, targets: {} };
        setTargetParameterState(settings, 'openai:gpt-4.1', 'temperature', 'omit');

        const payload = { temperature: 0.5, presence_penalty: 0.1 };
        const ctx = makeContext({
            policy: getTargetSamplingPolicy(settings, 'openai:gpt-4.1'),
            legacyExclusions: exclusions,
        });
        applySamplingParameterPolicy(payload, ctx);

        expect(Object.hasOwn(payload, 'temperature')).toBe(false);
        expect(Object.hasOwn(payload, 'presence_penalty')).toBe(false);

        expect(preset.name).toBe('test-preset');
        expect(preset.custom_exclude_body).toBe('- presence_penalty\n- frequency_penalty\n');
        expect(preset.temperature).toBe(0.5);
        expect(Object.keys(preset)).toEqual(['name', 'custom_exclude_body', 'temperature']);
    });

    test('legacy parser returns a fresh Set each call', () => {
        const raw = 'presence_penalty,frequency_penalty';
        const a = parseLegacySamplingExclusions(raw);
        const b = parseLegacySamplingExclusions(raw);
        expect(a).not.toBe(b);
        a.add('temperature');
        expect(b.has('temperature')).toBe(false);
    });
});

function deepFreeze(obj) {
    Object.getOwnPropertyNames(obj).forEach(name => {
        const value = obj[name];
        if (value && typeof value === 'object') {
            deepFreeze(value);
        }
    });
    return Object.freeze(obj);
}

// ---------------------------------------------------------------------------
// I2 — Absolute wire absence
// ---------------------------------------------------------------------------

describe('I2: Absolute wire absence', () => {
    test('JSON.stringify does not leak forbidden fields', () => {
        const payload = {
            presence_penalty: 0,
            frequency_penalty: 1,
            temperature: 0.7,
            options: { typical_p: 0.9, other: 'x' },
        };
        applySamplingParameterPolicy(payload, makeContext({
            source: 'openrouter',
            model: 'x-ai/grok-2',
            policy: { parameters: { temperature: 'omit' } },
            backend: 'text',
            adapter: 'ollama',
        }));
        const json = JSON.stringify(payload);
        expect(json).not.toContain('"presence_penalty"');
        expect(json).not.toContain('"frequency_penalty"');
        expect(json).not.toContain('"temperature"');
        expect(json).not.toContain('"typical_p"');
        expect(json).toContain('"other":"x"');
    });

    test('values 0/1/false are not treated as omission markers', () => {
        const payload = { temperature: 0, top_p: 1, presence_penalty: false };
        applySamplingParameterPolicy(payload, makeContext());
        expect(payload.temperature).toBe(0);
        expect(payload.top_p).toBe(1);
        expect(payload.presence_penalty).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// I3 — Route isolation
// ---------------------------------------------------------------------------

describe('I3: Route isolation', () => {
    test('three targets maintain independent policies', () => {
        const settings = { version: 1, targets: {} };
        setTargetParameterState(settings, 'openrouter:x-ai/grok-2', 'presence_penalty', 'omit');
        setTargetParameterState(settings, 'openai:gpt-4.1', 'presence_penalty', 'include');
        setTargetParameterState(settings, 'custom:p1:gpt-4.1', 'presence_penalty', 'omit');

        const grokCtx = makeContext({
            source: 'openrouter',
            model: 'x-ai/grok-2',
            policy: getTargetSamplingPolicy(settings, 'openrouter:x-ai/grok-2'),
            activeValues: { presence_penalty: 0.34 },
        });
        const openaiCtx = makeContext({
            source: 'openai',
            model: 'gpt-4.1',
            policy: getTargetSamplingPolicy(settings, 'openai:gpt-4.1'),
            activeValues: { presence_penalty: 0.34 },
        });
        const customCtx = makeContext({
            source: 'custom',
            model: 'gpt-4.1',
            customProfileId: 'p1',
            policy: getTargetSamplingPolicy(settings, 'custom:p1:gpt-4.1'),
            activeValues: { presence_penalty: 0.34 },
        });

        const grok = { presence_penalty: 0.34 };
        const openai = { presence_penalty: 0.34 };
        const custom = { presence_penalty: 0.34 };
        applySamplingParameterPolicy(grok, grokCtx);
        applySamplingParameterPolicy(openai, openaiCtx);
        applySamplingParameterPolicy(custom, customCtx);

        // Grok: capability + explicit omit → absent
        expect(Object.hasOwn(grok, 'presence_penalty')).toBe(false);
        // OpenAI gpt-4.1: include → present
        expect(openai.presence_penalty).toBe(0.34);
        // Custom: explicit omit → absent
        expect(Object.hasOwn(custom, 'presence_penalty')).toBe(false);
    });

    test('two custom profiles serving the same model never share policy', () => {
        const settings = { version: 1, targets: {} };
        setTargetParameterState(settings, 'custom:alpha:proxy-1', 'temperature', 'omit');
        setTargetParameterState(settings, 'custom:beta:proxy-1', 'temperature', 'include');

        const alpha = makeContext({
            source: 'custom',
            model: 'proxy-1',
            customProfileId: 'alpha',
            policy: getTargetSamplingPolicy(settings, 'custom:alpha:proxy-1'),
            activeValues: { temperature: 0.8 },
        });
        const beta = makeContext({
            source: 'custom',
            model: 'proxy-1',
            customProfileId: 'beta',
            policy: getTargetSamplingPolicy(settings, 'custom:beta:proxy-1'),
            activeValues: { temperature: 0.8 },
        });

        const a = { temperature: 0.8 };
        const b = { temperature: 0.8 };
        applySamplingParameterPolicy(a, alpha);
        applySamplingParameterPolicy(b, beta);

        expect(Object.hasOwn(a, 'temperature')).toBe(false);
        expect(b.temperature).toBe(0.8);
    });
});

// ---------------------------------------------------------------------------
// I4 — Decoupled safety
// ---------------------------------------------------------------------------

describe('I4: Decoupled safety (model_sampling_profiles_enabled === false)', () => {
    // The engine does not consult any feature flag; enforcement is
    // unconditional. We simulate "profiles disabled" by simply not loading
    // value profiles — policy still applies.
    test('Grok restriction applies without value profiles', () => {
        const payload = { presence_penalty: 0.5, frequency_penalty: 0.5 };
        const ctx = makeContext({ source: 'nanogpt', model: 'grok-2-latest' });
        applySamplingParameterPolicy(payload, ctx);
        expect(Object.hasOwn(payload, 'presence_penalty')).toBe(false);
        expect(Object.hasOwn(payload, 'frequency_penalty')).toBe(false);
    });

    test('o-series restriction applies without value profiles', () => {
        const payload = { temperature: 0.9, top_p: 0.9 };
        const ctx = makeContext({ source: 'openai', model: 'o3-mini' });
        applySamplingParameterPolicy(payload, ctx);
        expect(Object.hasOwn(payload, 'temperature')).toBe(false);
        expect(Object.hasOwn(payload, 'top_p')).toBe(false);
    });

    test('manual omit enforced without value profiles', () => {
        const settings = { version: 1, targets: {} };
        setTargetParameterState(settings, 'openai:gpt-4.1', 'temperature', 'omit');
        const payload = { temperature: 0.5 };
        const ctx = makeContext({
            source: 'openai',
            model: 'gpt-4.1',
            policy: getTargetSamplingPolicy(settings, 'openai:gpt-4.1'),
        });
        applySamplingParameterPolicy(payload, ctx);
        expect(Object.hasOwn(payload, 'temperature')).toBe(false);
    });

    test('manual include enforced without value profiles', () => {
        const settings = { version: 1, targets: {} };
        setTargetParameterState(settings, 'openai:gpt-4.1', 'temperature', 'include');
        const payload = {};
        const ctx = makeContext({
            source: 'openai',
            model: 'gpt-4.1',
            policy: getTargetSamplingPolicy(settings, 'openai:gpt-4.1'),
            activeValues: { temperature: 0.55 },
        });
        applySamplingParameterPolicy(payload, ctx);
        expect(payload.temperature).toBe(0.55);
    });

    test('Text/Ollama restriction applies without value profiles', () => {
        const payload = { options: { typical_p: 0.95 } };
        const ctx = makeContext({
            backend: 'text',
            adapter: 'ollama',
            source: 'textgenerationwebui',
            model: 'llama-3.1-8b',
        });
        applySamplingParameterPolicy(payload, ctx);
        expect(Object.hasOwn(payload.options, 'typical_p')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// I5 — Dual-backend parity
// ---------------------------------------------------------------------------

describe('I5: Dual-backend parity', () => {
    const states = ['inherit', 'include', 'omit'];

    test.each(states)('Chat and Text both honor state=%s for temperature', state => {
        const policy = { parameters: { temperature: state } };
        const chatPayload = { temperature: 0.9 };
        const textPayload = { temperature: 0.9 };

        applySamplingParameterPolicy(chatPayload, makeContext({
            backend: 'chat',
            source: 'openai',
            model: 'gpt-4.1',
            policy,
            activeValues: { temperature: 0.33 },
        }));
        applySamplingParameterPolicy(textPayload, makeContext({
            backend: 'text',
            source: 'textgenerationwebui',
            model: 'llama-3.1-8b',
            policy,
            activeValues: { temperature: 0.33 },
        }));

        if (state === 'omit') {
            expect(Object.hasOwn(chatPayload, 'temperature')).toBe(false);
            expect(Object.hasOwn(textPayload, 'temperature')).toBe(false);
        } else if (state === 'include') {
            expect(chatPayload.temperature).toBe(0.33);
            expect(textPayload.temperature).toBe(0.33);
        } else {
            expect(chatPayload.temperature).toBe(0.9);
            expect(textPayload.temperature).toBe(0.9);
        }
    });

    test('typical_p is only reachable via text backend', () => {
        const chatPath = getWirePath('typical_p', { backend: 'chat' });
        const textPath = getWirePath('typical_p', { backend: 'text' });
        expect(chatPath).toBeNull();
        expect(textPath).toEqual(['options', 'typical_p']);
    });

    test('explicit include overrides legacy exclusion on both backends', () => {
        const exclusions = new Set(['temperature']);
        const policy = { parameters: { temperature: 'include' } };
        const chatPayload = {};
        const textPayload = {};
        applySamplingParameterPolicy(chatPayload, makeContext({
            backend: 'chat',
            policy,
            legacyExclusions: exclusions,
            activeValues: { temperature: 0.2 },
        }));
        applySamplingParameterPolicy(textPayload, makeContext({
            backend: 'text',
            policy,
            legacyExclusions: exclusions,
            activeValues: { temperature: 0.2 },
        }));
        expect(chatPayload.temperature).toBe(0.2);
        expect(textPayload.temperature).toBe(0.2);
    });
});

// ---------------------------------------------------------------------------
// Prototype pollution safety
// ---------------------------------------------------------------------------

describe('Prototype pollution safety', () => {
    test('forbidden segments are rejected on every helper', () => {
        expect(setOwnPath({}, ['__proto__', 'polluted'], true)).toBe(false);
        expect(setOwnPath({}, ['constructor', 'prototype', 'polluted'], true)).toBe(false);
        expect(deleteOwnPath({ a: 1 }, ['__proto__'])).toBe(false);
        expect(getOwnPath({ a: 1 }, ['prototype'])).toBeUndefined();
        expect(({}).polluted).toBeUndefined();
        expect(Object.prototype.polluted).toBeUndefined();
    });

    test('legacy parser rejects dangerous segments', () => {
        const set = parseLegacySamplingExclusions([
            '__proto__',
            'constructor',
            'temperature',
            'options.typical_p',
        ]);
        expect(set.has('temperature')).toBe(true);
        expect(set.has('typical_p')).toBe(true);
        expect(set.has('__proto__')).toBe(false);
        expect(set.has('constructor')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Legacy parser
// ---------------------------------------------------------------------------

describe('parseLegacySamplingExclusions', () => {
    test('handles YAML-style list', () => {
        const set = parseLegacySamplingExclusions('- temperature\n- top_p\n');
        expect(set.has('temperature')).toBe(true);
        expect(set.has('top_p')).toBe(true);
    });
    test('handles JSON array', () => {
        const set = parseLegacySamplingExclusions('["temperature","presence_penalty"]');
        expect(set.has('temperature')).toBe(true);
        expect(set.has('presence_penalty')).toBe(true);
    });
    test('handles comma and newline lists', () => {
        const a = parseLegacySamplingExclusions('temperature, top_p');
        expect(a.has('temperature')).toBe(true);
        expect(a.has('top_p')).toBe(true);
        const b = parseLegacySamplingExclusions('temperature\ntop_p');
        expect(b.has('temperature')).toBe(true);
        expect(b.has('top_p')).toBe(true);
    });
    test('maps options.typical_p to typical_p', () => {
        const set = parseLegacySamplingExclusions('options.typical_p');
        expect(set.has('typical_p')).toBe(true);
    });
    test('ignores unknown paths', () => {
        const set = parseLegacySamplingExclusions('made_up_field');
        expect(set.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Context immutability
// ---------------------------------------------------------------------------

describe('createSamplingRequestContext', () => {
    test('captures a snapshot of policy and exclusions', () => {
        const policy = { parameters: { temperature: 'omit' } };
        const legacy = new Set(['top_p']);
        const ctx = createSamplingRequestContext({
            backend: 'chat',
            source: 'openai',
            model: 'gpt-4.1',
            activeValues: { temperature: 0.7, top_p: 0.9 },
            policy,
            legacyExclusions: legacy,
        });

        // Mutating originals must not affect the context.
        policy.parameters.temperature = 'include';
        legacy.add('presence_penalty');

        expect(ctx.policy.parameters.temperature).toBe('omit');
        expect(ctx.legacyExclusions.has('presence_penalty')).toBe(false);
        expect(ctx.activeValues.temperature).toBe(0.7);
    });

    test('frozen context', () => {
        const ctx = createSamplingRequestContext({
            backend: 'chat',
            source: 'openai',
            model: 'gpt-4.1',
        });
        expect(Object.isFrozen(ctx)).toBe(true);
        expect(Object.isFrozen(ctx.policy)).toBe(true);
        expect(Object.isFrozen(ctx.activeValues)).toBe(true);
    });

    test('in-flight capture is unaffected by later policy edits', () => {
        const settings = { version: 1, targets: {} };
        setTargetParameterState(settings, 'openai:gpt-4.1', 'temperature', 'omit');

        const payload = { temperature: 0.7 };
        const captured = createSamplingRequestContext({
            backend: 'chat',
            source: 'openai',
            model: 'gpt-4.1',
            policy: getTargetSamplingPolicy(settings, 'openai:gpt-4.1'),
            activeValues: { temperature: 0.7 },
        });

        // Later user edit — must not affect the running request.
        setTargetParameterState(settings, 'openai:gpt-4.1', 'temperature', 'include');

        applySamplingParameterPolicy(payload, captured);
        expect(Object.hasOwn(payload, 'temperature')).toBe(false);

        const fresh = { temperature: 0.7 };
        applySamplingParameterPolicy(fresh, createSamplingRequestContext({
            backend: 'chat',
            source: 'openai',
            model: 'gpt-4.1',
            policy: getTargetSamplingPolicy(settings, 'openai:gpt-4.1'),
            activeValues: { temperature: 0.7 },
        }));
        expect(fresh.temperature).toBe(0.7);
    });
});

// ---------------------------------------------------------------------------
// Registry shape guards
// ---------------------------------------------------------------------------

describe('registry integrity', () => {
    test('all descriptors expose a valid id', () => {
        for (const [key, descriptor] of Object.entries(SAMPLING_PARAMETER_DESCRIPTORS)) {
            expect(descriptor.id).toBe(key);
            expect(descriptor.label).toBeTruthy();
            expect(descriptor.valueKey).toBeTruthy();
        }
    });
    test('capability rules use frozen arrays', () => {
        for (const rule of BUILTIN_SAMPLING_CAPABILITIES) {
            expect(Array.isArray(rule.forbidden)).toBe(true);
            expect(Object.isFrozen(rule.forbidden)).toBe(true);
        }
    });
    test('getSamplingParameterDescriptor round-trips', () => {
        for (const key of Object.keys(SAMPLING_PARAMETER_DESCRIPTORS)) {
            expect(getSamplingParameterDescriptor(key)).toBe(SAMPLING_PARAMETER_DESCRIPTORS[key]);
        }
        expect(getSamplingParameterDescriptor('nope')).toBeUndefined();
    });
});