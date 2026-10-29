/* eslint-disable playwright/no-standalone-expect -- Jest source-contract tests do not use a browser. */
import { describe, expect, test } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'acorn';

const UI_ROOT = new URL('../../public/scripts/extensions/in-chat-agents/ui/', import.meta.url);

function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string') visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(child => walk(child, visit));
        else if (value && typeof value === 'object') walk(value, visit);
    }
}

function translatedStrings(source) {
    const strings = [];
    walk(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), node => {
        if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier' && node.tag.name === 't') {
            strings.push({ text: node.quasi.quasis.map(part => part.value.cooked).join('${}'), node });
        }
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'translate'
            && node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string') {
            strings.push({ text: node.arguments[0].value, node });
        }
    });
    return strings;
}

function uiFiles(root = UI_ROOT) {
    return readdirSync(root, { withFileTypes: true }).flatMap(item => {
        const url = new URL(item.name + (item.isDirectory() ? '/' : ''), root);
        if (item.isDirectory()) return uiFiles(url);
        return item.name.endsWith('.js') ? [url] : [];
    });
}

async function sources() {
    // The model is the first A2 seam; never turn an absent ui/ directory into a vacuous pass.
    await import('../../public/scripts/extensions/in-chat-agents/ui/agent-list-model.js');
    return uiFiles().map(file => ({ file: file.pathname, source: readFileSync(file, 'utf8') }));
}

function forbiddenCopy(text) {
    return text.includes('...') || /\.\s*$/.test(text) || /\b(?:e\.g\.|i\.e\.)/i.test(text);
}

function fragmentedTranslations(source) {
    const translations = translatedStrings(source);
    const translatedTemplates = new Set(translations.map(({ node }) => node.quasi?.start));
    const fragments = [];
    walk(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), node => {
        const concatenation = node.type === 'BinaryExpression' && node.operator === '+';
        const interpolation = node.type === 'TemplateLiteral' && !translatedTemplates.has(node.start)
            && (node.expressions.length > 1 || node.quasis.some(part => part.value.cooked.trim()));
        if (!concatenation && !interpolation) return;
        if (translations.some(({ node: translated }) => translated.start >= node.start && translated.end <= node.end)) {
            fragments.push(source.slice(node.start, node.end));
        }
    });
    return fragments;
}

describe('Agents UI copy matcher', () => {
    test('reads tagged/call translations including escaped text, but ignores JavaScript spread and comments', () => {
        const source = 'const copy = {...original}; // t`Ignored...`\nt`Update All (${count})…`; translate("Search Agents…"); t`It\\\'s Ready`;';
        expect(translatedStrings(source).map(item => item.text)).toEqual(['Update All (${})…', 'Search Agents…', 'It\'s Ready']);
        expect(fragmentedTranslations('t`${on} on · ${tokens} tokens`; `${t`${count} selected`}`;')).toEqual([]);
        expect(fragmentedTranslations('`${count} ${t`selected`}`;')).toEqual(['`${count} ${t`selected`}`']);
        expect(fragmentedTranslations('count + t` selected`;')).toEqual(['count + t` selected`']);
    });

    test.each(['Search...', 'Delete.', 'For e.g. This', 'For i.e. This'])('rejects forbidden UI text %s', text => {
        expect(forbiddenCopy(text)).toBe(true);
    });

    test.each(['Search…', 'Delete', '${} on · ${} tokens', 'lorum ipsum'])('accepts UI text %s', text => {
        expect(forbiddenCopy(text)).toBe(false);
    });
});

describe('new Agents ui/ modules follow Q32', () => {
    test('translated labels use U+2026, never three-dot ellipses', async () => {
        const violations = (await sources()).flatMap(({ file, source }) => translatedStrings(source)
            .filter(({ text }) => text.includes('...')).map(({ text }) => ({ file, text })));
        expect(violations).toEqual([]);
    });

    test('translated labels and captions have no trailing period or Latin abbreviations', async () => {
        const violations = (await sources()).flatMap(({ file, source }) => translatedStrings(source)
            .filter(({ text }) => /\.\s*$/.test(text) || /\b(?:e\.g\.|i\.e\.)/i.test(text)).map(({ text }) => ({ file, text })));
        expect(violations).toEqual([]);
    });

    test('the on/token header counter is one translated template with both placeholders', async () => {
        const list = (await sources()).find(({ file }) => file.endsWith('/agent-list.js'));
        expect(list).toBeDefined();
        const counters = translatedStrings(list.source).filter(({ text }) => text === '${} on · ${} tokens');
        expect(counters).toHaveLength(1);
        expect(counters[0].node.type).toBe('TaggedTemplateExpression');
        expect(counters[0].node.quasi.expressions).toHaveLength(2);
    });

    test('translated counters and sentences are not built by concatenating translated fragments', async () => {
        const violations = [];
        for (const { file, source } of await sources()) {
            violations.push(...fragmentedTranslations(source).map(text => ({ file, text })));
        }
        expect(violations).toEqual([]);
    });
});

describe(
    'A3 editor modules follow Q32 without vacuous missing-file passes',
    () => {
        test.each([
            'agent-editor-model.js',
            'agent-editor-controller.js',
            'agent-editor.js',
            'agent-editor-dialogs.js',
        ])(
            '%s is present and its translated copy follows the same rules',
            async name => {
                // Gate only new assertions: existing A2 contracts must stay runnable during A3 red.
                await import('../../public/scripts/extensions/in-chat-agents/ui/agent-editor-model.js');
                const source = readFileSync(new URL(name, UI_ROOT), 'utf8');
                expect(translatedStrings(source).filter(({ text }) => forbiddenCopy(text)).map(({ text }) => text)).toEqual([]);
                expect(fragmentedTranslations(source)).toEqual([]);
            },
        );
    },
);

describe('A4 pages follow Q32 without vacuous missing-file passes', () => {
    test.each([
        ['settings-page.js', 'settings-page-controller.js'],
        ['settings-page-controller.js', 'settings-page-controller.js'],
        ['companions-page.js', 'companions-page-controller.js'],
        ['companions-page-controller.js', 'companions-page-controller.js'],
        ['groups-page.js', 'groups-page-controller.js'],
        ['groups-page-controller.js', 'groups-page-controller.js'],
    ])('%s is present and its translated copy follows the same rules', async (name, controller) => {
        // Keep the pre-existing A2/A3 copy assertions runnable while each A4 seam is absent.
        await import(new URL(controller, UI_ROOT).href);
        const source = readFileSync(new URL(name, UI_ROOT), 'utf8');
        expect(translatedStrings(source).filter(({ text }) => forbiddenCopy(text)).map(({ text }) => text)).toEqual([]);
        expect(fragmentedTranslations(source)).toEqual([]);
    });
});
