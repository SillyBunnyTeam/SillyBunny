/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for DOM helpers. */
import { describe, expect, jest, test } from '@jest/globals';

let language = 'first';
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => `${language}:${String.raw({ raw: strings }, ...values)}`,
}));
jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu: jest.fn() }));
const { HOME_DESTINATIONS, getHomeDestination } = await import('../../public/scripts/sillybunny-home/destinations.js');
const { createGettingStartedState } = await import('../../public/scripts/sillybunny-home/getting-started.js');
const { buildHomeMenuSections } = await import('../../public/scripts/sillybunny-home/menu.js');
const { mountTiles } = await import('../../public/scripts/sillybunny-home/tiles-view.js');

function mountedTiles() {
    const panel = document.createElement('div');
    panel.innerHTML = '<section data-sb-home-region="tiles"></section>';
    document.body.append(panel);
    mountTiles(panel, {
        state: createGettingStartedState(['a', 'b']),
        onRowChanged: jest.fn(),
        openGettingStarted: jest.fn(),
        openBundledExtras: jest.fn(),
        openHelp: jest.fn(),
    });
    return [...panel.querySelectorAll('.sbHomeTile')];
}

function menuItems() {
    const sections = buildHomeMenuSections(
        { displayMode: 'full', gettingStartedHidden: true },
        { setDisplayMode: jest.fn(), showGettingStarted: jest.fn(), openHelp: jest.fn() },
    );
    return sections.flatMap(section => section.items);
}

describe('Home destinations', () => {
    test('name the three tiles of Home in the order of the tiles', () => {
        expect(HOME_DESTINATIONS.map(destination => destination.key)).toEqual(['getting-started', 'help', 'extras']);
        expect(mountedTiles().map(tile => tile.dataset.sbHomeKey)).toEqual(HOME_DESTINATIONS.map(destination => destination.key));
    });

    test('give each tile its icon, title and voiced line', () => {
        const tiles = mountedTiles();

        for (const destination of HOME_DESTINATIONS) {
            const tile = tiles.find(candidate => candidate.dataset.sbHomeKey === destination.key);
            expect(tile.querySelector('.sbHomeTileIcon i').className).toBe(`${destination.icon} fa-fw`);
            expect(tile.querySelector('.sbHomeTileTitle').textContent).toBe(destination.getTitle());
            expect(tile.querySelector('.sbHomeTileLine').dataset.sbCopySlot).toBe(destination.lineSlot);
        }
    });

    test('give the Home menu the icon of Getting Started and the icon and title of Help', () => {
        const items = menuItems();

        expect(items.find(item => item.label.endsWith('Show Getting Started')).icon).toBe(getHomeDestination('getting-started').icon);
        const help = items.find(item => item.icon === getHomeDestination('help').icon);
        expect(help.label).toBe(getHomeDestination('help').getTitle());
    });

    test('translate a title when it is asked for, not when the module loads', () => {
        const before = getHomeDestination('help').getTitle();
        language = 'second';

        expect(before).toBe('first:Help');
        expect(getHomeDestination('help').getTitle()).toBe('second:Help');
        language = 'first';
    });

    test('refuse a key that no tile has', () => {
        expect(() => getHomeDestination('about')).toThrow('Unknown Home destination: about');
    });

    test('cannot be changed by a caller', () => {
        expect(Object.isFrozen(HOME_DESTINATIONS)).toBe(true);
        expect(HOME_DESTINATIONS.every(destination => Object.isFrozen(destination))).toBe(true);
    });
});
