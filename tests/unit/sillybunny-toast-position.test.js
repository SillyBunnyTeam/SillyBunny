/**
 * @jest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const {
    DEFAULT_TOAST_POSITION,
    TOAST_POSITION_SELECT_ID,
    applyToastPosition,
    bindToastPositionSelect,
    parseToastPosition,
} = await import('../../public/scripts/sillybunny-toast-position.js');

const POSITIONS = [
    'toast-top-left',
    'toast-top-center',
    'toast-top-right',
    'toast-bottom-left',
    'toast-bottom-center',
    'toast-bottom-right',
];

const readSource = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const indexHtml = readSource('public/index.html');
const powerUserSource = readSource('public/scripts/power-user.js');

/** A stand-in for the overlay that holds toasts; the real motion module moves it when the position changes. */
function addOverlay(positionClass = 'toast-bottom-center') {
    const overlay = document.createElement('div');
    overlay.id = 'sb-toast-overlay';
    overlay.className = positionClass;
    document.body.append(overlay);
    return overlay;
}

function addSelect() {
    const select = document.createElement('select');
    select.id = TOAST_POSITION_SELECT_ID;
    for (const value of POSITIONS) {
        select.add(new Option(value, value));
    }
    document.body.append(select);
    return select;
}

beforeEach(() => {
    document.body.replaceChildren();
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('the default and the validation', () => {
    test('a toast shows at the bottom centre unless the user chose another place', () => {
        expect(DEFAULT_TOAST_POSITION).toBe('toast-bottom-center');
        expect(parseToastPosition(undefined, POSITIONS)).toBe('toast-bottom-center');
    });

    test.each(POSITIONS)('%s is kept', position => {
        expect(parseToastPosition(position, POSITIONS)).toBe(position);
    });

    test.each([
        ['nothing', undefined],
        ['null', null],
        ['an empty string', ''],
        ['a class that is not a position', 'toast-middle-center'],
        ['a class with a stray space', 'toast-top-center '],
        ['a number', 4],
        ['an object', { value: 'toast-top-left' }],
    ])('%s becomes the default', (_name, value) => {
        expect(parseToastPosition(value, POSITIONS)).toBe(DEFAULT_TOAST_POSITION);
    });
});

describe('applying the saved position', () => {
    test('moves the toast overlay to the saved position and shows it in the select', () => {
        const overlay = addOverlay('toast-bottom-center');
        const select = addSelect();
        const settings = { toast_position: 'toast-top-right' };

        expect(applyToastPosition(settings, POSITIONS)).toBe('toast-top-right');

        expect(overlay.className).toBe('toast-top-right');
        expect(select.value).toBe('toast-top-right');
        expect(settings.toast_position).toBe('toast-top-right');
    });

    test('does not move the container of in-app notifications', () => {
        const notifications = document.createElement('div');
        notifications.id = 'toast-container';
        notifications.className = 'toast-top-center';
        document.body.append(notifications);
        addOverlay();

        applyToastPosition({ toast_position: 'toast-bottom-left' }, POSITIONS);

        expect(notifications.className).toBe('toast-top-center');
    });

    test('replaces a saved value that is not a position with the default, and says so once', () => {
        const overlay = addOverlay('toast-top-left');
        const select = addSelect();
        const settings = { toast_position: 'toast-middle-center' };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(applyToastPosition(settings, POSITIONS)).toBe(DEFAULT_TOAST_POSITION);

        expect(settings.toast_position).toBe(DEFAULT_TOAST_POSITION);
        expect(overlay.className).toBe(DEFAULT_TOAST_POSITION);
        expect(select.value).toBe(DEFAULT_TOAST_POSITION);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    test('works before the select and the overlay exist', () => {
        const settings = { toast_position: 'toast-top-left' };

        expect(() => applyToastPosition(settings, POSITIONS)).not.toThrow();

        expect(settings.toast_position).toBe('toast-top-left');
    });

    test('tells the select row that the value changed, once, so that the row shows it', () => {
        const select = addSelect();
        const changes = jest.fn();
        select.addEventListener('change', changes);

        applyToastPosition({ toast_position: 'toast-top-right' }, POSITIONS);
        applyToastPosition({ toast_position: 'toast-top-right' }, POSITIONS);

        expect(changes).toHaveBeenCalledTimes(1);
    });
});

describe('the select', () => {
    function bind(settings) {
        const overlay = addOverlay('toast-bottom-center');
        const select = addSelect();
        const onChange = jest.fn();
        bindToastPositionSelect(settings, POSITIONS, onChange);
        return { overlay, select, onChange };
    }

    const choose = (select, value) => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    };

    test('a choice is stored, moves the overlay and is saved', () => {
        const settings = { toast_position: 'toast-bottom-center' };
        const { overlay, select, onChange } = bind(settings);

        choose(select, 'toast-top-left');

        expect(settings.toast_position).toBe('toast-top-left');
        expect(overlay.className).toBe('toast-top-left');
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    test('choosing the place that is already in use saves nothing', () => {
        const settings = { toast_position: 'toast-bottom-left' };
        const { select, onChange } = bind(settings);

        choose(select, 'toast-bottom-left');

        expect(onChange).not.toHaveBeenCalled();
    });

    test('a value that is not a position falls back to the default and is saved as the default', () => {
        const settings = { toast_position: 'toast-top-left' };
        const { overlay, select, onChange } = bind(settings);
        const option = new Option('Elsewhere', 'toast-elsewhere');
        select.add(option);
        jest.spyOn(console, 'warn').mockImplementation(() => {});

        choose(select, 'toast-elsewhere');

        expect(settings.toast_position).toBe(DEFAULT_TOAST_POSITION);
        expect(overlay.className).toBe(DEFAULT_TOAST_POSITION);
        expect(select.value).toBe(DEFAULT_TOAST_POSITION);
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    test('applying the saved position on load saves nothing', () => {
        const settings = { toast_position: 'toast-top-right' };
        const { select, onChange } = bind(settings);

        applyToastPosition(settings, POSITIONS);

        expect(select.value).toBe('toast-top-right');
        expect(settings.toast_position).toBe('toast-top-right');
        expect(onChange).not.toHaveBeenCalled();
    });

    test('does nothing when the page has no such select', () => {
        document.body.replaceChildren();

        expect(() => bindToastPositionSelect({ toast_position: 'toast-top-left' }, POSITIONS, jest.fn())).not.toThrow();
    });
});

describe('the Customize row and the saved key', () => {
    const optionValues = id => {
        const select = new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(indexHtml)?.[1] ?? '';
        return [...select.matchAll(/<option value="([^"]+)" data-i18n="([^"]+)">([^<]+)<\/option>/g)]
            .map(([, value, key, text]) => ({ value, key, text }));
    };

    test('power_user holds the toast position, seeded with the default', () => {
        expect(powerUserSource).toMatch(/^\s{4}toast_position: DEFAULT_TOAST_POSITION,/m);
    });

    test('the notification position keeps its own key and default', () => {
        expect(powerUserSource).toMatch(/^\s{4}toastr_position: defaultToastPosition,/m);
        expect(powerUserSource).toContain('const defaultToastPosition = \'toast-top-center\';');
    });

    test('the toast select has the six positions of toastPositionClasses, with the labels of the notification select', () => {
        const declared = /export const toastPositionClasses = \[([\s\S]*?)\];/.exec(powerUserSource)?.[1] ?? '';
        const classes = [...declared.matchAll(/'([^']+)'/g)].map(match => match[1]);

        expect(classes).toEqual(POSITIONS);
        expect(optionValues('toast_position').map(option => option.value)).toEqual(classes);
        expect(optionValues('toast_position')).toEqual(optionValues('toastr_position'));
    });

    test('the select ids are the ones the module binds to', () => {
        expect(TOAST_POSITION_SELECT_ID).toBe('toast_position');
        expect(indexHtml).toContain('<select id="toast_position" class="widthNatural flex1 margin0 text_pole">');
    });

    test('each select sits in a row of its own, with the label and the subtitle the user wrote', () => {
        const row = id => new RegExp(`<div class="flex-container alignItemsBaseline">\\s*<span data-i18n="([^"]+)">([^<]+)</span>\\s*<small class="ds-row-subtitle" data-i18n="([^"]+)">([^<]+)</small>\\s*<select id="${id}"`).exec(indexHtml)?.slice(1);

        expect(row('toastr_position')).toEqual([
            'Notifications:', 'Notifications:',
            'Choose where application pop-up notifications appear on the screen', 'Choose where application pop-up notifications appear on the screen',
        ]);
        expect(row('toast_position')).toEqual([
            'Toasts:', 'Toasts:',
            'Choose where application toast confirmations appear on the screen', 'Choose where application toast confirmations appear on the screen',
        ]);
    });

    test('the Toasts row follows the Notifications row', () => {
        expect(indexHtml.indexOf('id="toast_position"')).toBeGreaterThan(indexHtml.indexOf('id="toastr_position"'));
        expect(indexHtml.indexOf('id="toast_position"')).toBeLessThan(indexHtml.indexOf('id="toastr_position"') + 2500);
    });
});
