import { describe, expect, test } from '@jest/globals';

import { collectPromptSetVariableNames } from '../public/scripts/prompt-variable-names.js';

describe('prompt variable cleanup', () => {
    test('collects colon-syntax setvar names', () => {
        const names = collectPromptSetVariableNames('{{setvar::nsfw::NSFW Mode}}{{setvar::genre::}}');

        expect(names.local.sort()).toEqual(['genre', 'nsfw']);
        expect(names.global).toEqual([]);
    });

    test('collects global setvar names', () => {
        const names = collectPromptSetVariableNames('{{setglobalvar::mode::value}} {{setGlobalVar flag on}}');

        expect(names.local).toEqual([]);
        expect(names.global.sort()).toEqual(['flag', 'mode']);
    });

    test('collects spaced-syntax setvar names', () => {
        const names = collectPromptSetVariableNames('{{setvar narration random}}{{setvar friction high}}');

        expect(names.local.sort()).toEqual(['friction', 'narration']);
        expect(names.global).toEqual([]);
    });

    test('ignores non-setter variable macros', () => {
        const names = collectPromptSetVariableNames('{{getvar::nsfw}}{{addvar::counter::1}}{{incvar::x}}{{deletevar::y}}');

        expect(names.local).toEqual([]);
        expect(names.global).toEqual([]);
    });

    test('handles empty or non-string content', () => {
        expect(collectPromptSetVariableNames('')).toEqual({ local: [], global: [] });
        expect(collectPromptSetVariableNames(null)).toEqual({ local: [], global: [] });
    });
});
