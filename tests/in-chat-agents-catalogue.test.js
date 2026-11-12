/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Jest test.each assertions run without a browser. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const originalFetch = globalThis.fetch;
let store;
let chatContext;
let extensionSettings;
let saveSettingsDebounced;

function template(overrides = {}) {
    return {
        id: 'tpl-helper',
        name: 'Bundled Helper',
        description: 'Bundled description',
        icon: 'fa-feather',
        category: 'content',
        subcategory: 'behaviour',
        tags: ['bundled'],
        version: 4,
        author: 'SillyBunny',
        prompt: 'Bundled prompt',
        phase: 'both',
        execution: 'inline',
        enabled: false,
        injection: { depth: 4, order: 15 },
        postProcess: { appendText: 'bundled suffix' },
        ...overrides,
    };
}

function savedAgent(overrides = {}) {
    return {
        id: 'saved-helper',
        sourceTemplateId: 'tpl-helper',
        name: 'Edited helper',
        prompt: 'Edited prompt',
        enabled: false,
        ...overrides,
    };
}

function context(templates = [template()], overrides = {}) {
    const result = {
        templates,
        regexBundles: {},
        getAgents: store.getAgents,
        saveAgent: jest.fn(store.saveAgent),
        initializeScopedAgentEnableState: store.initializeScopedAgentEnableState,
        setAgentEnabledForCurrentScope: store.setAgentEnabledForCurrentScope,
        autoSeededTemplateIds: new Set(),
        t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
        ...overrides,
    };
    result.persistState = jest.fn(() => {
        store.persistAgentGlobalSettings();
        extensionSettings.inChatAgents.autoSeededTemplateIds = [...result.autoSeededTemplateIds];
    });
    return result;
}

function entries(catalogue, dependencies) {
    return catalogue.listAgentEntries({
        agents: store.getAgents(),
        templates: dependencies.templates,
        regexBundles: dependencies.regexBundles,
    });
}

async function importCatalogue() {
    return await import('../public/scripts/extensions/in-chat-agents/catalogue.js');
}

beforeEach(async () => {
    jest.resetModules();
    chatContext = { groupId: null };
    extensionSettings = { inChatAgents: { dismissedTemplatesCallout: true } };
    saveSettingsDebounced = jest.fn();
    let nextId = 0;
    await jest.unstable_mockModule('../public/script.js', () => ({
        getRequestHeaders: () => ({}),
        saveSettingsDebounced,
    }));
    await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
        extension_settings: extensionSettings,
        getContext: () => chatContext,
    }));
    await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
        uuidv4: () => `catalogue-uuid-${++nextId}`,
        regexFromString: value => {
            const match = String(value ?? '').match(/^\/([\s\S]*)\/([a-z]*)$/i);
            return match ? new RegExp(match[1], match[2]) : new RegExp(String(value ?? ''));
        },
    }));
    globalThis.fetch = jest.fn(async () => ({ ok: true }));
    store = await import('../public/scripts/extensions/in-chat-agents/agent-store.js');
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
});

