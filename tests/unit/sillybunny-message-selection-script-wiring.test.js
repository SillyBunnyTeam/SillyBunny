/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from '../util/script-harness.js';

let activeScript = null;

afterEach(() => {
    activeScript?.cleanup();
    activeScript = null;
    document.body.innerHTML = '';
});

describe('public/script.js openMessageDelete and clearChat wiring', () => {
    test('clearChat resets is_delete_mode and invalidates an in-flight openMessageDelete before selection mounts', async () => {
        const openSelectionMock = jest.fn(async () => {});
        const loaded = await importScriptModule({
            dom: `
                <div id="options_button"></div>
                <div id="options">
                    <a id="option_delete_mes"></a>
                </div>
                <div id="export_button"></div>
                <div id="export_format_popup"></div>
                <div id="online_status_indicator"></div>
                <div id="online_status_text"></div>
                <select id="main_api"><option value="openai">openai</option></select>
                <div id="chat"></div>
                <div id="message_template" hidden>
                    <div class="mes">
                        <div class="mes_block">
                            <div class="ch_name"><span class="name_text"></span></div>
                            <div class="mes_text"></div>
                        </div>
                    </div>
                </div>
                <textarea id="send_textarea"></textarea>
                <div id="send_but"></div>
                <div id="mes_stop"></div>
            `,
            mocks: {
                'scripts/sillybunny-message-selection.js': {
                    openMessageSelection: openSelectionMock,
                    cancelMessageSelection: jest.fn(),
                    isMessageSelectionActive: jest.fn(() => false),
                },
            },
        });
        activeScript = loaded;

        await loaded.runReady();
        loaded.script.chat.push({ is_user: true, is_system: false, name: 'User', mes: 'Hello' });

        // Trigger option_delete_mes and verify clearChat invalidates the pending selection request
        // before the dynamic import resolves and mounts selection mode.
        jest.useFakeTimers();
        try {
            document.getElementById('option_delete_mes').click();
            jest.advanceTimersByTime(500);
        } finally {
            jest.useRealTimers();
        }
        await loaded.script.clearChat();
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(openSelectionMock).not.toHaveBeenCalled();

        // Fresh openMessageDelete enters selection mode with live isStillWanted and syncWindowControls.
        loaded.script.chat.push({ is_user: true, is_system: false, name: 'User', mes: 'Fresh' });
        jest.useFakeTimers();
        try {
            document.getElementById('option_delete_mes').click();
            jest.advanceTimersByTime(500);
        } finally {
            jest.useRealTimers();
        }
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(openSelectionMock).toHaveBeenCalledTimes(1);
        const firstOpts = openSelectionMock.mock.calls[0][0];
        expect(firstOpts.deleteToolCalls).toBe(true);
        expect(firstOpts.isStillWanted()).toBe(true);
        expect(typeof firstOpts.syncWindowControls).toBe('function');

        await firstOpts.syncWindowControls();
        expect(document.querySelectorAll('#chat > .mes')).toHaveLength(2);

        // Clearing chat resets internal delete mode even when #dialogue_del_mes_cancel is not mounted.
        await loaded.script.clearChat();
        expect(firstOpts.isStillWanted()).toBe(false);

        // Calling onExit clears selection state on its own.
        loaded.script.chat.push({ is_user: true, is_system: false, name: 'User', mes: 'Second' });
        jest.useFakeTimers();
        try {
            document.getElementById('option_delete_mes').click();
            jest.advanceTimersByTime(500);
        } finally {
            jest.useRealTimers();
        }
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(openSelectionMock).toHaveBeenCalledTimes(2);
        const secondOpts = openSelectionMock.mock.calls[1][0];
        expect(secondOpts.isStillWanted()).toBe(true);
        secondOpts.onExit();
        expect(secondOpts.isStillWanted()).toBe(false);
    });
});
