import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ICON_CONTROL_ANCHOR = '.right_menu_button:not(:has(> span)):not(:has(> small)):not(:has(> b)):not(:has(> strong)):has(> :is(.fa, .fa-solid, .fa-regular, .fa-brands, i, svg, img):only-child)';

function getIconControlRuleBodies(fileName) {
    const css = readFileSync(path.join(repoRoot, 'public', 'css', fileName), 'utf8').replace(/\r\n/g, '\n');
    const escapedAnchor = ICON_CONTROL_ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...css.matchAll(new RegExp(`${escapedAnchor}\\s*\\{(?<body>[^}]*)\\}`, 'gs'))];

    return matches.map(match => match.groups?.body ?? '');
}

const themeRules = getIconControlRuleBodies('sillybunny-theme.css');
const mobileRules = getIconControlRuleBodies('mobile-styles.css');
const allRules = [...themeRules, ...mobileRules];

describe('icon control sizing css', () => {
    test('both sheets still carry the shared icon control rule', () => {
        expect(themeRules.length).toBeGreaterThan(0);
        expect(mobileRules.length).toBeGreaterThan(0);
    });

    test('every copy sizes icon controls by a minimum, never a fixed box', () => {
        // A third-party button whose label is a bare text node matches this selector, so a fixed
        // width/height would squash the label out of the box instead of letting the pill grow.
        const fixedBoxRules = allRules.filter(body => /(?<!min-|max-)\b(width|height|inline-size|block-size):\s*var\(--sb-control-icon-physical-size/.test(body)
            || /\bmax-(width|inline-size|height|block-size):/.test(body));

        expect(fixedBoxRules).toEqual([]);
    });

    test('every copy keeps the minimum touch target on both axes', () => {
        const missingFloor = allRules.filter(body => !/min-width:\s*var\(--sb-control-icon-physical-size/.test(body)
            || !/min-height:\s*var\(--sb-control-icon-physical-size/.test(body));

        expect(missingFloor).toEqual([]);
    });

    test('every copy keeps horizontal padding for a text label', () => {
        const flushRules = allRules.filter(body => !/padding:\s*0 6px !important/.test(body));

        expect(flushRules).toEqual([]);
    });
});
