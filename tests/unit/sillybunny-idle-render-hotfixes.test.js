import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readRepoFile = (...segments) => readFileSync(path.join(repoRoot, ...segments), 'utf8').replace(/\r\n/g, '\n');

describe('idle rendering and GPU layer hotfix contracts', () => {
    test('isolates pixel art figure frame swaps with CSS layout, style and paint containment', () => {
        const homeCss = readRepoFile('public', 'css', 'sillybunny-home.css');
        const figureRule = homeCss.match(/\.sbArtFigure\s*\{[^}]*\}/)?.[0] ?? '';

        expect(figureRule).toContain('contain: layout style paint;');
        expect(figureRule).toContain('isolation: isolate;');
    });

    test('scopes settings page will-change to transitions and skips hidden inner rendering', () => {
        const tabsCss = readRepoFile('public', 'css', 'sillybunny-tabs.css');
        const pageRule = tabsCss.match(/#sb-settings-page\s*\{[^}]*\}/)?.[0] ?? '';
        const transitionRule = tabsCss.match(/#sb-settings-page\.sb-settings-page--opening,\s*#sb-settings-page\.sb-settings-page--closing\s*\{[^}]*\}/)?.[0] ?? '';
        const hiddenInnerRule = tabsCss.match(/#sb-settings-page\[hidden\]\s*>\s*#sb-settings-inner\s*\{[^}]*\}/)?.[0] ?? '';

        expect(pageRule).not.toContain('will-change');
        expect(transitionRule).toContain('will-change: transform, opacity;');
        expect(hiddenInnerRule).toContain('content-visibility: hidden;');
    });

    test('does not force optimizeLegibility text shaping across the whole document body', () => {
        const themeCss = readRepoFile('public', 'css', 'sillybunny-theme.css');
        const bodyRule = themeCss.match(/(?:^|\n)body\s*\{[^}]*\}/)?.[0] ?? '';

        expect(bodyRule).not.toContain('optimizeLegibility');
    });

    test('guards the expressions 2s poll against hidden tabs and repeated empty-chat style queries', () => {
        const expressionsJs = readRepoFile('public', 'scripts', 'extensions', 'expressions', 'index.js');

        expect(expressionsJs).toContain('if (document.hidden)');
        expect(expressionsJs).toContain('expressionRemovedForEmptyChat');
        expect(expressionsJs).toContain('vnWrapperInitialized');
        expect(expressionsJs).toContain('lastOfflineModeDisplayed');
        expect(expressionsJs).not.toContain('$(\'#visual-novel-wrapper\').is(\':visible\')');
        expect(expressionsJs).not.toContain('offlineMode.is(\':visible\')');
    });
});
