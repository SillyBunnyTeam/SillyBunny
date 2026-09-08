import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/profile-utils.js', () => ({ listConnectionProfiles: () => [] }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/pathfinder-tool-bridge.js', () => ({ getWritableBooks: () => ['Book A'] }));

const { replaceSettings } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');
const { initAutoSummary, deinitAutoSummary, getAutoSummaryCount, resetAutoSummaryCount, shouldAutoSummarize } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/auto-summary.js');

describe('Pathfinder lifecycle integration', () => {
    beforeEach(() => {
        deinitAutoSummary();
        replaceSettings({ autoSummary: true, autoSummaryInterval: 2 });
    });

    test('keeps native activation before both prompt builders consume retrieval injections', () => {
        const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
        const native = source.indexOf('= await getWorldInfoPrompt(chatForWI,');
        const story = source.indexOf('const afterScenarioAnchor = await getExtensionPrompt(');
        const chatCompletion = source.indexOf('await prepareOpenAIMessages(', native);
        expect(native).toBeGreaterThan(0);
        expect(story).toBeGreaterThan(native);
        expect(chatCompletion).toBeGreaterThan(native);
        const worldInfo = readFileSync(new URL('../public/scripts/world-info.js', import.meta.url), 'utf8');
        expect(worldInfo.indexOf('await eventSource.emit(event_types.WORLD_INFO_ACTIVATED')).toBeGreaterThan(worldInfo.indexOf('const activatedWorldInfo = await checkWorldInfo('));
    });

    test('keeps the dispatch wrapper after the pre-generation hook, before member generation', () => {
        const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
        const afterCommands = source.indexOf('await eventSource.emit(event_types.GENERATION_AFTER_COMMANDS');
        const wrapper = source.indexOf('if (selected_group && !is_group_generating)', afterCommands);
        expect(afterCommands).toBeGreaterThan(0);
        expect(wrapper).toBeGreaterThan(afterCommands);
        expect(source.indexOf('return await generateGroupWrapper(', wrapper)).toBeGreaterThan(wrapper);
    });

    test('does not duplicate auto-summary listeners across init, teardown and re-enable', () => {
        const events = new EventEmitter();
        const types = { MESSAGE_RECEIVED: 'received', MESSAGE_SENT: 'sent' };
        initAutoSummary(events, types);
        initAutoSummary(events, types);
        events.emit(types.MESSAGE_SENT);
        expect(getAutoSummaryCount()).toBe(1);
        events.emit(types.MESSAGE_RECEIVED);
        expect(shouldAutoSummarize()).toBe(true);
        resetAutoSummaryCount();
        expect(shouldAutoSummarize()).toBe(false);
        deinitAutoSummary();
        events.emit(types.MESSAGE_RECEIVED);
        expect(getAutoSummaryCount()).toBe(0);
        initAutoSummary(events, types);
        events.emit(types.MESSAGE_RECEIVED);
        expect(getAutoSummaryCount()).toBe(1);
        deinitAutoSummary();
        expect(events.listenerCount(types.MESSAGE_RECEIVED)).toBe(0);
        expect(events.listenerCount(types.MESSAGE_SENT)).toBe(0);
    });
});
