import { t } from '../i18n.js';
import { createArtPlaceholder } from '../sillybunny-home/art.js';
import { COPY_PLACEHOLDER, markCopyPlaceholder } from '../sillybunny-home/copy.js';
import { openDialog } from '../sillybunny-editor/dialog.js';
import { LAYOUT_MOBILE_QUERY } from '../sillybunny-editor/breakpoints.js';
import { createListEditor, isListEditorCollapsed } from '../sillybunny-editor/list-shell.js';
import { createPrefGroup, createRow } from '../sillybunny-editor/rows.js';
import { createStatusPage } from '../sillybunny-editor/status-page.js';
import { ensureWindowStyles } from '../sillybunny-window-styles.js';
import { filterHelpSections, findHelpTopic, getHelpSections } from './topics.js';

/** Below this width of the window body, the sections and the topic stack as pages. */
const COLLAPSE_AT = 600;

function createIntro() {
    const intro = document.createElement('div');
    intro.className = 'sbHelpIntro';
    intro.append(createArtPlaceholder('help-reisen'), markCopyPlaceholder(document.createElement('p'), 'HELP-INTRO'));
    return intro;
}

function createNoMatchPage() {
    const { element } = createStatusPage({ icon: 'magnifying-glass', title: COPY_PLACEHOLDER, description: COPY_PLACEHOLDER, compact: true });
    markCopyPlaceholder(element.querySelector('.sb-status-page__title'), 'HELP-SEARCH-EMPTY-HEAD');
    markCopyPlaceholder(element.querySelector('.sb-status-page__description'), 'HELP-SEARCH-EMPTY-BODY');
    // The search announces "No results" itself, so the page must not announce a second time.
    element.removeAttribute('role');
    return element;
}

/**
 * @param {import('./topics.js').HelpTopic} topic
 * @param {object} options
 * @param {boolean} options.heading Whether the view names the topic. A pushed page already shows the title in its header.
 * @param {(id: string) => void} options.openTopic
 */
function createTopicView(topic, { heading, openTopic }) {
    const view = document.createElement('div');
    view.className = 'sbHelpTopic';
    if (heading) {
        const title = document.createElement('h3');
        title.className = 'sbHelpTopicTitle';
        title.textContent = topic.title;
        view.append(title);
    }
    view.append(markCopyPlaceholder(document.createElement('p'), `HELP-TOPIC-${topic.id}`));

    const related = topic.seeAlso.map(id => findHelpTopic(id)).filter(Boolean);
    if (related.length > 0) {
        const rows = related.map(({ topic: other }) => createRow({
            label: other.title,
            field: `help-see-also-${other.id}`,
            activatable: true,
            onActivate: () => openTopic(other.id),
        }));
        view.append(createPrefGroup({ title: t`See Also`, field: `help-see-also-${topic.id}`, rows }).section);
    }
    return view;
}

/**
 * Opens the Help window. The sections sit in a sidebar and the open topic beside it. Where the window is too
 * narrow for both, the sections come first and a topic opens as a pushed page with Back, the way the Chat
 * Archive collapses its locations.
 * @returns {Promise<ReturnType<typeof openDialog>>}
 */
