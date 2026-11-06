import { t } from '../i18n.js';
import { createArtIntro } from '../sillybunny-home/art-intro.js';
import { COPY_PLACEHOLDER, markCopyPlaceholder, markRowSubtitle } from '../sillybunny-home/copy.js';
import { createPrefGroup, createRow } from '../sillybunny-editor/rows.js';
import { createStatusPage } from '../sillybunny-editor/status-page.js';
import { renderTemplateAsync } from '../templates.js';
import { findHelpTopic, getFeaturedTopics } from './topics.js';

let titleCount = 0;

/**
 * What the Help window shows. The front page is the top of a tree: a section sits under it and a topic under
 * its section.
 * @typedef {{ kind: 'index' } | { kind: 'section', section: import('./topics.js').HelpSection } | { kind: 'topic', section: import('./topics.js').HelpSection, topic: import('./topics.js').HelpTopic }} HelpView
 */

/**
 * How a move relates to the page it leaves. `down` goes to a child, `up` to an ancestor, `side` to a related page.
 * @typedef {'down' | 'up' | 'side'} HelpRelation
 */

/**
 * @typedef {object} ViewContext
 * @property {import('./topics.js').HelpSection[]} sections
 * @property {boolean} heading Whether the page names itself. A pushed page already shows its title in its header.
 * @property {(target: HelpView, relation: HelpRelation) => void} navigate
 * @property {TopicBodies} bodies The bodies that `loadViewBody` has loaded.
 */

export const OVERVIEW_KEY = 'overview';

/** @type {HelpView} */
export const INDEX_VIEW = Object.freeze({ kind: 'index' });

/** @returns {HelpView} */
export const sectionView = section => ({ kind: 'section', section });

/** @returns {HelpView} */
export const topicView = (section, topic) => ({ kind: 'topic', section, topic });

/**
 * @param {HelpView} left
 * @param {HelpView} right
 */
export function isSameView(left, right) {
    if (left.kind !== right.kind) {
        return false;
    }
    if (left.kind === 'index') {
        return true;
    }
    if (left.kind === 'section') {
        return left.section.id === right.section.id;
    }
    return left.topic.id === right.topic.id;
}

/**
 * The sidebar entry that stands for a view: Overview for the front page, otherwise the section it belongs to.
 * @param {HelpView} view
 * @returns {string}
 */
export function getNavigationKey(view) {
    return view.kind === 'index' ? OVERVIEW_KEY : view.section.id;
}

/** @param {HelpView} view */
export function getViewTitle(view) {
    if (view.kind === 'index') {
        return t`Overview`;
    }
    return view.kind === 'section' ? view.section.title : view.topic.title;
}

/**
 * The pages a narrow window stacks to show a view, bottom first.
 * @param {HelpView} view
 * @returns {HelpView[]}
 */
export function getViewAncestry(view) {
    return view.kind === 'topic' ? [sectionView(view.section), view] : [view];
}

/**
 * @param {string} name Font Awesome icon name without the fa- prefix.
 * @returns {HTMLElement}
 */
