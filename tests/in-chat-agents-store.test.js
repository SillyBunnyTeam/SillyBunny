/* global globalThis */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

describe('in-chat agent scoped enabled state', () => {
    let context;
    let extensionSettings;
    let saveSettingsDebounced;

    async function importStore() {
        jest.resetModules();

        context = { groupId: null };
        extensionSettings = {};
        saveSettingsDebounced = jest.fn();

        await jest.unstable_mockModule('../public/script.js', () => ({
            getRequestHeaders: jest.fn(() => ({})),
            saveSettingsDebounced,
        }));

        await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
            extension_settings: extensionSettings,
            getContext: jest.fn(() => context),
        }));

        await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
            regexFromString: jest.fn(value => {
                const match = String(value ?? '').match(/^\/([\s\S]*)\/([a-z]*)$/i);
                return match ? new RegExp(match[1], match[2]) : new RegExp(String(value ?? ''));
            }),
            uuidv4: jest.fn(() => 'test-uuid'),
        }));

        return await import('../public/scripts/extensions/in-chat-agents/agent-store.js');
    }

    beforeEach(() => {
        delete globalThis.fetch;
    });

    function useAgents(store) {
        store.loadAgents([
            {
                id: 'agent-individual',
                name: 'Individual Agent',
                enabled: true,
                category: 'custom',
                injection: { order: 10 },
            },
            {
                id: 'agent-group',
                name: 'Group Agent',
                enabled: false,
                category: 'tool',
                injection: { order: 20 },
            },
        ]);
    }

    test('keeps individual and group enabled agents separate when scoped toggles are enabled', async () => {
        const store = await importStore();
        useAgents(store);

        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['agent-individual']);

        store.setGlobalSettings({ separateRecentChats: true });
        expect(store.initializeScopedAgentEnableState()).toBe(true);
        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['agent-individual']);

        context.groupId = 'group-1';
        expect(store.getEnabledAgents()).toEqual([]);

        const groupAgent = store.getAgentById('agent-group');
        store.setAgentEnabledForCurrentScope(groupAgent, true);
        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['agent-group']);
        expect(store.getEnabledToolAgents().map(agent => agent.id)).toEqual(['agent-group']);

        context.groupId = null;
        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['agent-individual']);
    });

    test('persists scoped global settings without changing extension state shape', async () => {
        const store = await importStore();
        useAgents(store);

        store.setGlobalSettings({ separateRecentChats: true });
        store.initializeScopedAgentEnableState();
        store.persistAgentGlobalSettings();

        expect(extensionSettings.inChatAgents.globalSettings.enabledAgentIdsByChatType).toEqual({
            individual: ['agent-individual'],
            group: [],
        });
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('exposes an empty helper prefill global setting by default', async () => {
        const store = await importStore();

        expect(store.getGlobalSettings().helperPrefillMessages).toBe('');
    });

    test('resolves compact regex snapshots from runtime cache', async () => {
        const store = await importStore();
        const snapshotStore = await import('../public/scripts/extensions/in-chat-agents/regex-snapshot-store.js');
        const regexScript = {
            id: 'script-1',
            findRegex: '/foo/g',
            replaceString: '<div>bar</div>',
        };

        store.loadAgents([{
            id: 'agent-1',
            name: 'Regex Agent',
            regexScripts: [regexScript],
        }]);

        const refs = snapshotStore.buildRegexScriptRefsForAgent('agent-1', store.getAgentById('agent-1').regexScripts);
        expect(snapshotStore.resolveRegexScriptsForSnapshot({ regexScriptRefs: refs })).toEqual(store.getAgentById('agent-1').regexScripts);
        expect(JSON.stringify({ regexScriptRefs: refs })).not.toContain(regexScript.replaceString);
        expect(snapshotStore.resolveRegexScriptsForSnapshot({ regexScripts: [regexScript] })).toEqual([regexScript]);
    });

    test('migrates legacy regex snapshots in messages and swipe metadata when refs are resolvable', async () => {
        const store = await importStore();
        const snapshotStore = await import('../public/scripts/extensions/in-chat-agents/regex-snapshot-store.js');
        const regexScript = {
            id: 'script-1',
            findRegex: '/foo/g',
            replaceString: 'bar',
        };

        store.loadAgents([{
            id: 'agent-1',
            name: 'Regex Agent',
            regexScripts: [regexScript],
        }]);

        const storedRegexScript = store.getAgentById('agent-1').regexScripts[0];
        const legacySnapshot = {
            activeAgentIds: ['agent-1'],
            generationType: 'normal',
            regexScripts: [structuredClone(storedRegexScript)],
            edited: true,
            extraField: 'preserved',
        };
        const message = {
            extra: { inChatAgents: structuredClone(legacySnapshot) },
            swipe_info: [{ extra: { inChatAgents: structuredClone(legacySnapshot) } }],
        };

        expect(snapshotStore.migrateLegacyRegexSnapshotsInMessages([message])).toBe(2);

        const expectedRefs = snapshotStore.buildRegexScriptRefsForAgent('agent-1', store.getAgentById('agent-1').regexScripts);
        expect(message.extra.inChatAgents).toMatchObject({
            activeAgentIds: ['agent-1'],
            generationType: 'normal',
            edited: true,
            extraField: 'preserved',
            regexScriptRefs: expectedRefs,
        });
        expect(message.extra.inChatAgents.regexScripts).toBeUndefined();
        expect(message.swipe_info[0].extra.inChatAgents.regexScriptRefs).toEqual(expectedRefs);
        expect(message.swipe_info[0].extra.inChatAgents.regexScripts).toBeUndefined();
        expect(snapshotStore.resolveRegexScriptsForSnapshot(message.extra.inChatAgents)).toEqual(store.getAgentById('agent-1').regexScripts);
    });

    test('leaves legacy regex snapshots inline when refs are missing, changed, or ambiguous', async () => {
        const store = await importStore();
        const snapshotStore = await import('../public/scripts/extensions/in-chat-agents/regex-snapshot-store.js');
        const legacyScript = {
            id: 'script-1',
            findRegex: '/foo/g',
            replaceString: 'old',
        };
        store.loadAgents([
            {
                id: 'agent-1',
                name: 'Changed Regex Agent',
                regexScripts: [{ ...legacyScript, replaceString: 'new' }],
            },
            {
                id: 'agent-2',
                name: 'Ambiguous Regex Agent A',
                regexScripts: [legacyScript],
            },
            {
                id: 'agent-3',
                name: 'Ambiguous Regex Agent B',
                regexScripts: [legacyScript],
            },
        ]);
        const mismatchedLegacyScript = {
            ...structuredClone(store.getAgentById('agent-1').regexScripts[0]),
            replaceString: 'old',
        };
        const ambiguousLegacyScript = structuredClone(store.getAgentById('agent-2').regexScripts[0]);
        const mismatchMessage = {
            extra: {
                inChatAgents: {
                    activeAgentIds: ['agent-1'],
                    generationType: 'normal',
                    regexScripts: [structuredClone(mismatchedLegacyScript)],
                },
            },
        };
        const ambiguousMessage = {
            extra: {
                inChatAgents: {
                    activeAgentIds: ['agent-2', 'agent-3'],
                    generationType: 'normal',
                    regexScripts: [structuredClone(ambiguousLegacyScript)],
                },
            },
        };
        const missingMessage = {
            extra: {
                inChatAgents: {
                    activeAgentIds: ['missing-agent'],
                    generationType: 'normal',
                    regexScripts: [structuredClone(ambiguousLegacyScript)],
                },
            },
        };

        expect(snapshotStore.migrateLegacyRegexSnapshotsInMessages([mismatchMessage, ambiguousMessage, missingMessage])).toBe(0);
        expect(mismatchMessage.extra.inChatAgents.regexScripts).toEqual([mismatchedLegacyScript]);
        expect(mismatchMessage.extra.inChatAgents.regexScriptRefs).toBeUndefined();
        expect(ambiguousMessage.extra.inChatAgents.regexScripts).toEqual([ambiguousLegacyScript]);
        expect(ambiguousMessage.extra.inChatAgents.regexScriptRefs).toBeUndefined();
        expect(missingMessage.extra.inChatAgents.regexScripts).toEqual([ambiguousLegacyScript]);
        expect(missingMessage.extra.inChatAgents.regexScriptRefs).toBeUndefined();
    });

    test('recovers legacy enabled agents missing from initialized scoped settings', async () => {
        const store = await importStore();
        store.setGlobalSettings({
            separateRecentChats: true,
            scopedEnabledAgentIdsInitialized: true,
            enabledAgentIdsByChatType: {
                individual: ['agent-individual'],
                group: [],
            },
        });
        store.loadAgents([
            {
                id: 'agent-individual',
                name: 'Individual Agent',
                enabled: true,
                category: 'custom',
                injection: { order: 10 },
            },
            {
                id: 'agent-post',
                name: 'Saved Post Agent',
                enabled: true,
                category: 'content',
                injection: { order: 20 },
                phase: 'post',
            },
            {
                id: 'agent-disabled',
                name: 'Disabled Agent',
                enabled: false,
                category: 'custom',
                injection: { order: 30 },
            },
        ]);

        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['agent-individual']);
        expect(store.reconcileScopedEnabledAgentIdsFromLegacyFlags()).toBe(true);
        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['agent-individual', 'agent-post']);
        expect(store.getGlobalSettings().enabledAgentIdsByChatType).toEqual({
            individual: ['agent-individual', 'agent-post'],
            group: [],
        });
    });

    test('normalizes pre-generation intercept settings with safe defaults', async () => {
        const store = await importStore();
        store.loadAgents([{
            id: 'agent-intercept',
            name: 'Intercept Agent',
            preProcess: {
                mode: 'intercept',
                interceptTiming: 'post-main-generation',
                applyMode: 'patch',
                wrapPosition: 'before',
                wrapPrefix: 'prefix',
                wrapSuffix: 'suffix',
                patchStartTag: '',
                patchEndTag: '<done>',
                maxTokens: 999999,
            },
        }]);

        expect(store.getAgentById('agent-intercept').preProcess).toEqual(expect.objectContaining({
            mode: 'intercept',
            interceptTiming: 'post-main-generation',
            applyMode: 'patch',
            wrapPosition: 'before',
            wrapPrefix: 'prefix',
            wrapSuffix: 'suffix',
            patchStartTag: '<context_patch>',
            patchEndTag: '<done>',
            maxTokens: 16000,
        }));

        store.loadAgents([{
            id: 'agent-invalid-intercept',
            name: 'Invalid Intercept Agent',
            preProcess: {
                mode: 'unknown',
                interceptTiming: 'after-lunch',
                applyMode: 'unknown',
                wrapPosition: 'middle',
                maxTokens: 'not-a-number',
            },
        }]);

        expect(store.getAgentById('agent-invalid-intercept').preProcess).toEqual(expect.objectContaining({
            mode: 'inject',
            interceptTiming: 'pre-generation',
            applyMode: 'replace',
            wrapPosition: 'after',
            maxTokens: store.DEFAULT_AGENT_MAX_TOKENS,
        }));
    });

    test('defaults agents to inline execution with companion settings available', async () => {
        const store = await importStore();
        const agent = store.createDefaultAgent();

        expect(agent.execution).toBe('inline');
        expect(agent.companion).toEqual({
            trigger: 'auto',
            displayMode: 'panel',
            format: 'markdown',
            rawPrompt: false,
            inlinePhase: '',
            minContextTokens: 0,
            contextMessages: 10,
            includeCharacterCard: true,
            includePersona: true,
            includeWorldInfo: true,
            includeAuthorsNote: true,
            includeSystemPrompt: true,
            includeHistory: true,
            historyDepth: 3,
            feedback: {
                enabled: false,
                depth: 1,
            },
            batch: false,
            maxTokens: 2048,
        });
        expect(store.isCompanionAgent(agent)).toBe(false);
    });

    test('normalizes companion execution settings with safe defaults and clamps', async () => {
        const store = await importStore();

        expect(store.normalizeCompanionConfig({
            trigger: 'manual',
            displayMode: 'hidden',
            format: 'html',
            contextMessages: 999,
            includeCharacterCard: true,
            includePersona: true,
            includeWorldInfo: true,
            includeHistory: true,
            historyDepth: -1,
            feedback: {
                enabled: true,
                depth: 999,
            },
            batch: true,
            maxTokens: 999999,
        })).toEqual(expect.objectContaining({
            trigger: 'manual',
            displayMode: 'hidden',
            format: 'html',
            contextMessages: 50,
            includeCharacterCard: true,
            includePersona: true,
            includeWorldInfo: true,
            includeHistory: true,
            historyDepth: 1,
            feedback: {
                enabled: true,
                depth: 10,
            },
            batch: true,
            maxTokens: 16000,
        }));

        expect(store.normalizeCompanionConfig({
            trigger: 'sometimes',
            displayMode: 'window',
            format: 'pdf',
            contextMessages: 'never',
            historyDepth: 'never',
            feedback: { depth: 'never' },
            maxTokens: 'never',
        })).toEqual(store.createDefaultCompanionConfig());
    });

    test('normalizes category and execution independently for companion agents', async () => {
        const store = await importStore();
        store.loadAgents([
            {
                id: 'pure-companion',
                name: 'Pure Companion',
                category: 'companion',
                execution: 'inline',
            },
            {
                id: 'tracker-companion',
                name: 'Status Tracker',
                category: 'companion',
                sourceTemplateId: 'tpl-status-tracker',
                execution: 'companion',
            },
        ]);

        expect(store.getAgentById('pure-companion')).toEqual(expect.objectContaining({
            category: 'companion',
            execution: 'companion',
        }));
        expect(store.isCompanionAgent(store.getAgentById('pure-companion'))).toBe(true);
        expect(store.getCompanionConfig(store.getAgentById('pure-companion'))).toEqual(store.createDefaultCompanionConfig());

        expect(store.getAgentById('tracker-companion')).toEqual(expect.objectContaining({
            category: 'tracker',
            execution: 'companion',
        }));
        expect(store.isCompanionAgent(store.getAgentById('tracker-companion'))).toBe(true);
    });

    test('converts an inline tracker to companion execution while keeping its identity', async () => {
        const store = await importStore();
        store.loadAgents([{
            id: 'inline-tracker',
            name: 'Inline Tracker',
            category: 'tracker',
            phase: 'pre',
            prompt: 'Track statuses.',
            regexScripts: [{ id: 'rs-1', scriptName: 'Beautifier', findRegex: '/foo/', replaceString: 'bar' }],
            injection: { position: 1, depth: 6, role: 2, order: 42, scan: true },
            conditions: { triggerKeywords: ['status'], triggerProbability: 100, generationTypes: ['normal'] },
        }]);
        const agent = store.getAgentById('inline-tracker');

        expect(store.convertAgentExecution(agent, 'companion')).toBe(true);

        expect(agent.execution).toBe('companion');
        expect(agent.phase).toBe('post');
        expect(agent.category).toBe('tracker');
        expect(store.isCompanionAgent(agent)).toBe(true);
        expect(agent.companion).toEqual({
            ...store.createDefaultCompanionConfig(),
            displayMode: 'panel',
            rawPrompt: true,
            inlinePhase: 'pre',
            feedback: { enabled: true, depth: 1 },
        });
        expect(agent.regexScripts).toHaveLength(1);
        expect(agent.regexScripts[0]).toEqual(expect.objectContaining({ findRegex: '/foo/', replaceString: 'bar' }));
        expect(agent.injection).toEqual(expect.objectContaining({ position: 1, depth: 6, role: 2, order: 42, scan: true }));
        expect(agent.conditions.triggerKeywords).toEqual(['status']);
        expect(agent.prompt).toBe('Track statuses.');
    });

    test('converts a companion-category agent back to inline by moving it to custom', async () => {
        const store = await importStore();
        store.loadAgents([{
            id: 'pure-companion',
            name: 'Pure Companion',
            category: 'companion',
            execution: 'companion',
            prompt: 'Write a side note.',
        }]);
        const agent = store.getAgentById('pure-companion');

        expect(store.convertAgentExecution(agent, 'inline')).toBe(true);

        expect(agent.execution).toBe('inline');
        expect(agent.category).toBe('custom');
        expect(store.isCompanionAgent(agent)).toBe(false);
    });

    test('round-trips a customized companion config through inline conversion', async () => {
        const store = await importStore();
        store.loadAgents([{
            id: 'customized-companion',
            name: 'Customized Companion',
            category: 'custom',
            execution: 'companion',
            prompt: 'Write a side note.',
            companion: { trigger: 'manual', format: 'text', maxTokens: 4096 },
        }]);
        const agent = store.getAgentById('customized-companion');

        expect(store.convertAgentExecution(agent, 'inline')).toBe(true);
        expect(agent.companion).toEqual(expect.objectContaining({ trigger: 'manual', format: 'text', maxTokens: 4096 }));

        expect(store.convertAgentExecution(agent, 'companion')).toBe(true);
        expect(store.isCompanionAgent(agent)).toBe(true);
        expect(agent.companion).toEqual(expect.objectContaining({ trigger: 'manual', format: 'text', maxTokens: 4096 }));
    });

    test('keeps converted trackers in the automatic panel loop', async () => {
        const store = await importStore();
        store.loadAgents([
            { id: 'plain-tracker', name: 'Plain Tracker', category: 'tracker', phase: 'pre' },
            { id: 'plain-content', name: 'Content Agent', category: 'content', phase: 'post' },
        ]);

        const plainTracker = store.getAgentById('plain-tracker');
        expect(store.convertAgentExecution(plainTracker, 'companion')).toBe(true);
        expect(plainTracker.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            displayMode: 'panel',
            rawPrompt: true,
            feedback: expect.objectContaining({ enabled: true }),
        }));

        const contentAgent = store.getAgentById('plain-content');
        expect(store.convertAgentExecution(contentAgent, 'companion')).toBe(true);
        expect(contentAgent.companion).toEqual(expect.objectContaining({
            displayMode: 'panel',
            rawPrompt: false,
            feedback: expect.objectContaining({ enabled: false }),
        }));
    });

    test('applies the tracker auto-loop defaults once and only to tracker companions', async () => {
        const store = await importStore();
        store.loadAgents([
            {
                id: 'manual-card-tracker',
                name: 'Manual Card Tracker',
                category: 'tracker',
                execution: 'companion',
                companion: { trigger: 'manual', displayMode: 'card', feedback: { enabled: false, depth: 2 } },
            },
            { id: 'inline-tracker', name: 'Inline Tracker', category: 'tracker' },
            { id: 'note-companion', name: 'Note Companion', category: 'companion', execution: 'companion' },
        ]);

        const trackerCompanion = store.getAgentById('manual-card-tracker');
        expect(store.applyTrackerCompanionAutoLoopDefaults(trackerCompanion)).toBe(true);
        expect(trackerCompanion.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            displayMode: 'panel',
            rawPrompt: true,
            feedback: { enabled: true, depth: 2 },
        }));
        expect(store.applyTrackerCompanionAutoLoopDefaults(trackerCompanion)).toBe(false);

        expect(store.applyTrackerCompanionAutoLoopDefaults(store.getAgentById('inline-tracker'))).toBe(false);
        const noteCompanion = store.getAgentById('note-companion');
        expect(store.applyTrackerCompanionAutoLoopDefaults(noteCompanion)).toBe(false);
        expect(noteCompanion.companion.displayMode).toBe('panel');
    });

    test('normalizes the panel display mode for companion configs', async () => {
        const store = await importStore();

        expect(store.normalizeCompanionConfig({ displayMode: 'panel' }).displayMode).toBe('panel');
        expect(store.normalizeCompanionConfig({ displayMode: 'window' }).displayMode).toBe('panel');
        expect(store.normalizeCompanionConfig({}).minContextTokens).toBe(0);
        expect(store.normalizeCompanionConfig({ minContextTokens: 30000 }).minContextTokens).toBe(30000);
        expect(store.normalizeCompanionConfig({ minContextTokens: 500000 }).minContextTokens).toBe(200000);
    });

    test('grants context access defaults to companions while honoring explicit choices', async () => {
        const store = await importStore();
        store.loadAgents([
            {
                id: 'opted-out-companion',
                name: 'Opted Out',
                category: 'companion',
                execution: 'companion',
                companion: { includeCharacterCard: false, includePersona: false, includeWorldInfo: false, includeAuthorsNote: false, includeSystemPrompt: false },
            },
            { id: 'fresh-companion', name: 'Fresh', category: 'companion', execution: 'companion' },
            { id: 'inline-agent', name: 'Inline', category: 'custom' },
        ]);

        // Stored explicit false survives normalization; absent keys pick up the new true defaults.
        const optedOut = store.getAgentById('opted-out-companion');
        expect(optedOut.companion.includeCharacterCard).toBe(false);
        expect(store.getAgentById('fresh-companion').companion).toEqual(expect.objectContaining({
            includeCharacterCard: true,
            includePersona: true,
            includeWorldInfo: true,
            includeAuthorsNote: true,
            includeSystemPrompt: true,
        }));

        expect(store.applyCompanionContextAccessDefaults(optedOut)).toBe(true);
        expect(optedOut.companion).toEqual(expect.objectContaining({
            includeCharacterCard: true,
            includeAuthorsNote: true,
            includeSystemPrompt: true,
            includeHistory: true,
        }));
        expect(store.applyCompanionContextAccessDefaults(optedOut)).toBe(false);
        expect(store.applyCompanionContextAccessDefaults(store.getAgentById('inline-agent'))).toBe(false);
    });

    test('moves card-mode companions into the panel once', async () => {
        const store = await importStore();
        store.loadAgents([
            { id: 'card-companion', name: 'Card Companion', category: 'companion', execution: 'companion', companion: { displayMode: 'card' } },
            { id: 'hidden-companion', name: 'Hidden Companion', category: 'companion', execution: 'companion', companion: { displayMode: 'hidden' } },
            { id: 'inline-agent', name: 'Inline', category: 'custom' },
        ]);

        const cardCompanion = store.getAgentById('card-companion');
        expect(store.applyCompanionPanelDisplayDefault(cardCompanion)).toBe(true);
        expect(cardCompanion.companion.displayMode).toBe('panel');
        expect(store.applyCompanionPanelDisplayDefault(cardCompanion)).toBe(false);

        const hiddenCompanion = store.getAgentById('hidden-companion');
        expect(store.applyCompanionPanelDisplayDefault(hiddenCompanion)).toBe(false);
        expect(hiddenCompanion.companion.displayMode).toBe('hidden');

        expect(store.applyCompanionPanelDisplayDefault(store.getAgentById('inline-agent'))).toBe(false);
    });

    test('matches agents to list tabs by phase and execution', async () => {
        const store = await importStore();
        const preAgent = { phase: 'pre' };
        const postAgent = { phase: 'post' };
        const bothAgent = { phase: 'both' };
        const companionAgent = { phase: 'post', execution: 'companion' };

        expect(store.agentMatchesListTab(preAgent, 'pre')).toBe(true);
        expect(store.agentMatchesListTab(preAgent, 'post')).toBe(false);
        expect(store.agentMatchesListTab(postAgent, 'post')).toBe(true);
        expect(store.agentMatchesListTab(bothAgent, 'pre')).toBe(true);
        expect(store.agentMatchesListTab(bothAgent, 'post')).toBe(true);
        expect(store.agentMatchesListTab(companionAgent, 'companion')).toBe(true);
        expect(store.agentMatchesListTab(companionAgent, 'post')).toBe(false);
        expect(store.agentMatchesListTab(preAgent, 'all')).toBe(true);
        expect(store.agentMatchesListTab(companionAgent, 'all')).toBe(true);
    });

    test('resolves companion connection profiles through the dedicated default', async () => {
        const store = await importStore();
        store.setGlobalSettings({ connectionProfile: 'default-profile', companionConnectionProfile: 'cheap-profile' });

        expect(store.resolveCompanionConnectionProfile('agent-profile')).toBe('agent-profile');
        expect(store.resolveCompanionConnectionProfile('')).toBe('cheap-profile');
        expect(store.resolveConnectionProfile('')).toBe('default-profile');

        store.setGlobalSettings({ companionConnectionProfile: '' });
        expect(store.resolveCompanionConnectionProfile('')).toBe('default-profile');
    });

    test('restores the inline phase when converting a companion back', async () => {
        const store = await importStore();
        store.loadAgents([{
            id: 'pre-gen-tracker',
            name: 'Pre Tracker',
            category: 'tracker',
            phase: 'pre',
            prompt: 'Track things.',
        }]);
        const agent = store.getAgentById('pre-gen-tracker');

        expect(store.convertAgentExecution(agent, 'companion')).toBe(true);
        expect(agent.phase).toBe('post');
        expect(agent.companion.inlinePhase).toBe('pre');

        expect(store.convertAgentExecution(agent, 'inline')).toBe(true);
        expect(agent.phase).toBe('pre');
    });

    test('refuses no-op and tool-agent execution conversions', async () => {
        const store = await importStore();
        store.loadAgents([
            { id: 'already-companion', name: 'Companion', category: 'companion', execution: 'companion' },
            { id: 'already-inline', name: 'Inline', category: 'custom' },
            { id: 'tool-agent', name: 'Tool', category: 'tool' },
        ]);

        expect(store.convertAgentExecution(store.getAgentById('already-companion'), 'companion')).toBe(false);
        expect(store.convertAgentExecution(store.getAgentById('already-inline'), 'inline')).toBe(false);
        expect(store.convertAgentExecution(store.getAgentById('tool-agent'), 'companion')).toBe(false);
        expect(store.convertAgentExecution(undefined, 'companion')).toBe(false);
    });

    test('preserves disabled Pathfinder summary tool toggles while normalizing agents', async () => {
        const store = await importStore();
        store.loadAgents([
            {
                id: 'pathfinder-agent',
                name: 'Pathfinder',
                category: 'tool',
                sourceTemplateId: 'tpl-pathfinder',
                tools: [
                    { name: 'Pathfinder_Summarize', enabled: false },
                    { name: 'Pathfinder_Search', enabled: true },
                ],
            },
        ]);

        expect(store.getAgentById('pathfinder-agent').tools).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'Pathfinder_Summarize', enabled: false }),
            expect.objectContaining({ name: 'Pathfinder_Search', enabled: true }),
        ]));
    });

    test('removes duplicate Pathfinder template agents while keeping the bundled automatic entry', async () => {
        const store = await importStore();
        const templates = [{
            id: 'tpl-pathfinder',
            name: 'Pathfinder',
            prompt: '',
            category: 'tool',
        }];
        const agents = [
            {
                id: 'keep-pathfinder',
                name: 'Pathfinder',
                prompt: '',
                category: 'tool',
                sourceTemplateId: 'tpl-pathfinder',
                author: 'SillyBunny',
                tools: [{ name: 'Pathfinder_Search' }],
            },
            {
                id: 'duplicate-pathfinder',
                name: 'Pathfinder',
                prompt: '',
                category: 'tool',
                author: 'SillyBunny',
                tools: [{ name: 'Pathfinder_Search' }],
            },
            {
                id: 'custom-locked-pathfinder',
                name: 'Pathfinder',
                prompt: '',
                category: 'tool',
                sourceTemplateId: 'tpl-pathfinder',
                author: 'SillyBunny',
                phaseLocked: true,
                tools: [{ name: 'Pathfinder_Search' }],
            },
        ];

        expect(store.getRedundantBundledAgentDuplicateIds(agents, templates)).toEqual(['duplicate-pathfinder']);
    });

    test('removes same-template duplicates while keeping the current template prompt', async () => {
        const store = await importStore();
        const templates = [{
            id: 'tpl-prose-polisher',
            name: 'Prose Polisher',
            prompt: 'new bundled wording',
            category: 'content',
        }];
        const agents = [
            {
                id: 'old-prose-polisher',
                name: 'Prose Polisher',
                prompt: 'old bundled wording',
                sourceTemplateId: 'tpl-prose-polisher',
                enabled: true,
            },
            {
                id: 'current-prose-polisher',
                name: 'Prose Polisher',
                prompt: 'new bundled wording',
                sourceTemplateId: 'tpl-prose-polisher',
                enabled: false,
            },
        ];

        expect(store.getRedundantBundledAgentDuplicateIds(agents, templates)).toEqual(['old-prose-polisher']);
    });

    test('does not mark phase-locked same-template duplicates redundant', async () => {
        const store = await importStore();
        const templates = [{
            id: 'tpl-prose-polisher',
            name: 'Prose Polisher',
            prompt: 'new bundled wording',
            category: 'content',
        }];
        const agents = [
            {
                id: 'old-locked-prose-polisher',
                name: 'Prose Polisher',
                prompt: 'old bundled wording',
                sourceTemplateId: 'tpl-prose-polisher',
                phaseLocked: true,
            },
            {
                id: 'current-prose-polisher',
                name: 'Prose Polisher',
                prompt: 'new bundled wording',
                sourceTemplateId: 'tpl-prose-polisher',
            },
        ];

        expect(store.getRedundantBundledAgentDuplicateIds(agents, templates)).toEqual([]);
    });

    test('matches bundled template snapshots after template prompt wording changes', async () => {
        const store = await importStore();
        const templates = [{
            id: 'tpl-achievements-tracker',
            name: 'Achievements Tracker',
            prompt: 'new bundled wording',
            author: 'Purachina',
            category: 'tracker',
        }];

        const agent = {
            id: 'saved-achievements',
            name: 'Achievements Tracker',
            prompt: 'old bundled wording',
            author: 'Purachina',
            category: 'tracker',
        };

        expect(store.findTemplateForAgentSnapshot(agent, templates)?.id).toBe('tpl-achievements-tracker');
    });

    test('normalizes legacy bundled tracker copies with stale categories', async () => {
        const store = await importStore();
        store.loadAgents([
            {
                id: 'saved-status',
                name: 'Saved Status',
                category: 'custom',
                sourceTemplateId: 'tpl-status-tracker',
                enabled: true,
            },
            {
                id: 'saved-scene',
                name: 'Scene Tracker',
                category: 'custom',
                enabled: true,
            },
        ]);

        expect(store.getAgentById('saved-status').category).toBe('tracker');
        expect(store.getAgentById('saved-scene').category).toBe('tracker');
        expect(store.getEnabledAgents().map(agent => agent.id)).toEqual(['saved-status', 'saved-scene']);
    });

    test('considers pre-phase extract trackers repairable', async () => {
        const store = await importStore();

        expect(store.isTrackerFixAgent({
            category: 'tracker',
            phase: 'pre',
            postProcess: {
                enabled: true,
                type: 'extract',
            },
        })).toBe(true);
        expect(store.isTrackerFixAgent({
            category: 'tracker',
            phase: 'pre',
            postProcess: {
                enabled: false,
                type: 'extract',
            },
        })).toBe(false);
        expect(store.isTrackerFixAgent({
            category: 'tracker',
            phase: 'pre',
            postProcess: {
                enabled: true,
                type: 'append',
            },
        })).toBe(false);
    });

    test('keeps prompt-changed custom snapshots from matching bundled templates', async () => {
        const store = await importStore();
        const templates = [{
            id: 'tpl-scene-tracker',
            name: 'Scene Tracker',
            prompt: 'new scene wording',
            author: 'Purachina',
            category: 'tracker',
        }];

        const agent = {
            id: 'custom-scene',
            name: 'Scene Tracker',
            prompt: 'custom scene wording',
            author: 'Someone Else',
            category: 'tracker',
        };

        expect(store.findTemplateForAgentSnapshot(agent, templates)).toBeNull();
    });
});
