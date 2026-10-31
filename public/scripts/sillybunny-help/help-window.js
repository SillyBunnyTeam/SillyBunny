import { t } from '../i18n.js';
import { HELP_DIALOG_CLASS } from './dialog-classes.js';
import { openDialog } from '../sillybunny-editor/dialog.js';
import { LAYOUT_MOBILE_QUERY } from '../sillybunny-editor/breakpoints.js';
import { COPY_PLACEHOLDER, markRowSubtitle } from '../sillybunny-home/copy.js';
import { createListEditor, isListEditorCollapsed } from '../sillybunny-editor/list-shell.js';
import { createPrefGroup, createRow } from '../sillybunny-editor/rows.js';
import { ensureWindowStyles } from '../sillybunny-window-styles.js';
import {
    createNoMatchPage,
    createRowIcon,
    createView,
    getNavigationKey,
    getViewAncestry,
    getViewFocusTarget,
    getViewTitle,
    INDEX_VIEW,
    isSameView,
    loadViewBody,
    OVERVIEW_KEY,
    sectionView,
    topicView,
} from './help-views.js';
import { createMoveRunner } from './move-runner.js';
import { filterHelpSections, findHelpTopic, getHelpSections, validateHelpSections } from './topics.js';

/** Below this width of the window body, the sections and the page stack as pages. */
const COLLAPSE_AT = 600;
const OVERVIEW_ICON = 'book-open';

const countTopics = sections => sections.reduce((sum, section) => sum + section.topics.length, 0);

/**
 * Opens the Help window: the front page, a section page for each section, and a topic page for each topic.
 *
 * The sections sit in a sidebar and the open page beside it. A move inside the page replaces the page, and the
 * trail of a topic is the way up, because a pushed page would cover the sidebar. Where the window is too narrow
 * for both, the sections come first and each deeper page is pushed with Back, the way the Chat Archive
 * collapses its locations. The trail still goes up there: it pops to the page it names, or, when that page is
 * not in the stack, makes the first pushed page that page, so Back and the trail agree.
 * @param {object} [options]
 * @param {() => import('./topics.js').HelpSection[]} [options.getSections] The model to show, for a window that needs more topics than the shipped ones.
 * @param {string | null} [options.topicId] A topic to open the window at, instead of the front page.
 * @returns {Promise<ReturnType<typeof openDialog>>}
 */
