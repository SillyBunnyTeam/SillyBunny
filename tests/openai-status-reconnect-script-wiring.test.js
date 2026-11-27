/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';

const STATUS_DOM = `
    <div id="options_button"></div>
    <div id="options"></div>
    <div id="export_button"></div>
    <div id="export_format_popup"></div>
    <div id="online_status_indicator"></div>
    <div id="online_status_text"></div>
    <select id="main_api"><option value="openai" selected>openai</option></select>
    <button class="api_button"></button>
    <div class="api_loading" style="display:none"></div>
    <div id="chat"></div>
    <div id="message_template" hidden><div class="mes"><div class="mes_block"><div class="mes_text"></div></div></div></div>
    <textarea id="send_textarea"></textarea>
    <div id="send_but"></div>
    <div id="mes_stop"></div>
`;

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
});

describe('script.js status loading and manual cancel wiring', () => {
    test('startStatusLoading notifies KoboldCpp switcher and toggles pending/button state, and clicking .api_loading cancels immediately', async () => {
        const countStatusLoadingStart = jest.fn();
        const setStatusCheckPending = jest.fn();

        loaded = await importScriptModule({
            dom: STATUS_DOM,
            mocks: {
                'scripts/sillybunny-koboldcpp-models.js': {
                    countStatusLoadingStart,
                },
                'scripts/sillybunny-connection-state.js': {
                    setStatusCheckPending,
                },
            },
        });
        await loaded.runReady();

        countStatusLoadingStart.mockClear();
        setStatusCheckPending.mockClear();

        const initialSignal = loaded.script.abortStatusCheck.signal;
        loaded.script.startStatusLoading();
        expect(countStatusLoadingStart).toHaveBeenCalledTimes(1);
        expect(setStatusCheckPending).toHaveBeenLastCalledWith(true);
        expect(document.querySelector('.api_button').classList.contains('disabled')).toBe(true);
        expect(document.querySelector('.api_loading').style.display).not.toBe('none');

        // Clicking .api_loading cancels the in-flight AbortController, swaps in a fresh non-aborted one, and clears pending state.
        loaded.$('.api_loading').trigger('click');
        expect(initialSignal.aborted).toBe(true);
        expect(loaded.script.abortStatusCheck.signal.aborted).toBe(false);
        expect(loaded.script.online_status).toBe('no_connection');
        expect(setStatusCheckPending).toHaveBeenLastCalledWith(false);
        expect(document.querySelector('.api_button').classList.contains('disabled')).toBe(false);

        // Second status check starts loading again and notifies KoboldCpp switcher a second time.
        loaded.script.startStatusLoading();
        loaded.script.resultCheckStatus();
        expect(countStatusLoadingStart).toHaveBeenCalledTimes(2);
        expect(setStatusCheckPending).toHaveBeenLastCalledWith(false);
    });
});
