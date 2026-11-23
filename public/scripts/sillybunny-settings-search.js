/**
 * Sidebar search of the settings pages: word-boundary matching, a match count on each page, rows that
 * do not match hidden in the open page, the group that holds the first match pulsed and scrolled into
 * view, and the matched words marked through the CSS Custom Highlight API.
 *
 * The module loads when the sidebar search is first opened (`sillybunny-tabs.js`), so it is not part of
 * the startup chain. The page builders do not depend on it: a group carries its former names in
 * `data-sb-search-aliases`, and this module reads that attribute and nothing else about a page.
 *
 * What a page is made of: a group is a boxed list (`.ds-pref-group` or `.sb-settings-category-body`), its
 * title sits in the header that holds it, and each child of the list is one row. Rows are the unit of the
 * filter, of the count and of the highlight. Lists of entities (characters, lorebook entries, personas) are
 * data, not settings, and are left to their own list filters.
 */

export const SETTINGS_SEARCH_HIGHLIGHT = 'sb-settings-search-text';
export const ROW_FILTERED_CLASS = 'sb-settings-row--filtered';
export const TAB_FILTERED_CLASS = 'sb-settings-tab--filtered';
export const TAB_BY_CONTENT_CLASS = 'sb-settings-tab--by-content';
export const TAB_BADGE_CLASS = 'sb-settings-tab-badge';
export const TAB_COUNT_DESCRIPTION_CLASS = 'sb-settings-tab-count-description';
export const ALIAS_ATTRIBUTE = 'data-sb-search-aliases';

const MAX_HIGHLIGHT_RANGES = 600;
const REVEAL_DELAY_MS = 180;
const ACTIVATION_REVEAL_DELAY_MS = 40;
const REAPPLY_DELAY_MS = 150;

const GROUP_BODY_SELECTOR = '.ds-pref-group, .sb-settings-category-body';
// Lists of entities have their own filter, and a list that is a row of the page is not a boxed list of settings.
const ENTITY_LIST_SELECTOR = '.ds-entity-list, .sb-wi-list-box, [role="list"]';
const EXCLUDED_SELECTOR = '.sb-search-result, .sb-legacy-search-hidden, .sb-theme-card, [data-sb-copy-placeholder]';
const NON_ROW_SELECTOR = 'script, style, template, [data-sb-copy-placeholder]';
const HEADER_SELECTOR = ':scope > :is(.ds-pref-group-header, .sb-settings-category-header, .sb-settings-flat-header, .inline-drawer-toggle)';
const HEADING_SELECTOR = '.ds-pref-group-heading, .sb-settings-category-title, h3, h4, b';
const DESCRIPTION_SELECTOR = '.ds-pref-group-subtitle, .sb-settings-category-heading > small, .sb-settings-flat-header small';
// Text that is on the page but not on screen: closed content stays searchable and is opened when it holds the match.
const CLOSED_CONTENT_SELECTOR = '.ds-row-expander-content[hidden], .sb-sampling-help[hidden]';
// Values a user typed and lines a program wrote are data, not the names of settings.
const SKIPPED_TEXT_SELECTOR = [
    'option', 'script', 'style', 'template', 'textarea', 'pre', '.sb-console-log-frame',
    '[data-sb-copy-placeholder]', '[aria-hidden="true"]', '.displayNone',
    '[hidden]:not(.ds-row-expander-content):not(.sb-sampling-help)',
].join(', ');
const ATTRIBUTE_TEXT_NAMES = ['title', 'aria-label', 'placeholder', 'data-sb-search-label'];

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

const COMBINING_MARKS = /\p{M}/gu;
// eslint-disable-next-line no-control-regex -- Fast check for pure ASCII text before NFD folding.
const NON_ASCII = /[^\x00-\x7f]/;

/**
 * Lowercase with the accents taken off ("Résumé" is "resume"), one code unit for one code unit, so an offset in
 * the folded text is an offset in the original. A character whose folded form would have another length
 * (a ligature, a letter with a long lowercase form) stays as it was typed.
 */