describe('agent catalogue entries', () => {
    test('lists saved copies plus unused templates without saving, migrating or allocating saved identities', async () => {
        const catalogue = await importCatalogue();
        const templates = [template(), template({ id: 'tpl-unused', name: 'Unused helper' })];
        store.loadAgents([
            savedAgent(),
            savedAgent({ id: 'second-copy', name: 'Second copy' }),
            savedAgent({ id: 'custom', sourceTemplateId: '', name: 'Custom' }),
        ]);
        const dependencies = context(templates);
        const before = structuredClone({ agents: store.getAgents(), templates });

        const first = entries(catalogue, dependencies);
        const second = entries(catalogue, dependencies);

        expect(first.map(entry => entry.key)).toEqual([
            'agent:saved-helper', 'agent:second-copy', 'agent:custom', 'agent-template:tpl-unused',
        ]);
        expect(second).toEqual(first);
        expect(first[0]).toMatchObject({ kind: 'agent', subcategory: 'behaviour', template: { id: 'tpl-helper' } });
        expect(first[2]).toMatchObject({ template: null, subcategory: '' });
        expect(first[3]).toMatchObject({ kind: 'agent-template', agent: { id: 'tpl-unused', enabled: false }, subcategory: 'behaviour' });
        expect(first[0].agent).not.toHaveProperty('subcategory');
        expect(first[3].agent).not.toHaveProperty('subcategory');
        expect({ agents: store.getAgents(), templates }).toEqual(before);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(dependencies.persistState).not.toHaveBeenCalled();
    });

    test('suppresses an unused row only for an exact sourceTemplateId, including an off saved copy', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([
            savedAgent({ id: 'unsourced', sourceTemplateId: '', name: 'Bundled Helper', prompt: 'Bundled prompt' }),
            savedAgent({ id: 'orphan', sourceTemplateId: 'tpl-missing' }),
        ]);
        const dependencies = context();

        expect(entries(catalogue, dependencies).map(entry => entry.key)).toEqual([
            'agent:unsourced', 'agent:orphan', 'agent-template:tpl-helper',
        ]);
        store.loadAgents([...store.getAgents(), savedAgent()]);
        expect(entries(catalogue, dependencies).map(entry => entry.key)).toEqual([
            'agent:unsourced', 'agent:orphan', 'agent:saved-helper',
        ]);
        expect(store.getAgentById('unsourced').sourceTemplateId).toBe('');
    });

    test('excludes hidden and removed bundles but not a custom same-name agent or a temporarily hidden companion', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([
            savedAgent({ id: 'internal', sourceTemplateId: 'tpl-pathfinder' }),
            savedAgent({ id: 'legacy-pathfinder', sourceTemplateId: '', name: 'Pathfinder' }),
            savedAgent({ id: 'tool-pathfinder', sourceTemplateId: '', category: 'tool', tools: [{ name: 'Pathfinder_Search' }] }),
            savedAgent({ id: 'removed-id', sourceTemplateId: 'tpl-director-core' }),
            savedAgent({ id: 'removed-name', sourceTemplateId: '', name: 'NSFW Mode', author: 'SillyBunny' }),
            savedAgent({ id: 'custom-name', sourceTemplateId: '', name: 'NSFW Mode', author: 'User' }),
            savedAgent({ id: 'hidden-companion', sourceTemplateId: '', execution: 'companion' }),
        ]);
        store.setGlobalSettings({ hiddenCompanionAgentIds: ['hidden-companion'] });
        const dependencies = context([
            template({ id: 'tpl-pathfinder' }),
            template({ id: 'tpl-anti-slop-regex' }),
            template({ id: 'tpl-director-core' }),
            template({ id: 'tpl-nsfw-mode' }),
            template(),
        ]);

        expect(entries(catalogue, dependencies).map(entry => entry.key)).toEqual([
            'agent:custom-name', 'agent:hidden-companion', 'agent-template:tpl-helper',
        ]);
        expect(store.getAgents()).toHaveLength(7);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('lists Prose Polisher off from the shipped catalogue without requiring the template browser', async () => {
        const catalogue = await importCatalogue();
        const templates = JSON.parse(readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/index.json', import.meta.url), 'utf8'));
        const dependencies = context(templates);
        const result = entries(catalogue, dependencies);

        expect(result.find(entry => entry.key === 'agent-template:tpl-prose-polisher')).toMatchObject({
            kind: 'agent-template', agent: { enabled: false, sourceTemplateId: 'tpl-prose-polisher' },
        });
        expect(result.some(entry => entry.template?.id === 'tpl-pathfinder')).toBe(false);
        expect(store.getAgents()).toEqual([]);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('returns to an unused row only after the last bundled copy is deleted, cleaning both scopes', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([savedAgent(), savedAgent({ id: 'second-copy' })]);
        store.setGlobalSettings({ separateRecentChats: true, enabledAgentIdsByChatType: {
            individual: ['saved-helper', 'second-copy'], group: ['second-copy'],
        } });
        const dependencies = context();

        await store.deleteAgent('saved-helper');
        expect(entries(catalogue, dependencies).map(entry => entry.key)).toEqual(['agent:second-copy']);
        await store.deleteAgent('second-copy');
        expect(entries(catalogue, dependencies).map(entry => entry.key)).toEqual(['agent-template:tpl-helper']);
        expect(store.getGlobalSettings().enabledAgentIdsByChatType).toEqual({ individual: [], group: [] });
        expect(extensionSettings.inChatAgents.globalSettings.enabledAgentIdsByChatType).toEqual({ individual: [], group: [] });
    });
});

describe('catalogue materialisation', () => {
    test.each([
        { action: 'turn on', options: { enable: true }, enabled: true, favorite: false },
        { action: 'pin', options: { favorite: true }, enabled: false, favorite: true },
        { action: 'save an edit', options: { edits: { prompt: 'Saved edit' } }, enabled: false, favorite: false },
    ])('materialises when requested to $action and reconciles the template key to the saved ID', async ({ options, enabled, favorite }) => {
        const catalogue = await importCatalogue();
        const dependencies = context();

        const result = await catalogue.materialise('tpl-helper', options, dependencies);

        expect(result).toMatchObject({ sourceTemplateId: 'tpl-helper', enabled, favorite });
        expect(result.id).not.toBe('tpl-helper');
        expect(result).not.toHaveProperty('subcategory');
        expect(store.getAgents()).toEqual([result]);
        expect(entries(catalogue, dependencies).map(entry => entry.key)).toEqual([`agent:${result.id}`]);
        expect(globalThis.fetch).toHaveBeenCalledWith('/api/in-chat-agents/save', expect.objectContaining({ method: 'POST' }));
    });

    test('merges edits without allowing a draft to replace its identity, provenance, or off state', async () => {
        const catalogue = await importCatalogue();
        const dependencies = context();
        const result = await catalogue.materialise('tpl-helper', { edits: {
            id: 'injected-id', sourceTemplateId: 'tpl-other', enabled: true,
            prompt: 'Saved edit', injection: { depth: 9 },
        } }, dependencies);

        expect(result).toMatchObject({ sourceTemplateId: 'tpl-helper', enabled: false, prompt: 'Saved edit', injection: { depth: 9, order: 15 } });
        expect(result.id).not.toBe('injected-id');
        expect(store.getEnabledAgents()).toEqual([]);
        expect(dependencies.templates[0].prompt).toBe('Bundled prompt');
    });

    test('reuses an already materialised copy rather than adding a stale-row duplicate or disabling it', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([savedAgent({ enabled: true, favorite: true, injection: { order: 62 } })]);
        const dependencies = context();

        const result = await catalogue.materialise('tpl-helper', { edits: { description: 'Changed description' } }, dependencies);

        expect(store.getAgents()).toHaveLength(1);
        expect(result).toMatchObject({ id: 'saved-helper', prompt: 'Edited prompt', description: 'Changed description', enabled: true, favorite: true, injection: { order: 62 } });
    });

    test('initializes existing legacy enables before turning a materialised agent on in the active scope', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([savedAgent({ id: 'legacy-on', sourceTemplateId: '', enabled: true })]);
        store.setGlobalSettings({ separateRecentChats: true });
        chatContext.groupId = 'active-group';
        const dependencies = context();

        const result = await catalogue.materialise('tpl-helper', { enable: true }, dependencies);

        expect(store.getGlobalSettings()).toMatchObject({
            scopedEnabledAgentIdsInitialized: true,
            enabledAgentIdsByChatType: { individual: [], group: ['legacy-on', result.id] },
        });
        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual([result.id, 'legacy-on']);
        expect(result.enabled).toBe(true);
        expect(extensionSettings.inChatAgents.globalSettings.enabledAgentIdsByChatType.group).toEqual(['legacy-on', result.id]);
        chatContext.groupId = null;
        expect(store.getEnabledAgents()).toEqual([]);
    });

    test('does not add a pinned off agent to either initialized scoped list', async () => {
        const catalogue = await importCatalogue();
        store.setGlobalSettings({ separateRecentChats: true, enabledAgentIdsByChatType: { individual: ['unrelated'], group: [] } });
        const dependencies = context();

        const result = await catalogue.materialise('tpl-helper', { favorite: true }, dependencies);

        expect(result).toMatchObject({ favorite: true, enabled: false });
        expect(store.getGlobalSettings().enabledAgentIdsByChatType).toEqual({ individual: ['unrelated'], group: [] });
    });

    test('records scoped turn-on while the extension-wide switch is off without enabling the extension', async () => {
        const catalogue = await importCatalogue();
        store.setGlobalSettings({ enabled: false, separateRecentChats: true });
        const dependencies = context();

        const result = await catalogue.materialise('tpl-helper', { enable: true }, dependencies);

        expect(store.getGlobalSettings().enabled).toBe(false);
        expect(store.isAgentEnabledForCurrentScope(result)).toBe(true);
        expect(store.getEnabledAgents()).toEqual([]);
    });

    test('propagates a rejected save instead of announcing a saved catalogue row', async () => {
        const catalogue = await importCatalogue();
        const dependencies = context();
        dependencies.saveAgent.mockRejectedValueOnce(new Error('Save rejected'));

        await expect(catalogue.materialise('tpl-helper', { favorite: true }, dependencies)).rejects.toThrow('Save rejected');
        expect(store.getAgents()).toEqual([]);
        expect(dependencies.persistState).not.toHaveBeenCalled();
    });

    test('rolls scoped turn-on back when persistence fails, retaining legacy initialization state', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([savedAgent({ id: 'legacy-on', sourceTemplateId: '', enabled: true })]);
        store.setGlobalSettings({ separateRecentChats: true });
        const before = structuredClone(store.getGlobalSettings());
        const dependencies = context();
        dependencies.saveAgent.mockImplementationOnce(async () => {
            store.setGlobalSettings({ connectionProfile: 'changed-while-saving' });
            throw new Error('Save rejected');
        });

        await expect(catalogue.materialise('tpl-helper', { enable: true }, dependencies)).rejects.toThrow('Save rejected');

        expect(store.getGlobalSettings()).toEqual({ ...before, connectionProfile: 'changed-while-saving' });
        expect(store.getAgents()).toEqual([expect.objectContaining({ id: 'legacy-on', enabled: true })]);
        expect(dependencies.persistState).not.toHaveBeenCalled();
    });
});

