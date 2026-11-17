/**
 * Settings pages: a bold heading above a boxed list (`AdwPreferencesGroup`), rows of `6px 12px` with a 50px minimum and 6px between
 * their parts, and the
 * shared libadwaita audit (`auditLibadwaita`) that runs on the root as the `libadwaita-audit` part. The value of each audit
 * rule is the number of records that fail it outside the audit's own allow-list; the entries of that list that hide a failing
 * record are in the census.
 *
 * The group heading, the group box and the row title are exported: editors and lists show the same elements.
 */

import { auditLibadwaita, LIBADWAITA_AUDIT_ALLOWLIST } from '../libadwaita-audit.js';
import { FORMS } from './dialog.js';

const AUDIT_RULES = { auditContentInset: 'content-inset', auditRowEdges: 'row-edges', auditRowGeometry: 'row-geometry', auditGroupAnatomy: 'group-anatomy' };

/** Rows that the server tools add when the server answers (`appendServerAdminStat`): which of them exist depends on the server, so they are not measured. */
const NOT_SERVER_STAT = ':not(:has(.sb-server-stat-value))';

/**
 * Rows whose text has a role of its own in DESIGN.md (Boxed lists): a property row names at Caption size, a button row sets its
 * title in the Title role, and an entry row's title is the field's floating label. Their titles are not Body at regular weight.
 */
const OWN_TITLE_ROLE = ':not(.ds-row-property, .ds-button-row, .ds-row-entry--floating)';

/** A property that only means something on a flex or grid container: `normal` on a block says nothing. */
export const IF_FLEX = ['flex', 'inline-flex', 'grid', 'inline-grid'];

/**
 * The group heading: the Title role, which is body size at weight 700 (DESIGN.md Typography), with no case change. The size is
 * read from `--sb-type-body`, because `--sb-type-title` holds another value until the stylesheets take the documents' scale.
 */
export const GROUP_HEADING = [
    { property: 'fontSize', token: '--sb-type-body', source: 'DESIGN.md' },
    { property: 'fontWeight', value: '700', source: 'DESIGN.md' },
    { property: 'textTransform', value: 'none', source: 'DESIGN.json' },
];

/** The description under a group heading: the Caption role at regular weight (DESIGN.md Typography). */
export const GROUP_DESCRIPTION = [
    { property: 'fontSize', token: '--sb-type-caption', source: 'DESIGN.md' },
    { property: 'fontWeight', value: '400', source: 'DESIGN.md' },
];

/**
 * The boxed list of a group: `--sb-radius-lg` on a settings page, the card radius inside a list editor, and no border, because
 * the card style draws its edge as a ring in the Card Shadow (DESIGN.md Elevation).
 */
export const GROUP_BOX = [
    { property: 'borderTopLeftRadius', token: '--sb-radius-lg', forms: [{ form: 'listEditor', token: '--sb-radius-card' }], source: 'DESIGN.json' },
    { property: 'borderTopWidth', value: 0, source: 'DESIGN.md' },
];

/** The title of a row in a boxed list: Body at regular weight (DESIGN.md Typography). */
export const ROW_TITLE = [
    { property: 'fontSize', token: '--sb-type-body', source: 'DESIGN.md' },
    { property: 'fontWeight', value: '400', source: 'DESIGN.md' },
];

/** The subtitle of a row: the Caption role, which shares the size token of Label (DESIGN.md Typography). */
export const ROW_SUBTITLE = [{ property: 'fontSize', token: '--sb-type-caption', source: 'DESIGN.md' }];

export const rules = {
    family: 'settings',
    forms: FORMS,
    audit: {
        part: 'libadwaita-audit',
        evaluate: auditLibadwaita,
        argument: { allowlist: LIBADWAITA_AUDIT_ALLOWLIST },
        explain: (root, { records, allowlist }) => records.map(record => {
            let element = null;
            try {
                element = root.ownerDocument.querySelector(record.selector);
            } catch {
                // A path that the page cannot read leaves the record unattributed.
            }
            return element === null
                ? -1
                : allowlist.findIndex(entry => (entry.rule === '*' || entry.rule === record.rule) && (element.matches(entry.selector) || Boolean(element.closest(entry.selector))));
        }),
        summarise: (records, hiding, explained) => {
            const ruleNames = Object.values(AUDIT_RULES);
            const failing = records.filter(record => !record.pass && !record.allowlisted && ruleNames.includes(record.rule));
            const hidden = new Map();
            hiding.forEach((record, index) => {
                if (ruleNames.includes(record.rule)) {
                    const selector = explained[index] >= 0 ? LIBADWAITA_AUDIT_ALLOWLIST[explained[index]].selector : 'unattributed';
                    hidden.set(`${record.rule}\u0000${selector}`, { rule: record.rule, selector });
                }
            });
            return {
                values: Object.fromEntries(Object.entries(AUDIT_RULES).map(([property, rule]) => [property, failing.filter(record => record.rule === rule).length])),
                hidden: [...hidden.entries()].sort(([left], [right]) => (left < right ? -1 : 1)).map(([, entry]) => entry),
            };
        },
    },
    parts: [
        {
            id: 'group-heading',
            selectors: [
                { id: 'ds-heading', selector: '.ds-pref-group-heading' },
                { id: 'flat-header', selector: '.sb-settings-flat-header :is(h4, b), .sb-settings-category-title' },
                { id: 'own', selector: ':is(.sb-wi-settings h3, .sb-persona-settings h3)' },
            ],
            properties: GROUP_HEADING,
        },
        {
            id: 'group-box',
            selectors: [
                { id: 'ds-group', selector: '.ds-pref-group' },
            ],
            properties: GROUP_BOX,
        },
        {
            id: 'row',
            selectors: [
                { id: 'ds-row', selector: `.ds-row${NOT_SERVER_STAT}` },
            ],
            properties: [
                { property: 'minHeight', value: 50, source: 'DESIGN.md' },
                { property: 'paddingTop', value: 6, source: 'DESIGN.md' },
                { property: 'paddingInlineStart', value: 12, source: 'DESIGN.md' },
                { property: 'columnGap', value: 6, ifDisplay: IF_FLEX, source: 'DESIGN.md' },
            ],
        },
        {
            id: 'group-description',
            selectors: [{ id: 'ds-subtitle', selector: '.ds-pref-group-subtitle' }],
            properties: GROUP_DESCRIPTION,
        },
        {
            id: 'row-title',
            selectors: [{ id: 'ds-row', selector: `.ds-pref-group .ds-row${NOT_SERVER_STAT}${OWN_TITLE_ROLE} .ds-row-label` }],
            properties: ROW_TITLE,
        },
        {
            id: 'row-subtitle',
            selectors: [{ id: 'ds-row', selector: `.ds-pref-group .ds-row${NOT_SERVER_STAT} .ds-row-subtitle` }],
            properties: ROW_SUBTITLE,
        },
        {
            id: 'libadwaita-audit',
            selectors: [{ id: 'libadwaita-audit', selector: ':scope', root: true }],
            properties: Object.keys(AUDIT_RULES).map(property => ({ property, value: 0, source: 'DESIGN.md' })),
        },
    ],
};