export function foldSearchText(value) {
    const text = String(value ?? '');
    if (!NON_ASCII.test(text)) {
        return text.toLowerCase();
    }
    let folded = '';
    for (const character of text) {
        const stripped = character.normalize('NFD').replace(COMBINING_MARKS, '');
        const lower = stripped.toLowerCase();
        folded += lower.length === character.length ? lower : character;
    }
    return folded;
}

/** Folded, with runs of whitespace as one space. */
export function normalizeSearchText(value) {
    // A mark typed on its own (a decomposed "é") is dropped here, where offsets are no longer needed.
    return foldSearchText(String(value ?? '').replace(/\s+/g, ' ').trim()).replace(COMBINING_MARKS, '');
}

/** The distinct words of a query, in the order typed. */
export function tokenizeQuery(query) {
    return [...new Set(normalizeSearchText(query).split(' ').filter(Boolean))];
}

/** The names a group or a page carries besides its title, from the pipe-separated attribute value. */
export function parseAliases(value) {
    return String(value ?? '').split('|').map(alias => alias.trim()).filter(Boolean);
}

function isWordCharacterAt(text, index) {
    return index >= 0 && index < text.length && WORD_CHARACTER.test(text[index]);
}

/**
 * Where `token` begins a word of `text`. A token that starts with a letter or digit must start at the start
 * of a word, so "freq" finds "Frequency Penalty" and "Penalty Frequency", "penalty" does not find
 * "FrequencyPenalty", and "temp" does not find "attempt". The end of the token is free: it is a prefix. A token
 * that starts with a symbol needs no boundary. Both strings are folded with `foldSearchText`; the returned
 * ranges cover the typed token only.
 * @param {string} text
 * @param {string} token
 * @returns {{start: number, end: number}[]}
 */
export function findWordMatches(text, token) {
    const matches = [];
    if (!token) return matches;
    const startNeedsBoundary = WORD_CHARACTER.test(token[0]);
    for (let from = 0; ;) {
        const start = text.indexOf(token, from);
        if (start === -1) return matches;
        if (!startNeedsBoundary || !isWordCharacterAt(text, start - 1)) {
            matches.push({ start, end: start + token.length });
        }
        from = start + 1;
    }
}

/** Whether `token` begins a word of `text`. */
export function hasWord(text, token) {
    return findWordMatches(text, token).length > 0;
}

/** Whether every token begins a word of `text`, in any order. */
export function textMatchesAll(text, tokens) {
    return tokens.length > 0 && tokens.every(token => hasWord(text, token));
}

/**
 * A row stays when each token is a word of its own text or of its group's (title, description, former
 * names), so a search for a group name keeps the whole group.
 */
export function isRowMatch(rowText, groupText, tokens) {
    return tokens.length > 0 && tokens.every(token => hasWord(rowText, token) || hasWord(groupText, token));
}

/**
 * The ranges of `text` that the tokens match, in order and without overlap.
 * @returns {{start: number, end: number}[]}
 */
export function findMatchRanges(text, tokens) {
    const ranges = tokens.flatMap(token => findWordMatches(text, token)).sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
        else merged.push({ ...range });
    }
    return merged;
}

/**
 * The text a row answers to: what it shows, plus the names that its controls carry in `title`, `aria-label`
 * and the placeholder. The values of a select are not part of it, and neither is anything that is hidden in
 * the row (the other backends' controls, placeholder copy).
 * @param {Element} element
 * @param {{includeClosed?: boolean}} [options] `includeClosed: false` leaves out closed expander and help content.
 */
export function getRowSearchText(element, { includeClosed = true } = {}) {
    const parts = [];
    const addAttributes = node => {
        for (const name of ATTRIBUTE_TEXT_NAMES) {
            const value = node.getAttribute(name);
            if (value) parts.push(value);
        }
    };
    addAttributes(element);
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
            if (node.matches(SKIPPED_TEXT_SELECTOR)) return NodeFilter.FILTER_REJECT;
            if (!includeClosed && node.matches(CLOSED_CONTENT_SELECTOR)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE) parts.push(node.data);
        else addAttributes(node);
    }
    return normalizeSearchText(parts.join(' '));
}

