/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
    ROW_FILTERED_CLASS,
    SETTINGS_SEARCH_HIGHLIGHT,
    TAB_BADGE_CLASS,
    analyzeSearchRoots,
    applyRowFilter,
    applyTextHighlights,
    collectSearchGroups,
    createSidebarSearch,
    findMatchRanges,
    findWordMatches,
    getRowSearchText,
    hasWord,
    isRowMatch,
    parseAliases,
    restoreFilteredRows,
    revealClosedMatches,
    textMatchesAll,
    tokenizeQuery,
} from '../../public/scripts/sillybunny-settings-search.js';

function html(markup) {
    const root = document.createElement('div');
    root.innerHTML = markup;
    document.body.append(root);
    return root;
}

beforeEach(() => {
    document.body.replaceChildren();
});

afterEach(() => {
    restoreFilteredRows();
    delete window.CSS;
    delete window.Highlight;
});

describe('word-boundary matching', () => {
    test('a word matches in any position, and never inside another word', () => {
        expect(hasWord('frequency penalty', 'frequency')).toBe(true);
        expect(hasWord('penalty frequency', 'frequency')).toBe(true);
        expect(hasWord('frequencypenalty', 'frequency')).toBe(false);
        expect(hasWord('myfrequency', 'frequency')).toBe(false);
        expect(hasWord('frequency-penalty', 'frequency')).toBe(true);
        expect(hasWord('top-p', 'p')).toBe(true);
    });

    test('a partial word does not match, so the sidebar waits for the whole word', () => {
        expect(hasWord('frequency penalty', 'freq')).toBe(false);
        expect(hasWord('frequency penalty', 'penalt')).toBe(false);
    });

    test('every token has to occur, in any order, and the case is ignored', () => {
        const tokens = tokenizeQuery('  Penalty   FREQUENCY ');
        expect(tokens).toEqual(['penalty', 'frequency']);
        expect(textMatchesAll('frequency penalty', tokens)).toBe(true);
        expect(textMatchesAll('penalty for the frequency', tokens)).toBe(true);
        expect(textMatchesAll('frequency only', tokens)).toBe(false);
        expect(textMatchesAll('anything', [])).toBe(false);
    });

    test('a token that starts or ends with a symbol needs no boundary on that side', () => {
        expect(hasWord('show {{char}}: in responses', '{{char}}')).toBe(true);
        expect(hasWord('edit config.yaml now', 'config.yaml')).toBe(true);
        expect(hasWord('myconfig.yaml', 'config.yaml')).toBe(false);
        expect(findWordMatches('a-b a-b', 'a-b')).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }]);
    });

    test('letters outside ASCII count as letters', () => {
        expect(hasWord('größe der schrift', 'größe')).toBe(true);
        expect(hasWord('schriftgröße', 'größe')).toBe(false);
    });

    test('tokenizing drops repeats and the empty query has no tokens', () => {
        expect(tokenizeQuery('swipes swipes')).toEqual(['swipes']);
        expect(tokenizeQuery('   ')).toEqual([]);
        expect(tokenizeQuery(null)).toEqual([]);
    });

    test('match ranges are ordered and overlapping ones are merged', () => {
        expect(findMatchRanges('frequency penalty frequency', ['frequency', 'penalty'])).toEqual([
            { start: 0, end: 9 }, { start: 10, end: 17 }, { start: 18, end: 27 },
        ]);
        expect(findMatchRanges('top p', ['top', 'top p'])).toEqual([{ start: 0, end: 5 }]);
    });

    test('a row stays when its group supplies the tokens it lacks', () => {
        expect(isRowMatch('image swipe behavior', 'swipes alternative replies', ['swipes', 'image'])).toBe(true);
        expect(isRowMatch('image swipe behavior', 'streaming', ['swipes'])).toBe(false);
    });

    test('aliases are the pipe-separated names of the attribute', () => {
        expect(parseAliases('Swipes and Continue| Parser Flags |')).toEqual(['Swipes and Continue', 'Parser Flags']);
        expect(parseAliases(null)).toEqual([]);
    });
});

