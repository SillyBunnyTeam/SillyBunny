/* eslint-disable playwright/no-duplicate-hooks, playwright/no-standalone-expect */
/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

let mockSettings;

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    escapeHtml: jest.fn(value => String(value)),
}));

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
    isPathfinderSubmoduleEnabled: jest.fn(() => true),
}));

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js', () => ({
    getSettings: jest.fn(() => mockSettings),
    getTree: jest.fn(() => null),
    getAllEntryUids: jest.fn(() => []),
    isEntryEligible: jest.fn(entry => entry && !entry.disable && !entry.agentBlacklisted),
    isLorebookEnabled: jest.fn(() => true),
    canReadBook: jest.fn(() => true),
    canWriteBook: jest.fn(() => true),
    canDeleteBook: jest.fn(() => true),
}));

const { getForcedToolChoice } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/pathfinder-tool-bridge.js');
const {
    confirmToolCall,
    formatToolArgsPreview,
    shouldConfirmToolCall,
} = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tool-confirmation.js');

function installPopup(result) {
    const show = jest.fn(async () => result);
    const completeCancelled = jest.fn();
    globalThis.window = {
        SillyTavern: {
            getContext: () => ({
                Popup: class {
                    async show() {
                        return show();
                    }
                    completeCancelled = completeCancelled;
                },
                POPUP_TYPE: { CONFIRM: 2 },
                POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
            }),
        },
    };
    return { show, completeCancelled };
}

describe('Pathfinder tool confirmation', () => {
    beforeEach(() => {
        mockSettings = {
            sidecarEnabled: true,
            mandatoryTools: false,
            confirmTools: {},
            enabledLorebooks: [],
        };
    });

    afterEach(() => {
        delete globalThis.window;
    });

    test('only confirmable tools with their own opt-in require confirmation', () => {
        expect(shouldConfirmToolCall('Pathfinder_Forget')).toBe(false);

        mockSettings.confirmTools = { Pathfinder_Forget: true };
        expect(shouldConfirmToolCall('Pathfinder_Forget')).toBe(true);

        mockSettings.confirmTools = { Pathfinder_Search: true };
        expect(shouldConfirmToolCall('Pathfinder_Search')).toBe(false);
    });

    test('approves and declines based on the popup result', async () => {
        installPopup(1);
        await expect(confirmToolCall('Pathfinder Forget', { uid: 3 })).resolves.toBe(true);

        installPopup(0);
        await expect(confirmToolCall('Pathfinder Forget', { uid: 3 })).resolves.toBe(false);
    });

    test('fails closed when no popup API is available', async () => {
        await expect(confirmToolCall('Pathfinder Forget', { uid: 3 })).resolves.toBe(false);
    });

    test('formats a compact argument preview', () => {
        const preview = formatToolArgsPreview({ uid: 3, book: 'Memory Book', empty: '', missing: undefined });

        expect(preview).toBe('uid: 3\nbook: Memory Book');
        expect(formatToolArgsPreview({ content: 'x'.repeat(500) })).toHaveLength('content: '.length + 300 + 1);
    });

    test('uses live agent confirmation settings even while runtime registration is deferred', () => {
        expect(shouldConfirmToolCall('Pathfinder_Forget', { confirmTools: { Pathfinder_Forget: true } })).toBe(true);
        expect(shouldConfirmToolCall('Pathfinder_Forget')).toBe(false);
    });

    test('does not open an already-cancelled approval', async () => {
        const popup = installPopup(1);
        const controller = new AbortController();
        controller.abort();
        await expect(confirmToolCall('Pathfinder Forget', { uid: 3 }, controller.signal)).resolves.toBe(false);
        expect(popup.show).not.toHaveBeenCalled();
    });

    test('cancels without waiting for the dialog and ignores a later affirmative result', async () => {
        let approve;
        const popup = installPopup(new Promise(resolve => { approve = resolve; }));
        const controller = new AbortController();
        const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
        const pending = confirmToolCall('Pathfinder Forget', { uid: 3 }, controller.signal);
        controller.abort();
        await expect(pending).resolves.toBe(false);
        expect(popup.completeCancelled).toHaveBeenCalledTimes(1);
        expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
        approve(1);
        await expect(pending).resolves.toBe(false);
    });
});

describe('Pathfinder forced tool choice', () => {
    beforeEach(() => {
        mockSettings = {
            sidecarEnabled: true,
            mandatoryTools: true,
            confirmTools: {},
            enabledLorebooks: [],
        };
    });

    test('returns null unless tool mode and the mandatory setting are both on', () => {
        mockSettings.mandatoryTools = false;
        expect(getForcedToolChoice('openai')).toBeNull();

        mockSettings.mandatoryTools = true;
        mockSettings.sidecarEnabled = false;
        expect(getForcedToolChoice('openai')).toBeNull();
    });

    test.each([
        ['claude', 'claude-sonnet-4-6', 'any'],
        ['linkapi', 'claude-sonnet-4-6', 'any'],
        ['linkapi', '[SP]claude-sonnet-4-6', 'required'],
        ['openai', 'gpt-5', 'required'],
        ['makersuite', 'gemini-2.5-pro', 'required'],
        ['cohere', 'command-r-plus', 'required'],
        ['ai21', 'jamba-large', null],
    ])('maps %s model %s to %s', (source, model, expected) => {
        expect(getForcedToolChoice(source, model)).toBe(expected);
    });
});