describe('moved agent builders and restore', () => {
    test('builds separate new off snapshots without changing template metadata or sharing nested configuration', async () => {
        const catalogue = await importCatalogue();
        const source = template({ enabled: true, settings: { mode: 'template' } });
        const before = structuredClone(source);

        const first = catalogue.buildAgentFromTemplate(source);
        const second = catalogue.buildAgentFromTemplate(source);

        expect(first).toMatchObject({ sourceTemplateId: 'tpl-helper', enabled: false, version: 4, injection: { depth: 4, order: 15 } });
        expect(first.id).not.toBe(second.id);
        expect(first).not.toHaveProperty('subcategory');
        first.settings.mode = 'changed';
        first.injection.order = 999;
        expect(source).toEqual(before);
        expect(second.settings.mode).toBe('template');
    });

    test('keeps tracker prompt-pass and bundled-regex precedence when moving the builder', async () => {
        const catalogue = await importCatalogue();
        const source = template({ category: 'tracker', regexScripts: [{ id: 'inline', findRegex: '/old/g' }] });
        const result = catalogue.buildAgentFromTemplate(source, { regexBundles: {
            'tpl-helper': [{ id: 'bundle', scriptName: 'Bundled', findRegex: '/new/g', replaceString: 'fresh' }],
        } });

        expect(result).toMatchObject({ phase: 'pre', postProcess: { promptTransformEnabled: false, promptTransformMode: 'append' } });
        expect(result.regexScripts).toEqual([expect.objectContaining({ id: 'bundle', findRegex: '/new/g', replaceString: 'fresh' })]);
        expect(source.phase).toBe('both');
    });

    test('keeps non-tracker regex post defaults and the Chatroom exclusion', async () => {
        const catalogue = await importCatalogue();
        const script = { id: 'renderer', findRegex: '/x/g', replaceString: 'y' };
        const options = { regexBundles: { 'tpl-helper': [script], 'tpl-chatroom-companion': [script] } };
        const ordinary = catalogue.buildAgentFromTemplate(template(), options);
        const chatroom = catalogue.buildAgentFromTemplate(template({ id: 'tpl-chatroom-companion' }), options);

        expect(ordinary).toMatchObject({ phase: 'post', postProcess: { promptTransformEnabled: true, promptTransformMode: 'rewrite' } });
        expect(chatroom.phase).toBe('both');
        expect(chatroom.postProcess.promptTransformEnabled).not.toBe(true);
    });

    test('does not infer bundled-regex post defaults from inline scripts when there is no external regex bundle', async () => {
        const catalogue = await importCatalogue();
        const result = catalogue.buildAgentFromTemplate(template({ regexScripts: [{ id: 'inline', findRegex: '/x/g' }] }));

        expect(result.phase).toBe('both');
        expect(result.postProcess.promptTransformEnabled).not.toBe(true);
        expect(result.regexScripts).toEqual([expect.objectContaining({ id: 'inline', findRegex: '/x/g' })]);
    });

    test('manual update preserves its existing small keep-list, not the startup-refresh preservation policy', async () => {
        const catalogue = await importCatalogue();
        const original = savedAgent({ enabled: true, favorite: true, connectionProfile: 'profile', modelOverride: 'model',
            phaseLocked: true, settings: { custom: true }, companion: { trigger: 'manual', contextMessages: 200 }, injection: { order: 73 },
        });
        const before = structuredClone(original);
        const result = catalogue.buildUpdatedAgentFromTemplate(original, template({ settings: { bundled: true }, companion: { trigger: 'auto', contextMessages: 12 } }));

        expect(result).toMatchObject({ id: 'saved-helper', enabled: true, favorite: true, connectionProfile: 'profile', modelOverride: 'model',
            version: 4, phaseLocked: false, prompt: 'Bundled prompt', injection: { order: 73, depth: 4 },
            settings: { bundled: true }, companion: { trigger: 'auto', contextMessages: 12 },
        });
        expect(result.settings).not.toHaveProperty('custom');
        expect(original).toEqual(before);
    });

    test('snapshot builder retains metadata and configuration but allocates a new off identity', async () => {
        const catalogue = await importCatalogue();
        const snapshot = savedAgent({ enabled: true, favorite: true, settings: { custom: true }, companion: { trigger: 'manual' } });
        const before = structuredClone(snapshot);
        const result = catalogue.buildAgentFromSnapshot(snapshot);

        expect(result).toMatchObject({ sourceTemplateId: 'tpl-helper', enabled: false, favorite: true, settings: { custom: true }, companion: { trigger: 'manual' } });
        expect(result.id).not.toBe('saved-helper');
        result.settings.custom = false;
        expect(snapshot).toEqual(before);
    });

    test('factory reset keeps only identity, enablement, favorite and model/profile overrides', async () => {
        const catalogue = await importCatalogue();
        const source = template({ companion: { trigger: 'auto', contextMessages: 12 } });
        store.loadAgents([savedAgent({
            enabled: true, favorite: true, version: 1, connectionProfile: 'kept-profile', modelOverride: 'kept-model',
            name: 'Edited name', description: 'Edited description', icon: 'fa-user', tags: ['edited'], author: 'User',
            phase: 'post', execution: 'companion', phaseLocked: true,
            injection: { order: 73, depth: 9, role: 2, scan: true },
            postProcess: { enabled: true, type: 'append', appendText: 'old suffix', extractVariable: 'kept-variable' },
            regexScripts: [{ id: 'old', findRegex: '/old/g', replaceString: 'old' }],
            companion: { trigger: 'manual', contextMessages: 200 },
            preProcess: { mode: 'intercept', wrapPrefix: 'kept-prefix' },
            conditions: { triggerKeywords: ['keep'], triggerProbability: 29 },
            tools: [{ name: 'Custom_Tool' }], settings: { customSetting: 'keep' }, customMetadata: { keep: true },
        })]);
        store.setGlobalSettings({ separateRecentChats: true, hiddenCompanionAgentIds: ['saved-helper'],
            enabledAgentIdsByChatType: { individual: [], group: ['saved-helper'] },
        });
        const before = structuredClone(store.getAgentById('saved-helper'));
        const scopedBefore = structuredClone(store.getGlobalSettings());
        const dependencies = context([source]);
        const expected = store.normalizeAgent({
            id: 'saved-helper', sourceTemplateId: 'tpl-helper', enabled: true, favorite: true,
            connectionProfile: 'kept-profile', modelOverride: 'kept-model', version: 4,
            name: 'Bundled Helper', description: 'Bundled description', icon: 'fa-feather', category: 'content',
            tags: ['bundled'], author: 'SillyBunny', prompt: 'Bundled prompt', phase: 'both', phaseLocked: false,
            injection: { depth: 4, order: 15 }, postProcess: { appendText: 'bundled suffix' },
            companion: { trigger: 'auto', contextMessages: 12 }, execution: 'inline',
        });

        const resetSnapshot = catalogue.buildRestoredAgentFromTemplate(before, source);
        const result = await catalogue.restoreDefault('saved-helper', dependencies);

        expect(store.normalizeAgent(resetSnapshot)).toEqual(expected);
        expect(result).toEqual(expected);
        expect(store.getAgentById('saved-helper')).toEqual(expected);
        expect(before).toMatchObject({ prompt: 'Edited prompt', injection: { order: 73 }, phaseLocked: true });
        expect(store.getGlobalSettings()).toEqual(scopedBefore);
        expect(store.isAgentEnabledForCurrentScope(result)).toBe(false);
        expect(result.enabled).toBe(true);
        expect(result.version).toBe(4);
        expect(result.settings).toEqual({});
        expect(result.preProcess.mode).toBe('inject');
        expect(result.conditions.triggerKeywords).toEqual([]);
        expect(result.tools).toEqual([]);
        expect(result).not.toHaveProperty('customMetadata');
    });

    test('uses factory defaults rather than retaining fields omitted by a template', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([savedAgent({ name: 'Legacy helper', execution: 'companion', injection: { order: 73 }, companion: { trigger: 'manual' } })]);
        const dependencies = context([{ id: 'tpl-helper', category: 'content', prompt: 'Fresh prompt' }]);

        const result = await catalogue.restoreDefault('saved-helper', dependencies);

        expect(result).toMatchObject({ name: '', prompt: 'Fresh prompt', phase: 'pre', injection: { order: 100 }, execution: 'inline', companion: { trigger: 'auto' } });
    });

    test('global reset and per-agent restore save identical factory-reset results', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([savedAgent({ enabled: true, favorite: true, settings: { old: true }, injection: { order: 87 }, version: 1 })]);
        const original = structuredClone(store.getAgents());
        const dependencies = context();

        const individual = await catalogue.restoreDefault('saved-helper', dependencies);
        store.loadAgents(original);
        const result = await catalogue.resetBundledAgents(dependencies);

        expect(store.getAgentById('saved-helper')).toEqual(individual);
        expect(result).toEqual({ reset: 1, added: 0 });
    });

    test('retains the global-reset legacy template fallback without changing list ownership on read', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([savedAgent({ sourceTemplateId: '', name: 'Bundled Helper', author: 'SillyBunny', category: 'content' })]);
        const dependencies = context();

        expect(entries(catalogue, dependencies).map(entry => entry.key)).toEqual(['agent:saved-helper', 'agent-template:tpl-helper']);
        const result = await catalogue.restoreDefault('saved-helper', dependencies);

        expect(result).toMatchObject({ id: 'saved-helper', sourceTemplateId: 'tpl-helper', prompt: 'Bundled prompt' });
        expect(entries(catalogue, dependencies).map(entry => entry.key)).toEqual(['agent:saved-helper']);
    });

    test('does not create or overwrite an unrelated custom agent when restore has no template', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([savedAgent({ sourceTemplateId: '', name: 'Custom helper', author: 'User' })]);
        const dependencies = context();
        const before = structuredClone(store.getAgents());

        expect(await catalogue.restoreDefault('saved-helper', dependencies)).toBeNull();
        expect(await catalogue.restoreDefault('missing', dependencies)).toBeNull();
        expect(store.getAgents()).toEqual(before);
        expect(dependencies.saveAgent).not.toHaveBeenCalled();
    });
});

