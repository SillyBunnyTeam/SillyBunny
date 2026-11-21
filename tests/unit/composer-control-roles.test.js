/** @jest-environment jsdom */
/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { test, expect } from '@jest/globals';
import { initAccessibility } from '../../public/scripts/a11y.js';

test('the composer icon controls get a button role and their tooltip as a label, also when they are added later', async () => {
    document.body.innerHTML = '<div id="send_form"><div id="leftSendForm"><div id="options_button" class="interactable"></div></div>'
        + '<div id="rightSendForm">'
        + '<div id="stscript_stop" class="stscript_btn" title="Abort script execution"></div>'
        + '<div id="mes_stop" title="Abort request"></div>'
        + '<div id="send_but" class="interactable" title="  Send a message  "></div>'
        + '<div id="mes_continue" class="interactable" title="Continue the last message" aria-label="Continue"></div>'
        + '<div id="extension_without_title" class="interactable"></div>'
        + '</div></div><div id="elsewhere" class="interactable" title="Not a composer control"></div>';
    initAccessibility();

    const read = id => {
        const element = document.getElementById(id);
        return [element.getAttribute('role'), element.getAttribute('aria-label')];
    };
    expect(read('options_button')).toEqual(['button', null]);
    expect(read('stscript_stop')).toEqual(['button', 'Abort script execution']);
    expect(read('mes_stop')).toEqual(['button', 'Abort request']);
    expect(read('send_but')).toEqual(['button', 'Send a message']);
    // A label that the code set stays.
    expect(read('mes_continue')).toEqual(['button', 'Continue']);
    // No tooltip, no invented name.
    expect(read('extension_without_title')).toEqual(['button', null]);
    expect(read('elsewhere')).toEqual([null, null]);

    const wand = document.createElement('div');
    wand.id = 'extensionsMenuButton';
    wand.className = 'fa-solid fa-magic-wand-sparkles interactable';
    wand.title = 'Extensions';
    document.getElementById('leftSendForm').append(wand);
    await Promise.resolve();
    expect(read('extensionsMenuButton')).toEqual(['button', 'Extensions']);
});
