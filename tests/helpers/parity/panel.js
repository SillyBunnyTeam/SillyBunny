/**
 * Side panels and sheets (DESIGN.md Side Panels): a docked panel is the Window layer with a 1px border and square corners; a
 * panel presented as a sheet follows the Dialog surface (a grab handle, the overlay radius on top). The Moving-UI windows and
 * the companion panel are upstream or extension markup that DESIGN.md gives no rule for, so they are not measured.
 */

import { DIALOG_HEADER, FORMS, SHEET_HANDLE, TARGET_SIZE, TITLE_TYPE } from './dialog.js';

const SKIP_REASON = 'upstream or extension window that DESIGN.md has no rule for';

export const rules = {
    family: 'panel',
    forms: FORMS,
    skip: {
        'panel.moving.zoomed-avatar': SKIP_REASON,
        'panel.moving.gallery': SKIP_REASON,
        'panel.moving.expression-holder': SKIP_REASON,
        'panel.moving.visual-novel': SKIP_REASON,
        'panel.moving.summary-popout': SKIP_REASON,
        'panel.moving.quick-reply-popout': SKIP_REASON,
        'panel.moving.group-members-popout': SKIP_REASON,
        'panel.companion.panel': SKIP_REASON,
    },
    parts: [
        {
            id: 'frame-docked',
            only: '^panel\\.side\\.',
            selectors: [{ id: 'side-panel', selector: '.sb-side-panel' }],
            properties: [
                { property: 'borderTopLeftRadius', value: 0, forms: [{ form: 'panelSheet', token: '--sb-radius-overlay' }], source: 'DESIGN.md' },
                { property: 'borderTopWidth', value: 1, source: 'DESIGN.md' },
            ],
        },
        {
            id: 'frame-sheet',
            only: '^panel\\.sheet\\.',
            selectors: [{ id: 'dialog', selector: '.sb-dialog' }],
            properties: [
                { property: 'borderTopLeftRadius', token: '--sb-radius-overlay', source: 'DESIGN.md' },
                { property: 'borderTopWidth', value: 1, source: 'DESIGN.md' },
            ],
        },
        {
            id: 'header',
            selectors: [
                { id: 'dialog-header', selector: '.sb-dialog__header' },
                { id: 'own', selector: '.sb-conversation-settings-header' },
            ],
            properties: DIALOG_HEADER,
        },
        {
            id: 'title',
            selectors: [
                { id: 'dialog', selector: '.sb-dialog__title' },
                { id: 'own', selector: '.sb-conversation-settings-header :is(h1, h2, h3)' },
            ],
            properties: TITLE_TYPE,
        },
        {
            id: 'header-button',
            filter: 'icon-only',
            selectors: [
                { id: 'dialog', selector: '.sb-dialog__icon-button' },
                { id: 'own', selector: '.sb-conversation-settings-header button' },
            ],
            properties: [
                { property: 'offsetWidth', value: TARGET_SIZE, floor: true, alts: ['dialog'], source: 'DESIGN.md' },
                { property: 'offsetHeight', value: TARGET_SIZE, floor: true, source: 'DESIGN.md' },
            ],
        },
        SHEET_HANDLE,
    ],
};