export function createRowIcon(name) {
    const icon = document.createElement('i');
    icon.className = `sbHelpRowIcon fa-solid fa-${name}`;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

/**
 * A page is a region named after its title, so assistive technology announces it when focus moves in. The name
 * comes from the heading when the page shows one, and from the title otherwise.
 * @param {object} options
 * @param {string} options.kind
 * @param {string} [options.id]
 * @param {string} options.title
 * @param {boolean} options.heading Whether the page shows its title as a heading.
 */
function createPage({ kind, id = '', title, heading }) {
    const root = document.createElement('div');
    root.className = 'sbHelpPage';
    root.tabIndex = -1;
    root.setAttribute('role', 'region');
    root.dataset.sbHelpView = kind;
    root.dataset.sbHelpId = id;
    if (!heading) {
        root.setAttribute('aria-label', title);
        return root;
    }
    const titleNode = document.createElement('h3');
    titleNode.className = 'sbHelpPageTitle';
    titleNode.id = `sb-help-title-${++titleCount}`;
    titleNode.tabIndex = -1;
    titleNode.textContent = title;
    root.setAttribute('aria-labelledby', titleNode.id);
    root.append(titleNode);
    return root;
}

/** A boxed row with a title and a one-line description, and an arrow at the end. */
function createLinkRow({ label, slot, field, prefix, onActivate }) {
    const row = createRow({ label, subtitle: COPY_PLACEHOLDER, field, prefix, activatable: true, onActivate });
    markRowSubtitle(row, slot);
    return row;
}

/** A group with no visible heading needs a name for assistive technology, which it takes from `label`. */
function createGroup({ title, label, field, rows, headingLevel }) {
    const group = createPrefGroup({ title, field, rows, headingLevel });
    if (!title) {
        group.group.setAttribute('aria-label', label);
    }
    return group.section;
}

function createIndexView({ sections, navigate }) {
    const root = createPage({ kind: 'index', title: t`Overview`, heading: false });
    root.append(createArtIntro({ art: 'help-reisen', text: t`Welcome to our handbook. ...I know I'm not the greatest at explaining things in simple terms, but I'll try my best to make this as easy as possible for you! Please select a category.` }).intro);

    const featured = getFeaturedTopics(sections);
    if (featured.length > 0) {
        const rows = featured.map(({ section, topic }) => createLinkRow({
            label: topic.title,
            slot: topic.descriptionSlot,
            field: `help-featured-${topic.id}`,
            onActivate: () => navigate(topicView(section, topic), 'down'),
        }));
        root.append(createGroup({ title: t`Featured Topics`, field: 'help-featured-group', rows, headingLevel: 3 }));
    }

    const rows = sections.map(section => createLinkRow({
        label: section.title,
        slot: section.descriptionSlot,
        field: `help-index-section-${section.id}`,
        prefix: createRowIcon(section.icon),
        onActivate: () => navigate(sectionView(section), 'down'),
    }));
    root.append(createGroup({ title: t`All Sections`, field: 'help-sections-group', rows, headingLevel: 3 }));
    return root;
}

function createSectionView(section, { heading, navigate }) {
    const root = createPage({ kind: 'section', id: section.id, title: section.title, heading });
    root.append(markCopyPlaceholder(document.createElement('p'), section.descriptionSlot));
    const rows = section.topics.map(topic => createLinkRow({
        label: topic.title,
        slot: topic.descriptionSlot,
        field: `help-section-topic-${topic.id}`,
        onActivate: () => navigate(topicView(section, topic), 'down'),
    }));
    root.append(createGroup({ label: section.title, field: `help-section-topics-${section.id}`, rows, headingLevel: 3 }));
    return root;
}

/** Help › Section, each part a button that goes up to that page. */
function createTrail(section, navigate) {
    const trail = document.createElement('nav');
    trail.className = 'sbHelpTrail';
    trail.setAttribute('aria-label', t`Breadcrumb`);
    const list = document.createElement('ol');
    const steps = [{ label: t`Help`, target: INDEX_VIEW }, { label: section.title, target: sectionView(section) }];
    steps.forEach(({ label, target }, index) => {
        const item = document.createElement('li');
        if (index > 0) {
            const separator = document.createElement('span');
            separator.setAttribute('aria-hidden', 'true');
            separator.textContent = '›';
            item.append(separator);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sbHelpTrailLink';
        button.textContent = label;
        button.addEventListener('click', () => navigate(target, 'up'));
        item.append(button);
        list.append(item);
    });
    trail.append(list);
    return trail;
}

/**
 * The loaded body markup of topics, by topic id. A topic whose template failed to load is stored as null, so a
 * failure is reported once per window and the topic keeps its placeholder.
 * @typedef {Map<string, string | null>} TopicBodies
 */

/**
 * Loads the template of a topic page before the page is built, so the page has its body in place when it first
 * shows. A view that needs no template, or whose body is loaded already, returns null: there is nothing to wait for.
 * @param {HelpView} view
 * @param {TopicBodies} bodies Filled by this call.
 * @returns {Promise<void> | null}
 */
export function loadViewBody(view, bodies) {
    if (view.kind !== 'topic' || !view.topic.template || bodies.has(view.topic.id)) {
        return null;
    }
    const { id, template } = view.topic;
    return renderTemplateAsync(template).then((markup) => {
        if (typeof markup !== 'string') {
            console.error(`The Help topic "${id}" could not load its template "${template}"; its page keeps the placeholder.`);
        }
        bodies.set(id, typeof markup === 'string' ? markup : null);
    });
}

/**
 * The body of a topic: its template when it has loaded, and the placeholder otherwise. The template stays in the
 * page as direct children of the topic page, which is where the page styles its text.
 * @param {import('./topics.js').HelpTopic} topic
 * @param {TopicBodies} bodies
 * @returns {Node}
 */
function createTopicBody(topic, bodies) {
    const markup = bodies.get(topic.id);
    if (markup) {
        const body = document.createElement('template');
        body.innerHTML = markup;
        if (body.content.childElementCount > 0) {
            return body.content;
        }
    }
    return markCopyPlaceholder(document.createElement('p'), topic.bodySlot);
}

function createTopicView(section, topic, { sections, heading, navigate, bodies }) {
    const root = createPage({ kind: 'topic', id: topic.id, title: topic.title, heading });
    // The trail sits above the title.
    root.prepend(createTrail(section, navigate));
    // Groups sit one level under a page heading, and directly under the window title when the page has none.
    const headingLevel = heading ? 4 : 3;
    root.append(createTopicBody(topic, bodies));

    const parent = createLinkRow({
        label: section.title,
        slot: section.descriptionSlot,
        field: `help-more-${section.id}`,
        prefix: createRowIcon(section.icon),
        onActivate: () => navigate(sectionView(section), 'up'),
    });
    root.append(createGroup({ title: t`More Information`, field: `help-more-information-${topic.id}`, rows: [parent], headingLevel }));

    const related = topic.seeAlso.map(id => findHelpTopic(sections, id));
    if (related.length > 0) {
        const rows = related.map(({ section: other, topic: relatedTopic }) => createLinkRow({
            label: relatedTopic.title,
            slot: relatedTopic.descriptionSlot,
            field: `help-see-also-${relatedTopic.id}`,
            onActivate: () => navigate(topicView(other, relatedTopic), 'side'),
        }));
        root.append(createGroup({ title: t`See Also`, field: `help-see-also-${topic.id}`, rows, headingLevel }));
    }
    return root;
}

/**
 * @param {HelpView} view
 * @param {ViewContext} context
 * @returns {HTMLElement} A focusable page. Its title, when it has one, is focusable too.
 */
export function createView(view, context) {
    if (view.kind === 'index') {
        return createIndexView(context);
    }
    return view.kind === 'section' ? createSectionView(view.section, context) : createTopicView(view.section, view.topic, context);
}

/**
 * Where focus goes after the window moved to a new page by the keyboard or pointer inside it.
 * @param {HTMLElement} root A page made by `createView`.
 * @returns {HTMLElement}
 */
export function getViewFocusTarget(root) {
    return root.querySelector('.sbHelpPageTitle') ?? root;
}

export function createNoMatchPage() {
    const { element } = createStatusPage({ icon: 'magnifying-glass', title: COPY_PLACEHOLDER, description: COPY_PLACEHOLDER, compact: true });
    markCopyPlaceholder(element.querySelector('.sb-status-page__title'), 'HELP-SEARCH-EMPTY-HEAD');
    markCopyPlaceholder(element.querySelector('.sb-status-page__description'), 'HELP-SEARCH-EMPTY-BODY');
    // The search announces "No results" itself, so the page must not announce a second time.
    element.removeAttribute('role');
    return element;
}
