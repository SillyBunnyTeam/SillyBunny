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

    test('swipe picker rows end in one circular flat menu button and hide the four forwarded controls', () => {
        expect(themeCss).toMatch(/\.swipe_picker_block \[data-sb-forwarded\]\s*\{\s*display:\s*none;\s*\}/);
        expect(themeCss).toMatch(/\.swipe_picker_block \.swipe_picker_menu\s*\{[^}]*border-radius:\s*var\(--sb-radius-pill\)/);
        expect(themeCss).toMatch(/\.swipe_picker_block \.swipe_picker_menu:hover\s*\{[^}]*var\(--sb-flat-hover-bg\)/);
        expect(themeCss).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.swipe_picker_block \.swipe_picker_menu\s*\{[^}]*inline-size:\s*44px/);
    });
});
