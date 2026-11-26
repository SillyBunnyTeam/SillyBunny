/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
    translate: value => value,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateHeightFrom: jest.fn(),
    animateIn: jest.fn(),
    animateOut: jest.fn((_element, _frames, hide) => hide()),
    play: jest.fn(),
    stopMotion: jest.fn(),
    MOTION_FAST: 200,
    MOTION_SLOW: 250,
    MOTION_POPOVER_CLOSE: 150,
    MOTION_EASE_OUT_CUBIC: 'cubic-bezier(0.33, 1, 0.68, 1)',
    SPRING_SHEET: {},
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    MOBILE_QUERY: '(max-width: 768px)',
    positionPopover: jest.fn(() => '0px 0'),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({
    blockUpstreamDrawerClose: jest.fn(),
    createSheetController: jest.fn(),
}));

const { bindDependentSets } = await import('../../public/scripts/sillybunny-settings-presentation.js');

function switchRow(id) {
    const row = document.createElement('label');
    row.className = 'ds-row ds-row-switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    row.append(input);
    return row;
}

describe('a group that depends on a switch', () => {
    let scope;
    let enabler;

    beforeEach(() => {
        document.body.innerHTML = '<section id="scope"><div id="body" data-sb-enabled-by="#enabler"></div></section>';
        scope = document.getElementById('scope');
        const body = document.getElementById('body');
        body.append(switchRow('enabler'), switchRow('plain'), switchRow('owned'));
        body.querySelector('#owned').closest('.ds-row').setAttribute('data-sb-sensitivity-owned', '');
        enabler = document.getElementById('enabler');
    });

    test('holds its rows insensitive while the switch is off and frees them when it turns on', () => {
        bindDependentSets(scope);
        const plain = document.getElementById('plain');
        expect(plain.disabled).toBe(true);
        expect(plain.closest('.ds-row').classList.contains('is-insensitive')).toBe(true);
        enabler.click();
        expect(plain.disabled).toBe(false);
        expect(plain.closest('.ds-row').classList.contains('is-insensitive')).toBe(false);
    });

    test('leaves a row that carries data-sb-sensitivity-owned to its owner', () => {
        bindDependentSets(scope);
        const owned = document.getElementById('owned');
        const row = owned.closest('.ds-row');
        expect(owned.disabled).toBe(false);
        expect(row.classList.contains('is-insensitive')).toBe(false);
        row.classList.add('is-insensitive');
        owned.disabled = true;
        enabler.click();
        document.getElementById('body').dispatchEvent(new Event('pointerover', { bubbles: true }));
        expect(owned.disabled).toBe(true);
        expect(row.classList.contains('is-insensitive')).toBe(true);
    });
});
