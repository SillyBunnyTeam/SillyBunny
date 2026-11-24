/* eslint-disable playwright/no-standalone-expect -- Jest unit tests for PR 10 shell deferral, CSS isolation, and chat-list caching. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8').replace(/\r\n/g, '\n');

function extractFunctionSource(source, name) {
    const pattern = new RegExp(`(?:^|\\n)[ \\t]*((?:async\\s+)?function\\s+${name}\\s*\\()`);
    const match = pattern.exec(source);
    if (!match) {
        throw new Error(`Function ${name} not found`);
    }
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0) + (match[0].length - (match[0].startsWith('\n') ? 1 : 0) - match[1].length);
    const paramsStart = source.indexOf('(', start);
    let parenDepth = 0;
    let paramsEnd = paramsStart;
    for (let i = paramsStart; i < source.length; i += 1) {
        if (source[i] === '(') parenDepth += 1;
        else if (source[i] === ')') {
            parenDepth -= 1;
            if (parenDepth === 0) {
                paramsEnd = i;
                break;
            }
        }
    }
    const bodyStart = source.indexOf('{', paramsEnd);
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let escaped = false;
    for (let i = bodyStart; i < source.length; i += 1) {
        const ch = source[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (!inDouble && !inTemplate && ch === '\'') {
            inSingle = !inSingle;
            continue;
        }
        if (!inSingle && !inTemplate && ch === '"') {
            inDouble = !inDouble;
            continue;
        }
        if (!inSingle && !inDouble && ch === '`') {
            inTemplate = !inTemplate;
            continue;
        }
        if (inSingle || inDouble || inTemplate) {
            continue;
        }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return source.slice(start, i + 1);
            }
        }
    }
    throw new Error(`Unbalanced braces in ${name}`);
}

describe('PR 10 shell boot diet & topbar layout', () => {
    test('initAll drops eager drag listeners, Select2 reinit, and formatting drawer grouping, and sets icons-only before buildTopBar', () => {
        const initSource = extractFunctionSource(tabsSource, 'initAll');
        expect(initSource).not.toContain('bindTopbarDragEvents()');
        expect(initSource).not.toContain('reinitSelect2AfterShell()');
        expect(initSource).not.toContain('groupAdvancedFormattingIntoDrawers()');

        const iconsOnlyIdx = initSource.indexOf('document.documentElement.dataset.sbTopbarIconsOnly = String(isTopbarIconsOnlyActive())');
        const buildTopBarIdx = initSource.indexOf('buildTopBar()');
        expect(iconsOnlyIdx).toBeGreaterThan(-1);
        expect(buildTopBarIdx).toBeGreaterThan(iconsOnlyIdx);
        expect(initSource).not.toContain('applyTopbarIconsOnlyPreference()');
    });

    test('topbar drag listeners bind only inside startTopbarDrag and unbind inside endTopbarDrag', () => {
        const startSource = extractFunctionSource(tabsSource, 'startTopbarDrag');
        const endSource = extractFunctionSource(tabsSource, 'endTopbarDrag');
        expect(startSource).toContain('bindTopbarDragEvents();');
        expect(endSource).toContain('unbindTopbarDragEvents();');

        const listeners = new Map();
        const mockWindow = {
            addEventListener: jest.fn((type, fn, opts) => listeners.set(type, { fn, opts })),
            removeEventListener: jest.fn(type => listeners.delete(type)),
        };
        const mockBody = { classList: { add: jest.fn(), remove: jest.fn() } };
        const chatbarState = { dragging: null, dragListenersBound: false, topbarOffset: { x: 0, y: 0 }, renderedTopbarOffset: { x: 0, y: 0 } };
        class FakeElement {}
        const handle = new FakeElement();

        const harness = new Function(
            'window',
            'document',
            'HTMLElement',
            'getChatbarState',
            'getRenderedTopbarOffset',
            'clampTopbarOffset',
            'setTopbarOffset',
            [
                extractFunctionSource(tabsSource, 'getTopbarDragKey'),
                extractFunctionSource(tabsSource, 'getTopbarDragPoint'),
                extractFunctionSource(tabsSource, 'updateTopbarDrag'),
                extractFunctionSource(tabsSource, 'endTopbarDrag'),
                extractFunctionSource(tabsSource, 'unbindTopbarDragEvents'),
                extractFunctionSource(tabsSource, 'bindTopbarDragEvents'),
                extractFunctionSource(tabsSource, 'startTopbarDrag'),
                'return { startTopbarDrag, endTopbarDrag };',
            ].join('\n'),
        )(
            mockWindow,
            { body: mockBody },
            FakeElement,
            () => chatbarState,
            () => ({ x: 0, y: 0 }),
            offset => offset,
            offset => { chatbarState.renderedTopbarOffset = offset; },
        );

        expect(listeners.size).toBe(0);
        harness.startTopbarDrag({
            currentTarget: handle,
            pointerType: 'touch',
            pointerId: 7,
            clientX: 20,
            clientY: 30,
            cancelable: true,
            preventDefault: jest.fn(),
        });
        expect(listeners.has('touchmove')).toBe(true);
        expect(listeners.get('touchmove').opts).toEqual({ passive: false });

        harness.endTopbarDrag({ pointerType: 'touch', pointerId: 7 });
        expect(listeners.size).toBe(0);
        expect(chatbarState.dragListenersBound).toBe(false);
    });

    test('defers PromptEditor, ConnectionsPanel, In-Chat Agents, and BackgroundGallery at boot', () => {
        const editorSource = extractFunctionSource(tabsSource, 'buildEditorPanel');
        expect(editorSource).toContain('let mounted = false;');
        expect(editorSource).toContain('ensureReady: async () =>');
        expect(editorSource).toContain('initializePromptEditor(column');

        const agentsSource = extractFunctionSource(tabsSource, 'buildInChatAgentsPanel');
        expect(agentsSource).toContain('let mountedController = null;');
        expect(agentsSource).toContain('ensureReady: async () =>');
        expect(agentsSource).toContain('const controller = mountAgentsPanel(column);');

        const appearanceSource = extractFunctionSource(tabsSource, 'presentAppearancePage');
        expect(appearanceSource).not.toContain('initBackgroundGallery');
        expect(tabsSource).toContain('deferMount: true');
    });
});

describe('PR 10 fitBottomChatBar single-read width cache & observer diet', () => {
    test('observes only data-sb-mobile-ui-mode on documentElement and fits in 1 read pass with cached button widths', () => {
        const observedFilters = [];
        class FakeResizeObserver {
            observe() {}
        }
        class FakeMutationObserver {
            observe(_target, options) {
                observedFilters.push(options.attributeFilter);
            }
        }
        class FakeElement {
            constructor({ width = 28, minWidth = '0px', classNames = [] } = {}) {
                this._width = width;
                this._minWidth = minWidth;
                this.hidden = false;
                this._classes = new Set(classNames);
                this.classList = {
                    contains: cls => this._classes.has(cls),
                    add: cls => this._classes.add(cls),
                    remove: cls => this._classes.delete(cls),
                    toggle: (cls, force) => {
                        const next = force === undefined ? !this._classes.has(cls) : Boolean(force);
                        if (next) this._classes.add(cls);
                        else this._classes.delete(cls);
                        return next;
                    },
                };
            }
            getBoundingClientRect() {
                rectReads += 1;
                return { width: this._width };
            }
        }

        let rectReads = 0;
        let styleReads = 0;
        let scrollWidthReads = 0;

        const navButtons = [new FakeElement({ width: 30 }), new FakeElement({ width: 30 })];
        const mgmtButtons = [
            new FakeElement({ width: 30 }),
            new FakeElement({ width: 30 }),
            new FakeElement({ width: 30 }),
            new FakeElement({ width: 30 }),
            new FakeElement({ width: 30 }),
            new FakeElement({ width: 30, classNames: ['sb-bottom-chat-search-toggle'] }),
            new FakeElement({ width: 30 }),
            new FakeElement({ width: 30 }),
        ];
        const allButtons = [...navButtons, ...mgmtButtons];
        const navCluster = new FakeElement();
        navCluster.querySelectorAll = () => navButtons;

        const bar = new FakeElement();
        bar.clientWidth = 430;
        Object.defineProperty(bar, 'scrollWidth', {
            get() {
                scrollWidthReads += 1;
                return 999;
            },
        });
        bar.querySelector = sel => (sel === '.sb-bottom-chat-nav-actions' ? navCluster : null);

        const overflow = new FakeElement({ width: 30 });
        overflow.hidden = true;
        const fitState = {
            overflowButton: overflow,
            personaBubble: new FakeElement({ width: 32 }),
            chatSelect: new FakeElement({ minWidth: '160px' }),
            searchField: new FakeElement({ minWidth: '140px' }),
            searchOpen: false,
            fitObserver: null,
            fitFrame: 0,
            widthCache: null,
        };
        const sbState = { bottomBarScale: 100, desktopButtonScale: 100, compactMode: false };

        const mockGetComputedStyle = el => {
            styleReads += 1;
            if (el === bar) {
                return { columnGap: '4px', paddingInlineStart: '8px', paddingInlineEnd: '8px' };
            }
            if (el === navCluster) {
                return { columnGap: '2px', paddingInlineEnd: '4px', borderInlineEndWidth: '1px' };
            }
            return { minWidth: el._minWidth || '0px' };
        };

        const harness = new Function(
            'window',
            'document',
            'HTMLElement',
            'ResizeObserver',
            'MutationObserver',
            'getComputedStyle',
            'sbState',
            'getBottomChatBarState',
            'getBottomChatFoldableButtons',
            [
                extractFunctionSource(tabsSource, 'invalidateBottomChatBarFitCache'),
                extractFunctionSource(tabsSource, 'measureBottomChatBarThresholds'),
                extractFunctionSource(tabsSource, 'fitBottomChatBar'),
                extractFunctionSource(tabsSource, 'observeBottomChatBarFit'),
                'return { fitBottomChatBar, observeBottomChatBarFit, invalidateBottomChatBarFitCache };',
            ].join('\n'),
        )(
            { requestAnimationFrame: cb => { cb(); return 0; } },
            {
                documentElement: { dataset: {} },
                getElementById: id => (id === 'sb-bottom-chat-bar' ? bar : null),
            },
            FakeElement,
            FakeResizeObserver,
            FakeMutationObserver,
            mockGetComputedStyle,
            sbState,
            () => fitState,
            () => allButtons,
        );

        harness.observeBottomChatBarFit(bar);
        expect(observedFilters).toEqual([['data-sb-mobile-ui-mode']]);
        expect(scrollWidthReads).toBe(0);
        expect(bar.classList.contains('sb-bottom-chat-search-folded')).toBe(true);
        expect(overflow.hidden).toBe(false);
        const keptOnNarrow = allButtons.filter(b => !b.hidden).length;
        expect(keptOnNarrow).toBeGreaterThan(0);
        expect(keptOnNarrow).toBeLessThan(allButtons.length);

        const readsAfterCold = rectReads + styleReads;
        expect(readsAfterCold).toBeGreaterThan(0);

        // Warm resize to wide bar: zero DOM style/rect reads!
        bar.clientWidth = 900;
        harness.fitBottomChatBar();
        expect(rectReads + styleReads).toBe(readsAfterCold);
        expect(bar.classList.contains('sb-bottom-chat-search-folded')).toBe(false);
        expect(overflow.hidden).toBe(true);
        expect(allButtons.every(b => !b.hidden)).toBe(true);

        // Warm resize back to narrow bar: still zero DOM style/rect reads!
        bar.clientWidth = 430;
        harness.fitBottomChatBar();
        expect(rectReads + styleReads).toBe(readsAfterCold);
        expect(allButtons.filter(b => !b.hidden).length).toBe(keptOnNarrow);
    });
});

describe('PR 10 chat-list fetch dedupe, invalidation & 0-chat no-poll', () => {
    test('dedupes concurrent getChatFilesForContext calls, ignores MESSAGE_RECEIVED, invalidates on CHAT_CREATED, and stops polling on valid []', async () => {
        const listeners = new Map();
        const eventSource = {
            on(name, fn) {
                if (!listeners.has(name)) listeners.set(name, []);
                listeners.get(name).push(fn);
            },
            emit(name) {
                for (const fn of listeners.get(name) ?? []) fn();
            },
        };
        const eventTypes = {
            APP_READY: 'app_ready',
            CHAT_CHANGED: 'chat_changed',
            CHAT_LOADED: 'chat_loaded',
            CHAT_CREATED: 'chat_created',
            CHAT_RENAMED: 'chat_renamed',
            GROUP_CHAT_CREATED: 'group_chat_created',
            CHAT_DELETED: 'chat_deleted',
            GROUP_CHAT_DELETED: 'group_chat_deleted',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_UPDATED: 'message_updated',
            MESSAGE_EDITED: 'message_edited',
            MESSAGE_DELETED: 'message_deleted',
            MESSAGE_SWIPED: 'message_swiped',
            MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
        };

        let fetchCount = 0;
        let nextPayload = [];
        const mockFetch = jest.fn(async () => {
            fetchCount += 1;
            await new Promise(resolve => setTimeout(resolve, 5));
            return { ok: true, json: async () => nextPayload };
        });

        class FakeSelect {
            constructor() {
                this.options = [];
                this.selectedOptions = [];
            }
            replaceChildren(...nodes) {
                this.options = nodes;
                this.selectedOptions = nodes.filter(n => n.selected);
            }
        }
        const chatSelect = new FakeSelect();
        const scheduledRetries = [];
        const sbState = {
            bottomChatBar: { chatSelect, visible: true },
            bottomChatBarRefreshAttempts: 0,
        };
        const chatContext = {
            context: {},
            chatId: '',
            group: null,
            character: { avatar: 'alice.png', name: 'Alice' },
            hasChat: false,
            canBrowseChats: true,
        };

        const cacheMatch = tabsSource.match(/const SB_CHAT_FILES_FOCUS_STALE_MS[\s\S]*?const sbChatFilesCache = \{[\s\S]*?\};/);
        expect(cacheMatch).not.toBeNull();

        const harness = new Function(
            'fetch',
            'document',
            'HTMLSelectElement',
            'sbState',
            'getChatUiContext',
            'getAuthorizedRequestHeadersOrNull',
            'normalizeChatInfo',
            'sortChatFiles',
            'setButtonDisabled',
            'describeChatName',
            'formatChatSelectorLabel',
            'isMobileViewport',
            'scheduleBottomChatBarRefresh',
            [
                cacheMatch[0],
                extractFunctionSource(tabsSource, 'fetchCharacterChatFiles'),
                'async function fetchGroupChatFiles() { return []; }',
                extractFunctionSource(tabsSource, 'getChatFilesCacheKey'),
                extractFunctionSource(tabsSource, 'invalidateChatFilesCache'),
                extractFunctionSource(tabsSource, 'markChatFilesCacheStale'),
                extractFunctionSource(tabsSource, 'invalidateChatFilesCacheIfOlderThan'),
                extractFunctionSource(tabsSource, 'loadChatFilesForContext'),
                extractFunctionSource(tabsSource, 'getChatFilesForContext'),
                extractFunctionSource(tabsSource, 'bindChatFilesCacheInvalidation'),
                extractFunctionSource(tabsSource, 'writeBottomChatOptions'),
                'function getBottomChatBarState() { return sbState.bottomChatBar; }',
                extractFunctionSource(tabsSource, 'refreshBottomChatSelect'),
                'return { getChatFilesForContext, bindChatFilesCacheInvalidation, refreshBottomChatSelect };',
            ].join('\n'),
        )(
            mockFetch,
            { createElement: () => ({ value: '', textContent: '', selected: false }) },
            FakeSelect,
            sbState,
            () => chatContext,
            async () => ({ 'Content-Type': 'application/json' }),
            item => ({ fileName: item.file_name, sortTimestamp: 1, tokenEstimate: 0 }),
            list => list,
            () => {},
            name => name,
            name => name,
            () => false,
            delay => scheduledRetries.push(delay),
        );

        harness.bindChatFilesCacheInvalidation(eventSource, eventTypes);

        // Concurrent calls from sidebar + bottom chat bar share 1 in-flight POST and do NOT retry on valid empty []!
        const [firstList] = await Promise.all([
            harness.getChatFilesForContext(chatContext),
            harness.refreshBottomChatSelect(),
        ]);
        expect(firstList).toEqual([]);
        expect(fetchCount).toBe(1);
        expect(scheduledRetries).toEqual([]);
        expect(sbState.bottomChatBarRefreshAttempts).toBe(0);

        // MESSAGE_RECEIVED only marks stale without invalidating or refetching
        eventSource.emit(eventTypes.MESSAGE_RECEIVED);
        await harness.getChatFilesForContext(chatContext);
        expect(fetchCount).toBe(1);

        // Explicit refreshStale (opening dropdown/sidebar) refetches once
        nextPayload = [{ file_name: 'chat-1' }];
        const refreshed = await harness.getChatFilesForContext(chatContext, { refreshStale: true });
        expect(fetchCount).toBe(2);
        expect(refreshed.map(c => c.fileName)).toEqual(['chat-1']);

        // CHAT_CREATED invalidates cache so next call refetches
        nextPayload = [{ file_name: 'chat-1' }, { file_name: 'chat-2' }];
        eventSource.emit(eventTypes.CHAT_CREATED);
        const afterCreate = await harness.getChatFilesForContext(chatContext);
        expect(fetchCount).toBe(3);
        expect(afterCreate.map(c => c.fileName)).toEqual(['chat-1', 'chat-2']);
    });
});

describe('PR 10 drawer persistence guard, narrowed shell search & settings scroll preservation', () => {
    test('bindInlineDrawerPersistence skips localStorage reads when already bound', () => {
        class FakeElement {}
        const boundDrawer = Object.assign(new FakeElement(), { dataset: { sbDrawerPersistenceBound: 'true' } });
        const freshDrawer = Object.assign(new FakeElement(), { dataset: {}, addEventListener: jest.fn() });
        const getStored = jest.fn(() => true);
        const setExpanded = jest.fn();

        const runBind = new Function(
            'document',
            'HTMLElement',
            'getInlineDrawers',
            'shouldPersistInlineDrawer',
            'getStoredInlineDrawerExpanded',
            'setInlineDrawerExpanded',
            'getInlineDrawerStorageKey',
            'setPersistentStorageItem',
            `${extractFunctionSource(tabsSource, 'bindInlineDrawerPersistence')}\nreturn bindInlineDrawerPersistence;`,
        )(
            {},
            FakeElement,
            () => [boundDrawer, freshDrawer],
            () => true,
            getStored,
            setExpanded,
            () => 'key',
            jest.fn(),
        );

        runBind();
        expect(getStored).toHaveBeenCalledTimes(1);
        expect(getStored).toHaveBeenCalledWith(freshDrawer);
        expect(setExpanded).toHaveBeenCalledTimes(1);
        expect(freshDrawer.dataset.sbDrawerPersistenceBound).toBe('true');

        // Second pass over already-bound drawers does 0 storage reads and 0 DOM mutations
        runBind();
        expect(getStored).toHaveBeenCalledTimes(1);
        expect(setExpanded).toHaveBeenCalledTimes(1);
    });

    test('prepareShellSearch hydrates only requested shells and skips hydration for characters', async () => {
        const leftReady = jest.fn(async () => {});
        const rightReady = jest.fn(async () => {});
        const sbState = {
            shells: {
                left: { tabs: new Map([['sampling', { ensureReady: leftReady }]]) },
                right: { tabs: new Map([['appearance', { ensureReady: rightReady }]]) },
            },
        };

        const prepare = new Function(
            'sbState',
            `${extractFunctionSource(tabsSource, 'prepareShellSearch')}\nreturn prepareShellSearch;`,
        )(sbState);

        await prepare(['characters']);
        expect(leftReady).not.toHaveBeenCalled();
        expect(rightReady).not.toHaveBeenCalled();

        await prepare(['left']);
        expect(leftReady).toHaveBeenCalledTimes(1);
        expect(rightReady).not.toHaveBeenCalled();

        await prepare();
        expect(leftReady).toHaveBeenCalledTimes(2);
        expect(rightReady).toHaveBeenCalledTimes(1);
    });

    test('openSettingsPage/closeSettingsPage toggle body.sb-settings-page-open and preserve #chat.scrollTop safely', () => {
        const openSource = extractFunctionSource(tabsSource, 'openSettingsPage');
        const closeSource = extractFunctionSource(tabsSource, 'closeSettingsPage');

        expect(openSource).toContain('document.body?.classList.add(\'sb-settings-page-open\')');
        expect(openSource).toContain('sbSettingsState.savedChatScrollTop = chatEl ? chatEl.scrollTop : null;');
        expect(openSource.indexOf('classList.add(\'sb-settings-page-open\')')).toBeLessThan(openSource.indexOf('mountShellRootInSettingsPage'));

        expect(closeSource).toContain('document.body?.classList.remove(\'sb-settings-page-open\')');
        expect(closeSource).toContain('if (savedKey === getActiveChatScrollKey())');
        expect(closeSource).toContain('chatEl.scrollTop = savedScrollTop;');
    });
});

describe('PR 10 ConnectionsPanel deferMount & body state classes', () => {
    test('sillybunny-connections-panel supports deferMount and avoids double mount()', () => {
        const panelSource = readFileSync(
            path.join(repoRoot, 'public', 'scripts', 'sillybunny-connections-panel.js'),
            'utf8',
        ).replace(/\r\n/g, '\n');

        expect(panelSource).toContain('deferMount = false');
        expect(panelSource).toContain('if (!deferMount) {\n        syncFromApi();\n    }');
        const syncSource = extractFunctionSource(panelSource, 'syncFromApi');
        expect(syncSource).toContain('mount({ syncSlots: false });');
        // No top-level eager mount() followed by syncFromApi() double-mounting
        expect(panelSource).not.toMatch(/\n\s*mount\(\);\s*\n\s*observeUpstreamMarkup\(\);\s*\n\s*bindEvents\(\);\s*\n\s*syncFromApi\(\);/);
    });

    test('syncBodyStateClasses toggles sb-drawer-maximized, sb-drawer-open, and sb-slide-toggle-shown', () => {
        class FakeBody {}
        const activeClasses = new Set();
        const body = Object.assign(new FakeBody(), {
            classList: {
                toggle: (cls, force) => {
                    if (force) activeClasses.add(cls);
                    else activeClasses.delete(cls);
                },
            },
        });
        let floatingOpen = false;
        let maximized = false;
        let drawerOpen = false;
        let slideShown = false;

        const topHolder = {
            querySelector: sel => (sel.includes('openDrawer') && floatingOpen ? {} : null),
        };
        const sync = new Function(
            'document',
            'HTMLElement',
            `${extractFunctionSource(tabsSource, 'syncBodyStateClasses')}\nreturn syncBodyStateClasses;`,
        )(
            {
                body,
                getElementById: id => (id === 'top-settings-holder' ? topHolder : null),
                querySelector: sel => {
                    if (sel === '.drawer-content.maximized') return maximized ? {} : null;
                    if (sel === '.drawer-content.open') return drawerOpen ? {} : null;
                    if (sel === '[data-slide-toggle="shown"]') return slideShown ? {} : null;
                    return null;
                },
            },
            FakeBody,
        );

        sync();
        expect([...activeClasses]).toEqual([]);

        maximized = true;
        sync();
        // Without an open non-fill drawer in #top-settings-holder, sb-drawer-maximized stays off
        expect(activeClasses.has('sb-drawer-maximized')).toBe(false);

        floatingOpen = true;
        drawerOpen = true;
        slideShown = true;
        sync();
        expect([...activeClasses].sort()).toEqual(['sb-drawer-maximized', 'sb-drawer-open', 'sb-slide-toggle-shown']);
    });
});