describe('row text', () => {
    test('reads titles and labels, and leaves out select options, textareas and placeholder copy', () => {
        const root = html(`
            <div class="ds-row" title="Hover name">
                <span class="ds-row-label">Enter to Send</span>
                <small class="ds-row-subtitle">Choose whether Enter sends</small>
                <select aria-label="Mode"><option>Ctrl and Enter</option></select>
                <textarea>raw value</textarea>
                <span data-sb-copy-placeholder="true">TODO(copy)</span>
                <i aria-hidden="true">glyph</i>
                <span hidden>other backend</span>
                <input placeholder="Search here">
            </div>`);
        const text = getRowSearchText(root.firstElementChild);
        expect(text).toContain('hover name');
        expect(text).toContain('enter to send');
        expect(text).toContain('choose whether enter sends');
        expect(text).toContain('mode');
        expect(text).toContain('search here');
        expect(text).not.toContain('ctrl and enter');
        expect(text).not.toContain('raw value');
        expect(text).not.toContain('todo(copy)');
        expect(text).not.toContain('glyph');
        expect(text).not.toContain('other backend');
    });

    test('closed expander content is searchable unless a caller asks for what is open', () => {
        const root = html(`
            <div class="ds-row-expander">
                <div class="ds-row-expander__header"><button>Dynamic Temperature</button></div>
                <div class="ds-row-expander-content" hidden><label>Sequence Breakers</label></div>
            </div>`);
        const row = root.firstElementChild;
        expect(getRowSearchText(row)).toContain('sequence breakers');
        expect(getRowSearchText(row, { includeClosed: false })).not.toContain('sequence breakers');
    });

    test('opens the closed content that holds a match', () => {
        const root = html(`
            <div class="ds-row-expander">
                <div class="ds-row-expander-content" hidden><label>Sequence Breakers</label></div>
                <div class="ds-row-expander-content" hidden><label>Multiplier</label></div>
            </div>`);
        const expand = jest.fn();
        revealClosedMatches(root.firstElementChild, ['sequence'], expand);
        expect(expand).toHaveBeenCalledTimes(1);
        expect(expand.mock.calls[0][0].textContent).toBe('Sequence Breakers');
    });
});

const MESSAGES_PAGE = `
    <div id="root">
        <section class="sb-settings-flat-section sb-settings-category" data-sb-category="swipes" data-sb-search-aliases="Swipes and Continue">
            <div class="sb-settings-flat-header sb-settings-category-header">
                <div class="sb-settings-category-heading"><h4 class="ds-pref-group-heading sb-settings-category-title">Swipes</h4><small>Alternative replies and automatic regeneration</small></div>
            </div>
            <div class="ds-pref-group sb-settings-category-body">
                <div class="ds-row" id="swipe-arrows"><span class="ds-row-label">Swipes</span><small>Show arrow buttons</small></div>
                <div class="ds-row" id="image-swipe"><span class="ds-row-label">Image Swipe Behavior</span></div>
            </div>
        </section>
        <section class="sb-settings-flat-section sb-settings-category" data-sb-category="streaming">
            <div class="sb-settings-flat-header sb-settings-category-header">
                <div class="sb-settings-category-heading"><h4 class="ds-pref-group-heading sb-settings-category-title">Streaming</h4></div>
            </div>
            <div class="ds-pref-group sb-settings-category-body">
                <div class="ds-row" id="fps"><span class="ds-row-label">Streaming FPS</span></div>
                <div class="ds-row" id="fade"><span class="ds-row-label">Stream Fade-In</span></div>
            </div>
        </section>
        <section class="sb-editor-section">
            <div class="ds-pref-group-header"><h3 class="ds-pref-group-heading" id="h-status" data-sb-copy-placeholder="true">TODO(copy)</h3></div>
            <div class="ds-pref-group" role="group" aria-labelledby="h-status">
                <div class="ds-row" id="status-row"><span class="ds-row-label">Runtime</span></div>
            </div>
        </section>
        <div class="ds-pref-group ds-entity-list"><div class="ds-row">Swipes persona</div></div>
    </div>`;

