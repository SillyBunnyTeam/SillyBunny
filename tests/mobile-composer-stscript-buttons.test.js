import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobileShellCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8');
const mobileStylesCss = readFileSync(path.join(repoRoot, 'public', 'css', 'mobile-styles.css'), 'utf8');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

describe('mobile composer STscript controls', () => {
    test('hides the unused stscript play/pause/stop buttons unconditionally', () => {
        // #533 forced .stscript_btn to display:flex !important in mobile-styles.css,
        // which let the unused script execution controls overlap the textarea.
        // sillybunny-mobile-shell.css loads later (verified below) so its
        // display:none !important wins and keeps them hidden.
        expect(mobileShellCss).toMatch(/#rightSendForm\s*>\s*\.stscript_btn\s*\{[^}]*display:\s*none\s*!important/);
    });

    test('the override sheet still loads after the sheet that forces display:flex', () => {
        const mobileStylesIdx = indexHtml.indexOf('css/mobile-styles.css');
        const mobileShellIdx = indexHtml.indexOf('css/sillybunny-mobile-shell.css');

        expect(mobileStylesIdx).toBeGreaterThan(-1);
        expect(mobileShellIdx).toBeGreaterThan(-1);
        expect(mobileShellIdx).toBeGreaterThan(mobileStylesIdx);
    });

    test('documents why the override is needed', () => {
        // Keep the explanatory comment so a future cleanup does not delete the
        // rule without understanding the #533 interaction.
        expect(mobileShellCss).toContain('stscript_btn');
        expect(mobileShellCss).toContain('#533');
    });

    test('mobile-styles.css still forces the controls visible (the thing being overridden)', () => {
        // Guards against #533 being reverted upstream: if it ever is, this test
        // flips and the override rule above can be simplified.
        expect(mobileStylesCss).toMatch(/#rightSendForm\s*>\s*\.stscript_btn\s*\{[^}]*display:\s*flex\s*!important/);
    });
});
