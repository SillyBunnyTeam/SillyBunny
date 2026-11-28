/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom uses synchronous DOM assertions. */
import { jest, describe, test, expect, afterEach } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
    translate: value => value,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateHeightFrom: jest.fn(), animateIn: jest.fn(), animateOut: jest.fn(), play: jest.fn(), stopMotion: jest.fn(), MOTION_SLOW: 250,
    MOTION_FAST: 200, MOTION_POPOVER_CLOSE: 150, MOTION_EASE_OUT_CUBIC: 'ease', SPRING_SHEET: {},
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ MOBILE_QUERY: '(max-width: 768px)', positionPopover: jest.fn(() => '0px 0') }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({ blockUpstreamDrawerClose: jest.fn(), createSheetController: jest.fn() }));

const { applyConnectionsFormPass } = await import('../../public/scripts/sillybunny-connections-form.js');

const t = (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), '');

// jsdom has no CSS.escape; the ids in this test need no escaping.
globalThis.CSS ??= { escape: value => String(value) };

/** Runs the form pass over upstream's KoboldCpp model markup, with the hint wrapper in the given state. */
function adoptModelRow(hintClasses) {
    const block = document.createElement('div');
    block.innerHTML = `
        <div class="flex1">
            <h4 id="koboldcpp_model_heading"><span>KoboldCpp Model</span></h4>
            <select id="koboldcpp_model" aria-labelledby="koboldcpp_model_heading"><option value="">-- Connect to the API --</option></select>
            <div class="marginTopBot5 ${hintClasses}" data-for="koboldcpp_model"><small id="koboldcpp_model_hint">Models load with KoboldCpp's default settings.</small></div>
        </div>`;
    document.body.append(block);
    applyConnectionsFormPass(block, {
        moveNode: (node, parent) => parent.append(node),
        snapshotAttributes: () => {},
        addLegacyClass: (node, className) => node.classList.add(className),
        controllers: [],
        generated: [],
        t,
    });
    const hint = document.getElementById('koboldcpp_model_hint').parentElement;
    return { row: document.querySelector('.ds-select-row'), hint, select: document.getElementById('koboldcpp_model') };
}

afterEach(() => {
    delete globalThis.jQuery;
    document.body.replaceChildren();
});

describe('applyConnectionsFormPass and the KoboldCpp model hint', () => {
    test.each([
        ['hidden when the panel is built', 'displayNone'],
        ['already shown when the panel is built', ''],
    ])('the hint stays below its row and describes the select, %s', (_name, hintClasses) => {
        const { row, hint, select } = adoptModelRow(hintClasses);

        expect(row).not.toBeNull();
        expect(row.contains(hint)).toBe(false);
        expect(row.parentElement.contains(hint)).toBe(true);
        expect(row.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(select.getAttribute('aria-describedby').split(' ')).toContain(hint.id);
    });
});
