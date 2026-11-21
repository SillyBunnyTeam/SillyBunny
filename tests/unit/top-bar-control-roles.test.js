/** @jest-environment jsdom */
/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { test, expect } from '@jest/globals';
import { initAccessibility } from '../../public/scripts/a11y.js';

test('the top bar drawer icons and adopted extension controls get a button role and their tooltip as a label', async () => {
    document.body.innerHTML = '<div id="top-settings-holder">'
        + '<div class="drawer"><div class="drawer-toggle"><div id="leftNavDrawerIcon" class="drawer-icon fa-solid fa-bars interactable" title="Open"></div></div></div>'
        + '<div class="drawer"><div class="drawer-toggle"><div id="named_icon" class="drawer-icon interactable" title="Tooltip" aria-label="Chosen name"></div></div></div>'
        + '<div class="drawer"><div class="drawer-toggle"><div id="untitled_icon" class="drawer-icon interactable"></div></div></div>'
        + '<div id="sb-topbar-extension-slot">'
        + '<div id="extension_control" class="menu_button interactable" title="Extension control"></div>'
        + '<div id="bare_extension_control" class="interactable" title="Bare control"></div>'
        + '<button id="real_button" class="menu_button" title="A real button"></button>'
        + '</div></div>'
        + '<div id="elsewhere" class="interactable" title="Not a top bar control"></div>';
    initAccessibility();

    const read = id => {
        const element = document.getElementById(id);
        return [element.getAttribute('role'), element.getAttribute('aria-label')];
    };
    expect(read('leftNavDrawerIcon')).toEqual(['button', 'Open']);
    // A label that the code set stays.
    expect(read('named_icon')).toEqual(['button', 'Chosen name']);
    // No tooltip, no invented name.
    expect(read('untitled_icon')).toEqual(['button', null]);
    expect(read('extension_control')).toEqual(['button', 'Extension control']);
    expect(read('bare_extension_control')).toEqual(['button', 'Bare control']);
    // A native button keeps its own name: the tooltip is not copied over it.
    expect(read('real_button')[1]).toBeNull();
    expect(read('elsewhere')).toEqual([null, null]);

    const adopted = document.createElement('div');
    adopted.id = 'late_extension_control';
    adopted.className = 'right_menu_button interactable';
    adopted.title = 'Added later';
    document.getElementById('sb-topbar-extension-slot').append(adopted);
    await Promise.resolve();
    expect(read('late_extension_control')).toEqual(['button', 'Added later']);
});
