/** @jest-environment jsdom */
import { afterEach, describe, expect, test } from '@jest/globals';
import { importPowerUserModule } from './util/power-user-harness.js';

const TOGGLES = [
    ['messageModelNameEnabled', 'timestamp_model_name'],
    ['messageReasoningEffortEnabled', 'timestamp_reasoning_effort'],
];

afterEach(() => {
    document.body.innerHTML = '';
});

describe('message model icon label power-user toggles', () => {
    test('defaults both settings off, syncs checkboxes on load, and repaints rendered messages on toggle', async () => {
        document.body.innerHTML = `
            <input id="messageModelNameEnabled" type="checkbox" />
            <input id="messageReasoningEffortEnabled" type="checkbox" />
        `;

        const { powerUser, mocks, runReady } = await importPowerUserModule();
        await runReady();

        for (const [id, setting] of TOGGLES) {
            expect(powerUser.power_user[setting]).toBe(false);
            const checkbox = document.getElementById(id);
            expect(checkbox.checked).toBe(false);
        }

        await powerUser.loadPowerUserSettings({
            power_user: {
                timestamp_model_name: true,
                timestamp_reasoning_effort: true,
            },
        }, {});

        for (const [id, setting] of TOGGLES) {
            expect(powerUser.power_user[setting]).toBe(true);
            expect(document.getElementById(id).checked).toBe(true);
        }

        mocks.script.refreshMessageModelIcons.mockClear();
        mocks.script.saveSettingsDebounced.mockClear();

        for (const [id, setting] of TOGGLES) {
            const checkbox = document.getElementById(id);
            checkbox.checked = false;
            window.jQuery(checkbox).trigger('input');
            expect(powerUser.power_user[setting]).toBe(false);

            checkbox.checked = true;
            window.jQuery(checkbox).trigger('input');
            expect(powerUser.power_user[setting]).toBe(true);
        }

        expect(mocks.script.refreshMessageModelIcons).toHaveBeenCalledTimes(4);
        expect(mocks.script.saveSettingsDebounced).toHaveBeenCalledTimes(4);
    });
});
