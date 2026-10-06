import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeCss = readFileSync(path.join(repoRoot, 'public/css/sillybunny-theme.css'), 'utf8');

describe('libadwaita shell entry css', () => {
    test('shell and settings entries use transparent border at rest', () => {
        expect(themeCss).toMatch(/:is\(\.sb-shell-root, \.sb-character-drawer-root, \.sb-settings-subdrawer\) :is\(\.text_pole[^}]+border-color:\s*transparent/);
    });

    test('shell and settings entries use accent focus ring', () => {
        expect(themeCss).toMatch(/:is\(\.sb-shell-root, \.sb-character-drawer-root, \.sb-settings-subdrawer\)[^}]*:focus[^}]+border-color:\s*var\(--sb-composer-focus-border\)/);
        expect(themeCss).toMatch(/:is\(\.sb-shell-root, \.sb-character-drawer-root, \.sb-settings-subdrawer\)[^}]*:focus[^}]+box-shadow:\s*var\(--sb-composer-focus-ring\)/);
    });

    test('shell and settings select elements use transparent border at rest', () => {
        expect(themeCss).toMatch(/:is\(\.sb-shell-root, \.sb-character-drawer-root, \.sb-settings-subdrawer\) select:where\([^}]+border-color:\s*transparent/);
    });

    test('shell and settings select elements use accent focus ring', () => {
        expect(themeCss).toMatch(/:is\(\.sb-shell-root, \.sb-character-drawer-root, \.sb-settings-subdrawer\) select[^}]*:focus[^}]+border-color:\s*var\(--sb-composer-focus-border\)/);
        expect(themeCss).toMatch(/:is\(\.sb-shell-root, \.sb-character-drawer-root, \.sb-settings-subdrawer\) select[^}]*:focus[^}]+box-shadow:\s*var\(--sb-composer-focus-ring\)/);
    });

    test('shell background header uses transparent treatment', () => {
        expect(themeCss).toMatch(/:is\(\.sb-shell-root, \.sb-character-drawer-root\) #bg-header-fixed\s*\{[^}]*background:\s*transparent/);
        expect(themeCss).toMatch(/:is\(\.sb-shell-root, \.sb-character-drawer-root\) #bg-header-fixed\s*\{[^}]*border:\s*none/);
    });

    test('shell character and group hover use flat hover token', () => {
        expect(themeCss).toMatch(/:is\(\.sb-shell-root, \.sb-character-drawer-root\)[^}]*:hover[^}]+background-color:\s*var\(--sb-flat-hover-bg\)/);
        expect(themeCss).toMatch(/:is\(\.sb-shell-root, \.sb-character-drawer-root\) :is\(\.character_select:hover[^}]+border-color:\s*transparent/);
    });
});
