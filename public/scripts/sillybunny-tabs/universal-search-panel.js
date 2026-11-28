import {
    clampMobileShellText as clampText,
    normalizeMobileShellText as normalizeText,
} from '../mobile-shell-lifecycle/index.js';
import {
    animateIn,
    MOTION_FAST,
    stopMotion,
} from '../sillybunny-motion.js';
import { escapeRegex } from '../util/escape-regex.js';
import { t } from '../i18n.js';
import {
    SB_FLAT_SECTION_CLASS,
    SB_FLAT_SECTION_HEADER_CLASS,
} from '../sillybunny-settings-content.js';
import { SB_SUBPAGE_STORE_CLASS } from '../sillybunny-settings-subpage.js';
import { createStatusPage } from '../sillybunny-editor/status-page.js';
import { collectEntitySearchEntries, primeWorldInfoSearchCache } from '../sillybunny-search-entities.js';

// Row subtitles and section meta lines describe a setting rather than name it: they stay searchable,
// but folding them into `textContent` would turn every label into "NameDescription". Placeholder copy is
// unwritten filler and is neither searchable nor shown.
const SB_SEARCH_DESCRIPTION_SELECTOR = [
    '.ds-row-subtitle',
    '.sb-group-meta',
    '.sb-settings-category-heading > small',
    `.${SB_FLAT_SECTION_HEADER_CLASS} > .flex-container > small`,
].join(', ');
const SB_SEARCH_PLACEHOLDER_SELECTOR = '[data-sb-copy-placeholder]';

/** Text inside `element`, leaving out descendants matching `skipSelector`. */
function getSearchNodeText(element, skipSelector) {
    if (!element.querySelector(skipSelector)) {
        return element.textContent ?? '';
    }
    const parts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const skipped = node.parentElement?.closest(skipSelector);
        if (skipped && skipped !== element && element.contains(skipped)) continue;
        parts.push(node.data);
    }
    return parts.join(' ');
}

/** The name a row or heading shows, without its description or placeholder copy. */
function getSearchLabelText(element) {
    return getSearchNodeText(element, `${SB_SEARCH_DESCRIPTION_SELECTOR}, ${SB_SEARCH_PLACEHOLDER_SELECTOR}`);
}

