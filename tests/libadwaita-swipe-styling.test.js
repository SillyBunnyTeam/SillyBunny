import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeCss = readFileSync(path.join(repoRoot, 'public/css/sillybunny-theme.css'), 'utf8');

describe('libadwaita swipe styling', () => {
    test('chat swipe arrows get a flat hover fill on hover-capable devices', () => {
        expect(themeCss).toMatch(/@media \(hover: hover\)\s*\{\s*#chat \.mes :is\(\.swipe_left, \.swipe_right\):hover\s*\{[^}]*opacity:\s*1;[^}]*background-color:\s*var\(--sb-flat-hover-bg\)/);
    });

    test('swipe picker rows are borderless with flat hover and selection fills', () => {
        expect(themeCss).toMatch(/\n\.swipe_picker_block\s*\{[^}]*border-color:\s*transparent/);
        expect(themeCss).toMatch(/\.swipe_picker_block:hover\s*\{[^}]*var\(--sb-flat-hover-bg\)/);
        expect(themeCss).toMatch(/\.swipe_picker_block\[highlight\]\s*\{[^}]*var\(--sb-flat-selected-bg\)/);
        expect(themeCss).toMatch(/\.swipe_picker_block\[highlight\]:hover\s*\{[^}]*var\(--sb-flat-selected-hover-bg\)/);
    });

    test('swipe picker row actions are circular flat icon buttons', () => {
        expect(themeCss).toMatch(/\.swipe_picker_block :is\(\.swipe_picker_expand_label[^{]*\{[^}]*border-radius:\s*999px/);
        expect(themeCss).toMatch(/\.swipe_picker_block :is\(\.swipe_picker_expand_label[^{]*:hover\s*\{[^}]*var\(--sb-flat-hover-bg\)/);
    });
});
