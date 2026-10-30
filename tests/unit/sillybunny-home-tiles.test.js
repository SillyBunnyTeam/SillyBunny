/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for DOM helpers. */
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const { createGettingStartedState } = await import('../../public/scripts/sillybunny-home/getting-started.js');
const { describeTiles, mountTiles } = await import('../../public/scripts/sillybunny-home/tiles-view.js');

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

describe('the voiced line of a tile', () => {
    test('every tile has one in its own copy slot, in the region that Compact hides', () => {
        const panel = renderPanel();
        mount(panel, createGettingStartedState(['a', 'b']));

        const lines = [...panel.querySelectorAll('.sbHomeTile')].map(tile => tile.querySelector('.sbHomeTileLine'));

        expect(lines.map(line => line.dataset.sbCopySlot)).toEqual(['HOME-ROW-GS-LINE', 'HOME-ROW-HELP', 'HOME-ROW-EXTRAS']);
        expect(lines.map(line => line.dataset.sbCopyPlaceholder)).toEqual(['true', 'true', 'true']);
        expect(lines.map(line => line.dataset.sbHomeRegion)).toEqual(['tile-lines', 'tile-lines', 'tile-lines']);
        expect(lines.map(line => line.textContent)).toEqual(['TODO(copy)', 'TODO(copy)', 'TODO(copy)']);
    });

    test('only Getting Started has a progress, and the progress is not a placeholder', () => {
        const state = createGettingStartedState(['a', 'b']);
        const panel = renderPanel();
        mount(panel, state);

        const progress = [...panel.querySelectorAll('.sbHomeTile')].map(tile => tile.querySelector('.sbHomeTileSub'));
        expect(progress.map(node => node?.textContent ?? null)).toEqual(['0 of 2', null, null]);
        expect(progress[0].dataset.sbCopyPlaceholder).toBeUndefined();

        state.setSkipped('a', true);
        expect(panel.querySelector('[data-sb-home-key="getting-started"] .sbHomeTileSub').textContent).toBe('1 of 2');
    });

    test('a Getting Started tile that comes back has its line and its progress again', () => {
        const state = createGettingStartedState(['a', 'b']);
        const panel = renderPanel();
        mount(panel, state);
        state.setHidden(true);

        state.setHidden(false);

        const tile = panel.querySelector('[data-sb-home-key="getting-started"]');
        expect(tile.querySelector('.sbHomeTileLine').dataset.sbCopySlot).toBe('HOME-ROW-GS-LINE');
        expect(tile.querySelector('.sbHomeTileSub').textContent).toBe('0 of 2');
    });
});

describe('the name and the description of a tile', () => {
    const textOf = (panel, ids) => ids.split(' ').map(id => panel.querySelector(`[id="${id}"]`).textContent).join(' ');

    test('the title names the tile, and the voiced line and the progress describe it', () => {
        const panel = renderPanel();
        mount(panel, createGettingStartedState(['a', 'b']));
        const started = panel.querySelector('[data-sb-home-key="getting-started"]');
        const help = panel.querySelector('[data-sb-home-key="help"]');

        expect(textOf(panel, started.getAttribute('aria-labelledby'))).toBe('Getting Started');
        expect(textOf(panel, started.getAttribute('aria-describedby'))).toBe('TODO(copy) 0 of 2');
        expect(textOf(panel, help.getAttribute('aria-labelledby'))).toBe('Help');
        expect(textOf(panel, help.getAttribute('aria-describedby'))).toBe('TODO(copy)');
    });

    test('a hidden line leaves the description, and the tile without a progress has none left', () => {
        const panel = renderPanel();
        mount(panel, createGettingStartedState(['a', 'b']));
        panel.querySelectorAll('.sbHomeTileLine').forEach((line) => { line.hidden = true; });

        describeTiles(panel);

        expect(panel.querySelector('[data-sb-home-key="getting-started"]').getAttribute('aria-describedby')).toBe('sb-home-tile-getting-started-progress');
        expect(panel.querySelector('[data-sb-home-key="help"]').hasAttribute('aria-describedby')).toBe(false);
        expect(panel.querySelector('[data-sb-home-key="extras"]').hasAttribute('aria-describedby')).toBe(false);
    });

    test('the ids are the same when the tile is made again', () => {
        const state = createGettingStartedState(['a', 'b']);
        const panel = renderPanel();
        mount(panel, state);
        const first = panel.querySelector('[data-sb-home-key="getting-started"]').getAttribute('aria-describedby');
        state.setHidden(true);

        state.setHidden(false);

        expect(panel.querySelector('[data-sb-home-key="getting-started"]').getAttribute('aria-describedby')).toBe(first);
    });
});
