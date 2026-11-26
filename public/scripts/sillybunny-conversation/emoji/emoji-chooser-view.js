/**
 * The inside of the emoji chooser: a search entry, a listbox of sections of emoji cells, and a toolbar with a button for
 * each section. It knows nothing about popovers, sheets, the composer or messages: `emoji-chooser.js` puts it in a surface
 * and the callers hand it what a pick does. Every effect that touches the outside comes in as an option (`requestClose`,
 * `recordRecent`, `onPick`, `schedule`, `columns`), so a test runs it in jsdom.
 *
 * - One Tab stop in the grid (roving `tabindex`); the arrows, Home, End and the page keys follow `emoji-grid-nav.js`.
 * - A section is built when it is first needed: the first one at once, the others one chunk per task, so that no task
 *   builds more than `SECTION_CHUNK` cells. A section that is not built keeps its height (`--sb-emoji-rows`), so the
 *   scrollbar and the jumps are right without its cells. A jump or a move into a section builds it first.
 * - A cell is a `role="option"` button named by the CLDR name of the emoji, in a `role="group"` that the heading names.
 *   The cell that has skin tones carries `data-variants`; a long press, a secondary click, Shift+F10 and the Menu key open them.
 */

import { createGridModel, moveInGrid } from './emoji-grid-nav.js';
import { searchRows } from './emoji-search.js';

/** The most cells that one task builds. About 0.17 ms a cell at 4x CPU in Chromium, so a chunk stays far below the 100 ms budget. */
export const SECTION_CHUNK = 96;
const SEARCH_LIMIT = 200;
const LONG_PRESS_MS = 380;
const LONG_PRESS_MOVE_PX = 8;
/** A click comes in the same task as the pointerup that ends a long press; a flag that is still set after this was for a click that never came (the finger left the cell). */
const CLICK_AFTER_RELEASE_MS = 100;
const SKIN_TONE_FIRST = 0x1F3FB;
const SKIN_TONE_LAST = 0x1F3FF;
const FALLBACK_COLUMNS = 8;
const FALLBACK_PAGE_ROWS = 4;
const PAIR_VARIANTS = 25;
const GROUP_ICONS = Object.freeze(['face-smile', 'hand', 'paw', 'utensils', 'car', 'futbol', 'lightbulb', 'icons', 'flag']);

let instanceCount = 0;

function el(tag, className, attributes = {}) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    for (const [name, value] of Object.entries(attributes)) {
        node.setAttribute(name, value);
    }
    return node;
}

function icon(name) {
    return el('i', `fa-solid fa-${name}`, { 'aria-hidden': 'true' });
}

function isToneModifier(character) {
    const point = character.codePointAt(0);
    return point >= SKIN_TONE_FIRST && point <= SKIN_TONE_LAST;
}

/**
 * @param {object} options
 * @param {HTMLElement} [options.root]
 * @param {'insert'|'react'} options.kind
 * @param {Array<{ e: string, n?: string }>} options.recents The chooser's recents, newest first.
 * @param {(emoji: string) => boolean} [options.isPicked] For `react`: whether the message already has this emoji.
 * @param {() => number} [options.columns] How many cells a line has. Read from the layout when not given.
 * @param {boolean} [options.touch] The first focus goes to the grid and not to the search entry.
 * @param {(task: () => void) => void} [options.schedule] Runs a task in a later turn of the event loop.
 * @param {() => void} options.requestClose Closes the surface.
 * @param {(entry: { e: string, n: string }) => void} options.recordRecent
 * @param {(emoji: string, details: { name: string, keepOpen: boolean }) => void} options.onPick
 * @param {() => Promise<import('./emoji-table.js').EmojiTable>} [options.loadEnglish] The English table, for a query that the language of the interface does not find.
 */
