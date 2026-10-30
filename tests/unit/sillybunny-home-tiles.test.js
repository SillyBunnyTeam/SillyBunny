/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for DOM helpers. */
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const { createGettingStartedState } = await import('../../public/scripts/sillybunny-home/getting-started.js');
const { mountTiles } = await import('../../public/scripts/sillybunny-home/tiles-view.js');

function renderPanel() {
    const panel = document.createElement('div');
    panel.innerHTML = '<section data-sb-home-region="tiles"></section>';
    document.body.append(panel);
    return panel;
}

function countListeners(state) {
    const counter = { active: 0 };
    const counted = Object.create(state);
    counted.subscribe = (listener) => {
        counter.active++;
        const stop = state.subscribe(listener);
        return () => {
            counter.active--;
            return stop();
        };
    };
    return { counted, counter };
}

function mount(panel, state, openers = {}) {
    mountTiles(panel, { state, onRowChanged: jest.fn(), openGettingStarted: jest.fn(), openBundledExtras: jest.fn(), openHelp: jest.fn(), ...openers });
}

describe('Getting Started tile subscription', () => {
    test('a second mount leaves one listener on the state, and the first panel can be collected', () => {
        const state = createGettingStartedState(['a', 'b']);
        const { counted, counter } = countListeners(state);
        const first = renderPanel();
        const second = renderPanel();

        mount(first, counted);
        expect(counter.active).toBe(1);
        mount(second, counted);

        expect(counter.active).toBe(1);
    });

    test('the listener of the latest mount keeps the tile in step with the state', () => {
        const state = createGettingStartedState(['a', 'b']);
        const first = renderPanel();
        const second = renderPanel();
        mount(first, state);
        mount(second, state);

        state.setHidden(true);

        expect(second.querySelectorAll('.sbHomeTile')).toHaveLength(2);
        expect(second.querySelector('[data-sb-home-key="getting-started"]')).toBeNull();
        expect(first.querySelector('[data-sb-home-key="getting-started"]')).not.toBeNull();
    });
});

describe('the tiles that open windows', () => {
    test.each([
        ['getting-started', 'openGettingStarted'],
        ['help', 'openHelp'],
        ['extras', 'openBundledExtras'],
    ])('the %s tile opens its window once, takes focus first, and is no stub', (key, opener) => {
        const state = createGettingStartedState(['a', 'b']);
        const panel = renderPanel();
        const open = jest.fn(() => { expect(document.activeElement).toBe(tile); });
        mount(panel, state, { [opener]: open });
        const tile = panel.querySelector(`[data-sb-home-key="${key}"]`);

        tile.click();

        expect(open).toHaveBeenCalledTimes(1);
        expect(tile.dataset.sbStub).toBeUndefined();
    });
});