function getHeadingText(element) {
    if (!element) return '';
    const parts = [];
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent?.closest(DESCRIPTION_SELECTOR) || parent?.closest('[data-sb-copy-placeholder]')) continue;
        parts.push(node.data);
    }
    return normalizeSearchText(parts.join(' '));
}

/**
 * Whether `element` or one of its ancestors up to `root` is not shown. A row that is not shown is not
 * searched: it belongs to another backend or another device, or waits on a setting that is off.
 */
export function isHiddenWithin(element, root) {
    for (let node = element; node && node !== root; node = node.parentElement) {
        if (node.hidden || node.classList.contains('displayNone')) return true;
        if (getComputedStyle(node).display === 'none') return true;
    }
    return false;
}

/**
 * @typedef {object} SearchRow
 * @property {HTMLElement} element
 * @property {string} text
 * @property {boolean} match      the row's words (with its group's) hold every token
 * @property {boolean} available  the row is shown; only read for a row that matches
 *
 * @typedef {object} SearchGroup
 * @property {HTMLElement} body        the boxed list
 * @property {HTMLElement|null} header the header over it, when it has one
 * @property {HTMLElement} container   what the group is hidden through: the section that holds header and list, or the list
 * @property {string} title
 * @property {string} text             title, description and former names, normalised
 * @property {SearchRow[]} rows
 */

/**
 * The groups of settings under `root`, each with its rows.
 * @param {HTMLElement} root
 * @returns {SearchGroup[]}
 */
export function collectSearchGroups(root) {
    const groups = [];
    for (const body of root.querySelectorAll(GROUP_BODY_SELECTOR)) {
        if (!(body instanceof HTMLElement) || body.matches(ENTITY_LIST_SELECTOR)) continue;
        if (body.closest(EXCLUDED_SELECTOR)) continue;
        const outer = body.parentElement?.closest(GROUP_BODY_SELECTOR);
        if (outer && root.contains(outer)) continue;

        const parent = body.parentElement;
        const inRoot = parent && parent !== root && root.contains(parent);
        let header = inRoot ? parent.querySelector(HEADER_SELECTOR) : null;
        const labelledBy = body.getAttribute('aria-labelledby');
        if (!header && labelledBy) {
            const labelled = document.getElementById(labelledBy);
            header = labelled?.closest('.ds-pref-group-header') ?? labelled;
        }
        const heading = header?.matches(HEADING_SELECTOR) ? header : header?.querySelector(HEADING_SELECTOR) ?? header;
        const container = inRoot && header && parent.contains(header) && parent.querySelectorAll(`:scope > :is(${GROUP_BODY_SELECTOR})`).length === 1
            ? parent : body;
        const title = getHeadingText(heading);
        const description = header ? normalizeSearchText(Array.from(header.querySelectorAll(DESCRIPTION_SELECTOR), node => node.textContent).join(' ')) : '';
        const aliases = [container, body, header].flatMap(node => parseAliases(node?.getAttribute?.(ALIAS_ATTRIBUTE)));

        groups.push({
            body,
            header: header instanceof HTMLElement ? header : null,
            container,
            title,
            text: normalizeSearchText([title, description, ...aliases].join(' ')),
            rows: Array.from(body.children)
                .filter(child => child instanceof HTMLElement && !child.matches(NON_ROW_SELECTOR))
                .map(element => ({ element, text: '', match: false, available: false })),
        });
    }
    return groups;
}

/**
 * Reads each row's text and availability, then decides which rows match.
 * @param {HTMLElement[]} roots
 * @param {string[]} tokens
 * @param {{isAvailable?: (element: HTMLElement, root: HTMLElement) => boolean}} [options]
 * @returns {{groups: (SearchGroup & {matched: SearchRow[], needsReveal: SearchRow[]})[], count: number}}
 */