describe('groups of a page', () => {
    test('a group has its title, description, former names and one row per child of its list', () => {
        const root = html(MESSAGES_PAGE).querySelector('#root');
        const groups = collectSearchGroups(root);
        expect(groups.map(group => group.title)).toEqual(['swipes', 'streaming', '']);
        expect(groups[0].text).toContain('alternative replies');
        expect(groups[0].text).toContain('swipes and continue');
        expect(groups[0].rows.map(row => row.element.id)).toEqual(['swipe-arrows', 'image-swipe']);
        expect(groups[0].container.dataset.sbCategory).toBe('swipes');
        expect(groups[0].header.classList.contains('sb-settings-category-header')).toBe(true);
    });

    test('a list of entities is not a group of settings, and a group inside a row is part of the row', () => {
        const root = html(`
            <div id="root">
                <div class="ds-pref-group ds-entity-list"><div class="ds-row">A persona</div></div>
                <div class="ds-pref-group" id="outer"><div class="ds-row" id="holder"><div class="ds-pref-group" id="inner"><div class="ds-row">Nested</div></div></div></div>
            </div>`).querySelector('#root');
        const groups = collectSearchGroups(root);
        expect(groups).toHaveLength(1);
        expect(groups[0].body.id).toBe('outer');
        expect(groups[0].rows.map(row => row.element.id)).toEqual(['holder']);
    });
});

