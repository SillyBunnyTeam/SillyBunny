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
const indexHtml = read('public', 'index.html');

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

    test('reloadMarkdownProcessor builds markdown-it unless the setting is showdown, before the Showdown block', () => {
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

    test('the setting defaults to markdown-it and loads into the select, which then announces the value with an input event', () => {
        expect(powerUserSource).toContain('    markdown_engine: MARKDOWN_ENGINES.MARKDOWN_IT,');
        expect(powerUserSource).toContain('    $(\'#markdown_engine\').val(normalizeMarkdownEngine(power_user.markdown_engine)).each((_, select) => select.dispatchEvent(new Event(\'input\', { bubbles: true })));');
    });

    test('a change of the select stores the engine and saves it, then reloads the processor and re-renders the chat', () => {
        const handler = [
            '    $(\'#markdown_engine\').on(\'change\', async function () {',
            '        power_user.markdown_engine = normalizeMarkdownEngine($(this).val());',
            '        saveSettingsDebounced();',
            '        reloadMarkdownProcessor();',
            '        await reloadCurrentChat();',
            '    });',
        ].join('\n');
        expect(powerUserSource).toContain(handler);
    });

    test('the shell presents the select as a toggle row before it splits the settings', () => {
        const tabsSource = read('public', 'scripts', 'sillybunny-tabs.js');
        expect(tabsSource).toContain('import { presentMarkdownEngineRow } from \'./sillybunny-markdown-engine-row.js\';');
        expect(tabsSource.indexOf('presentMarkdownEngineRow(originalContent);')).toBeGreaterThan(0);
        expect(tabsSource.indexOf('presentMarkdownEngineRow(originalContent);')).toBeLessThan(tabsSource.indexOf('splitUserSettingsContent(originalContent);'));
    });

    test('Customize > Messages lists the engine in Message Display right after Auto-fix Markdown', () => {
        const rows = /id: 'message-display',[\s\S]*?rows: \[([\s\S]*?)\]/.exec(read('public', 'scripts', 'sillybunny-settings-content.js'))?.[1] ?? '';
        const selectors = [...rows.matchAll(/'([^']+)'/g)].map(match => match[1]);
        expect(selectors.indexOf('#markdown_engine')).toBe(selectors.indexOf('#auto_fix_generated_markdown') + 1);
        expect(selectors.indexOf('#auto_fix_generated_markdown')).toBeGreaterThanOrEqual(0);
    });

    test('the settings markup has a labelled engine select after Auto-fix Markdown, with markdown-it first and a marked subtitle placeholder', () => {
        const row = [
            '                                <div>',
            '                                    <label for="markdown_engine">',
            '                                        <small data-i18n="Markdown Engine">Markdown Engine</small>',
            '                                        <small class="ds-row-subtitle" data-sb-copy-placeholder="true">TODO(copy)</small>',
            '                                    </label>',
            '                                    <select id="markdown_engine">',
            '                                        <option value="markdown-it">markdown-it</option>',
            '                                        <option value="showdown">Showdown</option>',
            '                                    </select>',
            '                                </div>',
        ].join('\n');

        expect(indexHtml).toContain(row);
        expect(indexHtml.indexOf('id="auto_fix_generated_markdown"')).toBeLessThan(indexHtml.indexOf(row));
        expect(indexHtml.indexOf(row)).toBeLessThan(indexHtml.indexOf('id="forbid_external_media"'));
    });
});
