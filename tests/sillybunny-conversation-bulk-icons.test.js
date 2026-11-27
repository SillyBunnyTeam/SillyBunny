import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

// A Font Awesome class that the bundled stylesheet does not define draws nothing, and an icon-only button (the action bar on a
// phone) is then an empty button. This reads the icons that the bulk actions name and looks each one up in the stylesheet.
const read = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
const FONT_AWESOME = read('css/fontawesome.min.css');
const SOURCES = [
    'scripts/sillybunny-conversation/details/pages/chats.js',
    'scripts/sillybunny-conversation/details/pages/shared.js',
    'scripts/sillybunny-conversation/details/bulk-selection.js',
];

function iconsNamedIn(source) {
    const names = new Set();
    for (const pattern of [/fa-solid fa-([a-z0-9-]+)/g, /\bicon\('([a-z0-9-]+)'\)/g, /createMenuItem\('[^']+',\s*'([a-z0-9-]+)'/g, /SELECT_ITEM = \['[^']+', '([a-z0-9-]+)'\]/g, /createIconButton\([^,]+,\s*'([a-z0-9-]+)'/g]) {
        for (const match of source.matchAll(pattern)) {
            names.add(match[1]);
        }
    }
    return [...names];
}

describe('bulk actions: the icons that a button or a menu item names are in the bundled font', () => {
    for (const path of SOURCES) {
        test(`${path} names only icons that the font has`, () => {
            const names = iconsNamedIn(read(path));
            expect(names.length).toBeGreaterThan(0);
            const missing = names.filter(name => !FONT_AWESOME.includes(`.fa-${name}`));
            expect(missing).toEqual([]);
        });
    }
});