export function analyzeSearchRoots(roots, tokens, {
    isAvailable = (element, root) => !isHiddenWithin(element, root),
    getGroups = collectSearchGroups,
} = {}) {
    const groups = [];
    let count = 0;
    for (const root of roots) {
        for (const group of getGroups(root)) {
            group.matched = [];
            group.needsReveal = [];
            for (const row of group.rows) {
                if (!row.textComputed) {
                    row.text = getRowSearchText(row.element);
                    row.textComputed = true;
                }
                row.match = isRowMatch(row.text, group.text, tokens);
                if (!row.match) continue;
                // Availability reads computed styles, so it is only read for the rows that match.
                row.available = isAvailable(row.element, root);
                if (!row.available) continue;
                group.matched.push(row);
                if (!isRowMatch(getRowSearchText(row.element, { includeClosed: false }), group.text, tokens)) group.needsReveal.push(row);
            }
            count += group.matched.length;
            groups.push(group);
        }
    }
    return { groups, count };
}

const filteredElements = new Set();

function setFiltered(element) {
    element.classList.add(ROW_FILTERED_CLASS);
    element.setAttribute('aria-hidden', 'true');
    filteredElements.add(element);
}

/** Shows every row and group that a search hid. */
export function restoreFilteredRows() {
    for (const element of filteredElements) {
        element.classList.remove(ROW_FILTERED_CLASS);
        element.removeAttribute('aria-hidden');
    }
    filteredElements.clear();
}

/**
 * Hides the rows that do not match, and a group left with none. A row that matches but is not shown is not
 * touched: its page hides it already, and it comes back with the setting that shows it.
 * @param {ReturnType<typeof analyzeSearchRoots>['groups']} groups
 */
export function applyRowFilter(groups) {
    for (const group of groups) {
        if (group.matched.length === 0) {
            setFiltered(group.container);
            continue;
        }
        for (const row of group.rows) {
            if (!row.match) setFiltered(row.element);
        }
    }
}

/** Opens what is closed in a row and holds a match: an expander, or the help of a sampler. */
export function revealClosedMatches(row, tokens, expand) {
    for (const closed of row.querySelectorAll(CLOSED_CONTENT_SELECTOR)) {
        const text = getRowSearchText(closed);
        if (tokens.some(token => hasWord(text, token))) expand(closed.firstElementChild ?? closed);
    }
}

/** Whether this browser can mark text without changing the page. */
export function supportsTextHighlight() {
    return typeof CSS !== 'undefined' && Boolean(CSS.highlights) && typeof globalThis.Highlight === 'function';
}

export function clearTextHighlights() {
    if (supportsTextHighlight()) CSS.highlights.delete(SETTINGS_SEARCH_HIGHLIGHT);
}

/**
 * Marks the tokens in the text of `elements` through the Custom Highlight API. The page is not changed, so
 * handlers and live nodes stay as they are; a browser without the API shows no marks.
 * @param {HTMLElement[]} elements
 * @param {string[]} tokens
 * @returns {number} how many ranges were marked
 */
export function applyTextHighlights(elements, tokens) {
    clearTextHighlights();
    if (!supportsTextHighlight() || !tokens.length) return 0;
    const ranges = [];
    for (const element of elements) {
        const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                return node.parentElement?.closest(SKIPPED_TEXT_SELECTOR) || node.parentElement?.closest(CLOSED_CONTENT_SELECTOR)
                    ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
            },
        });
        for (let node = walker.nextNode(); node && ranges.length < MAX_HIGHLIGHT_RANGES; node = walker.nextNode()) {
            // The fold keeps the length, so a range of the folded text is a range of the node.
            for (const { start, end } of findMatchRanges(foldSearchText(node.data), tokens)) {
                const range = new Range();
                range.setStart(node, start);
                range.setEnd(node, end);
                ranges.push(range);
            }
        }
    }
    if (ranges.length) CSS.highlights.set(SETTINGS_SEARCH_HIGHLIGHT, new globalThis.Highlight(...ranges));
    return ranges.length;
}