export async function openHelpWindow({ getSections = getHelpSections, topicId = null } = {}) {
    await ensureWindowStyles();
    const sections = getSections();
    validateHelpSections(sections);
    const found = topicId === null ? null : findHelpTopic(sections, topicId);
    if (topicId !== null && !found) {
        throw new Error(`Unknown Help topic: ${topicId}`);
    }
    /** @type {import('./help-views.js').HelpView | null} The page to show once the layout is known, if the window opens at a topic. */
    let startingView = found && topicView(found.section, found.topic);
    const entries = [
        { key: OVERVIEW_KEY, label: t`Overview`, icon: OVERVIEW_ICON, view: INDEX_VIEW },
        ...sections.map(section => ({ key: section.id, label: section.title, icon: section.icon, view: sectionView(section) })),
    ];
    let query = '';
    /** @type {import('./help-views.js').HelpView} The page that is shown, or that was shown last while the window is narrow and only the sections are. */
    let view = INDEX_VIEW;
    /** @type {{ view: import('./help-views.js').HelpView, root: HTMLElement, handle: ReturnType<ReturnType<typeof openDialog>['push']> | null }[]} The pushed pages of a narrow window, bottom first. */
    let pages = [];
    /** @type {boolean | null} */
    let collapsedNow = null;
    /** @type {import('./help-views.js').TopicBodies} */
    const bodies = new Map();
    /** @type {ReturnType<typeof createListEditor> | null} The list builds its sidebar while it is created, before this is set. */
    let editor = null;

    // The window opens only once its first page has what it shows, so the page is not built twice.
    if (startingView) {
        await loadViewBody(startingView, bodies);
    }

    const dialog = openDialog({
        tier: 'window',
        title: t`Help`,
        className: HELP_DIALOG_CLASS,
        search: { collapsed: true, label: t`Search Help`, toggleLabel: t`Search Help`, onChange: (value) => { query = value; editor?.refresh(); } },
    });
    dialog.body.classList.add('sbHelpBody');
    // A topic page is built with its template in place, so a move to one waits for the template.
    const moveWhenLoaded = createMoveRunner({ isOpen: () => dialog.isOpen, load: target => loadViewBody(target, bodies) });
    // A page over the sections hides them, and a hidden list editor has no width to notice a resize with. The
    // page area is always laid out, so the layout is read from it.
    const pagesNode = dialog.page.parentElement;
    const phone = matchMedia(LAYOUT_MOBILE_QUERY);
    const isCollapsed = () => isListEditorCollapsed({ viewportMobile: phone.matches, width: pagesNode.clientWidth, collapseAt: COLLAPSE_AT });

    /** @param {boolean} heading */
    const viewContext = heading => ({ sections, heading, navigate, bodies });

    function markCurrent() {
        if (!editor) {
            return;
        }
        const shown = editor.isOpen;
        const currentKey = shown ? getNavigationKey(view) : null;
        const currentTopic = shown && view.kind === 'topic' ? view.topic.id : null;
        for (const row of editor.sidebar.querySelectorAll('[data-sb-help-nav], [data-sb-help-topic]')) {
            if (row.dataset.sbHelpNav === currentKey || row.dataset.sbHelpTopic === currentTopic) {
                row.setAttribute('aria-current', 'page');
            } else {
                row.removeAttribute('aria-current');
            }
        }
    }

    function createNavigation() {
        const rows = entries.map((entry) => {
            const row = createRow({
                label: entry.label,
                field: `help-nav-${entry.key}`,
                prefix: createRowIcon(entry.icon),
                activatable: true,
                onActivate: () => openFromSidebar(entry.view),
            });
            row.row.dataset.sbHelpNav = entry.key;
            row.row.classList.add('sbHelpNavRow');
            return row;
        });
        const group = createPrefGroup({ field: 'help-nav-group', rows });
        group.group.setAttribute('aria-label', t`Help Sections`);
        return group.section;
    }

    function createResults(matching) {
        if (matching.length === 0) {
            return [createNoMatchPage()];
        }
        return matching.map((section) => {
            const rows = section.topics.map((topic) => {
                const row = createRow({
                    label: topic.title,
                    subtitle: COPY_PLACEHOLDER,
                    field: `help-topic-${topic.id}`,
                    activatable: true,
                    onActivate: () => openFromSidebar(topicView(section, topic)),
                });
                markRowSubtitle(row, topic.descriptionSlot);
                row.row.dataset.sbHelpTopic = topic.id;
                row.row.classList.add('sbHelpNavRow');
                return row;
            });
            return createPrefGroup({ title: section.title, field: `help-section-${section.id}`, rows }).section;
        });
    }

    function renderSidebar(sidebar) {
        const matching = filterHelpSections(sections, query);
        sidebar.replaceChildren(...(query.trim() === '' ? [createNavigation()] : createResults(matching)));
        markCurrent();
        dialog.search?.report(countTopics(matching), countTopics(sections));
    }

    function renderPane(pane = editor.detail) {
        pane.replaceChildren(createView(view, viewContext(true)));
    }

    function focusPane() {
        const root = editor.detail.firstElementChild;
        if (root instanceof HTMLElement) {
            getViewFocusTarget(root).focus({ preventScroll: true });
        }
    }

    /**
     * @param {import('./help-views.js').HelpView} target
     * @param {{ focus: boolean }} options Whether focus follows to the new page. It stays on the sidebar row that was used.
     */
    async function showInPane(target, { focus }) {
        view = target;
        const key = getNavigationKey(target);
        if (editor.isOpen && editor.selectedKey === key) {
            renderPane();
        } else {
            await editor.selectItem(entries.find(entry => entry.key === key));
        }
        markCurrent();
        if (focus) {
            focusPane();
        }
    }

    function pushPage(target) {
        const root = createView(target, viewContext(false));
        const entry = { view: target, root, handle: null };
        entry.handle = dialog.push({
            title: getViewTitle(target),
            content: body => body.append(root),
            initialFocus: () => entry.root,
        });
        pages.push(entry);
        view = target;
        void entry.handle.closed.then(() => {
            pages = pages.filter(page => page !== entry);
            if (collapsedNow) {
                view = pages.at(-1)?.view ?? INDEX_VIEW;
            }
        });
    }

    function replacePage(entry, target) {
        entry.view = target;
        entry.root = createView(target, viewContext(false));
        entry.handle.setTitle(getViewTitle(target));
        entry.handle.body.replaceChildren(entry.root);
        entry.handle.body.scrollTop = 0;
    }

    function closePagesAbove(index) {
        for (const entry of pages.slice(index + 1).reverse()) {
            entry.handle.forceClose();
        }
    }

    function goUpTo(target) {
        const found = pages.findIndex(entry => isSameView(entry.view, target));
        const keep = Math.max(found, 0);
        if (found < 0) {
            replacePage(pages[keep], target);
        }
        closePagesAbove(keep);
        view = target;
        pages[keep].root.focus({ preventScroll: true });
    }

    /**
     * @param {import('./help-views.js').HelpView} target
     * @param {import('./help-views.js').HelpRelation} relation
     */
    function navigate(target, relation) {
        moveWhenLoaded(target, () => moveTo(target, relation));
    }

    function moveTo(target, relation) {
        if (!(collapsedNow ?? isCollapsed())) {
            void showInPane(target, { focus: true });
            return;
        }
        if (relation === 'up') {
            goUpTo(target);
            return;
        }
        if (relation === 'side' && pages.length > 0) {
            replacePage(pages.at(-1), target);
            view = target;
            pages.at(-1).root.focus({ preventScroll: true });
            return;
        }
        pushPage(target);
    }

    function openFromSidebar(target) {
        moveWhenLoaded(target, () => {
            if (collapsedNow ?? isCollapsed()) {
                pushPage(target);
            } else {
                void showInPane(target, { focus: false });
            }
        });
    }

    function reconcileLayout(collapsed) {
        if (!editor || !dialog.isOpen) {
            return;
        }
        if (collapsed) {
            if (editor.isOpen) {
                editor.deselectNow();
                getViewAncestry(view).forEach(pushPage);
            }
            return;
        }
        const target = pages.at(-1)?.view ?? view;
        closePagesAbove(-1);
        editor.layout();
        void showInPane(target, { focus: false });
    }

    function syncLayout() {
        if (!dialog.isOpen || pagesNode.clientWidth === 0) {
            return;
        }
        const collapsed = isCollapsed();
        if (collapsed !== collapsedNow) {
            collapsedNow = collapsed;
            reconcileLayout(collapsed);
            showStartingView();
        }
    }

    /** Opens the page that the window was asked to open at, the first time the layout is known. A narrow window stacks the pages above it. */
    function showStartingView() {
        const target = startingView;
        startingView = null;
        if (!target) {
            return;
        }
        if (collapsedNow) {
            getViewAncestry(target).forEach(pushPage);
        } else {
            void showInPane(target, { focus: true });
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
        label: t`Help Sections`,
        classNames: { root: 'sbHelpShell', sidebar: 'sbHelpSidebar', detail: 'sbHelpDetail' },
        renderList: renderSidebar,
        renderDetail: renderPane,
        getKey: entry => entry.key,
        focusTarget: () => null,
        isDirty: () => false,
        onSave: () => true,
        onDiscard: () => {},
        onSelect: markCurrent,
        onDeselect: markCurrent,
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