describe('row filter', () => {
    function analyze(query, root) {
        return analyzeSearchRoots([root], tokenizeQuery(query));
    }

    test('hides the rows that do not match and keeps the group that holds one', () => {
        const root = html(MESSAGES_PAGE).querySelector('#root');
        const analysis = analyze('fade', root);
        applyRowFilter(analysis.groups);
        expect(analysis.count).toBe(1);
        expect(root.querySelector('#fade').classList.contains(ROW_FILTERED_CLASS)).toBe(false);
        expect(root.querySelector('#fps').classList.contains(ROW_FILTERED_CLASS)).toBe(true);
        expect(root.querySelector('#fps').getAttribute('aria-hidden')).toBe('true');
        expect(root.querySelector('[data-sb-category="streaming"]').classList.contains(ROW_FILTERED_CLASS)).toBe(false);
    });

    test('hides a group with no match, header and list together', () => {
        const root = html(MESSAGES_PAGE).querySelector('#root');
        applyRowFilter(analyze('fade', root).groups);
        const swipes = root.querySelector('[data-sb-category="swipes"]');
        expect(swipes.classList.contains(ROW_FILTERED_CLASS)).toBe(true);
        expect(swipes.getAttribute('aria-hidden')).toBe('true');
    });

    test('the Quick Actions group is not searched, and a filter hides it with the other groups that miss', () => {
        const root = html(`
            <div id="root">
                <section class="sb-settings-category sb-mobile-quick-actions-group" data-sb-category="quick">
                    <div class="sb-settings-category-header"><h4 class="ds-pref-group-heading sb-settings-category-title">Mobile Quick Actions</h4></div>
                    <div class="ds-pref-group sb-settings-category-body"><div class="ds-row">Fade shortcut</div></div>
                </section>
                <section class="sb-settings-category" data-sb-category="stream">
                    <div class="sb-settings-category-header"><h4 class="ds-pref-group-heading sb-settings-category-title">Streaming</h4></div>
                    <div class="ds-pref-group sb-settings-category-body"><div class="ds-row">Fade</div></div>
                </section>
            </div>`).querySelector('#root');
        const analysis = analyze('fade', root);
        applyRowFilter(analysis.groups);
        expect(analysis.count).toBe(1);
        expect(root.querySelector('[data-sb-category="quick"]').classList.contains(ROW_FILTERED_CLASS)).toBe(true);
        expect(root.querySelector('[data-sb-category="stream"]').classList.contains(ROW_FILTERED_CLASS)).toBe(false);
    });

    test('a group name keeps all of its rows, and so does a name it had before', () => {
        const root = html(MESSAGES_PAGE).querySelector('#root');
        for (const query of ['Swipes', 'Swipes and Continue', 'alternative replies']) {
            restoreFilteredRows();
            const analysis = analyze(query, root);
            applyRowFilter(analysis.groups);
            expect(analysis.groups[0].matched.map(row => row.element.id)).toEqual(['swipe-arrows', 'image-swipe']);
            expect(root.querySelector('#image-swipe').classList.contains(ROW_FILTERED_CLASS)).toBe(false);
            expect(root.querySelector('[data-sb-category="streaming"]').classList.contains(ROW_FILTERED_CLASS)).toBe(true);
        }
    });

    test('a word inside a longer word matches nothing', () => {
        const root = html(MESSAGES_PAGE).querySelector('#root');
        expect(analyze('strea', root).count).toBe(0);
        expect(analyze('fad', root).count).toBe(0);
        expect(analyze('streaming', root).count).toBe(2);
    });

    test('restores every row and group, and the attribute with them', () => {
        const root = html(MESSAGES_PAGE).querySelector('#root');
        applyRowFilter(analyze('fade', root).groups);
        restoreFilteredRows();
        expect(root.querySelectorAll(`.${ROW_FILTERED_CLASS}`)).toHaveLength(0);
        expect(root.querySelectorAll('[aria-hidden]')).toHaveLength(0);
    });

    test('a row that matches but is not shown is not counted and not touched', () => {
        const root = html(MESSAGES_PAGE).querySelector('#root');
        root.querySelector('#fade').hidden = true;
        const analysis = analyze('streaming', root);
        expect(analysis.count).toBe(1);
        applyRowFilter(analysis.groups);
        expect(root.querySelector('#fade').classList.contains(ROW_FILTERED_CLASS)).toBe(false);
    });

    test('marks a row that matches only through closed content, to be opened', () => {
        const root = html(`
            <div id="root"><div class="ds-pref-group">
                <div class="ds-row-expander" id="dry"><div>DRY Repetition Penalty</div><div class="ds-row-expander-content" hidden>Sequence Breakers</div></div>
            </div></div>`).querySelector('#root');
        const [group] = analyze('sequence breakers', root).groups;
        expect(group.matched).toHaveLength(1);
        expect(group.needsReveal).toHaveLength(1);
        expect(analyze('repetition', root).groups[0].needsReveal).toHaveLength(0);
    });
});

describe('text highlight', () => {
    test('marks each word of the matched text through the Highlight API and clears it', () => {
        const registry = new Map();
        window.CSS = { highlights: { set: (name, value) => registry.set(name, value), delete: name => registry.delete(name) } };
        window.Highlight = class { constructor(...ranges) { this.ranges = ranges; } };
        const root = html('<div class="ds-row"><span>Frequency Penalty</span> <span>MyFrequency</span> <span>frequency</span></div>');
        expect(applyTextHighlights([root.firstElementChild], ['frequency'])).toBe(2);
        const marked = registry.get(SETTINGS_SEARCH_HIGHLIGHT).ranges.map(range => range.toString());
        expect(marked).toEqual(['Frequency', 'frequency']);
        expect(applyTextHighlights([root.firstElementChild], [])).toBe(0);
        expect(registry.has(SETTINGS_SEARCH_HIGHLIGHT)).toBe(false);
    });

    test('a browser without the API marks nothing and changes nothing', () => {
        const root = html('<div class="ds-row"><span>Frequency Penalty</span></div>');
        const before = root.innerHTML;
        expect(applyTextHighlights([root.firstElementChild], ['frequency'])).toBe(0);
        expect(root.innerHTML).toBe(before);
    });
});

