/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { importScriptModule } from '../util/script-harness.js';

const activeCleanups = [];

afterEach(() => {
    while (activeCleanups.length) activeCleanups.pop()();
    document.body.replaceChildren();
    jest.restoreAllMocks();
});

async function flushAsync(ms = 20) {
    await new Promise(resolve => setTimeout(resolve, ms));
    await Promise.resolve();
}

describe('upstream misc-dialog seam (message screenshot popup)', () => {
    test('message screenshot popup spreads messageScreenshotOptions and parses/rejects raw input text via Number.parseInt', async () => {
        const popupCalls = [];

        class SpyPopup {
            constructor(content, type, inputValue, options) {
                this.content = document.createElement('div');
                this.content.className = 'popup-content';
                if (content instanceof HTMLElement) {
                    this.content.appendChild(content);
                }
                this.inputControls = document.createElement('div');
                this.inputControls.className = 'popup-inputs';
                for (const input of options.customInputs ?? []) {
                    const label = document.createElement('label');
                    label.className = 'text_label';
                    const span = document.createElement('span');
                    span.textContent = input.label;
                    const el = document.createElement('input');
                    el.id = input.id;
                    el.type = input.type ?? 'text';
                    el.value = input.defaultState ?? '';
                    el.title = input.tooltip ?? '';
                    label.append(span, el);
                    this.inputControls.appendChild(label);
                }
                this.dlg = document.createElement('dialog');
                this.dlg.append(this.content, this.inputControls);
                document.body.appendChild(this.dlg);
                this.options = options;
                this.result = null;
                popupCalls.push({ popup: this, type, inputValue, options });
            }

            async show() {
                this.options.onOpening?.(this);
                return 0;
            }
        }
        SpyPopup.show = { confirm: jest.fn(async () => 0), input: jest.fn(async () => '') };

        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
        activeCleanups.push(() => consoleError.mockRestore());

        const loaded = await importScriptModule({
            keepReal: ['scripts/sillybunny-editor/adapters/misc-dialogs.js'],
            dom: '<div id="chat"><div class="mes" mesid="1"><button class="mes_screenshot" type="button"></button></div></div>',
            mocks: {
                'scripts/popup.js': base => ({ ...base, Popup: SpyPopup }),
            },
        });
        activeCleanups.push(() => loaded.cleanup());

        loaded.script.chat.push(
            { name: 'Alice', mes: 'Zero', is_user: false },
            { name: 'User', mes: 'One', is_user: true },
            { name: 'Alice', mes: 'Two', is_user: false },
        );

        await loaded.runReady();
        loaded.$('.mes_screenshot').trigger('click');
        await flushAsync();

        expect(popupCalls).toHaveLength(1);
        const { popup, options } = popupCalls[0];
        expect(options.tier).toBe('dialog');
        expect(typeof options.onOpening).toBe('function');
        expect(typeof options.onClose).toBe('function');

        const startInput = popup.dlg.querySelector('#message_screenshot_start_id');
        const endInput = popup.dlg.querySelector('#message_screenshot_end_id');
        expect(startInput).toBeInstanceOf(HTMLInputElement);
        expect(startInput.closest('.ds-row-suffix')).not.toBeNull();
        expect(startInput.closest('.popup-content')).not.toBeNull();

        // Invalid range is rejected by onClosing and warns the user.
        popup.result = 1;
        startInput.value = '999';
        endInput.value = '999';
        expect(options.onClosing(popup)).toBe(false);
        expect(loaded.toastr.warning).toHaveBeenCalledWith(
            expect.stringContaining('0 and 2'),
            expect.any(String),
        );

        // Blank text parses as NaN and is rejected.
        loaded.toastr.warning.mockClear();
        startInput.value = '';
        endInput.value = '1';
        expect(options.onClosing(popup)).toBe(false);
        expect(loaded.toastr.warning).toHaveBeenCalledTimes(1);

        // Valid numeric strings pass onClosing (even with surrounding whitespace).
        startInput.value = ' 0 ';
        endInput.value = '2';
        expect(options.onClosing(popup)).toBe(true);
        options.onClose?.(popup);
    });
});
