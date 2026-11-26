/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Playwright does not recognize Jest test callbacks. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

const { MENU_LAYER_CLOSED_EVENT, isChildLayerOf, linkChildLayer } = await import('../../public/scripts/sillybunny-editor/overlay-host.js');

afterEach(() => {
    document.body.replaceChildren();
});

/** A menu surface with the control that opens a picker inside it, and the picker's surface elsewhere in the page. */
function build({ parentClass = 'sb-action-popover', parentId = '' } = {}) {
    const parent = document.createElement('div');
    parent.className = parentClass;
    if (parentId) parent.id = parentId;
    const owner = document.createElement('button');
    parent.append(owner);
    const surface = document.createElement('div');
    const inner = document.createElement('input');
    surface.append(inner);
    document.body.append(parent, surface);
    return { parent, owner, surface, inner };
}

describe('linkChildLayer', () => {
    test('marks the surface as a child of the popover that holds its owner, and gives the popover an id when it has none', () => {
        const { parent, owner, surface } = build();

        const unlink = linkChildLayer(surface, owner, () => {});

        expect(typeof unlink).toBe('function');
        expect(parent.id).not.toBe('');
        expect(surface.dataset.sbParentLayer).toBe(parent.id);
    });

    test('keeps the id that the parent has, and takes a sheet for a parent as well', () => {
        const { parent, owner, surface } = build({ parentClass: 'sb-action-sheet', parentId: 'sheet-1' });

        linkChildLayer(surface, owner, () => {});

        expect(parent.id).toBe('sheet-1');
        expect(surface.dataset.sbParentLayer).toBe('sheet-1');
    });

    test('does nothing for an owner that is not in a menu surface, and says so', () => {
        const owner = document.createElement('button');
        const surface = document.createElement('div');
        document.body.append(owner, surface);

        expect(linkChildLayer(surface, owner, () => {})).toBeNull();
        expect(surface.dataset.sbParentLayer).toBeUndefined();
    });

    test('calls back when its parent closes, and not when another surface does', () => {
        const { parent, owner, surface } = build();
        const onParentClosed = jest.fn();
        linkChildLayer(surface, owner, onParentClosed);

        document.dispatchEvent(new CustomEvent(MENU_LAYER_CLOSED_EVENT, { detail: 'another-surface' }));
        expect(onParentClosed).not.toHaveBeenCalled();

        document.dispatchEvent(new CustomEvent(MENU_LAYER_CLOSED_EVENT, { detail: parent.id }));
        expect(onParentClosed).toHaveBeenCalledTimes(1);
    });

    test('stops following its parent once it is unlinked, so a surface that closed first is not closed twice', () => {
        const { parent, owner, surface } = build();
        const onParentClosed = jest.fn();
        const unlink = linkChildLayer(surface, owner, onParentClosed);

        unlink();
        document.dispatchEvent(new CustomEvent(MENU_LAYER_CLOSED_EVENT, { detail: parent.id }));

        expect(onParentClosed).not.toHaveBeenCalled();
    });
});

describe('isChildLayerOf', () => {
    test('is true for the surface and for anything inside it, once the surface is linked to that root', () => {
        const { parent, owner, surface, inner } = build();
        linkChildLayer(surface, owner, () => {});

        expect(isChildLayerOf(parent, surface)).toBe(true);
        expect(isChildLayerOf(parent, inner)).toBe(true);
    });

    test('is false for a surface that is linked to another root, for one that is not linked, and for a root without an id', () => {
        const { parent, owner, surface } = build();
        const other = build({ parentId: 'other-popover' });
        linkChildLayer(surface, owner, () => {});
        const stranger = document.createElement('div');
        document.body.append(stranger);
        const bare = document.createElement('div');

        expect(isChildLayerOf(other.parent, surface)).toBe(false);
        expect(isChildLayerOf(parent, stranger)).toBe(false);
        expect(isChildLayerOf(bare, surface)).toBe(false);
    });

    test('is false for anything that is not an element', () => {
        const { parent } = build();

        expect(isChildLayerOf(parent, null)).toBe(false);
        expect(isChildLayerOf(parent, document)).toBe(false);
    });
});