/**
 * The search of one sidebar: which pages stay in the list and what each shows, and the open page's rows.
 *
 * `adapter` is what the shell knows and the module does not:
 * - `getShellKey()`, `getTabList()`: the open shell, and the element that holds the page buttons
 *   (`.sb-settings-tab`, `data-sb-settings-tab`).
 * - `getTabs()`: `{id, label, aliases}` of each page of the open shell.
 * - `getActiveTabId()`.
 * - `getRoots(tabId)`: the elements whose groups are searched, or `null` for a page that is not made of groups.
 * - `canHideRows(body)`: whether the rows of a group may be hidden (the Characters pages are only marked).
 * - `getContentMatches(rawQuery)`: `{tabId, key, searchText}` for what is found in other ways (entities, the
 *   pages that are not made of groups); the module checks each against the tokens.
 * - `ensureReady()`: resolves when every page is built. `whenTabReady(tabId)`: when a page is mounted and shown.
 * - `isAvailable(element, root)`: optional, whether a row is shown on this device and backend.
 * - `changeSelector`: controls whose change shows other rows (the backend pickers).
 * - `pulse(element)`, `scroll(element)`, `expand(element)`: the shell's own reveal.
 * - `canReveal()`: optional, whether the open page is on screen (a phone shows the sidebar or the page, not both).
 * - `countDescription(count)`: the accessible text of a page's count ("2 matching settings"), and `emptyLabel`.
 */
