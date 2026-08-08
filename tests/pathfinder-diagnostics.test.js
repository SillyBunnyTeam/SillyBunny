/* eslint-disable playwright/no-duplicate-hooks */
/* global globalThis */
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

const TOOL_NAMES = [
    'Pathfinder_Search',
    'Pathfinder_Summarize',
    'Pathfinder_Remember',
];

let mockSettings;
let mockTrees;
let mockActiveBooks;
let mockContextualBooks;
let mockEnabledAgents;
let mockRuntimeAgent;
let mockSyncToolAgentRegistrations;

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js', () => ({
    canDeleteBook: jest.fn(() => true),
    canReadBook: jest.fn(() => true),
    canWriteBook: jest.fn(() => true),
    getSettings: jest.fn(() => mockSettings),
    getTree: jest.fn(bookName => mockTrees[bookName] ?? null),
    getAllEntryUids: jest.fn(tree => tree.uids ?? []),
}));

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/pathfinder-tool-bridge.js', () => ({
    ALL_TOOL_NAMES: TOOL_NAMES,
    getActiveTunnelVisionBooks: jest.fn(() => mockActiveBooks),
    getContextualLorebooks: jest.fn(() => mockContextualBooks),
}));

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
    getEnabledToolAgents: jest.fn(() => mockEnabledAgents),
}));

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-runner.js', () => ({
    getPathfinderRuntimeAgent: jest.fn(() => mockRuntimeAgent),
    getToolRecursionState: jest.fn(() => ({ depth: 0, limit: 5, registeredToolNames: TOOL_NAMES })),
    isPathfinderToolEnabledForAgent: jest.fn((agent, toolName) => {
        const states = agent?.settings?.toolStates;
        if (states && Object.prototype.hasOwnProperty.call(states, toolName)) {
            return states[toolName] !== false;
        }
        const savedTool = agent?.tools?.find(tool => tool?.name === toolName);
        return savedTool?.enabled !== false;
    }),
    syncToolAgentRegistrations: jest.fn(() => mockSyncToolAgentRegistrations()),
}));

const { runDiagnostics } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/diagnostics.js');

describe('Pathfinder diagnostics', () => {
    beforeEach(() => {
        mockSettings = {
            enabledLorebooks: ['Manual Book'],
            includeContextualLorebooks: true,
            pipelineEnabled: false,
            sidecarEnabled: true,
            toolStates: Object.fromEntries(TOOL_NAMES.map(name => [name, true])),
            autoSyncLorebooksOnChatChange: true,
            dedupeNaturalActivation: true,
        };
        mockTrees = {
            'Manual Book': { uids: ['uid-1', 'uid-2'] },
        };
        mockActiveBooks = ['Manual Book'];
        mockContextualBooks = ['Chat Book'];
        mockEnabledAgents = [];
        mockRuntimeAgent = {
            tools: TOOL_NAMES.map(name => ({ name, enabled: true })),
        };
        mockSyncToolAgentRegistrations = jest.fn();
        globalThis.window = {
            SillyTavern: {
                getContext: () => ({
                    ToolManager: {
                        tools: TOOL_NAMES.map(name => ({ name })),
                        isToolCallingSupported: jest.fn(() => true),
                    },
                }),
            },
        };
    });

    afterEach(() => {
        delete globalThis.window;
    });

    test('accepts active enabled Pathfinder tools when each enabled tool is registered', async () => {
        const results = await runDiagnostics();

        expect(mockSyncToolAgentRegistrations).toHaveBeenCalledTimes(1);
        expect(results['Tool Registration']).toEqual({
            ok: true,
            message: 'All 3 enabled Pathfinder tool(s) registered and active. Registered: Pathfinder_Search, Pathfinder_Summarize, Pathfinder_Remember. Enabled: Pathfinder_Search, Pathfinder_Summarize, Pathfinder_Remember. Recursion: 0/5.',
        });
    });

    test('reports a missing Pathfinder runtime agent even when tools are registered', async () => {
        mockRuntimeAgent = null;

        const results = await runDiagnostics();

        expect(results['Tool Registration']).toEqual({
            ok: false,
            message: 'Tool mode is enabled, but the Pathfinder tool agent is not active right now. Enable Pathfinder as a tool agent, then reopen settings or reload agents.',
        });
    });

    test('uses enabled tools from the active Pathfinder agent instead of registered disabled-state guesses', async () => {
        mockRuntimeAgent = {
            tools: [
                { name: 'Pathfinder_Search', enabled: false },
                { name: 'Pathfinder_Summarize', enabled: true },
                { name: 'Pathfinder_Remember', enabled: false },
            ],
        };
        mockSettings.toolStates = {};
        globalThis.window.SillyTavern.getContext = () => ({
            ToolManager: {
                tools: new Map([
                    ['Pathfinder_Search', { name: 'Pathfinder_Search' }],
                    ['Pathfinder_Summarize', { name: 'Pathfinder_Summarize' }],
                    ['Pathfinder_Remember', { name: 'Pathfinder_Remember' }],
                ]),
                isToolCallingSupported: jest.fn(() => true),
            },
        });

        const results = await runDiagnostics();

        expect(results['Tool Registration']).toEqual({
            ok: true,
            message: 'All 1 enabled Pathfinder tool(s) registered and active. Registered: Pathfinder_Search, Pathfinder_Summarize, Pathfinder_Remember. Enabled: Pathfinder_Summarize. Recursion: 0/5.',
        });
    });

    test('prefers canonical toolStates over stale agent tool arrays', async () => {
        mockRuntimeAgent = {
            tools: TOOL_NAMES.map(name => ({ name, enabled: true })),
        };
        mockSettings.toolStates = {
            Pathfinder_Search: false,
            Pathfinder_Summarize: true,
            Pathfinder_Remember: false,
        };

        const results = await runDiagnostics();

        expect(results['Tool Registration']).toEqual({
            ok: true,
            message: 'All 1 enabled Pathfinder tool(s) registered and active. Registered: Pathfinder_Search, Pathfinder_Summarize, Pathfinder_Remember. Enabled: Pathfinder_Summarize. Recursion: 0/5.',
        });
    });
});
