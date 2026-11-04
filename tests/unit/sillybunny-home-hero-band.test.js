/* eslint-disable playwright/no-standalone-expect -- Jest contracts for the hero's band. */
// A tripwire for the coupling between the art width and the container limit of the band's padding. jsdom has no container
// queries, so this reads the style sheet; tests/home-hero-art.e2e.js checks the real widths in a browser.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';
import { getPixelArt } from '../../public/scripts/sillybunny-home/art-sources.js';

const css = readFileSync(fileURLToPath(new URL('../../public/css/sillybunny-home.css', import.meta.url)), 'utf8');

/** The text of the first block that starts with `header`, up to the line that closes it. */
function blockAfter(header) {
    const start = css.indexOf(`\n${header}`);
    if (start === -1) {
        throw new Error(`${header} is not in the style sheet.`);
    }
    return css.slice(start, css.indexOf('\n}\n', start));
}

/** The container width up to which the band keeps its narrow padding, from the rule that says so. */
function narrowBandLimit() {
    const rule = css.match(/@container welcome-home \(max-width: (\d+)px\) \{\s*\.sbHomeBand \{\s*padding-inline: 4px;\s*\}\s*\}/);
    if (!rule) {
        throw new Error('The container rule that gives the band 4px of padding is not in the style sheet.');
    }
    return Number(rule[1]);
}

describe('the band of the hero', () => {
    // The day hero keeps its fixed step on a phone only while the band can hold the picture and the paddings around it. The
    // limit of the narrow band padding is that sum, so a new art width has to move the limit with it.
    test('keeps its narrow padding up to the container width that holds the day hero with the padding of a wide band', () => {
        const picture = getPixelArt('hero-duo').width;
        const panelPadding = 2 * 12;
        const bandPadding = 2 * 16;
        const layoutPadding = 2 * 12;
        const bandBorder = 2 * 1;

        expect(narrowBandLimit()).toBe(picture + panelPadding + bandPadding + layoutPadding + bandBorder);
    });

    test('the paddings in that sum are the ones that the style sheet gives', () => {
        const narrow = blockAfter('@container welcome-home (max-width: 560px) {');

        expect(blockAfter('.sbArtPanel {')).toContain('padding: var(--sb-art-pad, 12px);');
        expect(blockAfter('.sbHomeBand {')).toContain('border: 1px solid');
        expect(narrow).toMatch(/\.sbHomeLayout \{\s*padding-inline: max\(12px,/);
        expect(narrow).toMatch(/\.sbHomeBand \{\s*padding-inline: 16px;/);
    });
});
