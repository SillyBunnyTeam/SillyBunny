/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for DOM helpers. */
import { describe, expect, jest, test } from '@jest/globals';
import { HOME_COPY } from '../helpers/copy-home.js';

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
    return mountTiles(panel, { state, onRowChanged: jest.fn(), openGettingStarted: jest.fn(), openBundledExtras: jest.fn(), openHelp: jest.fn(), ...openers });
}

describe('Getting Started tile subscription', () => {
    test('a mount holds one listener on the state, and the stop it returns takes it off', () => {
        const state = createGettingStartedState(['a', 'b']);
        const { counted, counter } = countListeners(state);

        const stop = mount(renderPanel(), counted);
        expect(counter.active).toBe(1);
        stop();

        expect(counter.active).toBe(0);
    });

    test('a stopped panel no longer follows the state, and the panel that is still mounted does', () => {
        const state = createGettingStartedState(['a', 'b']);
        const first = renderPanel();
        const second = renderPanel();
        const stopFirst = mount(first, state);
        mount(second, state);
        stopFirst();

        state.setHidden(true);

        expect(second.querySelectorAll('.sbHomeTile')).toHaveLength(2);
        expect(second.querySelector('[data-sb-home-key="getting-started"]')).toBeNull();
        expect(first.querySelector('[data-sb-home-key="getting-started"]')).not.toBeNull();
    });

    test('a mount does not take the listener of another panel off, because the caller owns each stop', () => {
        const state = createGettingStartedState(['a', 'b']);
        const { counted, counter } = countListeners(state);

        mount(renderPanel(), counted);
        mount(renderPanel(), counted);

        expect(counter.active).toBe(2);
    });

    test('a panel with no tile row holds no listener and returns a stop that does nothing', () => {
        const state = createGettingStartedState(['a', 'b']);
        const { counted, counter } = countListeners(state);

        const stop = mount(document.createElement('div'), counted);

        expect(counter.active).toBe(0);
        expect(() => stop()).not.toThrow();
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
    test('every tile has its written line, in the region that Compact hides', () => {
        const panel = renderPanel();
        mount(panel, createGettingStartedState(['a', 'b']));

        const lines = [...panel.querySelectorAll('.sbHomeTile')].map(tile => tile.querySelector('.sbHomeTileLine'));

        expect(lines.map(line => line.textContent)).toEqual([HOME_COPY.tileGettingStarted, HOME_COPY.tileHelp, HOME_COPY.tileExtras]);
        expect(lines.map(line => line.hasAttribute('data-sb-copy-placeholder'))).toEqual([false, false, false]);
        expect(lines.map(line => line.dataset.sbHomeRegion)).toEqual(['tile-lines', 'tile-lines', 'tile-lines']);
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
        expect(tile.querySelector('.sbHomeTileLine').textContent).toBe(HOME_COPY.tileGettingStarted);
        expect(tile.querySelector('.sbHomeTileSub').textContent).toBe('0 of 2');
    });
});

describe('the Getting Started tile once every step is resolved', () => {
    const IDS = ['a', 'b'];
    const tileOf = panel => panel.querySelector('[data-sb-home-key="getting-started"]');
    const glyphOf = panel => tileOf(panel).querySelector('.sbHomeTileIcon > i');
    const lineOf = panel => tileOf(panel).querySelector('.sbHomeTileLine');
    const finish = state => IDS.forEach(id => state.markDone(id));

    test('stays on Home with the check, the finished line and its progress', () => {
        const state = createGettingStartedState(IDS);
        const panel = renderPanel();
        mount(panel, state);
        expect(glyphOf(panel).classList.contains('fa-list-check')).toBe(true);

        finish(state);

        expect(tileOf(panel)).not.toBeNull();
        expect(glyphOf(panel).classList.contains('fa-circle-check')).toBe(true);
        expect(glyphOf(panel).classList.contains('fa-list-check')).toBe(false);
        expect(glyphOf(panel).getAttribute('aria-hidden')).toBe('true');
        expect(tileOf(panel).hasAttribute('data-sb-getting-started-finished')).toBe(true);
        expect(lineOf(panel).textContent).toBe(HOME_COPY.tileGettingStartedDone);
        expect(lineOf(panel).hasAttribute('data-sb-copy-placeholder')).toBe(false);
        expect(tileOf(panel).querySelector('.sbHomeTileSub').textContent).toBe('2 of 2');
    });

    test('is the one that opens Getting Started, and the other tiles keep their icons and lines', () => {
        const state = createGettingStartedState(IDS);
        const open = jest.fn();
        const panel = renderPanel();
        mount(panel, state, { openGettingStarted: open });

        finish(state);
        tileOf(panel).click();

        expect(open).toHaveBeenCalledTimes(1);
        expect(panel.querySelector('[data-sb-home-key="help"] .sbHomeTileLine').textContent).toBe(HOME_COPY.tileHelp);
        expect(panel.querySelector('[data-sb-home-key="help"] .sbHomeTileIcon > i').classList.contains('fa-circle-question')).toBe(true);
        expect(panel.querySelector('[data-sb-home-key="help"]').hasAttribute('data-sb-getting-started-finished')).toBe(false);
    });

    test('starts finished when the stored value is finished and shown', () => {
        const state = createGettingStartedState(IDS, { snapshot: { hidden: false, hiddenBy: null, steps: { a: 'done', b: 'skipped' }, characterVariant: null } });
        const panel = renderPanel();

        mount(panel, state);

        expect(glyphOf(panel).classList.contains('fa-circle-check')).toBe(true);
        expect(lineOf(panel).textContent).toBe(HOME_COPY.tileGettingStartedDone);
    });

    test('goes back to the checklist look when a step is un-skipped', () => {
        const state = createGettingStartedState(IDS);
        const panel = renderPanel();
        mount(panel, state);
        state.markDone('a');
        state.setSkipped('b', true);
        expect(lineOf(panel).textContent).toBe(HOME_COPY.tileGettingStartedDone);

        state.setSkipped('b', false);

        expect(glyphOf(panel).classList.contains('fa-list-check')).toBe(true);
        expect(lineOf(panel).textContent).toBe(HOME_COPY.tileGettingStarted);
        expect(tileOf(panel).hasAttribute('data-sb-getting-started-finished')).toBe(false);
        expect(tileOf(panel).querySelector('.sbHomeTileSub').textContent).toBe('1 of 2');
    });

    test('Hide Getting Started removes the tile, and Show Getting Started brings the finished tile back', () => {
        const state = createGettingStartedState(IDS);
        const panel = renderPanel();
        mount(panel, state);
        finish(state);

        state.hideFinished();
        expect(tileOf(panel)).toBeNull();
        expect(panel.querySelectorAll('.sbHomeTile')).toHaveLength(2);
        state.setHidden(false);

        expect(glyphOf(panel).classList.contains('fa-circle-check')).toBe(true);
        expect(lineOf(panel).textContent).toBe(HOME_COPY.tileGettingStartedDone);
        expect(panel.querySelector('[data-sb-home-region="tiles"]').firstElementChild).toBe(tileOf(panel));
    });

    test('the description follows the finished line while it shows, and the progress alone when Compact hides it', () => {
        const state = createGettingStartedState(IDS);
        const panel = renderPanel();
        mount(panel, state);
        finish(state);
        const textOf = ids => ids.split(' ').map(id => panel.querySelector(`[id="${id}"]`).textContent).join(' ');

        expect(textOf(tileOf(panel).getAttribute('aria-describedby'))).toBe(`${HOME_COPY.tileGettingStartedDone} 2 of 2`);
        panel.querySelectorAll('.sbHomeTileLine').forEach((line) => { line.hidden = true; });
        describeTiles(panel);

        expect(tileOf(panel).getAttribute('aria-describedby')).toBe('sb-home-tile-getting-started-progress');
        expect(textOf(tileOf(panel).getAttribute('aria-labelledby'))).toBe('Getting Started');
    });

    test('a finished change keeps the hidden line of Compact hidden, and out of the description', () => {
        const state = createGettingStartedState(IDS);
        const panel = renderPanel();
        mount(panel, state);
        panel.querySelectorAll('.sbHomeTileLine').forEach((line) => { line.hidden = true; });
        describeTiles(panel);

        finish(state);

        expect(lineOf(panel).hidden).toBe(true);
        expect(tileOf(panel).getAttribute('aria-describedby')).toBe('sb-home-tile-getting-started-progress');
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
        expect(textOf(panel, started.getAttribute('aria-describedby'))).toBe(`${HOME_COPY.tileGettingStarted} 0 of 2`);
        expect(textOf(panel, help.getAttribute('aria-labelledby'))).toBe('Help');
        expect(textOf(panel, help.getAttribute('aria-describedby'))).toBe(HOME_COPY.tileHelp);
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
