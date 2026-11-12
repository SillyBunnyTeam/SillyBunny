/**
 * Menus, pickers and popovers (DESIGN.md Menus and Popovers): an opaque popover surface at the overlay radius, with a ring in
 * its shadow for an edge and no border, `6px` of padding for a menu list and `8px` for any other popover, and rows of at least
 * 32px (44px on a coarse pointer and in sheets) with `0 12px` padding and the control radius. The first alternative of the item
 * is the action menu row; pickers, the prompt editor popovers, the side panel menu, upstream menus and the two menus that still
 * use `div` items have their own. The press-label tooltip has its own rule (Tooltips) and is not a menu surface here.
 */

import { FORMS, SHEET_HANDLE } from './dialog.js';
import { IF_FLEX } from './settings.js';

export const rules = {
    family: 'menu',
    forms: FORMS,
    parts: [
        {
            id: 'surface',
            only: '^menu\\.(?!tooltip\\.)',
            selectors: [
                { id: 'popover', selector: '.sb-action-popover, .sb-action-sheet, .sb-picker, .sb-picker-sheet, .sb-custom-popover, .sb-prompt-popover, .sb-side-panel__menu' },
                { id: 'own', selector: '#options, #extensionsMenu, .actionButtonsModal, .ctx-menu, .autoComplete-wrap, .ui-autocomplete' },
            ],
            properties: [
                { property: 'borderTopLeftRadius', token: '--sb-radius-overlay', source: 'DESIGN.md' },
                { property: 'borderTopWidth', value: 0, source: 'DESIGN.md' },
                { property: 'paddingTop', value: 6, forms: [{ form: 'plainPopover', value: 8 }], source: 'DESIGN.md' },
            ],
        },
        {
            id: 'item',
            selectors: [
                { id: 'action-menu', selector: '.sb-action-menu-item' },
                { id: 'picker', selector: '.sb-picker__option' },
                { id: 'prompt-popover', selector: '.sb-prompt-option' },
                { id: 'side-panel', selector: '.sb-side-panel__menu-item' },
                { id: 'legacy-list', selector: '.list-group-item, .actionButton' },
                { id: 'own', selector: ':is(a, li, button, [role="menuitem"], [role="option"]):not(.sb-picker__search)' },
            ],
            properties: [
                { property: 'offsetHeight', value: { fine: 32, coarse: 44 }, floor: true, forms: [{ form: 'sheet', value: 44 }], source: 'DESIGN.md' },
                { property: 'paddingInlineStart', value: 12, source: 'DESIGN.md' },
                { property: 'borderTopLeftRadius', token: '--sb-radius-control', source: 'DESIGN.md' },
                { property: 'columnGap', value: 6, ifDisplay: IF_FLEX, source: 'census' },
            ],
        },
        {
            id: 'item-label',
            selectors: [
                { id: 'action-menu', selector: '.sb-action-menu-label' },
                { id: 'picker', selector: '.sb-picker__label' },
            ],
            properties: [{ property: 'fontSize', token: '--sb-type-body', source: 'census' }],
        },
        SHEET_HANDLE,
    ],
};
