/* eslint-disable playwright/no-standalone-expect */
/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { importOpenAiModule } from './util/openai-harness.js';

await importOpenAiModule({ mockToolCalling: false });
const { ToolManager } = await import('../public/scripts/tool-calling.js');

const TOOL_NAMES = ['Pathfinder_Search', 'Pathfinder_Remember'];
const response = TOOL_NAMES.map((name, index) => ({ id: String(index), function: { name, arguments: '{}' } }));

describe('tool response origin', () => {
    beforeEach(() => {
        for (const name of TOOL_NAMES) {
            ToolManager.unregisterFunctionTool(name);
        }
        globalThis.toastr.info.mockClear();
        globalThis.toastr.clear.mockClear();
    });

    afterEach(() => {
        for (const name of TOOL_NAMES) {
            ToolManager.unregisterFunctionTool(name);
        }
    });

    test.each(['chat response', 'stream response'])('preserves active multi-tool batches for a %s', async format => {
        const action = jest.fn(async () => 'ok');
        for (const name of TOOL_NAMES) ToolManager.registerFunctionTool({ name, action });
        const data = { 'chat response': { choices: [{ index: 0, message: { tool_calls: response } }] }, 'stream response': [response] }[format];
        const result = await ToolManager.invokeFunctionTools(data);
        expect(action).toHaveBeenCalledTimes(2);
        expect(result.invocations).toHaveLength(2);
    });

    test.each(['chat', 'signal'])('does not start a second tool after the first tool changes %s', async mode => {
        const controller = new AbortController();
        let chatId = 'original';
        const original = chatId;
        const search = jest.fn(async () => {
            await Promise.resolve();
            ({ chat: () => { chatId = 'different'; }, signal: () => controller.abort() })[mode]();
            return 'found';
        });
        ToolManager.registerFunctionTool({ name: 'Pathfinder_Search', action: search });
        const remember = jest.fn();
        ToolManager.registerFunctionTool({ name: 'Pathfinder_Remember', action: remember });
        await ToolManager.invokeFunctionTools({ choices: [{ index: 0, message: { tool_calls: response } }] }, { isCurrent: () => chatId === original, signal: controller.signal });
        expect(search).toHaveBeenCalledTimes(1);
        expect(remember).not.toHaveBeenCalled();
    });

    test('rechecks origin after an asynchronous formatter, before executing or showing a toast', async () => {
        let current = true;
        const action = jest.fn();
        ToolManager.registerFunctionTool({ name: 'Pathfinder_Search', action, formatMessage: async () => { current = false; return 'Search'; } });
        await ToolManager.invokeFunctionTools({ choices: [{ index: 0, message: { tool_calls: response.slice(0, 1) } }] }, { isCurrent: () => current });
        expect(action).not.toHaveBeenCalled();
        expect(globalThis.toastr.info).not.toHaveBeenCalled();
    });
});