describe('explicit catalogue duplication', () => {
    test('duplicates a saved snapshot off without changing either scope or the source copy', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([savedAgent({ enabled: true, favorite: true, connectionProfile: 'profile', settings: { user: true } })]);
        store.setGlobalSettings({ separateRecentChats: true, enabledAgentIdsByChatType: { individual: ['saved-helper'], group: ['saved-helper'] } });
        const dependencies = context();
        const before = structuredClone(store.getAgentById('saved-helper'));

        const result = await catalogue.duplicate('agent:saved-helper', dependencies);

        expect(result).toMatchObject({ enabled: false, favorite: true, sourceTemplateId: '', prompt: 'Edited prompt', connectionProfile: 'profile', settings: { user: true } });
        expect(result.id).not.toBe(before.id);
        expect(store.getAgentById(before.id)).toEqual(before);
        expect(entries(catalogue, dependencies).map(entry => entry.key)).toEqual(['agent:saved-helper', `agent:${result.id}`]);
        expect(store.getGlobalSettings().enabledAgentIdsByChatType).toEqual({ individual: ['saved-helper'], group: ['saved-helper'] });
    });

    test('duplicating an unused template saves exactly one off copy, not an installed original plus duplicate', async () => {
        const catalogue = await importCatalogue();
        const dependencies = context();

        const result = await catalogue.duplicate('agent-template:tpl-helper', dependencies);

        expect(result).toMatchObject({ sourceTemplateId: '', enabled: false, prompt: 'Bundled prompt' });
        expect(store.getAgents()).toEqual([result]);
        expect(entries(catalogue, dependencies).map(entry => entry.key)).toEqual([`agent:${result.id}`, 'agent-template:tpl-helper']);
    });

    test('distinguishes a saved ID equal to a template ID and preserves embedded colons in IDs', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([
            savedAgent({ id: 'tpl-helper', sourceTemplateId: '', prompt: 'Custom collision' }),
            savedAgent({ id: 'user:helper', sourceTemplateId: '', prompt: 'Colon identity' }),
        ]);
        const dependencies = context();

        const savedCopy = await catalogue.duplicate('agent:tpl-helper', dependencies);
        const bundledCopy = await catalogue.duplicate('agent-template:tpl-helper', dependencies);
        const colonCopy = await catalogue.duplicate('agent:user:helper', dependencies);

        expect(savedCopy.prompt).toBe('Custom collision');
        expect(savedCopy.sourceTemplateId).toBe('');
        expect(bundledCopy.prompt).toBe('Bundled prompt');
        expect(bundledCopy.sourceTemplateId).toBe('');
        expect(colonCopy.prompt).toBe('Colon identity');
        expect(new Set([savedCopy.id, bundledCopy.id, colonCopy.id]).size).toBe(3);
    });

    test.each([
        { key: 'agent:saved-helper', installed: true },
        { key: 'agent-template:tpl-helper', installed: true },
        { key: 'agent-template:tpl-helper', installed: false },
    ])('detached duplicate $key (installed: $installed) survives startup seeding, deduplication and latest-template refresh', async ({ key, installed }) => {
        const catalogue = await importCatalogue();
        store.loadAgents(installed ? [savedAgent({ name: 'Bundled Helper', prompt: 'Bundled prompt', version: 1 })] : []);
        const dependencies = context([template(), template({ id: 'tpl-pathfinder', name: 'Pathfinder', category: 'tool' })]);
        const copy = await catalogue.duplicate(key, dependencies);
        const copyBefore = structuredClone(copy);

        expect(copy).toMatchObject({ name: 'Bundled Helper (Copy)', sourceTemplateId: '', enabled: false });
        expect(store.findTemplateForAgentSnapshot(copy, dependencies.templates)).toBeNull();
        store.loadAgents(structuredClone(store.getAgents()));
        await catalogue.ensureDefaultBundledAgents(dependencies);
        const plan = store.getBundledAgentLatestTemplatePlan(store.getAgents(), dependencies.templates);
        for (const id of plan.redundantIds) await store.deleteAgent(id);
        for (const update of plan.updates) await store.saveAgent(update.agent);
        for (const id of store.getRedundantBundledAgentDuplicateIds(store.getAgents(), dependencies.templates)) await store.deleteAgent(id);

        expect(store.getAgentById(copy.id)).toEqual(copyBefore);
        expect(Boolean(store.getAgentById('saved-helper'))).toBe(installed);
        expect(store.findTemplateForAgentSnapshot(store.getAgentById(copy.id), dependencies.templates)).toBeNull();
        expect(catalogue.hasTemplateUpdate(copy, dependencies.templates)).toBe(false);
        expect(plan.updates.some(update => update.agentId === copy.id)).toBe(false);
    });
});