export function createSidebarSearch(adapter) {
    let request = 0;
    let tokens = [];
    let rawQuery = '';
    let revealTimer = 0;
    let reapplyTimer = 0;
    let structureObserver = null;
    let hiddenObserver = null;
    let observedKey = [];
    let applying = false;
    let lastRevealKey = '';
    let cachedShellKey = null;
    /** @type {Map<HTMLElement, SearchGroup[]>} */
    const rootGroupsCache = new Map();

    const getCachedGroups = root => {
        let groups = rootGroupsCache.get(root);
        if (!groups) {
            groups = collectSearchGroups(root);
            rootGroupsCache.set(root, groups);
        }
        return groups;
    };

    const tabButtons = () => Array.from(adapter.getTabList()?.querySelectorAll('.sb-settings-tab') ?? []);

    /**
     * The count shows as a bare number that screen readers skip. The tab keeps its name, and a hidden element
     * ("2 matching settings") that `aria-describedby` points at gives the count as its description.
     */
    function setBadge(button, count) {
        const badge = button.querySelector(`:scope > .${TAB_BADGE_CLASS}`);
        const description = button.querySelector(`:scope > .${TAB_COUNT_DESCRIPTION_CLASS}`);
        if (count <= 0) {
            badge?.remove();
            description?.remove();
            button.removeAttribute('aria-describedby');
            return;
        }
        const label = adapter.countDescription(count);
        if (badge && description && description.textContent === label && badge.textContent === String(count)) return;
        const visibleBadge = badge ?? button.appendChild(Object.assign(document.createElement('span'), { className: TAB_BADGE_CLASS }));
        visibleBadge.setAttribute('aria-hidden', 'true');
        visibleBadge.textContent = String(count);
        const hiddenDescription = description ?? button.appendChild(Object.assign(document.createElement('span'), { className: TAB_COUNT_DESCRIPTION_CLASS }));
        hiddenDescription.hidden = true;
        hiddenDescription.id = `sb-settings-tab-count-${adapter.getShellKey()}-${button.dataset.sbSettingsTab}`;
        hiddenDescription.textContent = label;
        button.setAttribute('aria-describedby', hiddenDescription.id);
    }

    function renderTabs(visibility) {
        const list = adapter.getTabList();
        if (!list) return;
        let visible = 0;
        for (const button of tabButtons()) {
            const state = visibility.get(button.dataset.sbSettingsTab) ?? { match: true, byName: true, count: 0 };
            button.classList.toggle(TAB_FILTERED_CLASS, !state.match);
            button.classList.toggle(TAB_BY_CONTENT_CLASS, tokens.length > 0 && state.match && !state.byName);
            button.setAttribute('aria-hidden', String(!state.match));
            button.tabIndex = state.match ? 0 : -1;
            // Name hits render above content hits; `order` does it without touching DOM order, which keeps
            // keyboard traversal stable while a filter is active.
            button.style.order = state.byName ? '0' : '1';
            setBadge(button, tokens.length > 0 && state.match ? Math.max(state.count, 1) : 0);
            visible += Number(state.match);
        }
        let empty = list.querySelector('.sb-settings-tab-empty');
        if (tokens.length && visible === 0) {
            if (!empty) {
                empty = document.createElement('p');
                empty.className = 'sb-settings-tab-empty';
                empty.textContent = adapter.emptyLabel;
                list.append(empty);
            }
        } else {
            empty?.remove();
        }
    }

    function nameMatches(tab) {
        return textMatchesAll(normalizeSearchText([tab.label, ...(tab.aliases ?? [])].join(' ')), tokens);
    }

    const onBackendChange = event => {
        if (!tokens.length || !(event.target instanceof Element) || !event.target.matches(adapter.changeSelector ?? ':not(*)')) return;
        scheduleReapply();
    };

    function scheduleReapply() {
        rootGroupsCache.clear();
        clearTimeout(reapplyTimer);
        reapplyTimer = setTimeout(() => void run({ reveal: false }), REAPPLY_DELAY_MS);
    }

    function stopObserving() {
        structureObserver?.disconnect();
        hiddenObserver?.disconnect();
        structureObserver = hiddenObserver = null;
        observedKey = [];
        document.removeEventListener('change', onBackendChange);
        clearTimeout(reapplyTimer);
    }

    /** Rows added or removed, and rows shown or hidden by the page: the filter is read again. */
    function observe(roots, groups) {
        const bodies = groups.map(group => group.body);
        const key = [...roots, ...bodies];
        if (observedKey.length === key.length && observedKey.every((node, index) => node === key[index])) return;
        stopObserving();
        observedKey = key;
        const onChange = () => { if (!applying) scheduleReapply(); };
        // Child lists are watched one level deep, so a page that rewrites a row's own text (the live console)
        // does not start a pass.
        structureObserver = new MutationObserver(onChange);
        hiddenObserver = new MutationObserver(onChange);
        for (const node of key) structureObserver.observe(node, { childList: true });
        for (const root of roots) hiddenObserver.observe(root, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
        document.addEventListener('change', onBackendChange);
    }

    function scheduleReveal(analysis, key, delay) {
        clearTimeout(revealTimer);
        if (key === lastRevealKey) return;
        revealTimer = setTimeout(() => {
            // The page is not on screen yet; opening it asks for the reveal again.
            if (adapter.canReveal && !adapter.canReveal()) return;
            lastRevealKey = key;
            const group = analysis?.groups.find(candidate => candidate.matched.length > 0);
            const row = group?.matched[0]?.element;
            if (!group || !row?.isConnected) return;
            for (const needed of group.needsReveal) revealClosedMatches(needed.element, tokens, adapter.expand);
            adapter.scroll(group.header ?? row);
            adapter.pulse(group.header ? group.container : row);
        }, delay);
    }

    function highlight(analysis) {
        const elements = [];
        for (const group of analysis?.groups ?? []) {
            if (!group.matched.length) continue;
            if (group.header) elements.push(group.header);
            elements.push(...group.matched.map(row => row.element));
        }
        applyTextHighlights(elements.filter(element => element.isConnected), tokens);
    }

    /** One pass over the shell: counts and visibility for every page, rows and marks for the open one. */
    async function run({ reveal = true, activeChanged = false } = {}) {
        const current = ++request;
        const shellKey = adapter.getShellKey();
        const tabs = adapter.getTabs();
        const visibility = new Map();
        for (const tab of tabs) {
            const byName = nameMatches(tab);
            visibility.set(tab.id, { match: byName, byName, count: 0 });
        }
        const ready = Promise.resolve(adapter.ensureReady());
        // Pages that are already built answer within the same task. Pages that are still loading (the first query)
        // keep the list as it is, so a query that only the pages' contents match does not flash the empty message.
        const built = await Promise.race([ready.then(() => true), new Promise(resolve => setTimeout(resolve, 0, false))]);
        if (current !== request || shellKey !== adapter.getShellKey()) return;
        const list = adapter.getTabList();
        if (built) {
            renderTabs(visibility);
        } else {
            list?.setAttribute('aria-busy', 'true');
            // Names that match are shown at once; what the pages hold refines them once every page is built.
            if ([...visibility.values()].some(state => state.match)) renderTabs(visibility);
            await ready;
            list?.removeAttribute('aria-busy');
            if (current !== request || shellKey !== adapter.getShellKey()) return;
        }

        if (shellKey !== cachedShellKey) {
            rootGroupsCache.clear();
            cachedShellKey = shellKey;
        }
        applying = true;
        try {
            restoreFilteredRows();
            const analyses = new Map();
            for (const tab of tabs) {
                const roots = adapter.getRoots(tab.id);
                if (roots) analyses.set(tab.id, { roots, ...analyzeSearchRoots(roots, tokens, { isAvailable: adapter.isAvailable, getGroups: getCachedGroups }) });
            }
            const entries = new Map();
            for (const match of adapter.getContentMatches(rawQuery)) {
                if (!textMatchesAll(normalizeSearchText(match.searchText), tokens)) continue;
                if (!entries.has(match.tabId)) entries.set(match.tabId, new Set());
                entries.get(match.tabId).add(match.key);
            }
            for (const tab of tabs) {
                const state = visibility.get(tab.id);
                state.count = (analyses.get(tab.id)?.count ?? 0) + (entries.get(tab.id)?.size ?? 0);
                state.match = state.byName || state.count > 0;
            }
            renderTabs(visibility);

            const activeId = adapter.getActiveTabId();
            const active = analyses.get(activeId);
            const activeState = visibility.get(activeId);
            const shown = active && activeState?.match ? active : null;
            if (shown) {
                // A page that the search names (its name or an alias) shows all of its rows; the others show what matched.
                if (!activeState.byName) {
                    applyRowFilter(shown.groups.filter(group => adapter.canHideRows(group.body)));
                }
                observe(shown.roots, shown.groups);
            } else {
                stopObserving();
            }
            highlight(shown);
            if (reveal || activeChanged) {
                scheduleReveal(shown, `${shellKey}:${activeId}:${tokens.join(' ')}`, activeChanged ? ACTIVATION_REVEAL_DELAY_MS : REVEAL_DELAY_MS);
            }
        } finally {
            applying = false;
            structureObserver?.takeRecords();
            hiddenObserver?.takeRecords();
        }
    }

    function clear() {
        request += 1;
        tokens = [];
        rawQuery = '';
        lastRevealKey = '';
        cachedShellKey = null;
        rootGroupsCache.clear();
        clearTimeout(revealTimer);
        stopObserving();
        adapter.getTabList()?.removeAttribute('aria-busy');
        restoreFilteredRows();
        clearTextHighlights();
        document.querySelectorAll('.highlighted-drawer').forEach(element => element.classList.remove('highlighted-drawer'));
        renderTabs(new Map());
    }

    return {
        /** Applies a query typed in the search field; an empty one restores everything at once. */
        update(query) {
            const next = tokenizeQuery(query);
            if (!next.length) {
                clear();
                return Promise.resolve();
            }
            rawQuery = String(query ?? '');
            if (next.join(' ') !== tokens.join(' ')) lastRevealKey = '';
            tokens = next;
            return run();
        },
        /** The open page changed: filter its rows now that it is shown. */
        async activate(tabId) {
            if (!tokens.length) return;
            const current = request;
            await adapter.whenTabReady(tabId);
            if (current !== request || !tokens.length) return;
            rootGroupsCache.clear();
            await run({ reveal: false, activeChanged: true });
        },
        clear,
        isActive: () => tokens.length > 0,
    };
}
