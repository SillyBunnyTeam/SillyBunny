import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    regexFromString: jest.fn(value => {
        const match = String(value ?? '').match(/^\/([\s\S]*)\/([a-z]*)$/i);
        return match ? new RegExp(match[1], match[2]) : new RegExp(String(value ?? ''));
    }),
    uuidv4: jest.fn(() => 'test-uuid'),
}));

const {
    AGENT_REGEX_PLACEMENT,
    applyRegexScriptList,
} = await import('../public/scripts/extensions/in-chat-agents/regex-scripts.js');

const { resolveRegexScriptsForSnapshot } = await import('../public/scripts/extensions/in-chat-agents/regex-snapshot-store.js');

const regexBundles = JSON.parse(readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/regex-bundles.json', import.meta.url), 'utf8'));
const cyoaChoiceScripts = regexBundles['tpl-cyoa-choices'];

function renderChoices(source) {
    return applyRegexScriptList(source, cyoaChoiceScripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
        isMarkdown: true,
    });
}

function countChoiceRows(html) {
    return html.match(/class="pura-choice"/g)?.length ?? 0;
}

describe('CYOA choices bundled regex', () => {
    test('removes optional empty choice rows after rendering fewer than seven choices', () => {
        const html = renderChoices([
            '[CHOICES]',
            '1. Go left',
            '2. Go right',
            '3. Ask a question',
            '4. Wait and watch',
            '[/CHOICES]',
        ].join('\n'));

        expect(countChoiceRows(html)).toBe(4);
        expect(html).toContain('4. Wait and watch');
        expect(html).not.toMatch(/<div class="pura-choice" style="[^"]*">\s*<\/div>/);
    });

    test('keeps all seven choice rows when seven choices are present', () => {
        const html = renderChoices([
            '[CHOICES]',
            '1. Go left',
            '2. Go right',
            '3. Ask a question',
            '4. Wait and watch',
            '5. Check the map',
            '6. Call for help',
            '7. Open the door',
            '[/CHOICES]',
        ].join('\n'));

        expect(countChoiceRows(html)).toBe(7);
        expect(html).toContain('7. Open the door');
    });

    test('still trims choices from prompt history at the configured depth', () => {
        const promptText = applyRegexScriptList('[CHOICES]\n1. Go\n2. Stay\n3. Wait\n[/CHOICES]', cyoaChoiceScripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
            isPrompt: true,
            depth: 2,
        });

        expect(promptText).toBe('');
    });

    test('trims choices via the prompt-assembly wiring (snapshot -> resolve -> apply)', () => {
        const snapshot = { regexScripts: cyoaChoiceScripts };
        const resolvedScripts = resolveRegexScriptsForSnapshot(snapshot);
        expect(resolvedScripts).toHaveLength(cyoaChoiceScripts.length);

        const message = '[CHOICES]\n1. Go\n2. Stay\n3. Wait\n[/CHOICES]';
        const trimmed = applyRegexScriptList(message, resolvedScripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
            isPrompt: true,
            depth: 2,
        });

        expect(trimmed).toBe('');
    });

    test('does not trim choices below the configured min depth', () => {
        const snapshot = { regexScripts: cyoaChoiceScripts };
        const resolvedScripts = resolveRegexScriptsForSnapshot(snapshot);
        const message = '[CHOICES]\n1. Go\n2. Stay\n3. Wait\n[/CHOICES]';

        const shallowDepth = applyRegexScriptList(message, resolvedScripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
            isPrompt: true,
            depth: 1,
        });

        expect(shallowDepth).toBe(message);
    });

    test('leaves the prompt untouched when no in-chat agent snapshot is present', () => {
        expect(resolveRegexScriptsForSnapshot(undefined)).toEqual([]);
        expect(resolveRegexScriptsForSnapshot(null)).toEqual([]);
        expect(resolveRegexScriptsForSnapshot({})).toEqual([]);
    });
});