export function createChooserView({
    root = document.createElement('div'),
    kind,
    recents,
    isPicked = null,
    columns = null,
    touch = false,
    schedule = task => setTimeout(task, 0),
    requestClose,
    recordRecent,
    onPick,
    loadEnglish = null,
}) {
    const prefix = `sb-emoji-${++instanceCount}`;
    const state = {
        table: null,
        names: new Map(),
        sections: [],
        results: null,
        mode: 'sections',
        active: null,
        searchToken: 0,
        buildScheduled: false,
        variants: null,
        pressTimer: 0,
        pressOrigin: null,
        swallowClick: false,
        swallowTimer: 0,
        disposed: false,
    };

    root.className = 'sb-emoji-chooser';
    root.dataset.kind = kind;
    root.dataset.state = 'loading';
    root.dataset.mode = 'sections';

    const searchEntry = el('input', 'sb-emoji-search-entry', {
        'type': 'search',
        'aria-label': 'Search Emoji',
        'placeholder': 'Search Emoji…',
        'autocomplete': 'off',
        'autocapitalize': 'off',
        'spellcheck': 'false',
        'enterkeyhint': 'search',
    });
    const searchBar = el('div', 'sb-emoji-search');
    searchBar.append(searchEntry);
    const scroller = el('div', 'sb-emoji-scroller', { 'role': 'listbox', 'aria-label': 'Emoji', 'tabindex': '-1' });
    const live = el('div', 'sb-emoji-live sr-only', { role: 'status' });
    const categories = el('div', 'sb-emoji-categories', { 'role': 'toolbar', 'aria-label': 'Categories' });
    root.append(searchBar, scroller, live, categories);

    const getColumns = () => {
        if (columns) {
            return columns();
        }
        const grid = scroller.querySelector('.sb-emoji-grid[data-built="true"], .sb-emoji-grid');
        const tracks = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
        return tracks || FALLBACK_COLUMNS;
    };

    // ---------------------------------------------------------------------------------------------------------------
    // Names and sections

    /** The name of an emoji, a skin tone variant included: the base name and the tone, as the table's own names read. */
    function indexNames(table) {
        state.names = new Map();
        for (const row of table.rows) {
            state.names.set(row[0], row[1]);
            for (const variant of row[5] ?? []) {
                state.names.set(variant, `${row[1]}: ${toneNamesOf(variant)}`);
            }
        }
    }

    function toneNamesOf(variant) {
        const tones = [];
        for (const character of variant) {
            if (isToneModifier(character)) {
                const tone = character.codePointAt(0) - SKIN_TONE_FIRST;
                if (!tones.includes(tone)) {
                    tones.push(tone);
                }
            }
        }
        return tones.map(tone => state.table.tones[tone]).join(', ');
    }

    const itemOfRow = row => ({ emoji: row[0], name: row[1], variants: row[5] ?? null });

    function makeSection(key, label, items, headingId) {
        const section = { key, label, items, cells: [], built: false, el: null, grid: null };
        section.el = el('div', 'sb-emoji-section', { role: 'presentation' });
        section.el.dataset.section = key;
        section.el.dataset.built = 'false';
        // A div, not an h3: the global h3 rule of the theme draws a boxed header, and the group is named by this element through aria-labelledby.
        const heading = el('div', 'sb-emoji-heading', { id: headingId });
        heading.textContent = label;
        section.grid = el('div', 'sb-emoji-grid', { 'role': 'group', 'aria-labelledby': headingId });
        section.el.append(heading, section.grid);
        reserveHeight(section);
        return section;
    }

    function reserveHeight(section) {
        section.el.style.setProperty('--sb-emoji-rows', String(Math.ceil(section.items.length / Math.max(1, getColumns()))));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Cells

    function createCell(item, sectionIndex, index) {
        const cell = el('button', 'sb-emoji-cell', { 'type': 'button', 'role': 'option', 'tabindex': '-1', 'aria-label': item.name || item.emoji });
        cell.dataset.emoji = item.emoji;
        cell.dataset.section = String(sectionIndex);
        cell.dataset.index = String(index);
        cell.textContent = item.emoji;
        if (item.variants?.length) {
            cell.dataset.variants = String(item.variants.length);
            cell.append(el('span', 'sb-emoji-variant-mark', { 'aria-hidden': 'true' }));
        }
        if (isPicked) {
            cell.setAttribute('aria-selected', String(Boolean(isPicked(item.emoji))));
        }
        return cell;
    }

    const activeSections = () => (state.mode === 'results' && state.results ? [state.results] : state.sections);

    function fillChunk(section) {
        const sectionIndex = activeSections().indexOf(section);
        const fragment = document.createDocumentFragment();
        const end = Math.min(section.items.length, section.cells.length + SECTION_CHUNK);
        for (let index = section.cells.length; index < end; index++) {
            const cell = createCell(section.items[index], sectionIndex, index);
            section.cells.push(cell);
            fragment.append(cell);
        }
        section.grid.append(fragment);
        if (section.cells.length === section.items.length) {
            section.built = true;
            section.el.dataset.built = 'true';
        }
    }

    function scheduleBuild() {
        if (state.buildScheduled || state.disposed) {
            return;
        }
        state.buildScheduled = true;
        schedule(() => {
            state.buildScheduled = false;
            if (state.disposed) {
                return;
            }
            const next = activeSections().find(section => !section.built);
            if (!next) {
                return;
            }
            fillChunk(next);
            if (activeSections().some(section => !section.built)) {
                scheduleBuild();
            }
        });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The roving focus

    const modelOf = () => createGridModel(activeSections().map(section => section.items.length), getColumns());

    /** The cell, built first when it is in a chunk that is not there yet. */
    function cellAt(position) {
        const section = activeSections()[position.section];
        if (!section || position.index >= section.items.length) {
            return null;
        }
        while (section.cells.length <= position.index) {
            fillChunk(section);
        }
        return section.cells[position.index];
    }

    function setActive(position, { focus = false } = {}) {
        const cell = cellAt(position);
        if (!cell) {
            return null;
        }
        const previous = state.active ? activeSections()[state.active.section]?.cells[state.active.index] : null;
        previous?.setAttribute('tabindex', '-1');
        cell.setAttribute('tabindex', '0');
        state.active = position;
        if (focus) {
            cell.focus();
        }
        markCurrent(position.section);
        return cell;
    }

    function positionOf(cell) {
        return { section: Number(cell.dataset.section), index: Number(cell.dataset.index) };
    }

    function markCurrent(sectionIndex) {
        if (state.mode !== 'sections') {
            return;
        }
        [...categories.children].forEach((button, index) => {
            if (index === sectionIndex) {
                button.setAttribute('aria-current', 'true');
            } else {
                button.removeAttribute('aria-current');
            }
        });
    }

    function jumpToSection(sectionIndex) {
        const section = state.sections[sectionIndex];
        if (!section) {
            return;
        }
        if (section.cells.length === 0) {
            fillChunk(section);
        }
        scroller.scrollTop = section.el.offsetTop;
        markCurrent(sectionIndex);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Picking

    function commit({ emoji, name }, { keepOpen }) {
        recordRecent({ e: emoji, n: name });
        if (!keepOpen) {
            requestClose();
        }
        onPick(emoji, { name, keepOpen });
        if (keepOpen) {
            closeVariants({ restoreFocus: true });
            refreshSelection();
        }
    }

    function commitCell(cell, keepOpen) {
        commit({ emoji: cell.dataset.emoji, name: cell.getAttribute('aria-label') }, { keepOpen });
    }

    function refreshSelection() {
        if (!isPicked) {
            return;
        }
        for (const section of activeSections()) {
            for (const cell of section.cells) {
                cell.setAttribute('aria-selected', String(Boolean(isPicked(cell.dataset.emoji))));
            }
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Skin tones

    function closeVariants({ restoreFocus = false } = {}) {
        if (!state.variants) {
            return;
        }
        const { panel, source } = state.variants;
        state.variants = null;
        panel.remove();
        if (restoreFocus && source.isConnected) {
            source.focus();
        }
    }

    function openVariants(cell) {
        if (state.variants?.source === cell) {
            return;
        }
        closeVariants();
        const item = activeSections()[Number(cell.dataset.section)]?.items[Number(cell.dataset.index)];
        if (!item?.variants?.length) {
            return;
        }
        const baseName = item.name || item.emoji;
        const panel = el('div', 'sb-emoji-variants', { 'role': 'listbox', 'aria-label': baseName });
        panel.dataset.count = String(item.variants.length);
        const entries = [{ emoji: item.emoji, name: baseName }, ...item.variants.map(variant => ({ emoji: variant, name: state.names.get(variant) ?? baseName }))];
        entries.forEach((entry, index) => {
            const option = el('button', 'sb-emoji-cell', { 'type': 'button', 'role': 'option', 'tabindex': index === 0 ? '0' : '-1', 'aria-label': entry.name });
            option.dataset.emoji = entry.emoji;
            option.textContent = entry.emoji;
            panel.append(option);
        });
        root.append(panel);
        state.variants = { panel, source: cell };
        positionVariants(panel, cell);
        panel.querySelector('[role="option"]').focus();
    }

    function positionVariants(panel, cell) {
        const rootBox = root.getBoundingClientRect();
        const cellBox = cell.getBoundingClientRect();
        const width = panel.offsetWidth;
        const left = Math.min(Math.max(0, cellBox.left - rootBox.left + cellBox.width / 2 - width / 2), Math.max(0, rootBox.width - width));
        const below = cellBox.bottom - rootBox.top;
        const roomBelow = rootBox.height - below;
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(roomBelow >= panel.offsetHeight + 6 ? below + 4 : Math.max(0, cellBox.top - rootBox.top - panel.offsetHeight - 4))}px`;
    }

    function onVariantsKey(event) {
        const options = [...state.variants.panel.querySelectorAll('[role="option"]')];
        const index = options.indexOf(event.target);
        const width = options.length === PAIR_VARIANTS + 1 ? 5 : options.length;
        let next = -1;
        switch (event.key) {
            case 'Escape':
                event.preventDefault();
                event.stopPropagation();
                closeVariants({ restoreFocus: true });
                return;
            case 'ArrowRight': next = index + 1; break;
            case 'ArrowLeft': next = index - 1; break;
            case 'ArrowDown': next = index + width; break;
            case 'ArrowUp': next = index - width; break;
            case 'Home': next = 0; break;
            case 'End': next = options.length - 1; break;
            case 'Enter':
            case ' ':
                event.preventDefault();
                event.stopPropagation();
                commit({ emoji: event.target.dataset.emoji, name: event.target.getAttribute('aria-label') }, { keepOpen: event.shiftKey });
                return;
            default: return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (options[next]) {
            options[index]?.setAttribute('tabindex', '-1');
            options[next].setAttribute('tabindex', '0');
            options[next].focus();
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Search

    function setStatus(text) {
        live.textContent = text;
    }

    function enterResults(items) {
        state.mode = 'results';
        root.dataset.mode = 'results';
        categories.hidden = true;
        state.results = makeSection('results', 'Search Results', items, `${prefix}-heading-results`);
        scroller.replaceChildren(items.length ? state.results.el : el('p', 'sb-emoji-empty'));
        if (!items.length) {
            scroller.firstChild.textContent = 'No Results';
        }
        state.active = null;
        scroller.scrollTop = 0;
        if (items.length) {
            fillChunk(state.results);
            setActive({ section: 0, index: 0 });
            scheduleBuild();
        }
        setStatus(items.length === 0 ? 'No Results' : `${items.length} ${items.length === 1 ? 'Result' : 'Results'}`);
    }

    function leaveResults() {
        if (state.mode !== 'results') {
            return;
        }
        state.searchToken += 1;
        state.mode = 'sections';
        root.dataset.mode = 'sections';
        state.results = null;
        categories.hidden = false;
        scroller.replaceChildren(...state.sections.map(section => section.el));
        state.sections.forEach(reserveHeight);
        state.active = null;
        const first = createGridModel(state.sections.map(section => section.items.length), getColumns()).first();
        if (first) {
            setActive(first);
        }
        setStatus('');
        scheduleBuild();
    }

    function runSearch(rawQuery) {
        const query = rawQuery.trim();
        closeVariants();
        if (!state.table || !query) {
            leaveResults();
            return;
        }
        const token = ++state.searchToken;
        const rowsOf = table => searchRows(table.getIndex(), query, { limit: SEARCH_LIMIT }).map(position => itemOfRow(table.rows[position]));
        const own = rowsOf(state.table);
        if (own.length || !loadEnglish || state.table.locale === 'en') {
            enterResults(own);
            return;
        }
        loadEnglish().then((english) => {
            if (token === state.searchToken && !state.disposed) {
                indexNames(state.table);
                enterResults(rowsOf(english));
            }
        }, () => {
            if (token === state.searchToken && !state.disposed) {
                enterResults([]);
            }
        });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Keys

    function tabStops() {
        const stops = [searchEntry];
        const gridStop = root.querySelector('.sb-emoji-grid [tabindex="0"]');
        if (gridStop) {
            stops.push(gridStop);
        }
        const toolbarStop = categories.hidden ? null : categories.querySelector('[tabindex="0"]');
        if (toolbarStop) {
            stops.push(toolbarStop);
        }
        const close = root.closest('.sb-action-sheet')?.querySelector('.sb-action-sheet-close');
        if (close) {
            stops.push(close);
        }
        return stops;
    }

    /**
     * Tab goes search, grid, toolbar. The shared popover and sheet trap Tab among every button inside them, which would make
     * each of the thousand cells a stop, so the chooser takes the key before they see it.
     */
    function onTab(event) {
        const stops = tabStops();
        let index = stops.findIndex(stop => stop === event.target || stop.contains(event.target));
        if (index === -1) {
            index = event.shiftKey ? 0 : stops.length - 1;
        }
        const next = stops[(index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length];
        event.preventDefault();
        event.stopPropagation();
        next.focus();
    }

    function pageRows() {
        const cell = scroller.querySelector('.sb-emoji-cell');
        const height = cell?.offsetHeight ?? 0;
        return height > 0 && scroller.clientHeight > 0 ? Math.max(1, Math.floor(scroller.clientHeight / height) - 1) : FALLBACK_PAGE_ROWS;
    }

    function onCellKey(event, cell) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            commitCell(cell, event.shiftKey);
            return;
        }
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
            if (cell.dataset.variants) {
                event.preventDefault();
                openVariants(cell);
            }
            return;
        }
        const model = modelOf();
        const position = positionOf(cell);
        const sectionStep = (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp'))
            ? (event.key === 'ArrowDown' ? 1 : -1)
            : (event.ctrlKey && !event.altKey && !event.metaKey && (event.key === 'n' || event.key === 'p')) ? (event.key === 'n' ? 1 : -1) : 0;
        if (sectionStep !== 0) {
            event.preventDefault();
            event.stopPropagation();
            const target = model.sectionStep(position, sectionStep);
            if (target) {
                if (state.mode === 'sections') {
                    jumpToSection(target.section);
                }
                setActive(target, { focus: true });
            }
            return;
        }
        if (event.altKey || event.metaKey || (event.ctrlKey && event.key !== 'Home' && event.key !== 'End')) {
            return;
        }
        if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const next = moveInGrid(model, position, event.key, { ctrl: event.ctrlKey, pageRows: pageRows() });
        if (next) {
            setActive(next, { focus: true });
        } else if (event.key === 'ArrowUp') {
            searchEntry.focus();
        }
    }

    function onSearchKey(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            const first = state.mode === 'results' ? state.results?.cells[0] : null;
            if (first) {
                commitCell(first, event.shiftKey);
            }
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            const stop = root.querySelector('.sb-emoji-grid [tabindex="0"]');
            stop?.focus();
        }
    }

    function onToolbarKey(event, button) {
        const buttons = [...categories.children];
        const index = buttons.indexOf(button);
        let next = -1;
        if (event.key === 'ArrowRight') {
            next = (index + 1) % buttons.length;
        } else if (event.key === 'ArrowLeft') {
            next = (index - 1 + buttons.length) % buttons.length;
        } else if (event.key === 'Home') {
            next = 0;
        } else if (event.key === 'End') {
            next = buttons.length - 1;
        } else {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        button.setAttribute('tabindex', '-1');
        buttons[next].setAttribute('tabindex', '0');
        buttons[next].focus();
    }

    function onKeydown(event) {
        if (event.key === 'Escape' && state.variants) {
            event.preventDefault();
            event.stopPropagation();
            closeVariants({ restoreFocus: true });
            return;
        }
        if (state.variants?.panel.contains(event.target)) {
            onVariantsKey(event);
            return;
        }
        if (event.key === 'Tab') {
            onTab(event);
            return;
        }
        if (event.target === searchEntry) {
            onSearchKey(event);
            return;
        }
        const cell = event.target.closest?.('.sb-emoji-cell');
        if (cell && scroller.contains(cell)) {
            onCellKey(event, cell);
            return;
        }
        const button = event.target.closest?.('.sb-emoji-categories button');
        if (button) {
            onToolbarKey(event, button);
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Pointer

    function cancelPress() {
        clearTimeout(state.pressTimer);
        state.pressTimer = 0;
        state.pressOrigin = null;
    }

    function onPointerDown(event) {
        const cell = event.target.closest?.('.sb-emoji-grid .sb-emoji-cell');
        if (!cell?.dataset.variants || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) {
            return;
        }
        cancelPress();
        state.pressOrigin = { x: event.clientX, y: event.clientY };
        state.pressTimer = setTimeout(() => {
            state.pressTimer = 0;
            state.swallowClick = true;
            openVariants(cell);
        }, LONG_PRESS_MS);
    }

    function onPointerMove(event) {
        if (state.pressOrigin && Math.hypot(event.clientX - state.pressOrigin.x, event.clientY - state.pressOrigin.y) > LONG_PRESS_MOVE_PX) {
            cancelPress();
        }
    }

    function onClick(event) {
        if (state.swallowClick) {
            state.swallowClick = false;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if (state.variants && !state.variants.panel.contains(event.target)) {
            closeVariants();
        }
        const option = event.target.closest?.('.sb-emoji-variants .sb-emoji-cell');
        if (option) {
            commit({ emoji: option.dataset.emoji, name: option.getAttribute('aria-label') }, { keepOpen: event.shiftKey });
            return;
        }
        const cell = event.target.closest?.('.sb-emoji-scroller .sb-emoji-cell');
        if (cell) {
            setActive(positionOf(cell));
            commitCell(cell, event.shiftKey);
            return;
        }
        const button = event.target.closest?.('.sb-emoji-categories button');
        if (button) {
            const index = [...categories.children].indexOf(button);
            [...categories.children].forEach(item => item.setAttribute('tabindex', item === button ? '0' : '-1'));
            jumpToSection(index);
        }
    }

    function onContextMenu(event) {
        const cell = event.target.closest?.('.sb-emoji-grid .sb-emoji-cell');
        if (cell?.dataset.variants) {
            event.preventDefault();
            openVariants(cell);
        }
    }

    function onScroll() {
        if (state.mode !== 'sections' || !state.sections.length) {
            return;
        }
        const top = scroller.scrollTop + 8;
        let current = 0;
        state.sections.forEach((section, index) => {
            if (section.el.offsetTop <= top) {
                current = index;
            }
        });
        markCurrent(current);
    }

    root.addEventListener('keydown', onKeydown);
    root.addEventListener('click', onClick);
    root.addEventListener('contextmenu', onContextMenu);
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    for (const type of ['pointerup', 'pointercancel']) {
        root.addEventListener(type, () => {
            cancelPress();
            if (state.swallowClick) {
                clearTimeout(state.swallowTimer);
                state.swallowTimer = setTimeout(() => {
                    state.swallowClick = false;
                }, CLICK_AFTER_RELEASE_MS);
            }
        });
    }
    scroller.addEventListener('scroll', onScroll, { passive: true });
    searchEntry.addEventListener('input', () => runSearch(searchEntry.value));

    let resizeObserver = null;
    if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(() => {
            state.sections.filter(section => !section.built).forEach(reserveHeight);
        });
        resizeObserver.observe(scroller);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // States

    function showMessage(stateName, content) {
        root.dataset.state = stateName;
        categories.replaceChildren();
        scroller.replaceChildren(content);
    }

    function showLoading() {
        showMessage('loading', el('p', 'sb-emoji-message'));
        scroller.firstChild.textContent = 'Loading…';
    }

    /** @param {() => void} retry */
    function showError(retry) {
        const message = el('div', 'sb-emoji-message');
        const title = el('p', 'sb-emoji-message-title');
        title.textContent = 'Emoji Unavailable';
        const description = el('p', 'sb-emoji-message-description');
        description.textContent = 'TODO(copy)';
        description.dataset.sbCopyPlaceholder = 'true';
        const again = el('button', 'menu_button sb-emoji-message-retry', { type: 'button' });
        again.textContent = 'Try Again';
        again.addEventListener('click', retry);
        message.append(title, description, again);
        showMessage('error', message);
    }

    function setTable(table) {
        state.table = table;
        indexNames(table);
        state.sections = [];
        const recentItems = recents
            .map(entry => ({ emoji: entry.e, name: entry.n ?? state.names.get(entry.e) ?? entry.e, variants: null }));
        if (recentItems.length) {
            state.sections.push(makeSection('recent', 'Recent', recentItems, `${prefix}-heading-recent`));
        }
        table.groups.forEach((label, group) => {
            const items = table.rows.filter(row => row[3] === group).map(itemOfRow);
            state.sections.push(makeSection(String(group), label, items, `${prefix}-heading-${group}`));
        });

        categories.replaceChildren(...state.sections.map((section, index) => {
            const group = section.key === 'recent' ? null : Number(section.key);
            const button = el('button', 'sb-emoji-category', { 'type': 'button', 'aria-label': section.label, 'title': section.label, 'tabindex': index === 0 ? '0' : '-1' });
            button.append(icon(group === null ? 'clock-rotate-left' : (GROUP_ICONS[group] ?? 'icons')));
            return button;
        }));
        categories.hidden = false;

        state.mode = 'sections';
        root.dataset.mode = 'sections';
        root.dataset.state = 'ready';
        scroller.replaceChildren(...state.sections.map(section => section.el));

        const sync = state.sections.filter(section => section.key === 'recent');
        const firstGroup = state.sections.find(section => section.key !== 'recent' && section.items.length);
        if (firstGroup) {
            sync.push(firstGroup);
        }
        sync.forEach(fillChunk);
        const first = createGridModel(state.sections.map(section => section.items.length), getColumns()).first();
        if (first) {
            setActive(first);
        }
        scheduleBuild();
    }

    function focusInitial() {
        const stop = root.querySelector('.sb-emoji-grid [tabindex="0"]');
        (touch && stop ? stop : searchEntry).focus({ preventScroll: true });
    }

    function dispose() {
        state.disposed = true;
        cancelPress();
        clearTimeout(state.swallowTimer);
        resizeObserver?.disconnect();
    }

    return { element: root, setTable, showLoading, showError, focusInitial, refreshSelection, dispose };
}
