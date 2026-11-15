/**
 * List views (DESIGN.md Boxed Lists and Rows): a boxed list at the card radius with a 1px border, rows (`.ds-entity-row`, 52px
 * minimum, `6px 12px`) with a title, a one-line description and at most a switch and a menu button. A member that builds its
 * rows from its own classes is reported under `own`; a member whose rows are neither is measured on the `ready` selector that
 * the registry gives for it. A member with no box has no box part: it is absent, not measured on its root.
 */

import { FORMS, TARGET_SIZE } from './dialog.js';
import { IF_FLEX, ROW_SUBTITLE, ROW_TITLE } from './settings.js';

const OWN_ROW = ':is(.sb-prompt-row, .attachmentListItem, .regex-script-label, .qr--set-item, .openai_logit_bias_form, .tag_view_item, .sb-wi-row, .ds-row)';
const OWN_TITLE = ':is(.ds-row-label, .sb-prompt-row-name, .attachmentListItemName, .regex_script_name, [class*="name" i]:not(input, .tag, .tag *))';
const READY_ROWS = '^list\\.(backgrounds|chat-history|sampler-order-|swipe-picker)';

export const rules = {
    family: 'list',
    forms: FORMS,
    parts: [
        {
            id: 'box',
            selectors: [
                { id: 'entity-list', selector: '.ds-entity-list' },
                { id: 'group', selector: '.ds-pref-group' },
            ],
            properties: [
                { property: 'borderTopLeftRadius', token: '--sb-radius-card', source: 'DESIGN.md' },
                { property: 'borderTopWidth', value: 0, source: 'DESIGN.md' },
            ],
        },
        {
            id: 'row',
            selectors: [
                { id: 'entity-row', selector: '.ds-entity-row' },
                { id: 'own', selector: OWN_ROW },
                { id: 'ready', ready: true, only: READY_ROWS },
            ],
            properties: [
                { property: 'minHeight', value: 52, source: 'DESIGN.json' },
                { property: 'paddingTop', value: 6, source: 'DESIGN.md' },
                { property: 'paddingInlineStart', value: 12, source: 'DESIGN.md' },
                { property: 'columnGap', value: 10, ifDisplay: IF_FLEX, source: 'census' },
                { property: 'alignItems', value: 'center', ifDisplay: IF_FLEX, source: 'census' },
            ],
        },
        {
            id: 'row-title',
            selectors: [{ id: 'entity-row', selector: '.ds-entity-row__title' }, { id: 'own', selector: OWN_TITLE }],
            properties: ROW_TITLE,
        },
        {
            id: 'row-subtitle',
            selectors: [{ id: 'entity-row', selector: '.ds-entity-row__subtitle' }, { id: 'own', selector: ':is(.ds-row-subtitle, [class*="subtitle" i])' }],
            properties: ROW_SUBTITLE,
        },
        {
            id: 'row-button',
            filter: 'icon-only',
            selectors: [
                { id: 'entity-row', selector: '.ds-entity-row__button' },
                { id: 'own', selector: ':is(button.menu_button, .menu_button.interactable):not(.sb-prompt-grip)' },
            ],
            properties: [
                { property: 'offsetWidth', value: { coarse: TARGET_SIZE.coarse }, floor: true, alts: ['entity-row'], source: 'DESIGN.md' },
                { property: 'offsetHeight', value: { coarse: TARGET_SIZE.coarse }, floor: true, source: 'DESIGN.md' },
            ],
        },
    ],
};
