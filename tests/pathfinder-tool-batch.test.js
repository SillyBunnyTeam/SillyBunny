/* eslint-disable playwright/no-standalone-expect */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/tool-calling.js', import.meta.url), 'utf8');

function tools() {
    const context = vm.createContext({ console, Error, toastr: { info: jest.fn(), clear: jest.fn() }, stringify: value => JSON.stringify(value) });
    vm.runInContext(source.slice(source.indexOf('class ToolDefinition {')).replace('export class ToolManager', 'class ToolManager') + '\nthis.ToolManager = ToolManager;', context);
    return context;
}

const response = ['Pathfinder_Search', 'Pathfinder_Remember'].map((name, index) => ({ id: String(index), function: { name, arguments: '{}' } }));

describe('tool response origin', () => {
    test.each(['chat response', 'stream response'])('preserves active multi-tool batches for a %s', async format => {
        const context = tools();
        const action = jest.fn(async () => 'ok');
        for (const name of ['Pathfinder_Search', 'Pathfinder_Remember']) context.ToolManager.registerFunctionTool({ name, action });
        const data = { 'chat response': { choices: [{ index: 0, message: { tool_calls: response } }] }, 'stream response': [response] }[format];
        const result = await context.ToolManager.invokeFunctionTools(data);
        expect(action).toHaveBeenCalledTimes(2);
        expect(result.invocations).toHaveLength(2);
    });

    test.each(['chat', 'signal'])('does not start a second tool after the first tool changes %s', async mode => {
        const context = tools();
        const controller = new AbortController();
        let chatId = 'original';
        const original = chatId;
        const search = jest.fn(async () => {
            await Promise.resolve();
            ({ chat: () => { chatId = 'different'; }, signal: () => controller.abort() })[mode]();
            return 'found';
        });
        context.ToolManager.registerFunctionTool({ name: 'Pathfinder_Search', action: search });
        const remember = jest.fn();
        context.ToolManager.registerFunctionTool({ name: 'Pathfinder_Remember', action: remember });
        await context.ToolManager.invokeFunctionTools({ choices: [{ index: 0, message: { tool_calls: response } }] }, { isCurrent: () => chatId === original, signal: controller.signal });
        expect(search).toHaveBeenCalledTimes(1);
        expect(remember).not.toHaveBeenCalled();
    });

    test('rechecks origin after an asynchronous formatter, before executing or showing a toast', async () => {
        const context = tools();
        let current = true;
        const action = jest.fn();
        context.ToolManager.registerFunctionTool({ name: 'Pathfinder_Search', action, formatMessage: async () => { current = false; return 'Search'; } });
        await context.ToolManager.invokeFunctionTools({ choices: [{ index: 0, message: { tool_calls: response.slice(0, 1) } }] }, { isCurrent: () => current });
        expect(action).not.toHaveBeenCalled();
        expect(context.toastr.info).not.toHaveBeenCalled();
    });
});
