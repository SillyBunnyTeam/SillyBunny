/* eslint-disable playwright/no-duplicate-hooks */
/* global globalThis */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const toolSource = readFileSync(new URL('../public/scripts/tool-calling.js', import.meta.url), 'utf8');
const ToolDefinition = new Function(`return (${toolSource.match(/class ToolDefinition \{[\s\S]*?\n\}/)[0]});`)();
const TOOL_NAMES = ['Pathfinder_Search', 'Pathfinder_Summarize', 'Pathfinder_Remember'];
let runtimeAgent;
let refreshRegistrations;

await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ getContext: () => null }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
    isPathfinderSubmoduleEnabled: () => true,
    getEnabledToolAgents: () => runtimeAgent ? [runtimeAgent] : [],
}));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-runner.js', () => ({
    getPathfinderRuntimeAgent: () => runtimeAgent,
    getToolRecursionState: () => ({ depth: 0, limit: 5, registeredToolNames: TOOL_NAMES }),
    isPathfinderToolEnabledForAgent: (agent, name) => agent?.tools?.find(tool => tool.name === name)?.enabled === true,
    syncToolAgentRegistrations: () => refreshRegistrations(),
}));

const { clearAllTrees, getSettings, getTree, replaceSettings, saveTree } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');
const { runDiagnostics } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/diagnostics.js');

describe('Pathfinder diagnostics', () => {
    let manager;
    let load;
    let save;

    beforeEach(() => {
        clearAllTrees();
        replaceSettings({
            enabledLorebooks: ['Manual Book'], includeContextualLorebooks: false, sidecarEnabled: true,
            toolStates: Object.fromEntries(TOOL_NAMES.map(name => [name, true])),
        });
        saveTree('Manual Book', { id: 'root', entries: [0, 1], children: [] });
        runtimeAgent = { tools: TOOL_NAMES.map(name => ({ name, enabled: true })) };
        refreshRegistrations = jest.fn();
        manager = {
            tools: TOOL_NAMES.map(name => new ToolDefinition(name, name, '', {}, jest.fn())),
            isToolCallingSupported: () => true,
        };
        load = jest.fn();
        save = jest.fn();
        globalThis.window = { SillyTavern: { getContext: () => ({ ToolManager: manager, loadWorldInfo: load, saveWorldInfo: save }) } };
    });

    afterEach(() => { delete globalThis.window; });

    test('recognises registered real ToolDefinitions, which have no public name property', async () => {
        expect(manager.tools[0].name).toBeUndefined();
        expect(manager.tools[0].toFunctionOpenAI().function.name).toBe('Pathfinder_Search');
        const results = await runDiagnostics();
        expect(refreshRegistrations).toHaveBeenCalledTimes(1);
        expect(results['Tool Registration'].ok).toBe(true);
        expect(results['Tool Registration'].message).toContain('All 3 enabled Pathfinder tool(s) registered and active.');
        expect(results['Tool Registration'].message).toContain('Recursion: 0/5.');
    });

    test('reports a missing runtime agent rather than guessing from registration', async () => {
        runtimeAgent = null;
        const results = await runDiagnostics();
        expect(results['Tool Registration'].ok).toBe(false);
        expect(results['Tool Registration'].message).toContain('Pathfinder tool agent is not active');
    });

    test('uses enabled tools from the active agent when no canonical tool state is configured', async () => {
        runtimeAgent.tools.forEach(tool => { tool.enabled = tool.name === 'Pathfinder_Summarize'; });
        getSettings().toolStates = {};
        manager.tools = new Map(manager.tools.map(tool => [tool.toFunctionOpenAI().function.name, tool]));
        const results = await runDiagnostics();
        expect(results['Tool Registration'].ok).toBe(true);
        expect(results['Tool Registration'].message).toContain('All 1 enabled Pathfinder tool(s)');
        expect(results['Tool Registration'].message).toContain('Enabled: Pathfinder_Summarize.');
    });

    test('prefers canonical tool states over stale agent tool arrays', async () => {
        getSettings().toolStates = { Pathfinder_Search: false, Pathfinder_Summarize: true, Pathfinder_Remember: false };
        const results = await runDiagnostics();
        expect(results['Tool Registration'].ok).toBe(true);
        expect(results['Tool Registration'].message).toContain('Enabled: Pathfinder_Summarize.');
    });

    test('acquires settings after registration refresh replaces the settings object', async () => {
        const oldSettings = getSettings();
        refreshRegistrations.mockImplementation(() => replaceSettings({
            enabledLorebooks: ['New Book'], includeContextualLorebooks: false, sidecarEnabled: false, pipelineEnabled: true,
        }));
        const results = await runDiagnostics();
        expect(getSettings()).not.toBe(oldSettings);
        expect(results['Lorebooks'].message).toContain('New Book');
        expect(results['Tool Mode'].message).toBe('Disabled - AI cannot call Pathfinder tools');
        expect(results['Pipeline Mode'].message).toContain('Enabled (default pipeline)');
        expect(results['Tool Registration'].message).toContain('Tool mode disabled');
    });

    test('reports actually missing registrations without loading, building or saving lorebooks', async () => {
        manager.tools.pop();
        const before = structuredClone(getTree('Manual Book'));
        const results = await runDiagnostics();
        expect(results['Tool Registration'].ok).toBe(false);
        expect(results['Tool Registration'].message).toContain('Missing: Pathfinder_Remember.');
        expect(getTree('Manual Book')).toEqual(before);
        expect(load).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });
});