describe('sidebar search', () => {
    function setup({ activeTab = 'messages', canHideRows = () => true, ensureReady = () => Promise.resolve(), canReveal } = {}) {
        const page = html(`
            <div id="tabs">
                <button class="sb-settings-tab" data-sb-settings-tab="messages"><span>Messages</span></button>
                <button class="sb-settings-tab" data-sb-settings-tab="logs"><span>Logs</span></button>
                <button class="sb-settings-tab" data-sb-settings-tab="extensions"><span>Extensions</span></button>
            </div>
            <div id="messages-root">${MESSAGES_PAGE}</div>
            <div id="logs-root"><div class="ds-pref-group"><div class="ds-row">Verbose Debug Logging</div></div></div>`);
        const calls = { pulse: [], scroll: [], expand: [] };
        const adapter = {
            getShellKey: () => 'right',
            getTabList: () => page.querySelector('#tabs'),
            getTabs: () => [
                { id: 'messages', label: 'Messages', aliases: ['chat'] },
                { id: 'logs', label: 'Logs', aliases: ['console'] },
                { id: 'extensions', label: 'Extensions', aliases: ['plugins'] },
            ],
            getActiveTabId: () => activeTab,
            getRoots: id => id === 'messages' ? [page.querySelector('#messages-root')] : id === 'logs' ? [page.querySelector('#logs-root')] : null,
            canHideRows,
            getContentMatches: () => [{ tabId: 'extensions', key: 'quick-reply', searchText: 'quick reply swipes' }],
            ensureReady,
            whenTabReady: () => Promise.resolve(),
            pulse: element => calls.pulse.push(element),
            scroll: element => calls.scroll.push(element),
            expand: element => calls.expand.push(element),
            canReveal,
            badgeLabel: count => `${count} found`,
            emptyLabel: 'No matching pages',
        };
        return { page, calls, search: createSidebarSearch(adapter) };
    }

    const tab = (page, id) => page.querySelector(`[data-sb-settings-tab="${id}"]`);

    test('keeps the pages with a hit, counts the hits, and hides the rows of the open page that miss', async () => {
        jest.useFakeTimers();
        const { page, search } = setup();
        await search.update('fade');
        expect(tab(page, 'messages').classList.contains('sb-settings-tab--filtered')).toBe(false);
        expect(tab(page, 'messages').querySelector(`.${TAB_BADGE_CLASS}`).textContent).toBe('1 found');
        expect(tab(page, 'logs').classList.contains('sb-settings-tab--filtered')).toBe(true);
        expect(tab(page, 'logs').getAttribute('aria-hidden')).toBe('true');
        expect(page.querySelector('#fps').classList.contains(ROW_FILTERED_CLASS)).toBe(true);
        expect(page.querySelector('#fade').classList.contains(ROW_FILTERED_CLASS)).toBe(false);
        jest.useRealTimers();
    });

    test('a page found by other means counts its hits too, and a hit is checked at word boundaries', async () => {
        jest.useFakeTimers();
        const { page, search } = setup();
        await search.update('swipes');
        expect(tab(page, 'extensions').classList.contains('sb-settings-tab--filtered')).toBe(false);
        expect(tab(page, 'extensions').querySelector(`.${TAB_BADGE_CLASS}`).textContent).toBe('1 found');
        await search.update('swipe');
        expect(tab(page, 'extensions').classList.contains('sb-settings-tab--filtered')).toBe(true);
        jest.useRealTimers();
    });

    test('a page named by the query shows all of its rows, and one found by content shows what matched', async () => {
        jest.useFakeTimers();
        const { page, search } = setup();
        await search.update('messages');
        expect(tab(page, 'messages').classList.contains('sb-settings-tab--by-content')).toBe(false);
        expect(page.querySelectorAll(`.${ROW_FILTERED_CLASS}`)).toHaveLength(0);
        await search.update('fade');
        expect(page.querySelectorAll(`.${ROW_FILTERED_CLASS}`).length).toBeGreaterThan(0);
        jest.useRealTimers();
    });

    test('a group alias keeps the group, and the first group with a hit is pulsed and scrolled to', async () => {
        jest.useFakeTimers();
        const { page, calls, search } = setup();
        await search.update('Swipes and Continue');
        expect(page.querySelector('[data-sb-category="swipes"]').classList.contains(ROW_FILTERED_CLASS)).toBe(false);
        expect(page.querySelector('[data-sb-category="streaming"]').classList.contains(ROW_FILTERED_CLASS)).toBe(true);
        jest.advanceTimersByTime(300);
        expect(calls.pulse).toEqual([page.querySelector('[data-sb-category="swipes"]')]);
        expect(calls.scroll[0].classList.contains('sb-settings-category-header')).toBe(true);
        jest.useRealTimers();
    });

    test('a page that is not on screen is not scrolled to, and opening it asks for the reveal again', async () => {
        jest.useFakeTimers();
        let onScreen = false;
        const { calls, search } = setup({ canReveal: () => onScreen });
        await search.update('Swipes and Continue');
        jest.advanceTimersByTime(300);
        expect(calls.pulse).toHaveLength(0);
        expect(calls.scroll).toHaveLength(0);
        onScreen = true;
        await search.activate('messages');
        jest.advanceTimersByTime(300);
        expect(calls.pulse).toHaveLength(1);
        expect(calls.scroll).toHaveLength(1);
        jest.useRealTimers();
    });

    test('rows of a page that is only marked are counted and kept', async () => {
        jest.useFakeTimers();
        const { page, search } = setup({ canHideRows: () => false });
        await search.update('fade');
        expect(page.querySelectorAll(`.${ROW_FILTERED_CLASS}`)).toHaveLength(0);
        expect(tab(page, 'messages').querySelector(`.${TAB_BADGE_CLASS}`).textContent).toBe('1 found');
        jest.useRealTimers();
    });

    test('clearing restores pages, rows, badges and the empty message in one step', async () => {
        jest.useFakeTimers();
        const { page, search } = setup();
        await search.update('fade');
        await search.update('zzzqqq');
        expect(page.querySelector('.sb-settings-tab-empty').textContent).toBe('No matching pages');
        search.update('');
        expect(page.querySelectorAll(`.${ROW_FILTERED_CLASS}`)).toHaveLength(0);
        expect(page.querySelectorAll(`.${TAB_BADGE_CLASS}`)).toHaveLength(0);
        expect(page.querySelectorAll('.sb-settings-tab--filtered')).toHaveLength(0);
        expect(page.querySelectorAll('.sb-settings-tab--by-content')).toHaveLength(0);
        expect(page.querySelector('.sb-settings-tab-empty')).toBeNull();
        expect(tab(page, 'logs').getAttribute('aria-hidden')).toBe('false');
        expect(search.isActive()).toBe(false);
        jest.useRealTimers();
    });

    test('a pass that a newer keystroke has replaced changes nothing', async () => {
        jest.useFakeTimers();
        const gates = [];
        const { page, search } = setup({ ensureReady: () => new Promise(resolve => gates.push(resolve)) });
        const first = search.update('fade');
        const second = search.update('streaming');
        gates[1]();
        await second;
        const settled = [...page.querySelectorAll(`.${ROW_FILTERED_CLASS}`)].map(element => element.id || element.dataset.sbCategory);
        gates[0]();
        await first;
        expect([...page.querySelectorAll(`.${ROW_FILTERED_CLASS}`)].map(element => element.id || element.dataset.sbCategory)).toEqual(settled);
        expect(settled).toContain('swipes');
        expect(settled).not.toContain('streaming');
        jest.useRealTimers();
    });
});
