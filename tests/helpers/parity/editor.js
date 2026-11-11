/**
 * Editors: single-content and list-content editors share the header, the group anatomy, the field and the action button
 * shapes. The first alternative of the header is the single-content editor's header; the list-content editors have their own,
 * and the windows of the Quick Reply and regex editors use the dialog header. The header, the group heading and the group box
 * are the rules of the header and settings families, because they are the same elements.
 */

import { FORMS } from './dialog.js';
import { BAR } from './header.js';
import { GROUP_BOX, GROUP_HEADING } from './settings.js';

export const rules = {
    family: 'editor',
    forms: FORMS,
    parts: [
        {
            id: 'header',
            selectors: [
                { id: 'editor-header', selector: '.sb-editor-header' },
                { id: 'detail-header', selector: '.sb-wi-detail-header, .sb-persona-detail-header, .sb-prompt-detail-header' },
                { id: 'dialog-header', selector: '.sb-dialog__header' },
            ],
            properties: BAR,
        },
        {
            id: 'group-heading',
            selectors: [{ id: 'ds-heading', selector: '.ds-pref-group-heading' }, { id: 'own', selector: 'h3' }],
            properties: GROUP_HEADING,
        },
        {
            id: 'group-box',
            selectors: [{ id: 'ds-group', selector: '.ds-pref-group' }],
            properties: GROUP_BOX,
        },
        {
            id: 'entry',
            selectors: [
                { id: 'text-pole', selector: 'input.text_pole:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"])' },
                { id: 'own', selector: 'input[type="text"], input:not([type])' },
            ],
            properties: [
                { property: 'offsetHeight', token: '--sb-field-min-height', source: 'DESIGN.md' },
                { property: 'borderTopLeftRadius', token: '--sb-radius-button', source: 'DESIGN.md' },
                { property: 'paddingInlineStart', token: '--sb-field-padding-x', source: 'DESIGN.md' },
            ],
        },
        {
            id: 'save-button',
            selectors: [
                { id: 'editor-action', selector: '.sb-editor-action--primary' },
                { id: 'dialog', selector: '.popup-button-ok, .sb-dialog__affirmative' },
            ],
            properties: [
                { property: 'offsetHeight', token: '--sb-control-min-height', floor: true, source: 'DESIGN.md' },
                { property: 'borderTopLeftRadius', token: '--sb-radius-button', source: 'DESIGN.md' },
            ],
        },
    ],
};