function getSearchTextCandidates(element) {
    const extensionContainer = element.closest('.extension_container');
    const extensionName = extensionContainer?.querySelector('.extension_name')?.textContent ?? '';
    const candidates = [
        element.dataset.sbSearchLabel,
        element.matches('.extension_name') ? element.textContent : '',
        extensionName,
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.placeholder : '',
        element instanceof HTMLSelectElement ? element.selectedOptions?.[0]?.textContent : '',
        element.matches('.range-block, .range-block-title, .range-block-header')
            ? element.closest('.range-block')?.querySelector('.range-block-title, .range-block-header, label, strong, h4, h5')?.textContent
            : '',
        element.matches('.extension_container, .extension_name')
            ? extensionContainer?.querySelector('.extension_name, .inline-drawer-header, .inline-drawer-toggle, h3, h4, strong')?.textContent
            : '',
        getSearchLabelText(element),
    ];

    return candidates
        .map(candidate => String(candidate ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .filter((candidate, index, collection) => collection.indexOf(candidate) === index);
}

function getSearchDisplayText(element, fallback = '') {
    const candidates = getSearchTextCandidates(element);
    const normalizedFallback = normalizeText(fallback);
    const preferredCandidate = candidates.find(candidate => normalizeText(candidate) !== normalizedFallback);
    return clampText(preferredCandidate || candidates[0] || fallback, 110);
}

function getSearchText(element, sectionLabel = '', includeCategoryDescription = false) {
    const descriptionRoot = includeCategoryDescription && element.matches('.sb-settings-category-title')
        ? element.closest('.sb-settings-category-heading') ?? element
        : element;
    return normalizeText([
        ...getSearchTextCandidates(element),
        getSearchNodeText(descriptionRoot, SB_SEARCH_PLACEHOLDER_SELECTOR),
        sectionLabel,
    ].join(' '));
}

function getSearchSectionLabel(element, fallback) {
    const sampler = element.closest('.ds-row-expander[data-sb-sampling-control]');
    const samplerTitle = sampler?.querySelector(':scope > .ds-row-expander__header .ds-row-label')?.textContent.trim();
    if (samplerTitle) return samplerTitle;
    // For extension containers: use the extension's own name/header, not the parent tab label
    const extContainer = element.closest('.extension_container, [id$="-container"]');
    if (extContainer instanceof HTMLElement) {
        const extName = extContainer.querySelector('.extension_name')
            ?? extContainer.querySelector(':scope > .inline-drawer > .inline-drawer-toggle b, :scope > .inline-drawer > .inline-drawer-header b')
            ?? extContainer.querySelector(':scope > .inline-drawer > .inline-drawer-toggle, :scope > .inline-drawer > .inline-drawer-header')
            ?? extContainer.querySelector('h3, h4, strong');
        if (extName) {
            const text = String(extName.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (text) return text;
        }
    }

    // Walk up to the nearest inline-drawer and use its toggle header as the section
    const inlineDrawer = element.closest('.inline-drawer');
    if (inlineDrawer instanceof HTMLElement) {
        const toggle = inlineDrawer.querySelector(':scope > .inline-drawer-toggle');
        if (toggle) {
            const text = getSearchLabelText(toggle).replace(/\s+/g, ' ').trim();
            if (text && text !== fallback) return text;
        }
    }

    // Flattened subsections are no longer drawers, so they are checked separately: without this a
    // control lifted out of, say, Auto-swipe would report the enclosing drawer's name instead.
    const flatSection = element.closest(`.${SB_FLAT_SECTION_CLASS}`);
    if (flatSection instanceof HTMLElement) {
        const heading = flatSection.querySelector(`:scope > .${SB_FLAT_SECTION_HEADER_CLASS}`);
        const text = (heading ? getSearchLabelText(heading) : '').replace(/\s+/g, ' ').trim();
        if (text && text !== fallback) return text;
    }

    // A group that SillyBunny builds names itself by its heading.
    const labelledGroup = element.closest('[data-sb-category] > .ds-pref-group[aria-labelledby]');
    const groupHeading = labelledGroup ? document.getElementById(labelledGroup.getAttribute('aria-labelledby') ?? '') : null;
    const groupText = (groupHeading ? getSearchLabelText(groupHeading) : '').replace(/\s+/g, ' ').trim();
    if (groupText && groupText !== fallback) return groupText;

    const preferred = element.closest('.bg-header-row-1')
        ?? element.closest('.bg-header-row-2')
        ?? element.closest('label, h3, h4, h5, strong');

    const text = (preferred ? getSearchLabelText(preferred) : String(fallback ?? '')).replace(/\s+/g, ' ').trim();
    return text || fallback;
}

// Ranking is coarse on purpose: an exact query name beats a prefix, a prefix beats a word-start,
// and a section heading beats a leaf control. Length is only a tiebreak, so a long descriptive row
// cannot outrank the setting it describes.
function getSearchMatchScore(entry, normalizedQuery, headingMatch) {
    const searchText = entry.searchText;
    const exactMatch = searchText === normalizedQuery;
    const startsWithQuery = searchText.startsWith(normalizedQuery);
    const wordMatch = !exactMatch && !startsWithQuery
        && new RegExp(`(^|\\s)${escapeRegex(normalizedQuery)}`).test(searchText);
    return Number(exactMatch) * 100
        + Number(startsWithQuery) * 20
        + Number(wordMatch) * 8
        + Number(headingMatch) * 5
        - Math.min(entry.displayText.length, 400) / 1000;
}

function getSearchMatchKey(shellKey, entry) {
    return [
        shellKey,
        entry.dedupeKey || [
            entry.tabId,
            normalizeText(entry.sectionLabel),
            normalizeText(entry.displayText),
        ].filter(Boolean).join('::'),
    ].filter(Boolean).join('::');
}

function createPageSearchEntry(tabState) {
    const heading = tabState.panel?.querySelector(`.${SB_FLAT_SECTION_HEADER_CLASS}, h3, h4, .standoutHeader`);
    const searchText = normalizeText([
        tabState.label,
        tabState.id,
        ...(tabState.searchAliases ?? []),
    ].join(' '));
    if (searchText.length < 3) {
        return null;
    }
    return {
        element: heading instanceof HTMLElement ? heading : null,
        searchText,
        displayText: tabState.label,
        sectionLabel: tabState.label,
        tabId: tabState.id,
        tabLabel: tabState.label,
        headingMatch: true,
        dedupeKey: `${tabState.id}::page`,
    };
}

export function createUniversalSearchController({
    sbState,
    sbSubpageStacks,
    sbSearchRenderRequests,
    SB_SEARCH_TARGET_SELECTOR,
    SB_SIDEBAR_SECTION_MATCH_SELECTOR,
    SB_CHARACTER_PANEL_TABS,
    SB_UNIVERSAL_SEARCH_IDLE_TITLE,
    SB_UNIVERSAL_SEARCH_IDLE_HINT,
    SB_UNIVERSAL_SEARCH_EMPTY_HINT,
    SB_UNIVERSAL_SEARCH_RESULT_LIMIT,
    SB_UNIVERSAL_SEARCH_GROUP_LIMIT,
    SB_UNIVERSAL_ENTITY_SCAN_LIMIT,
    createElement,
    getShellConfig,
    getCharacterPanel,
    getUniversalSearchState,
    getSearchEntryDedupeKey,
    getExtraTabSearchEntries,
    getEntityPersonaSearchEntries,
    createTabSearchIndex,
    isMobileViewport,
    prepareShellSearch,
    setUniversalSearchOpenState,
    scrollElementIntoManagedView,
    getSillyTavernContext,
    scheduleUniversalSearchRender,
}) {
    // Loading one book per keystroke would be a request storm, so entry bodies are primed once when
    // the panel opens under a fixed budget, then the list is repainted with whatever arrived.
    function primeUniversalSearchEntityMetadata() {
        const searchState = getUniversalSearchState();
        if (searchState.entityPrimeStarted) {
            return;
        }
        searchState.entityPrimeStarted = true;
        const skippedWorlds = searchState.skippedWorlds ?? new Set();
        searchState.skippedWorlds = skippedWorlds;
        const names = getSillyTavernContext()?.getWorldInfoNames?.() ?? [];
        void primeWorldInfoSearchCache({ names, skippedWorlds }).then(() => {
            if (getUniversalSearchState().expanded && (getUniversalSearchState().input?.value ?? '').trim()) {
                scheduleUniversalSearchRender({ flush: true });
            }
        }).catch(() => {
            // A failed priming pass leaves world names searchable; only entry bodies are missing.
        });
    }
    function getSubpageSearchRoots(searchRoot) {
        const sections = new Map();
        const headings = [];
        for (const stack of sbSubpageStacks.values()) {
            if (!stack.host.contains(searchRoot) && !searchRoot.contains(stack.host)) {
                continue;
            }
            headings.push(stack.listLead);
            for (const row of stack.rows) {
                const source = row.source?.();
                if (source instanceof HTMLElement) {
                    sections.set(source, row.label);
                }
            }
        }
        return { sections, headings };
    }

    function buildTabSearchIndex(tabState) {
        const searchRoot = tabState.searchRoot;
        if (!(searchRoot instanceof HTMLElement)) {
            return [];
        }

        const entries = [];
        const seen = new Set();
        const pageEntry = createPageSearchEntry(tabState);
        if (pageEntry) {
            entries.push(pageEntry);
        }
        const excludedSelector = [
            '.sb-search-result',
            '.sb-legacy-search-hidden',
            // Unwritten placeholder copy is not a setting.
            SB_SEARCH_PLACEHOLDER_SELECTOR,
            '.sb-theme-card',
        ].join(', ');
        const { sections: subpageSections, headings: subpageHeadings } = getSubpageSearchRoots(searchRoot);
        const searchRoots = [searchRoot, ...subpageHeadings, ...subpageSections.keys()]
            .filter((root, index) => index === 0 || !searchRoot.contains(root));

        // The Editor retains its existing heading and search structure.
        const includeCategoryTitles = tabState.id !== 'editor';
        const targetSelector = includeCategoryTitles
            ? `${SB_SEARCH_TARGET_SELECTOR}, .sb-settings-category-title`
            : SB_SEARCH_TARGET_SELECTOR;
        for (const element of searchRoots.flatMap(root => Array.from(root.querySelectorAll(targetSelector)))) {
            if (!(element instanceof HTMLElement)) {
                continue;
            }

            if (element.closest(excludedSelector)) {
                continue;
            }

            // The title carries the category description in search; indexing its wrapper adds a second result.
            if (includeCategoryTitles && element.matches('.sb-settings-category-header, .sb-settings-flat-header, .inline-drawer-toggle')
                && element.querySelector('.sb-settings-category-title')) {
                continue;
            }

            // SillyBunny: the subpage store is hidden by CSS, and a match there is only reachable
            // through the row that moves its section onto the detail page (see revealSearchMatch).
            // Store content no row presents has no way on screen, so it is left out.
            let subpageLabel = null;
            for (const [section, label] of subpageSections) {
                if (section.contains(element)) {
                    subpageLabel = label;
                    break;
                }
            }
            if (subpageLabel === null && element.closest(`.${SB_SUBPAGE_STORE_CLASS}`)) {
                continue;
            }

            const sectionLabel = subpageLabel ?? getSearchSectionLabel(element, tabState.label);
            const searchText = getSearchText(element, sectionLabel, includeCategoryTitles);
            const displayText = getSearchDisplayText(element, sectionLabel);
            const dedupeKey = getSearchEntryDedupeKey(tabState, sectionLabel, displayText);
            // Identical sampler explanations belong to separate live backend sections. Keep both
            // until availability filtering, or the hidden first backend masks the active one's help.
            const indexDedupeKey = [dedupeKey, element.closest('[data-sb-sampling-apis]')?.id].filter(Boolean).join('::');

            // Keep each backend's category title until the active-backend filter runs.
            if (searchText.length < 3 || (seen.has(indexDedupeKey) && !(includeCategoryTitles && element.matches('.sb-settings-category-title')))) {
                continue;
            }

            seen.add(indexDedupeKey);
            entries.push({
                element,
                searchText,
                displayText,
                sectionLabel,
                tabId: tabState.id,
                tabLabel: tabState.label,
                dedupeKey,
            });
        }

        return entries;
    }

    function getCharacterPanelSearchEntries() {
        const panel = getCharacterPanel();

        return SB_CHARACTER_PANEL_TABS.map((tab) => {
            const button = panel?.querySelector(`[data-sb-character-tab="${CSS.escape(tab.id)}"]`);
            const searchText = normalizeText([
                tab.label,
                tab.id,
                'characters',
                ...(tab.searchAliases ?? []),
            ].join(' '));

            return {
                element: button instanceof HTMLElement ? button : null,
                searchText,
                displayText: tab.label,
                sectionLabel: tab.label,
                tabId: tab.id,
                tabLabel: tab.label,
                headingMatch: true,
                dedupeKey: `characters::${tab.id}`,
            };
        });
    }

    function computeSearchEntryAvailability(entry, tabState) {
        // Keep both device variants indexed so resizing can reveal the newly available controls.
        const unavailableDevice = isMobileViewport() ? '.sb-desktop-setting' : '.sb-mobile-setting';
        if (entry.element instanceof HTMLElement && entry.element.closest(unavailableDevice)) return false;
        if (!['sampling', 'prompting', 'editor'].includes(tabState.id)) return true;
        if (!(entry.element instanceof HTMLElement) || !tabState.searchRoot.contains(entry.element)) return false;
        for (let element = entry.element; element && element !== tabState.searchRoot; element = element.parentElement) {
            // Collapsed sampler help and closed expanders are searchable; their provider/card ancestors still gate availability.
            if (element.matches('.sb-sampling-help[hidden], .ds-row-expander-content[hidden]')) continue;
            if (element.hidden || getComputedStyle(element).display === 'none') return false;
        }
        return true;
    }

    function isSearchEntryAvailable(entry, tabState, availableByEntry = null) {
        if (availableByEntry?.has(entry)) {
            return availableByEntry.get(entry);
        }
        const available = computeSearchEntryAvailability(entry, tabState);
        availableByEntry?.set(entry, available);
        return available;
    }

    function collectGlobalSearchMatches(query, { limit = Infinity, includeEntities = true } = {}) {
        const normalizedQuery = normalizeText(query);

        if (!normalizedQuery) {
            return [];
        }

        const searchTerms = normalizedQuery.split(' ').filter(Boolean);
        const matches = new Map();
        const availableByEntry = new WeakMap();

        for (const [shellKey, shellState] of Object.entries(sbState.shells)) {
            const shellLabel = getShellConfig(shellKey)?.title || shellKey;

            for (const tabState of shellState.tabs.values()) {
                if (!tabState.searchIndex) {
                    tabState.searchIndex = createTabSearchIndex(tabState);
                }

                const extraEntries = getExtraTabSearchEntries(tabState);

                for (const entry of [...(tabState.id === 'agents' ? [] : tabState.searchIndex), ...extraEntries]) {
                    // Match first: the visibility check walks ancestors with `getComputedStyle`, and the
                    // memo only covers repeated rows, so this filter is what keeps a keystroke cheap.
                    if (!searchTerms.every(term => entry.searchText.includes(term))) {
                        continue;
                    }
                    if (!isSearchEntryAvailable(entry, tabState, availableByEntry)) continue;

                    // Whether the hit names a section rather than a control. The universal search panel
                    // uses this for ranking; the sidebar needs it to tell a page-level hit from a control.
                    const headingMatch = entry.headingMatch === true || (entry.element instanceof HTMLElement
                        && (entry.element.matches(SB_SIDEBAR_SECTION_MATCH_SELECTOR)
                            || (tabState.id !== 'editor' && entry.element.matches('.sb-settings-category-title'))));
                    const match = {
                        ...entry,
                        shellKey,
                        shellLabel,
                        headingMatch,
                        score: getSearchMatchScore(entry, normalizedQuery, headingMatch),
                    };
                    const matchKey = getSearchMatchKey(shellKey, entry);
                    const existingMatch = matches.get(matchKey);
                    const shouldReplaceMatch = !existingMatch
                        || match.score > existingMatch.score
                        || (match.score === existingMatch.score
                            && typeof match.action === 'function'
                            && typeof existingMatch.action !== 'function');

                    if (shouldReplaceMatch) {
                        matches.set(matchKey, match);
                    }
                }
            }
        }

        // Characters, groups, World Info books and personas live outside sbState.shells; their entries
        // come from app data rather than the tab DOM.
        if (includeEntities) {
            const searchState = getUniversalSearchState();
            const personas = getEntityPersonaSearchEntries();
            const entities = [
                ...getCharacterPanelSearchEntries(),
                ...personas,
                ...collectEntitySearchEntries(normalizedQuery, {
                    limit: SB_UNIVERSAL_ENTITY_SCAN_LIMIT,
                    skippedWorlds: searchState.skippedWorlds,
                }),
            ];
            for (const entry of entities) {
                if (!searchTerms.every(term => entry.searchText.includes(term))) continue;
                const headingMatch = entry.headingMatch !== false;
                matches.set(getSearchMatchKey('characters', entry), {
                    ...entry,
                    shellKey: 'characters',
                    shellLabel: 'Characters',
                    headingMatch,
                    score: getSearchMatchScore(entry, normalizedQuery, headingMatch),
                });
            }
        }

        // A stable tiebreak keeps the panel from reshuffling equal scores between keystrokes.
        return Array.from(matches.values())
            .sort((left, right) => right.score - left.score
                || left.displayText.localeCompare(right.displayText))
            .slice(0, limit);
    }

    function createUniversalSearchShowAllRow(hiddenCount, groupLabel = '') {
        const row = createElement('button', {
            className: 'sb-search-show-all',
            attrs: {
                type: 'button',
                'data-sb-search-show-all': 'true',
            },
        });
        row.appendChild(createElement('strong', {
            text: groupLabel
                ? `Show ${hiddenCount} More in ${groupLabel}`
                : `Show All ${hiddenCount} More Results`,
        }));
        row.addEventListener('click', () => {
            const searchState = getUniversalSearchState();
            searchState.expandedAll = true;
            // Go through the open-state setter: it is the path that repaints an already-open panel.
            setUniversalSearchOpenState(true);
        });
        return row;
    }

    function renderSearchEmptyState(container, title, detail, state = 'no-results') {
        container.replaceChildren();

        const empty = createElement('div', { className: 'sb-search-empty' });
        empty.append(createStatusPage({ state, icon: 'magnifying-glass', title, description: detail, compact: true }).element);
        container.appendChild(empty);
    }

    function setUniversalSearchActiveIndex(index) {
        const searchState = getUniversalSearchState();
        const results = searchState.results;
        const input = searchState.input;

        if (!(results instanceof HTMLElement)) {
            return;
        }

        const buttons = Array.from(results.querySelectorAll('.sb-search-result'));
        searchState.activeIndex = buttons.length ? Math.min(Math.max(index, 0), buttons.length - 1) : -1;

        for (let i = 0; i < buttons.length; i++) {
            const button = buttons[i];
            const active = i === searchState.activeIndex;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', String(active));
            if (active) {
                input?.setAttribute('aria-activedescendant', button.id);
                scrollElementIntoManagedView(button, { block: 'nearest' });
            }
        }

        if (searchState.activeIndex === -1) {
            input?.removeAttribute('aria-activedescendant');
        }
    }

    async function renderUniversalSearchResults(query) {
        const searchState = getUniversalSearchState();
        const results = searchState.results;

        if (!(results instanceof HTMLElement)) {
            return;
        }

        const request = Symbol();
        sbSearchRenderRequests.set(results, request);

        const clearResults = () => {
            results.replaceChildren();
            searchState.activeIndex = -1;
            searchState.input?.removeAttribute('aria-activedescendant');
        };

        if (!searchState.expanded) {
            clearResults();
            results.classList.remove('is-visible');
            return;
        }

        const trimmedQuery = String(query ?? '').trim();

        // A new query starts from the short list: "show all" belongs to the query it was asked for.
        if (trimmedQuery !== searchState.renderedQuery) {
            searchState.renderedQuery = trimmedQuery;
            searchState.expandedAll = false;
        }

        if (!trimmedQuery) {
            results.removeAttribute('aria-busy');
            clearResults();
            renderSearchEmptyState(results, SB_UNIVERSAL_SEARCH_IDLE_TITLE, SB_UNIVERSAL_SEARCH_IDLE_HINT, 'empty');
            results.classList.add('is-visible');
            return;
        }

        // The first query waits for the on-demand settings pages. The list keeps what it shows (the idle state, or the
        // last answer) until the new answer replaces it in one step, so it is never blank while the pages load.
        results.setAttribute('aria-busy', 'true');
        await prepareShellSearch();
        if (sbSearchRenderRequests.get(results) !== request) return;
        results.removeAttribute('aria-busy');
        if (!searchState.expanded) return;
        clearResults();
        const matches = collectGlobalSearchMatches(trimmedQuery, {
            limit: searchState.expandedAll ? Infinity : SB_UNIVERSAL_SEARCH_RESULT_LIMIT,
        });

        // Rows are deduped on what the panel actually shows, so two controls that read identically in
        // one section collapse to one destination instead of filling the list twice.
        const groupedMatches = new Map();
        for (const match of matches) {
            const groupLabel = `${match.shellLabel} · ${match.tabLabel}`;
            if (!groupedMatches.has(groupLabel)) {
                groupedMatches.set(groupLabel, new Map());
            }
            const groupMatches = groupedMatches.get(groupLabel);
            const rowKey = [match.dedupeKey, match.sectionLabel, match.displayText]
                .map(value => normalizeText(value))
                .join('::');
            const existing = groupMatches.get(rowKey);
            if (!existing || match.score > existing.score) {
                groupMatches.set(rowKey, match);
            }
        }

        const totalMatches = matches.length;
        const perGroupLimit = searchState.expandedAll ? Infinity : SB_UNIVERSAL_SEARCH_GROUP_LIMIT;
        // Rows are addressed by position, not by the element: a debounced re-render can replace a row
        // between the pointerdown and the click, and a handler bound to the dead node would do nothing.
        const rows = [];
        searchState.renderedRows = rows;

        for (const [groupLabel, groupMatches] of groupedMatches.entries()) {
            const group = createElement('div', {
                className: 'sb-search-result-group',
                attrs: {
                    role: 'group',
                    'aria-label': groupLabel,
                },
            });
            group.appendChild(createElement('div', { className: 'sb-search-result-group-label', text: groupLabel }));

            let shown = 0;
            // Two cards can legitimately share a name, so identical rows are counted rather than hidden:
            // three "Bunny Guide" results would otherwise read as three destinations when they are one.
            const shownCounts = new Map();
            for (const match of groupMatches.values()) {
                if (shown >= perGroupLimit) break;
                shown += 1;
                const sectionDisplay = match.sectionLabel === match.tabLabel
                    ? match.displayText || match.tabLabel
                    : match.sectionLabel;
                const duplicateKey = `${sectionDisplay}::${match.displayText}`;
                shownCounts.set(duplicateKey, (shownCounts.get(duplicateKey) ?? 0) + 1);
                const duplicateIndex = shownCounts.get(duplicateKey);

                const rowIndex = rows.length;
                rows.push(match);
                const button = createElement('button', {
                    className: 'sb-search-result',
                    attrs: {
                        type: 'button',
                        role: 'option',
                        id: `sb-search-result-${rowIndex}`,
                        'data-sb-search-row': String(rowIndex),
                        'aria-selected': 'false',
                    },
                });
                const detailText = normalizeText(match.displayText) === normalizeText(match.sectionLabel)
                    ? `Jump straight to this item in ${match.tabLabel}.`
                    : match.displayText;

                button.appendChild(createElement('strong', { text: match.description !== undefined ? match.displayText : sectionDisplay }));

                if (match.description !== undefined || sectionDisplay !== match.displayText) {
                    button.appendChild(createElement('span', { text: match.description ?? detailText }));
                }

                button.appendChild(createElement('small', {
                    text: match.locationLabel ? `${groupLabel} · ${match.sectionLabel}` : typeof match.action === 'function' ? 'Quick action' : 'Jump to setting',
                }));

                if (duplicateIndex > 1) {
                    button.classList.add('is-duplicate');
                    button.setAttribute('data-sb-search-duplicate', String(duplicateIndex));
                }

                group.appendChild(button);
            }

            const hiddenInGroup = groupMatches.size - shown;
            if (hiddenInGroup > 0) {
                group.appendChild(createUniversalSearchShowAllRow(hiddenInGroup, groupLabel));
            }

            results.appendChild(group);
        }

        if (!results.childElementCount) {
            renderSearchEmptyState(
                results,
                t`No Results Found`,
                SB_UNIVERSAL_SEARCH_EMPTY_HINT,
            );
        } else if (!searchState.expandedAll && totalMatches > rows.length) {
            results.appendChild(createUniversalSearchShowAllRow(totalMatches - rows.length));
        }

        const wasVisible = results.classList.contains('is-visible');
        results.classList.add('is-visible');

        // Animate the results panel on first appearance
        if (!wasVisible) {
            stopMotion(results);
            animateIn(results, [
                { opacity: 0, transform: 'translateY(-4px)' },
                { opacity: 1, transform: 'translateY(0)' },
            ], { duration: MOTION_FAST });
        }

        setUniversalSearchActiveIndex(results.querySelector('.sb-search-result') ? 0 : -1);
    }

    return {
        primeUniversalSearchEntityMetadata,
        buildTabSearchIndex,
        collectGlobalSearchMatches,
        renderUniversalSearchResults,
        setUniversalSearchActiveIndex,
    };
}
