import { describe, expect, test } from '@jest/globals';

import {
    applyPromptVariableAssignments,
    collectPromptVariableNames,
    createPromptVariableScope,
    getPromptVariableScopedValue,
    setPromptVariableScopedValue,
    withPromptVariableScope,
} from '../public/scripts/prompt-variable-scope.js';

describe('prompt variable scope', () => {
    test('collects prompt-controlled variable names without treating reads as controlled', () => {
        const names = collectPromptVariableNames([
            { content: '{{getvar::external}}{{setvar:: nsfw ::enabled}}{{incvar::counter}}' },
            { value: '{{setglobalvar globalMode enabled}}{{flushglobalvar::staleGlobal}}{{addglobalvar::score::2}}' },
        ]);

        expect([...names.local].sort()).toEqual(['counter', 'nsfw']);
        expect([...names.global].sort()).toEqual(['globalMode', 'score', 'staleGlobal']);
    });

    test('shadows disabled prompt variables while leaving unrelated variables unscoped', () => {
        const names = collectPromptVariableNames([
            { content: '{{#if .nsfw}}{{getvar::nsfw}}{{/if}}' },
            { content: '{{setvar::nsfw::enabled}}' },
        ]);
        const scope = createPromptVariableScope(names);

        withPromptVariableScope(scope, () => {
            expect(getPromptVariableScopedValue('local', 'nsfw')).toEqual({ scoped: true, value: undefined });
            expect(getPromptVariableScopedValue('local', 'external')).toEqual({ scoped: false, value: undefined });
        });
    });

    test('preseeds enabled setvar values before prompt rendering order matters', () => {
        const names = collectPromptVariableNames([
            { content: '{{#if .nsfw}}{{getvar::nsfw}}{{/if}}' },
            { content: '{{setvar::nsfw::enabled}}' },
        ]);
        const scope = createPromptVariableScope(names);

        applyPromptVariableAssignments(scope, [{ content: '{{setvar::nsfw::enabled}}' }]);

        withPromptVariableScope(scope, () => {
            expect(getPromptVariableScopedValue('local', 'nsfw')).toEqual({ scoped: true, value: 'enabled' });
        });
    });

    test('applies set and delete assignments in source order', () => {
        const names = collectPromptVariableNames([{ content: '{{setvar mode one}}{{flushvar mode}}{{setvar mode two}}' }]);
        const scope = createPromptVariableScope(names);

        applyPromptVariableAssignments(scope, [{ content: '{{setvar mode one}}{{flushvar mode}}{{setvar mode two}}' }]);

        withPromptVariableScope(scope, () => {
            expect(getPromptVariableScopedValue('local', 'mode')).toEqual({ scoped: true, value: 'two' });
        });
    });

    test('keeps prompt writes inside the active scope', () => {
        const scope = createPromptVariableScope();

        withPromptVariableScope(scope, () => {
            expect(setPromptVariableScopedValue('local', 'temporary', 'value')).toBe(true);
            expect(getPromptVariableScopedValue('local', 'temporary')).toEqual({ scoped: true, value: 'value' });
        });

        expect(setPromptVariableScopedValue('local', 'temporary', 'outside')).toBe(false);
        expect(getPromptVariableScopedValue('local', 'temporary')).toEqual({ scoped: false, value: undefined });
    });

    test('keeps async prompt writes scoped until the async render finishes', async () => {
        const scope = createPromptVariableScope();

        await withPromptVariableScope(scope, async () => {
            expect(setPromptVariableScopedValue('local', 'temporary', 'value')).toBe(true);
            await Promise.resolve();
            expect(getPromptVariableScopedValue('local', 'temporary')).toEqual({ scoped: true, value: 'value' });
        });

        expect(getPromptVariableScopedValue('local', 'temporary')).toEqual({ scoped: false, value: undefined });
    });
});
