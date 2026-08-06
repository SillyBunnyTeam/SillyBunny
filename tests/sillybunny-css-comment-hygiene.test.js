import { describe, expect, test } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssDir = path.join(repoRoot, 'public', 'css');

// CSS has no line-comment syntax: a `//` inside a declaration block makes the parser
// discard tokens through the next semicolon, silently swallowing the declaration that
// follows. That is exactly how the iOS keyboard shell offset regressed -- a `//` comment
// ate the `top: calc(... + var(--sb-shell-viewport-top))` rule, so the composer slid back
// behind the virtual keyboard. Guard first-party sheets so the whole class stays dead.
const firstPartyCssFiles = readdirSync(cssDir)
    .filter(name => name.endsWith('.css') && !name.endsWith('.min.css'))
    .sort();

function stripCssBlockComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '));
}

describe('SillyBunny CSS comment hygiene', () => {
    test('ships first-party CSS sheets to guard', () => {
        expect(firstPartyCssFiles.length).toBeGreaterThan(0);
    });

    test('no first-party CSS sheet uses invalid // comments', () => {
        const offenders = [];

        for (const fileName of firstPartyCssFiles) {
            const source = stripCssBlockComments(readFileSync(path.join(cssDir, fileName), 'utf8'));
            source.split('\n').forEach((line, index) => {
                // Allow URL schemes such as http:// and https://, but flag line-start,
                // inline, and trailing `//` comments. Protocol-relative URLs would need
                // an explicit exception if the project ever intentionally adds one.
                if (/(^|[^:])\/\//.test(line)) {
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