describe('additive group turn-on', () => {
    test('turns existing and unused template members on without changing edits or unrelated agents, and is repeatable', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([
            savedAgent({ connectionProfile: 'kept-profile' }),
            savedAgent({ id: 'unrelated-on', sourceTemplateId: '', enabled: true }),
            savedAgent({ id: 'unrelated-off', sourceTemplateId: '' }),
        ]);
        const dependencies = context([template(), template({ id: 'tpl-second', name: 'Second helper' })]);
        const group = { builtin: true, agentTemplateIds: ['tpl-helper', 'tpl-second', 'tpl-second', 'missing'], customAgents: [] };

        const result = await catalogue.turnOnGroup(group, dependencies);
        const added = store.getAgents().find(agent => agent.sourceTemplateId === 'tpl-second');

        expect(result).toEqual({ added: 1, enabled: 2, agentIds: ['saved-helper', added.id] });
        expect(store.getAgentById('saved-helper')).toMatchObject({ enabled: true, prompt: 'Edited prompt', connectionProfile: 'kept-profile' });
        expect(store.getAgentById('unrelated-on').enabled).toBe(true);
        expect(store.getAgentById('unrelated-off').enabled).toBe(false);
        expect(await catalogue.turnOnGroup(group, dependencies)).toEqual({ added: 0, enabled: 0, agentIds: ['saved-helper', added.id] });
        expect(store.getAgents()).toHaveLength(4);
    });

    test('prefers exact template provenance over the legacy same-name matching fallback', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([
            savedAgent({ id: 'same-name', sourceTemplateId: '', name: 'Bundled Helper' }),
            savedAgent(),
        ]);
        const dependencies = context();

        expect(await catalogue.turnOnGroup({ builtin: true, agentTemplateIds: ['tpl-helper'] }, dependencies)).toEqual({ added: 0, enabled: 1, agentIds: ['saved-helper'] });
        expect(store.getAgentById('same-name').enabled).toBe(false);
    });

    test('preserves existing template-name fallback rather than making a redundant group copy', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([savedAgent({ sourceTemplateId: '', name: '  BUNDLED HELPER  ', prompt: 'Customized legacy prompt' })]);
        const dependencies = context();

        expect(await catalogue.turnOnGroup({ builtin: true, agentTemplateIds: ['tpl-helper'] }, dependencies)).toEqual({ added: 0, enabled: 1, agentIds: ['saved-helper'] });
        expect(store.getAgentById('saved-helper')).toMatchObject({ sourceTemplateId: '', prompt: 'Customized legacy prompt', enabled: true });
    });

    test('enables matching custom snapshots and creates only unmatched snapshots in the current scope', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([
            savedAgent({ id: 'matched', sourceTemplateId: '', name: 'Custom note', prompt: 'Custom prompt', settings: { keep: true } }),
            savedAgent({ id: 'other-scope', sourceTemplateId: '', enabled: true }),
        ]);
        store.setGlobalSettings({ separateRecentChats: true, enabledAgentIdsByChatType: { individual: ['other-scope'], group: [] } });
        chatContext.groupId = 'active-group';
        const dependencies = context();
        const group = { builtin: false, agentTemplateIds: [], customAgents: [
            { name: ' custom NOTE ', prompt: 'Custom prompt' },
            { name: 'Fresh custom', prompt: 'Fresh custom prompt', favorite: true, settings: { new: true } },
        ] };

        const result = await catalogue.turnOnGroup(group, dependencies);
        const added = store.getAgents().find(agent => agent.name === 'Fresh custom');

        expect(result).toEqual({ added: 1, enabled: 2, agentIds: ['matched', added.id] });
        expect(store.getAgentById('matched').settings).toEqual({ keep: true });
        expect(added).toMatchObject({ enabled: true, favorite: true, settings: { new: true } });
        expect(store.getGlobalSettings().enabledAgentIdsByChatType).toEqual({ individual: ['other-scope'], group: ['matched', added.id] });
        expect(extensionSettings.inChatAgents.globalSettings.enabledAgentIdsByChatType.group).toEqual(['matched', added.id]);
    });

    test('does not match a custom snapshot by name alone when its non-empty prompt differs', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([savedAgent({ sourceTemplateId: '', name: 'Custom note', prompt: 'Different prompt' })]);
        const dependencies = context();

        const result = await catalogue.turnOnGroup({ builtin: false, agentTemplateIds: [], customAgents: [{ name: 'Custom note', prompt: 'Requested prompt' }] }, dependencies);

        expect(result).toMatchObject({ added: 1, enabled: 1 });
        expect(store.getAgents()).toHaveLength(2);
        expect(store.getAgentById('saved-helper').enabled).toBe(false);
    });

    test('enables a legacy custom group ID in place instead of its currently self-matching no-op fallback', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([savedAgent({ sourceTemplateId: '', settings: { keep: true } })]);
        const dependencies = context();

        expect(await catalogue.turnOnGroup({ builtin: false, agentTemplateIds: ['saved-helper', 'missing'], customAgents: [] }, dependencies)).toEqual({ added: 0, enabled: 1, agentIds: ['saved-helper'] });
        expect(store.getAgents()).toHaveLength(1);
        expect(store.getAgentById('saved-helper')).toMatchObject({ enabled: true, settings: { keep: true } });
    });

    test('does not use the legacy saved-ID fallback for built-ins or custom groups containing snapshots', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([savedAgent({ sourceTemplateId: '' })]);
        const dependencies = context();

        expect(await catalogue.turnOnGroup({ builtin: true, agentTemplateIds: ['saved-helper'], customAgents: [] }, dependencies)).toEqual({ added: 0, enabled: 0, agentIds: [] });
        await catalogue.turnOnGroup({ builtin: false, agentTemplateIds: ['saved-helper'], customAgents: [{ name: 'Different', prompt: 'Different' }] }, dependencies);

        expect(store.getAgentById('saved-helper').enabled).toBe(false);
        expect(store.getAgents()).toHaveLength(2);
    });
});

