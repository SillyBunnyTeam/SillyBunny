import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SILLYBUNNY_SHOWDOWN_OPTIONS } from './util/sillybunny-showdown.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...segments) => readFileSync(path.join(repoRoot, ...segments), 'utf8').replace(/\r\n/g, '\n');
const scriptSource = read('public', 'script.js');
const powerUserSource = read('public', 'scripts', 'power-user.js');
const libSource = read('public', 'lib.js');

function getFunctionSource(source, signature) {
    const start = source.indexOf(signature);
    expect(start).toBeGreaterThanOrEqual(0);

    let depth = 0;
    for (let index = source.indexOf('{', start + signature.length - 1); index < source.length; index++) {
        if (source[index] === '{') {
            depth++;
        } else if (source[index] === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${signature}`);
}

describe('markdown engine wiring', () => {
    const reloadSource = getFunctionSource(scriptSource, 'export function reloadMarkdownProcessor() {');

    test('reloadMarkdownProcessor builds markdown-it only for the markdown-it setting, before the Showdown block', () => {
        const adapter = [
            '    if (normalizeMarkdownEngine(power_user.markdown_engine) === MARKDOWN_ENGINES.MARKDOWN_IT) {',
            '        converter = createMarkdownItConverter({ markdownit, markdownItEmoji, markdownItCjkFriendly }, {',
            '            getNonMarkdownStrings: () => power_user.markdown_escape_strings ? substituteParams(power_user.markdown_escape_strings) : \'\',',
            '        });',
            '        return converter;',
            '    }',
        ].join('\n');

        expect(reloadSource).toContain(adapter);
        expect(reloadSource.indexOf(adapter)).toBeLessThan(reloadSource.indexOf('converter = new showdown.Converter({'));
        expect(scriptSource).toContain('import { MARKDOWN_ENGINES, createMarkdownItConverter, normalizeMarkdownEngine } from \'./scripts/markdown-engine.js\';');
    });

    test('the Showdown converter keeps the options that the parity test builds Showdown with', () => {
        const optionsBlock = /converter = new showdown\.Converter\(\{\n([\s\S]*?)\n {4}\}\);/.exec(reloadSource)?.[1] ?? '';
        const booleanOptions = Object.fromEntries(
            [...optionsBlock.matchAll(/^ {8}(\w+): (true|false),$/gm)].map(([, name, value]) => [name, value === 'true']),
        );

        expect(booleanOptions).toEqual(SILLYBUNNY_SHOWDOWN_OPTIONS);
        expect(optionsBlock).toContain('        extensions: [markdownUnderscoreExt()],');
        expect(reloadSource).toContain('converter.addExtension(markdownExclusionExt(), \'exclusion\');');
    });

    test('lib.js exports the markdown-it libraries by name and in the default export', () => {
        expect(libSource).toContain('import markdownit from \'markdown-it\';');
        expect(libSource).toContain('import { full as markdownItEmoji } from \'markdown-it-emoji\';');
        expect(libSource).toContain('import markdownItCjkFriendly from \'markdown-it-cjk-friendly\';');

        const exportBlocks = [...libSource.matchAll(/^export (?:default )?\{\n([\s\S]*?)\n\};?$/gm)].map(match => match[1]);
        expect(exportBlocks).toHaveLength(2);
        for (const block of exportBlocks) {
            expect(block).toContain('    markdownit,\n    markdownItEmoji,\n    markdownItCjkFriendly,');
        }
    });

    test('the setting defaults to Showdown, loads into the select and re-renders the chat on change', () => {
        expect(powerUserSource).toContain('    markdown_engine: MARKDOWN_ENGINES.SHOWDOWN,');
        expect(powerUserSource).toContain('    $(\'#markdown_engine\').val(normalizeMarkdownEngine(power_user.markdown_engine));');

        const handler = [
            '    $(\'#markdown_engine\').on(\'change\', async function () {',
            '        power_user.markdown_engine = normalizeMarkdownEngine($(this).val());',
            '        reloadMarkdownProcessor();',
            '        await reloadCurrentChat();',
            '        saveSettingsDebounced();',
            '    });',
        ].join('\n');
        expect(powerUserSource).toContain(handler);
    });
});
