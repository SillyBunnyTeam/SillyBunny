import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUT_MOBILE_QUERY, MENU_SHEET_QUERY, OVERLAY_SHEET_QUERY } from '../../public/scripts/sillybunny-editor/breakpoints.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = relative => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const upstreamOrigin = new Set(JSON.parse(read('tests/fixtures/upstream-origin-public-files.json')));

/** Modules that decide a layout with the shell breakpoint and must take it from `breakpoints.js`. */
const LAYOUT_MODULES = [
    'public/scripts/sillybunny-prompt-editor.js',
    'public/scripts/sillybunny-search-entities.js',
    'public/scripts/sillybunny-world-info-editor.js',
    'public/scripts/sillybunny-tabs.js',
    'public/scripts/sillybunny-conversation/conversation-pages.js',
    'public/scripts/extensions/in-chat-agents/ui/agent-editor.js',
];

function listScripts(directory) {
    return fs.readdirSync(path.join(repoRoot, directory), { withFileTypes: true }).flatMap(entry => {
        const relative = `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
            return ['lib', 'third-party', 'quick-image-gen', 'node_modules'].includes(entry.name) ? [] : listScripts(relative);
        }
        return entry.name.endsWith('.js') && !entry.name.endsWith('.min.js') ? [relative] : [];
    });
}

describe('shared breakpoints', () => {
    test('the shell layout query is 768px and the overlay sheet query is the AdwDialog condition', () => {
        expect(LAYOUT_MOBILE_QUERY).toBe('(max-width: 768px)');
        expect(OVERLAY_SHEET_QUERY).toBe('(max-width: 450px), (max-height: 360px)');
    });

    test('menus and pickers become sheets in the mobile layout, dialogs under the AdwDialog condition', () => {
        expect(MENU_SHEET_QUERY).toBe(`${LAYOUT_MOBILE_QUERY}, (max-height: 360px)`);
        expect(MENU_SHEET_QUERY).not.toBe(OVERLAY_SHEET_QUERY);
    });

    test.each([
        'public/scripts/sillybunny-action-menu.js',
        'public/scripts/sillybunny-editor/picker.js',
    ])('%s decides its sheet with the menu query, not the dialog one', relative => {
        const source = read(relative);
        expect(source).toMatch(/\bMENU_SHEET_QUERY\b/);
        expect(source).not.toMatch(/\bOVERLAY_SHEET_QUERY\b/);
    });

    test.each(LAYOUT_MODULES)('%s takes the layout query from breakpoints.js', relative => {
        const source = read(relative);
        expect(source).toMatch(/import \{[^}]*\bLAYOUT_MOBILE_QUERY\b[^}]*\} from '[./]*(?:sillybunny-editor\/)?breakpoints\.js';/);
        expect(source).not.toMatch(/\(max-width: ?(?:768|620)px\)/);
    });

    test('no SillyBunny script writes a width query as a literal', () => {
        const offenders = listScripts('public/scripts')
            .filter(relative => !upstreamOrigin.has(`public/${relative.replace(/^public\//, '')}`) && !upstreamOrigin.has(relative))
            .filter(relative => !relative.endsWith('sillybunny-editor/breakpoints.js'))
            .filter(relative => /matchMedia\(\s*['"`]\((?:max|min)-width: ?\d+px/.test(read(relative)));
        expect(offenders).toEqual([]);
    });
});