describe('catalogue seeding compatibility', () => {
    test('a fresh state seeds only internal Pathfinder and leaves Prose Polisher as an unused off row', async () => {
        const catalogue = await importCatalogue();
        const dependencies = context([template({ id: 'tpl-prose-polisher', name: 'Prose Polisher' }), template({ id: 'tpl-pathfinder', name: 'Pathfinder', category: 'tool' })]);

        await catalogue.ensureDefaultBundledAgents(dependencies);

        expect(store.getAgents()).toEqual([expect.objectContaining({ sourceTemplateId: 'tpl-pathfinder', enabled: false })]);
        expect([...dependencies.autoSeededTemplateIds]).toEqual(['tpl-pathfinder']);
        expect(extensionSettings.inChatAgents.autoSeededTemplateIds).toEqual(['tpl-pathfinder']);
        expect(extensionSettings.inChatAgents.dismissedTemplatesCallout).toBe(true);
        expect(entries(catalogue, dependencies).map(entry => entry.key)).toEqual(['agent-template:tpl-prose-polisher']);
    });

    test('keeps an existing Prose Polisher snapshot and historical seed IDs unchanged when seeding changes', async () => {
        const catalogue = await importCatalogue();
        store.loadAgents([
            savedAgent({ sourceTemplateId: 'tpl-prose-polisher', name: 'My prose', prompt: 'Keep customized prose', enabled: true, favorite: true }),
            savedAgent({ id: 'internal', sourceTemplateId: 'tpl-pathfinder', name: 'Pathfinder' }),
        ]);
        const dependencies = context([template({ id: 'tpl-prose-polisher' }), template({ id: 'tpl-pathfinder', name: 'Pathfinder' })], {
            autoSeededTemplateIds: new Set(['tpl-prose-polisher', 'tpl-pathfinder', 'historical-template']),
        });
        const before = structuredClone(store.getAgents());

        await catalogue.ensureDefaultBundledAgents(dependencies);

        expect(store.getAgents()).toEqual(before);
        expect([...dependencies.autoSeededTemplateIds]).toEqual(['tpl-prose-polisher', 'tpl-pathfinder', 'historical-template']);
        expect(dependencies.saveAgent).not.toHaveBeenCalled();
        expect(entries(catalogue, dependencies).map(entry => entry.key)).toEqual(['agent:saved-helper']);
    });

    test('does not resurrect deleted Prose Polisher, but still re-ensures a missing internal Pathfinder', async () => {
        const catalogue = await importCatalogue();
        const dependencies = context([template({ id: 'tpl-prose-polisher' }), template({ id: 'tpl-pathfinder', name: 'Pathfinder' })], {
            autoSeededTemplateIds: new Set(['tpl-prose-polisher', 'tpl-pathfinder']),
        });

        await catalogue.ensureDefaultBundledAgents(dependencies);

        expect(store.getAgents().map(agent => agent.sourceTemplateId)).toEqual(['tpl-pathfinder']);
        expect([...dependencies.autoSeededTemplateIds]).toEqual(['tpl-prose-polisher', 'tpl-pathfinder']);
    });

    test('retains the reset missing-default path without adding internal or unused catalogue members', async () => {
        const catalogue = await importCatalogue();
        const dependencies = context([template(), template({ id: 'tpl-other' }), template({ id: 'tpl-pathfinder', name: 'Pathfinder' })]);
        catalogue.DEFAULT_BUNDLED_TEMPLATE_IDS.add('tpl-helper');
        try {
            expect(await catalogue.resetBundledAgents(dependencies)).toEqual({ reset: 0, added: 1 });
            expect(store.getAgents()).toEqual([expect.objectContaining({ sourceTemplateId: 'tpl-helper', enabled: false })]);
            expect([...dependencies.autoSeededTemplateIds]).toEqual(['tpl-helper']);
            expect(dependencies.persistState).toHaveBeenCalledTimes(1);
        } finally {
            catalogue.DEFAULT_BUNDLED_TEMPLATE_IDS.delete('tpl-helper');
        }
    });
});
