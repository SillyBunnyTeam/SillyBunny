/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a plain function. */
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/script.js', () => ({ displayVersion: 'SillyBunny 0.0.0' }));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({ extension_settings: {}, extensionNames: [] }));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: strings => strings[0] }));
// The window shell is not under test; mocking it keeps its dependency tree out of this contract.
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/dialog.js', () => ({ openDialog: jest.fn() }));
jest.unstable_mockModule('../../public/scripts/sillybunny-window-styles.js', () => ({ ensureWindowStyles: jest.fn() }));
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({ copyText: jest.fn(), download: jest.fn() }));

const { formatDebugInfo } = await import('../../public/scripts/sillybunny-about.js');

const BASE = {
    version: '2.0.0',
    branch: 'main',
    commit: 'abc1234',
    userAgent: 'Agent/1.0',
    viewport: '1440×900',
    extensionCount: 3,
};

describe('the debug information', () => {
    test('keeps its English labels, one per line', () => {
        expect(formatDebugInfo(BASE).split('\n').slice(0, 6)).toEqual([
            'Version: 2.0.0',
            'Branch: main',
            'Commit: abc1234',
            'User agent: Agent/1.0',
            'Viewport: 1440×900',
            'Enabled extensions: 3',
        ]);
    });

    test('lists each boot mark with its time in milliseconds, in the order given', () => {
        const text = formatDebugInfo({
            ...BASE,
            bootMarks: [
                { name: 'sb-boot-inline', startTime: 12.3456 },
                { name: 'sb-app-ready', startTime: 1840.5 },
            ],
        });

        expect(text.split('\n').slice(6)).toEqual([
            'Boot mark sb-boot-inline: 12 ms',
            'Boot mark sb-app-ready: 1841 ms',
        ]);
    });

    test('says no boot mark was recorded, rather than leave the report silent', () => {
        expect(formatDebugInfo({ ...BASE, bootMarks: [] }).split('\n').slice(6)).toEqual(['Boot marks: not recorded']);
        expect(formatDebugInfo(BASE).split('\n').slice(6)).toEqual(['Boot marks: not recorded']);
    });
});
