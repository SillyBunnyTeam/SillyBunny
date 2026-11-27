import { describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const regexSource = fs.readFileSync(
    fileURLToPath(new URL('../public/scripts/extensions/regex/index.js', import.meta.url)),
    'utf8',
);

function extractApplyPreset() {
    const start = regexSource.indexOf('async applyPreset(presetId)');
    expect(start).toBeGreaterThanOrEqual(0);
    const bodyStart = regexSource.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < regexSource.length; i++) {
        if (regexSource[i] === '{') depth++;
        if (regexSource[i] === '}' && --depth === 0) {
            return regexSource.slice(start, i + 1);
        }
    }
    throw new Error('Could not extract applyPreset');
}

describe('regex preset reload guard (ST #6109)', () => {
    function runApplyPreset(currentChatId) {
        const loadRegexScripts = jest.fn(async () => {});
        const reloadCurrentChat = jest.fn(async () => {});
        const getCurrentChatId = jest.fn(() => currentChatId);
        const applyPresetList = jest.fn(async () => {});

        const methodSource = extractApplyPreset();
        const context = vm.createContext({
            extension_settings: {
                regex_presets: [{ id: 'preset-1', global: [], scoped: [], preset: [] }],
            },
            SCRIPT_TYPES: { GLOBAL: 1, SCOPED: 2, PRESET: 3 },
            getScriptsByType: () => [],
            saveScriptsByType: jest.fn(async () => {}),
            toastr: { error: jest.fn() },
            t: strings => strings.join(''),
            loadRegexScripts,
            reloadCurrentChat,
            getCurrentChatId,
        });
        const TestManager = vm.runInContext(`class TestManager {
            constructor(applyPresetListImpl) { this.applyPresetList = applyPresetListImpl; }
            ${methodSource}
        }
        TestManager`, context);

        const manager = new TestManager(applyPresetList);
        return {
            promise: manager.applyPreset('preset-1'),
            loadRegexScripts,
            reloadCurrentChat,
            applyPresetList,
        };
    }

    test('skips reloadCurrentChat when no chat is open', async () => {
        const { promise, loadRegexScripts, reloadCurrentChat, applyPresetList } = runApplyPreset(undefined);
        await promise;
        expect(applyPresetList).toHaveBeenCalledTimes(3);
        expect(loadRegexScripts).toHaveBeenCalledTimes(1);
        expect(reloadCurrentChat).not.toHaveBeenCalled();
    });

    test('calls reloadCurrentChat when a chat is open', async () => {
        const { promise, loadRegexScripts, reloadCurrentChat, applyPresetList } = runApplyPreset('active-chat');
        await promise;
        expect(applyPresetList).toHaveBeenCalledTimes(3);
        expect(loadRegexScripts).toHaveBeenCalledTimes(1);
        expect(reloadCurrentChat).toHaveBeenCalledTimes(1);
    });
});
