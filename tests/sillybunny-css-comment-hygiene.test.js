import { describe, expect, test } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssDir = path.join(repoRoot, 'public', 'css');

// SillyBunny layers its own CSS sheets on top of upstream SillyTavern. CSS has no
// line-comment syntax: a `//` inside a declaration block makes the parser discard
// tokens through the next semicolon, silently swallowing the declaration that follows.
// That is exactly how the iOS keyboard shell offset regressed -- a `//` comment ate the
// `top: calc(... + var(--sb-shell-viewport-top))` rule, so the composer slid back behind
// the virtual keyboard. Guard every SillyBunny sheet so the whole class of bug stays dead.
const sillyBunnyCssFiles = readdirSync(cssDir)
    .filter(name => /^sillybunny.*\.css$/.test(name))
    .sort();

describe('SillyBunny CSS comment hygiene', () => {
    test('ships SillyBunny CSS sheets to guard', () => {
        expect(sillyBunnyCssFiles.length).toBeGreaterThan(0);
    });

    test('no SillyBunny CSS sheet uses // line-comments', () => {
        const offenders = [];

        for (const fileName of sillyBunnyCssFiles) {
            const source = readFileSync(path.join(cssDir, fileName), 'utf8');
            source.split('\n').forEach((line, index) => {
                if (/^\s*\/\//.test(line)) {
                    offenders.push(`${fileName}:${index + 1}: ${line.trim()}`);
                }
            });
        }

        expect(offenders).toEqual([]);
    });

    test('iOS shell keeps the visual-viewport top offset the keyboard fix depends on', () => {
        const mobileShellCss = readFileSync(path.join(cssDir, 'sillybunny-mobile-shell.css'), 'utf8');

        // The iOS #sheld rule must shift down by the visual-viewport top so the shell
        // tracks Safari when the keyboard opens. If a comment ever swallows this again,
        // the composer hides behind the keyboard (the bug this sheet's fix addresses).
        expect(mobileShellCss).toMatch(/#sheld\s*\{[^}]*top:\s*calc\([^}]*--sb-shell-viewport-top[^}]*\}/);
    });
});