export async function openHelpWindow() {
    await ensureWindowStyles();
    let query = '';
    /** @type {{ topic: import('./topics.js').HelpTopic } | null} */
    let pageTopic = null;
    /** @type {ReturnType<ReturnType<typeof openDialog>['push']> | null} */
    let topicPage = null;
    /** @type {boolean | null} */
    let collapsedNow = null;
    /** @type {ReturnType<typeof createListEditor> | null} The list builds its sidebar while it is created, before this is set. */
    let editor = null;

    const dialog = openDialog({
        tier: 'window',
        title: t`Help`,
        className: 'sbHelpDialog',
        search: { collapsed: true, onChange: (value) => { query = value; editor?.refresh(); } },
    });
    dialog.body.classList.add('sbHelpBody');
    // A page over the sections hides them, and a hidden list editor has no width to notice a resize with. The
    // page area is always laid out, so the layout is read from it.
    const pagesNode = dialog.page.parentElement;
    const phone = matchMedia(LAYOUT_MOBILE_QUERY);
    const isCollapsed = () => isListEditorCollapsed({ viewportMobile: phone.matches, width: pagesNode.clientWidth, collapseAt: COLLAPSE_AT });

    function markOpenTopic() {
        if (!editor) {
            return;
        }
        const openId = editor.isOpen ? editor.selectedKey : null;
        for (const row of editor.sidebar.querySelectorAll('[data-sb-help-topic]')) {
            if (row.dataset.sbHelpTopic === openId) {
                row.setAttribute('aria-current', 'true');
            } else {
                row.removeAttribute('aria-current');
            }
        }
    }

    function renderSidebar(sidebar) {
        const all = getHelpSections();
        const sections = filterHelpSections(all, query);
        const groups = sections.map((section) => {
            const rows = section.topics.map((topic) => {
                const row = createRow({
                    label: topic.title,
                    field: `help-topic-${topic.id}`,
                    activatable: true,
                    onActivate: () => openTopic(topic.id),
                });
                row.row.dataset.sbHelpTopic = topic.id;
                row.row.classList.add('sbHelpTopicRow');
                return row;
            });
            return createPrefGroup({ title: section.title, field: `help-section-${section.id}`, rows }).section;
        });
        const intro = query.trim() === '' ? [createIntro()] : [];
        sidebar.replaceChildren(...intro, ...(groups.length > 0 ? groups : [createNoMatchPage()]));
        markOpenTopic();
        dialog.search?.report(sections.reduce((sum, section) => sum + section.topics.length, 0), all.reduce((sum, section) => sum + section.topics.length, 0));
    }

    function showTopicPage(topic) {
        if (topicPage?.isOpen) {
            pageTopic = { topic };
            topicPage.setTitle(topic.title);
            topicPage.body.replaceChildren(createTopicView(topic, { heading: false, openTopic }));
            topicPage.body.scrollTop = 0;
            return;
        }
        pageTopic = { topic };
        const page = dialog.push({
            title: topic.title,
            content: body => body.append(createTopicView(topic, { heading: false, openTopic })),
        });
        topicPage = page;
        void page.closed.then(() => {
            if (topicPage === page) {
                topicPage = null;
                pageTopic = null;
            }
        });
    }

    function openTopic(id) {
        const found = findHelpTopic(id);
        if (!found) {
            return;
        }
        if (collapsedNow ?? isCollapsed()) {
            showTopicPage(found.topic);
        } else {
            void editor.selectItem(found.topic);
        }
    }

    function reconcileLayout(collapsed) {
        if (!editor || !dialog.isOpen) {
            return;
        }
        if (collapsed) {
            if (editor.isOpen) {
                const topic = editor.selectedItem;
                editor.deselectNow();
                showTopicPage(topic);
            }
            return;
        }
        const topic = pageTopic?.topic ?? (editor.isOpen ? null : getHelpSections()[0].topics[0]);
        if (topicPage?.isOpen) {
            topicPage.forceClose();
        }
        editor.layout();
        if (topic) {
            void editor.selectItem(topic);
        }
    }

    function syncLayout() {
        if (!dialog.isOpen || pagesNode.clientWidth === 0) {
            return;
        }
        const collapsed = isCollapsed();
        if (collapsed !== collapsedNow) {
            collapsedNow = collapsed;
            reconcileLayout(collapsed);
        }
    }

    editor = createListEditor({
        container: dialog.body,
        storageKey: 'sb-help-sidebar-width',
        defaultWidth: 0.32,
        minWidth: 220,
        maxWidth: 360,
        collapseAt: COLLAPSE_AT,
        escapeCloses: false,
        label: t`Help Topics`,
        classNames: { root: 'sbHelpShell', sidebar: 'sbHelpSidebar', detail: 'sbHelpDetail' },
        renderList: renderSidebar,
        renderDetail: (detail, topic) => detail.replaceChildren(createTopicView(topic, { heading: true, openTopic })),
        getKey: topic => topic.id,
        focusTarget: () => null,
        isDirty: () => false,
        onSave: () => true,
        onDiscard: () => {},
        onSelect: markOpenTopic,
        onDeselect: markOpenTopic,
    });

    const layoutWatcher = new ResizeObserver(syncLayout);
    layoutWatcher.observe(pagesNode);
    phone.addEventListener('change', syncLayout);
    syncLayout();

    void dialog.closed.then(() => {
        layoutWatcher.disconnect();
        phone.removeEventListener('change', syncLayout);
        editor.destroy();
    });
    return dialog;
}
