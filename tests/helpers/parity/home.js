/**
 * Home windows: Welcome, Getting Started, Help, About, Troubleshooting, Bundled Extras, Keyboard Shortcuts and the assistant
 * picker are dialogs and share their parts with the dialog family. Home itself, the splash screen and the login page are
 * pages: the parts that they do not have are absent, and the title of a page is a Display (DESIGN.md Typography: "Home and
 * first-run welcome titles only").
 */

import { DIALOG_HEADER, FORMS, TARGET_SIZE, TITLE_TYPE } from './dialog.js';

const DIALOGS = '^home\\.(welcome|getting-started|help|about|troubleshooting|bundled-extras|keyboard-shortcuts|assistant-picker)';

export const rules = {
    family: 'home',
    forms: FORMS,
    parts: [
        {
            id: 'frame',
            only: DIALOGS,
            selectors: [{ id: 'dialog', selector: '.sb-dialog' }],
            properties: [
                { property: 'borderTopLeftRadius', token: '--sb-radius-overlay', source: 'DESIGN.md' },
                { property: 'borderTopWidth', value: 1, source: 'DESIGN.md' },
            ],
        },
        {
            id: 'header',
            only: DIALOGS,
            selectors: [{ id: 'dialog', selector: '.sb-dialog__header' }],
            properties: DIALOG_HEADER,
        },
        {
            id: 'title',
            only: DIALOGS,
            selectors: [{ id: 'dialog', selector: '.sb-dialog__title' }],
            properties: TITLE_TYPE,
        },
        {
            id: 'page-title',
            selectors: [{ id: 'home', selector: '.sbHomeTitle' }],
            properties: [
                { property: 'fontSize', token: '--sb-type-display', source: 'DESIGN.md' },
                { property: 'fontWeight', value: '800', source: 'DESIGN.md' },
            ],
        },
        {
            id: 'close-button',
            only: DIALOGS,
            selectors: [{ id: 'dialog', selector: '.sb-dialog__close' }],
            properties: [
                { property: 'offsetWidth', value: TARGET_SIZE, floor: true, source: 'DESIGN.md' },
                { property: 'offsetHeight', value: TARGET_SIZE, floor: true, source: 'DESIGN.md' },
            ],
        },
    ],
};
