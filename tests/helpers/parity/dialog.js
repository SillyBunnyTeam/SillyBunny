/**
 * Dialogs by tier (DESIGN.md Dialogs): an Alert (18px radius, a centred heading, responses stacked full width at 44px in a
 * sheet), a Dialog and a Window (15px radius, a header bar with the title and the responses, and one body). A part with
 * `only` belongs to the surfaces of one tier. A frame that is not the shared `.sb-dialog` (the legacy `#dialogue_popup`, the
 * cropper) is a `dialog.popup` and is reported as `own`; a part that a dialog does not have is absent.
 *
 * This file owns the pieces that other families measure on the same elements (the forms of a surface, the dialog header, the
 * title type, the sheet handle, the target size), so that an element has one canonical value.
 */

/**
 * The forms that DESIGN.md states a rule for. Each is read in the page, for the instance that is measured.
 * - `sheet`: the overlay breakpoint, under which overlays are bottom sheets (DESIGN.md Layout).
 * - `listEditor`: inside a list editor, where a group takes the card radius (DESIGN.json, Preferences Group).
 * - `panelSheet`: a side panel that is presented as a sheet (DESIGN.md Side Panels: "A panel sheet follows the Dialog surface").
 */
export const FORMS = Object.freeze({
    sheet: { media: '(max-width: 450px), (max-height: 360px)' },
    listEditor: { closest: '.sb-list-editor, .sb-editor-sheet' },
    panelSheet: { closest: '.sb-side-panel--sheet' },
});

/** A target size: 44px on a coarse pointer, and 40px on a fine one for shell controls and close buttons (DESIGN.md Layout). */
export const TARGET_SIZE = Object.freeze({ fine: 40, coarse: 44 });

/** The header bar of a dialog, window or sheet: at least as tall as the buttons it holds, with 6px of inline padding. */
export const DIALOG_HEADER = [
    { property: 'offsetHeight', value: TARGET_SIZE, floor: true, source: 'DESIGN.md' },
    { property: 'paddingInlineStart', value: 6, source: 'census' },
];

/** The type of a title in a header (DESIGN.md Typography: Title, `--sb-type-title`, 700). */
export const TITLE_TYPE = [
    { property: 'fontSize', token: '--sb-type-title', source: 'DESIGN.md' },
    { property: 'fontWeight', value: '700', source: 'DESIGN.md' },
];

export const SHEET_HANDLE = {
    id: 'sheet-handle',
    selectors: [{ id: 'shared', selector: '.sb-dialog__handle' }],
    properties: [
        { property: 'offsetWidth', value: 80, source: 'census' },
        { property: 'offsetHeight', value: 20, source: 'census' },
    ],
};

const OWN_FRAME = { id: 'own', selector: 'dialog.popup' };

export const rules = {
    family: 'dialog',
    forms: FORMS,
    parts: [
        {
            id: 'frame-alert',
            only: '^dialog\\.alert\\.',
            selectors: [{ id: 'shared', selector: '.sb-dialog--alert' }, OWN_FRAME],
            properties: [
                { property: 'borderTopLeftRadius', token: '--sb-radius-alert', forms: [{ form: 'sheet', token: '--sb-radius-overlay' }], source: 'DESIGN.md' },
                { property: 'borderTopWidth', value: 1, source: 'DESIGN.md' },
            ],
        },
        {
            id: 'frame-overlay',
            only: '^dialog\\.(dialog|window)\\.',
            selectors: [{ id: 'shared', selector: '.sb-dialog--dialog, .sb-dialog--window' }, OWN_FRAME],
            properties: [
                { property: 'borderTopLeftRadius', token: '--sb-radius-overlay', source: 'DESIGN.md' },
                { property: 'borderTopWidth', value: 1, source: 'DESIGN.md' },
            ],
        },
        {
            id: 'heading',
            only: '^dialog\\.alert\\.',
            selectors: [{ id: 'shared', selector: '.sb-dialog__heading' }],
            properties: [
                { property: 'fontSize', token: '--sb-type-headline', source: 'census' },
                { property: 'fontWeight', value: '800', source: 'census' },
                { property: 'textAlign', value: 'center', source: 'DESIGN.md' },
            ],
        },
        {
            id: 'header',
            only: '^dialog\\.(dialog|window)\\.',
            selectors: [{ id: 'shared', selector: '.sb-dialog__header' }],
            properties: DIALOG_HEADER,
        },
        {
            id: 'title',
            only: '^dialog\\.(dialog|window)\\.',
            selectors: [{ id: 'shared', selector: '.sb-dialog__title' }],
            properties: [
                ...TITLE_TYPE,
                { property: 'textAlign', value: 'center', source: 'census' },
            ],
        },
        {
            id: 'response-alert',
            only: '^dialog\\.alert\\.',
            selectors: [{ id: 'response', selector: '.sb-dialog__response, .popup-controls .menu_button, #dialogue_popup_controls .menu_button' }],
            properties: [
                { property: 'offsetHeight', forms: [{ form: 'sheet', value: 44 }], source: 'DESIGN.md' },
                { property: 'borderTopLeftRadius', token: '--sb-radius-button', source: 'DESIGN.md' },
            ],
        },
        {
            id: 'response-header',
            only: '^dialog\\.(dialog|window)\\.',
            selectors: [{ id: 'response', selector: '.sb-dialog__response, .popup-controls .menu_button' }],
            properties: [{ property: 'offsetHeight', token: '--sb-control-min-height', floor: true, source: 'DESIGN.md' }],
        },
        {
            id: 'response-row-alert',
            only: '^dialog\\.alert\\.',
            selectors: [{ id: 'popup', selector: '.popup-controls' }, { id: 'legacy', selector: '#dialogue_popup_controls' }],
            properties: [{ property: 'flexDirection', forms: [{ form: 'sheet', value: 'column-reverse' }], source: 'DESIGN.md' }],
        },
        SHEET_HANDLE,
    ],
};
