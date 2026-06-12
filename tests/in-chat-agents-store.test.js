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
            displayMode: 'card',
            format: 'markdown',
            contextMessages: 10,
            includeCharacterCard: false,
            includePersona: false,
            includeWorldInfo: false,
            includeHistory: false,
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
