/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (index < values.length ? values[index] : ''), ''),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ openPicker: jest.fn(), closePicker: jest.fn(), isPickerOpen: () => false }));
const { chooseSliderMode, createSliderModeRow, readSliderMode } = await import('../../public/scripts/sillybunny-appearance.js');

let zen;
let lab;
let power;
let toasts;
let events;
const instantly = jest.fn(async () => {});

/** The two upstream handlers of power-user.js, reduced to what this control depends on: the exclusion rule and the booleans. */
function bindUpstream() {
    power = { enableZenSliders: false, enableLabMode: false };
    toasts = [];
    events = [];
    zen.addEventListener('input', () => {
        events.push(`zen:${zen.checked}`);
        if (power.enableLabMode && zen.checked) {
            toasts.push('Disable Mad Lab Mode before enabling Zen Sliders');
            zen.checked = false;
            return;
        }
        power.enableZenSliders = zen.checked;
    });
    lab.addEventListener('input', () => {
        events.push(`lab:${lab.checked}`);
        if (power.enableZenSliders && lab.checked) {
            toasts.push('Disable Zen Sliders before enabling Mad Lab Mode');
            lab.checked = false;
            return;
        }
        power.enableLabMode = lab.checked;
    });
}

beforeEach(() => {
    document.body.innerHTML = '<input type="checkbox" id="enableZenSliders"><input type="checkbox" id="enableLabMode">';
    zen = document.getElementById('enableZenSliders');
    lab = document.getElementById('enableLabMode');
    bindUpstream();
    instantly.mockClear();
});

describe('reading the mode', () => {
    test.each([[false, false, 'none'], [true, false, 'zen'], [false, true, 'lab']])('zen %s and lab %s read as %s', (zenOn, labOn, mode) => {
        expect(readSliderMode(zenOn, labOn)).toBe(mode);
    });
});

describe('writing the mode through the upstream inputs', () => {
    test('stores the two booleans that upstream stores, for each of the three choices', async () => {
        await chooseSliderMode('zen', { zen, lab }, instantly);
        expect(power).toEqual({ enableZenSliders: true, enableLabMode: false });
        await chooseSliderMode('lab', { zen, lab }, instantly);
        expect(power).toEqual({ enableZenSliders: false, enableLabMode: true });
        await chooseSliderMode('none', { zen, lab }, instantly);
        expect(power).toEqual({ enableZenSliders: false, enableLabMode: false });
    });

    test('switches the old mode off before the new one on, and never trips the upstream rejection', async () => {
        await chooseSliderMode('zen', { zen, lab }, instantly);
        events.length = 0;
        await chooseSliderMode('lab', { zen, lab }, instantly);
        expect(events).toEqual(['zen:false', 'lab:true']);
        expect(toasts).toEqual([]);
        await chooseSliderMode('zen', { zen, lab }, instantly);
        expect(toasts).toEqual([]);
    });

    test('waits between the off and the on only when a mode had to be switched off', async () => {
        await chooseSliderMode('zen', { zen, lab }, instantly);
        expect(instantly).not.toHaveBeenCalled();
        await chooseSliderMode('lab', { zen, lab }, instantly);
        expect(instantly).toHaveBeenCalledTimes(1);
        await chooseSliderMode('none', { zen, lab }, instantly);
        expect(instantly).toHaveBeenCalledTimes(1);
    });

    test('fires no event for a choice that is already in force', async () => {
        await chooseSliderMode('none', { zen, lab }, instantly);
        expect(events).toEqual([]);
    });
});

describe('the row', () => {
    const radios = row => [...row.querySelectorAll('input[type="radio"]')];
    const checked = row => radios(row).find(input => input.checked)?.value;

    test('offers none, Zen Sliders and Mad Lab Mode as one radio group, in that order', () => {
        const row = createSliderModeRow({ zen, lab });
        expect(radios(row).map(input => input.value)).toEqual(['none', 'zen', 'lab']);
        expect([...row.querySelectorAll('.sb-boolean-radio-option span')].map(node => node.textContent)).toEqual(['None', 'Zen Sliders', 'Mad Lab Mode']);
        expect(row.querySelector('[role="radiogroup"]')).not.toBeNull();
        expect(row.id).toBe('sb-slider-mode');
    });

    test('starts on the mode the inputs hold', () => {
        lab.checked = true;
        expect(checked(createSliderModeRow({ zen, lab }))).toBe('lab');
    });

    test('a pick writes the inputs, and the stored booleans follow', async () => {
        const row = createSliderModeRow({ zen, lab });
        document.body.append(row);
        radios(row)[1].click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(zen.checked).toBe(true);
        expect(power.enableZenSliders).toBe(true);
    });

    test('follows the inputs when upstream settings load or a switch function sets them', () => {
        const row = createSliderModeRow({ zen, lab });
        zen.checked = true;
        zen.dispatchEvent(new Event('input', { bubbles: true }));
        expect(checked(row)).toBe('zen');
        zen.checked = false;
        zen.dispatchEvent(new Event('input', { bubbles: true }));
        expect(checked(row)).toBe('none');
    });
});
