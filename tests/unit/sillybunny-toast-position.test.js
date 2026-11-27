/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static HTML contracts. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

import { importPowerUserModule } from '../util/power-user-harness.js';

const motion = await import('../../public/scripts/sillybunny-toast-motion.js');
const {
    DEFAULT_TOAST_POSITION,
    TOAST_POSITION_SELECT_ID,
    applyPositionsEarly,
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

const { powerUser, mocks } = await importPowerUserModule({ mockToastPosition: true });
const initialDefaults = structuredClone(powerUser.power_user);

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
    Object.assign(powerUser.power_user, structuredClone(initialDefaults));
    mocks.toastPosition.applyPositionsEarly.mockClear();
    mocks.toastPosition.applyToastPosition.mockClear();
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('the positions at start-up', () => {
    const { getNotificationPosition, setNotificationPosition, setToastPosition } = motion;

    afterEach(() => {
        setToastPosition('toast-bottom-center');
        setNotificationPosition('toast-top-center');
    });

    test('moves the overlay and the notification container to the saved positions before the page has its controls', () => {
        const overlay = addOverlay();
        const container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-top-center';
        document.body.append(container);

        applyPositionsEarly({ toast_position: 'toast-top-right', toastr_position: 'toast-bottom-left' }, POSITIONS, 'toast-top-center');

        expect(overlay.className).toBe('toast-top-right');
        expect(container.className).toBe('toast-bottom-left');
        expect(getNotificationPosition()).toBe('toast-bottom-left');
    });

    test('takes the defaults for a position that is not offered, and leaves the settings as they are', () => {
        const settings = { toast_position: 'sideways', toastr_position: 42 };
        const overlay = addOverlay('toast-top-right');
        applyPositionsEarly(settings, POSITIONS, 'toast-top-center');
        expect(overlay.className).toBe('toast-bottom-center');
        expect(getNotificationPosition()).toBe('toast-top-center');
        expect(settings).toEqual({ toast_position: 'sideways', toastr_position: 42 });
    });

    test('touches nothing of the page: it does not write to the select, which the later call does', () => {
        const select = addSelect();
        select.value = 'toast-bottom-left';
        const listener = jest.fn();
        select.addEventListener('change', listener);
        applyPositionsEarly({ toast_position: 'toast-top-right', toastr_position: 'toast-top-center' }, POSITIONS, 'toast-top-center');
        expect(select.value).toBe('toast-bottom-left');
        expect(listener).not.toHaveBeenCalled();
    });
});

describe('the wiring in loadPowerUserSettings', () => {
    test('moves both positions synchronously as soon as power_user holds the saved values, before the first await, and applies controls afterward', async () => {
        const overlay = addOverlay('toast-bottom-center');
        const container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-top-center';
        document.body.append(container);
        const select = addSelect();

        const loadPromise = powerUser.loadPowerUserSettings(
            {
                power_user: {
                    toast_position: 'toast-top-right',
                    toastr_position: 'toast-bottom-left',
                },
            },
            { themes: [], context: [], instruct: [], sysprompt: [], reasoning: [] },
        );

        // Immediately after synchronous entry — before any await resolves — applyPositionsEarly has already moved both positions.
        expect(mocks.toastPosition.applyPositionsEarly).toHaveBeenCalledTimes(1);
        expect(overlay.className).toBe('toast-top-right');
        expect(container.className).toBe('toast-bottom-left');
        expect(motion.getNotificationPosition()).toBe('toast-bottom-left');

        await loadPromise;

        // After load finishes, applyToastPosition has synced the page select and toastr.options has the notification position.
        expect(mocks.toastPosition.applyToastPosition).toHaveBeenCalledWith(powerUser.power_user, powerUser.toastPositionClasses);
        expect(select.value).toBe('toast-top-right');
        expect(global.toastr.options.positionClass).toBe('toast-bottom-left');
    });
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
        expect(initialDefaults.toast_position).toBe(DEFAULT_TOAST_POSITION);
    });

    test('the notification position keeps its own key and default', () => {
        expect(initialDefaults.toastr_position).toBe('toast-top-center');
    });

    test('the toast select has the six positions of toastPositionClasses, with the labels of the notification select', () => {
        expect(powerUser.toastPositionClasses).toEqual(POSITIONS);
        expect(optionValues('toast_position').map(option => option.value)).toEqual(powerUser.toastPositionClasses);
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
