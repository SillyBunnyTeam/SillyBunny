/** @jest-environment jsdom */
import { describe, test, expect, beforeEach } from '@jest/globals';
import { adoptStrayExtensionDrawers, watchStrayExtensionDrawers } from '../../public/scripts/sillybunny-settings-stray-drawers.js';

const drawer = id => `<div id="${id}" class="inline-drawer"><div class="inline-drawer-toggle"><b>${id}</b></div><div class="inline-drawer-content">body</div></div>`;

const column = () => document.getElementById('column');
const destination = () => document.getElementById('extensions_settings2');
const idsIn = element => Array.from(element.children).map(child => child.id);

beforeEach(() => {
    document.body.innerHTML = `
        <div id="column"><div id="UI-Customization">${drawer('authored')}</div></div>
        <div id="extensions_settings2"></div>`;
});

describe('adoptStrayExtensionDrawers', () => {
    test('moves the drawers appended to the column, in order, and leaves the authored ones', () => {
        column().insertAdjacentHTML('beforeend', drawer('first') + drawer('second'));

        expect(adoptStrayExtensionDrawers(column(), destination())).toBe(2);

        expect(idsIn(destination())).toEqual(['first', 'second']);
        expect(idsIn(column())).toEqual(['UI-Customization']);
        expect(document.getElementById('authored').parentElement.id).toBe('UI-Customization');
    });

    test('moves the node itself, so a reference held by the extension still points at it', () => {
        column().insertAdjacentHTML('beforeend', drawer('held'));
        const held = document.getElementById('held');

        adoptStrayExtensionDrawers(column(), destination());

        expect(document.getElementById('held')).toBe(held);
    });

    test('moves nothing that is not a drawer', () => {
        column().insertAdjacentHTML('beforeend', '<div id="note">not a drawer</div>');

        expect(adoptStrayExtensionDrawers(column(), destination())).toBe(0);
        expect(idsIn(column())).toEqual(['UI-Customization', 'note']);
    });

    test('keeps the drawers where they are while the destination is missing', () => {
        column().insertAdjacentHTML('beforeend', drawer('early'));

        expect(adoptStrayExtensionDrawers(column(), null)).toBe(0);
        expect(idsIn(column())).toEqual(['UI-Customization', 'early']);
    });
});

describe('watchStrayExtensionDrawers', () => {
    test('adopts the drawers that are there and every one appended later', async () => {
        column().insertAdjacentHTML('beforeend', drawer('before'));
        const observer = watchStrayExtensionDrawers(column(), destination);
        expect(idsIn(destination())).toEqual(['before']);

        column().insertAdjacentHTML('beforeend', drawer('after'));
        await Promise.resolve();

        expect(idsIn(destination())).toEqual(['before', 'after']);
        observer.disconnect();
    });

    test('has nothing to watch without a column', () => {
        expect(watchStrayExtensionDrawers(null, destination)).toBeNull();
    });
});
