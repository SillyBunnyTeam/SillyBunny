/**
 * Status pages and empty states (`AdwStatusPage`, DESIGN.md Banners, Status Pages, and Progress): an icon, a heading that names
 * the state, a line of guidance and an action. The shared component is `createStatusPage` (`.sb-status-page`); a member that
 * draws its own empty state uses its own classes for the same roles, which the `own` alternatives find by shape. A role that a
 * member does not have is absent.
 */

const NOT_IN_ACTION = ':not(:is(button, a, .menu_button) *)';

/** The registry title of a status surface ends with `[status page: shared | adapted | own | none]`. */
const STYLE_OF = /\[status page: (shared|adapted|own|none)/;

/**
 * The default set is for a full view: a 128px icon and the title in the Display role. The compact set, for a sidebar, a popover
 * or a pane, is the canonical value of every part (DESIGN.md Status pages, Metrics).
 */
const FORMS = Object.freeze({
    defaultSet: { closest: '.sb-status-page:not(.sb-status-page--compact)' },
});

export const rules = {
    family: 'status',
    forms: FORMS,
    groupOf: surface => (STYLE_OF.exec(surface.title)?.[1] === 'shared' ? 'shared' : 'own'),
    groupLabels: { shared: 'Members that use the shared status page', own: 'Members with their own markup (own, adapted or none)' },
    parts: [
        {
            id: 'page',
            selectors: [{ id: 'shared', selector: '.sb-status-page' }],
            properties: [
                { property: 'paddingInlineStart', value: 12, source: 'DESIGN.md' },
                { property: 'alignItems', value: 'center', ifDisplay: ['flex', 'inline-flex'], source: 'census' },
                { property: 'textAlign', value: 'center', source: 'census' },
            ],
        },
        {
            id: 'icon',
            selectors: [
                { id: 'shared', selector: '.sb-status-page__icon' },
                { id: 'own', selector: `:scope i.fa-solid${NOT_IN_ACTION}` },
                { id: 'svg', selector: `:scope svg${NOT_IN_ACTION}` },
                // The loading form shows the shared spinner in its place, at 64px.
                { id: 'spinner', selector: '.sb-spinner', agrees: true },
            ],
            properties: [
                { property: 'fontSize', value: 96, forms: [{ form: 'defaultSet', value: 128 }], alts: ['shared', 'own'], source: 'census' },
                { property: 'offsetWidth', value: 64, alts: ['spinner'], source: 'DESIGN.md' },
            ],
        },
        {
            id: 'title',
            selectors: [
                { id: 'shared', selector: '.sb-status-page__title' },
                // A class that holds "title" also holds it in "subtitle", which is the description's role.
                { id: 'own', selector: `:scope :is(h1, h2, h3, h4, [class*="title" i]:not([class*="subtitle" i]))${NOT_IN_ACTION}` },
            ],
            properties: [
                { property: 'fontSize', token: '--sb-type-headline', forms: [{ form: 'defaultSet', token: '--sb-type-display' }], source: 'DESIGN.md' },
                { property: 'fontWeight', value: '800', source: 'DESIGN.md' },
            ],
        },
        {
            id: 'description',
            selectors: [
                { id: 'shared', selector: '.sb-status-page__description' },
                { id: 'own', selector: ':scope > :is(span, p, small):not(.sb-spinner), :scope [class*="description" i]' },
            ],
            properties: [
                { property: 'fontSize', token: '--sb-type-body', source: 'DESIGN.md' },
                { property: 'textAlign', value: 'center', source: 'census' },
            ],
        },
        {
            id: 'action',
            selectors: [{ id: 'shared', selector: '.sb-status-page__action' }, { id: 'own', selector: ':scope :is(button, .menu_button)' }],
            properties: [
                { property: 'offsetHeight', token: '--sb-control-min-height', floor: true, source: 'DESIGN.md' },
                { property: 'paddingInlineStart', value: 16, source: 'census' },
            ],
        },
    ],
};
