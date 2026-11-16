/**
 * Header bars: the top bar, the headers of settings pages, editors, lists, dialogs, side panels and sheets. Several
 * components build a header today, and the census reports which markup each member uses. The height of a bar is not a rule
 * here: a title that wraps makes it taller. The dialog header's height is a floor (see `dialog.js`).
 *
 * The root of a header surface is the bar itself, so the `bar` part is the root. Shell and top bar titles are Headline
 * (DESIGN.md Typography); every other title is a Title.
 */

import { DIALOG_HEADER, FORMS, TARGET_SIZE, TITLE_TYPE } from './dialog.js';
import { IF_FLEX } from './settings.js';

/** What every header bar shares: the inline padding, and the gap and alignment of its flex row. Editors import it. */
export const BAR = [
    DIALOG_HEADER.find(property => property.property === 'paddingInlineStart'),
    { property: 'columnGap', value: 6, ifDisplay: IF_FLEX, source: 'census' },
    { property: 'alignItems', value: 'center', ifDisplay: IF_FLEX, source: 'census' },
];

export const SHELL_TITLE = '#sb-topbar-title, .sb-brand-title, .sb-settings-title, #sb-settings-sidebar-title';

/** A class that holds "title" also holds it in "subtitle" and "titles" (the wrapper of a title and its subtitle), which are not titles. */
const OWN_TITLE = `:scope :is(h1, h2, h3, input[class*="title" i], input[class*="name" i], [class*="title" i]:not([class*="subtitle" i]):not([class*="titles" i]):not([class*="button" i]), [class*="name" i]:not(button)):not(:is(${SHELL_TITLE}))`;
const OWN_BUTTON = ':scope :is(button, [role="button"]):not(.sb-editor-action):not(.sb-dialog__response)';

export const rules = {
    family: 'header',
    forms: FORMS,
    skip: {},
    parts: [
        {
            id: 'bar',
            selectors: [{ id: 'bar', selector: ':scope', root: true }],
            properties: BAR,
        },
        {
            id: 'title',
            selectors: [
                { id: 'dialog', selector: '.sb-dialog__title' },
                { id: 'list', selector: '.sb-list-header__title' },
                { id: 'own', selector: OWN_TITLE },
            ],
            properties: TITLE_TYPE,
        },
        {
            id: 'shell-title',
            selectors: [{ id: 'shell', selector: SHELL_TITLE }],
            properties: TITLE_TYPE,
        },
        {
            id: 'button',
            filter: 'icon-only',
            selectors: [
                { id: 'shared', selector: '.sb-header-icon-button' },
                { id: 'dialog', selector: '.sb-dialog__icon-button, .sb-dialog__close' },
                { id: 'own', selector: OWN_BUTTON },
            ],
            properties: [
                { property: 'offsetWidth', value: TARGET_SIZE, floor: true, alts: ['shared', 'dialog'], source: 'DESIGN.md' },
                { property: 'offsetHeight', value: TARGET_SIZE, floor: true, source: 'DESIGN.md' },
            ],
        },
    ],
};
