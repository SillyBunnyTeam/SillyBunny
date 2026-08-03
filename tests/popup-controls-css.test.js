import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const popupCss = readFileSync(path.join(repoRoot, 'public', 'css', 'popup.css'), 'utf8').replace(/\r\n/g, '\n');
const styleCss = readFileSync(path.join(repoRoot, 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');

function getRuleBody(cssSource, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...cssSource.matchAll(new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'gs'))];
    const match = matches.at(-1);

    return match?.groups?.body ?? '';
}

// '.popup-body' and '#dialogue_popup_holder' both clip overflow, so a popup action row that
// sizes itself to its content gets sliced at the popup edges once the labels are long enough,
// and the focus ring plus the '.menu_button_default' glow -- which paint outside the button
// border box -- get cut off along the bottom. The row therefore has to stay inside its parent
// and carry its own padding as ring room.
describe('popup controls css', () => {
    test('keeps the modern popup action row inside the clipped popup body', () => {
        const controlsRule = getRuleBody(popupCss, '.popup-controls');

        expect(controlsRule).toContain('flex-wrap: wrap;');
        expect(controlsRule).toContain('max-width: 100%;');
        expect(controlsRule).toContain('padding: 6px;');
    });

    test('sizes modern popup buttons from the row gap so the row padding stays ring room', () => {
        const buttonRule = getRuleBody(popupCss, '.popup-controls .menu_button');

        expect(buttonRule).toContain('margin: 0;');
        expect(buttonRule).toContain('max-width: 100%;');
        expect(buttonRule).toContain('white-space: normal;');
    });

    test('keeps the legacy popup action row inside the clipped popup holder', () => {
        const legacyControlsRule = getRuleBody(styleCss, '#dialogue_popup_controls');

        expect(legacyControlsRule).toContain('flex-wrap: wrap;');
        expect(legacyControlsRule).toContain('max-width: 100%;');
        expect(legacyControlsRule).toContain('padding: 6px;');
    });

    test('cache-busts the popup sheet import so returning users get the fix', () => {
        expect(styleCss).toMatch(/@import url\(css\/popup\.css\?v=[0-9a-z]+\);/);
    });
});
