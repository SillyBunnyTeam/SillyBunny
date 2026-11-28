/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importTabsModule } from './util/tabs-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssSource = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8');
const mobileCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8');

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

async function openInterfaceSettings(options = {}) {
    loaded?.cleanup();
    loaded = await importTabsModule(options);
    loaded.shell.openTab('right', 'appearance');
    await loaded.flush();
    loaded.shell.openTab('right', 'interface');
    await loaded.flush();
    return loaded;
}

describe('Backend shortcut routes', () => {
    test.each([
        ['left:presets', 'left:prompting'],
        ['left:api', 'left:connections'],
        ['left:advanced-formatting', 'left:context'],
        ['left:world-info', 'characters:world-info'],
        ['left:editor', 'left:editor'],
        ['right:extensions', 'right:extensions'],
    ])('migrates stored shortcut %s to %s without crossing shell boundaries', async (stored, expected) => {
        await openInterfaceSettings({
            storage: { 'sb-shortcut-left': stored },
        });
        const select = /** @type {HTMLSelectElement} */ (document.querySelector('#sb-quick-access-shortcuts-drawer select[data-sb-shortcut-slot="left"], #sb-shortcut-slot-left, #sb-quick-access-shortcuts-drawer select'));
        expect(select).toBeInstanceOf(HTMLSelectElement);
        expect(select.value).toBe(expected);
    });

    test('keeps characters:editor inside the Characters section without remapping it to Backend', async () => {
        loaded = await importTabsModule();
        loaded.shell.openTab('characters', 'editor');
        expect(document.getElementById('sb-character-toggle').classList.contains('sb-settings-active')).toBe(true);
        expect(document.querySelector('#sb-settings-tab-list [data-sb-settings-tab="editor"]')?.getAttribute('aria-selected')).toBe('true');

        loaded.shell.openTab('left', 'editor');
        expect(document.getElementById('sb-left-shell-toggle').classList.contains('sb-settings-active')).toBe(true);
        expect(document.querySelector('#sb-settings-tab-list [data-sb-settings-tab="editor"]')?.getAttribute('aria-selected')).toBe('true');
    });

    test('lists the canonical Backend targets in the Quick Access slot selector', async () => {
        await openInterfaceSettings();
        const select = /** @type {HTMLSelectElement} */ (document.querySelector('#sb-quick-access-shortcuts-drawer select'));
        expect(select).toBeInstanceOf(HTMLSelectElement);
        const leftValues = [...select.options]
            .map(opt => opt.value)
            .filter(value => value.startsWith('left:'));
        expect(leftValues).toEqual([
            'left:connections', 'left:sampling', 'left:prompting', 'left:editor', 'left:context', 'left:agents',
        ]);
        const allValues = [...select.options].map(opt => opt.value);
        expect(allValues).toContain('action:search');
    });
});

describe('topbar label title', () => {
    test('flushes configured label settings immediately after storage writes and renders one shared label group', async () => {
        await openInterfaceSettings();

        const labelDrawer = document.getElementById('sb-topbar-label-drawer');
        expect(labelDrawer).not.toBeNull();
        expect(labelDrawer.classList.contains('sb-desktop-setting')).toBe(false);
        expect(labelDrawer.classList.contains('sb-mobile-setting')).toBe(false);
        expect(labelDrawer.textContent).toContain('Choose what the center label shows');
        expect(document.getElementById('sb-topbar-label-mobile-group')).toBeNull();
        expect(document.getElementById('sb-topbar-custom-text-input-mobile')).toBeNull();
        expect(document.querySelector('#sb-topbar-label-desktop-char')?.closest('.ds-row-switch')).not.toBeNull();
        expect(document.body.textContent).toContain('This only appears in the top bar when the Custom Text switch is enabled above');

        // Quick Access sits on the desktop settings alone.
        const shortcutsDrawer = document.getElementById('sb-quick-access-shortcuts-drawer');
        expect(shortcutsDrawer).not.toBeNull();
        expect(shortcutsDrawer.classList.contains('sb-desktop-setting')).toBe(true);

        // Changing label parts and custom text flushes synchronously (before any debounce timer or pagehide).
        const ctxInput = /** @type {HTMLInputElement} */ (document.getElementById('sb-topbar-label-desktop-ctx'));
        ctxInput.checked = true;
        ctxInput.dispatchEvent(new Event('change', { bubbles: true }));
        expect(window.localStorage.getItem('sb-topbar-label-desktop-parts')).toBe('["ctx","char"]');

        const customInput = /** @type {HTMLInputElement} */ (document.getElementById('sb-topbar-custom-text-input'));
        customInput.value = 'Immediate';
        customInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(window.localStorage.getItem('sb-topbar-label-custom-text')).toBe('Immediate');
    });

    test('title activation by click, Enter, or Space returns to chat without closing it and never cycles labels', async () => {
        const closeChatSpy = jest.fn();
        loaded = await importTabsModule({
            context: {
                characterId: 0,
                name2: 'Lyra',
                chat: [{ mes: 'Hello' }],
                closeCurrentChat: closeChatSpy,
            },
        });

        const title = document.getElementById('sb-topbar-title');
        expect(title).not.toBeNull();
        expect(title.getAttribute('role')).toBe('button');
        expect(title.getAttribute('tabindex')).toBe('0');
        expect(title.getAttribute('aria-label')).toBeTruthy();

        const initialText = title.textContent;

        // Open left shell, then click title -> closes settings page without closing chat or changing label text.
        loaded.shell.openTab('left', 'connections');
        expect(document.documentElement.dataset.sbSettingsOpen).toBe('true');
        title.click();
        expect(document.documentElement.dataset.sbSettingsOpen).toBeUndefined();
        expect(title.textContent).toBe(initialText);
        expect(title.classList.contains('is-previewing')).toBe(false);
        expect(closeChatSpy).not.toHaveBeenCalled();

        // Open right shell, then press Enter on title -> closes settings page.
        loaded.shell.openTab('right', 'appearance');
        expect(document.documentElement.dataset.sbSettingsOpen).toBe('true');
        const enterEvt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        title.dispatchEvent(enterEvt);
        expect(enterEvt.defaultPrevented).toBe(true);
        expect(document.documentElement.dataset.sbSettingsOpen).toBeUndefined();

        // Open Characters shell, then press Space on title -> closes settings page.
        loaded.shell.openTab('characters', 'characters');
        expect(document.documentElement.dataset.sbSettingsOpen).toBe('true');
        const spaceEvt = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
        title.dispatchEvent(spaceEvt);
        expect(spaceEvt.defaultPrevented).toBe(true);
        expect(document.documentElement.dataset.sbSettingsOpen).toBeUndefined();
        expect(closeChatSpy).not.toHaveBeenCalled();
    });

    test('marks the title as a visible tappable affordance in CSS without negative margin', () => {
        const titleRuleMatch = cssSource.match(/\.sb-brand-title\s*\{[^}]*\}/);
        expect(titleRuleMatch).not.toBeNull();

        const titleRule = titleRuleMatch[0];
        expect(titleRule).toContain('cursor: pointer;');
        expect(titleRule).toContain('touch-action: manipulation;');
        expect(titleRule).toContain('-webkit-user-select: none;');
        expect(titleRule).toContain('user-select: none;');
        expect(titleRule).toContain('padding: 0 6px;');
        expect(titleRule).not.toMatch(/margin:\s*-/);
        expect(cssSource).toContain('.sb-brand-title:focus-visible');
        expect(cssSource).not.toContain('.sb-brand-title.is-previewing');
    });
});

describe('icons only top bar', () => {
    test('builds one child order for every width and mode, with all controls present and no retired rails', async () => {
        const expectedLeft = [
            'sb-left-shell-toggle',
            'sb-right-shell-toggle',
            'sb-topbar-divider-search-mobile',
            'sb-topbar-search-toggle',
            'sb-topbar-divider-quick-left',
            'sb-shortcut-left',
            'sb-shortcut-slot3',
            'sb-shortcut-slot4',
        ];
        const expectedRight = [
            'sb-topbar-extension-slot',
            'sb-shortcut-slot6',
            'sb-shortcut-slot5',
            'sb-shortcut-right',
            'sb-topbar-overflow-toggle',
            'sb-topbar-divider-quick-right',
            'sb-mode-toggle',
            'sb-topbar-divider-mode-mobile',
            'sb-home-toggle',
            'sb-character-toggle',
        ];

        loaded = await importTabsModule();
        const inner = document.getElementById('sb-topbar-inner');
        const readOrder = () => ({
            left: [...inner.querySelector('.sb-topbar-group-left').children].map(el => el.id),
            right: [...inner.querySelector('.sb-topbar-group-right').children].map(el => el.id),
        });

        expect(readOrder()).toEqual({ left: expectedLeft, right: expectedRight });

        // Toggling icons-only does not rebuild #sb-topbar-inner or change child order.
        loaded.shell.setTopbarIconsOnly('desktop', true);
        expect(document.getElementById('sb-topbar-inner')).toBe(inner);
        expect(readOrder()).toEqual({ left: expectedLeft, right: expectedRight });
        expect(document.documentElement.dataset.sbTopbarIconsOnly).toBe('true');

        // Switching to mobile viewport keeps the exact same DOM order and turns desktop icons-only off.
        loaded.setViewport({ width: 390, height: 844 });
        expect(readOrder()).toEqual({ left: expectedLeft, right: expectedRight });
        expect(document.documentElement.dataset.sbTopbarIconsOnly).toBe('false');

        // Switching back to desktop restores the desktop preference.
        loaded.setViewport({ width: 1440, height: 900 });
        expect(document.documentElement.dataset.sbTopbarIconsOnly).toBe('true');

        // Retired cluster/rail CSS and DOM attributes do not exist.
        for (const removed of ['sb-topbar-pages', 'sb-topbar-cluster-lead', 'sb-topbar-page-button', 'sb-topbar-cluster-workspace', 'data-sb-topbar-brand-cramped', 'data-sb-topbar-scroll']) {
            expect(cssSource).not.toContain(removed);
            expect(mobileCss).not.toContain(removed);
        }
    });

    test('opens Characters, Backend, and Customize from their lead buttons and yields Home while open', async () => {
        let fakeNow = 1000;
        jest.spyOn(performance, 'now').mockImplementation(() => fakeNow);

        loaded = await importTabsModule();

        const leftBtn = document.getElementById('sb-left-shell-toggle');
        const rightBtn = document.getElementById('sb-right-shell-toggle');
        const charBtn = document.getElementById('sb-character-toggle');
        const homeBtn = document.getElementById('sb-home-toggle');

        // Clicking Characters opens the settings page in labelled mode and lights #sb-character-toggle.
        fakeNow += 500;
        charBtn.click();
        expect(document.documentElement.dataset.sbSettingsOpen).toBe('true');
        expect(charBtn.classList.contains('sb-settings-active')).toBe(true);
        expect(homeBtn.classList.contains('is-active')).toBe(false);
        expect(document.querySelectorAll('#sb-settings-tab-list [data-sb-settings-tab]').length).toBeGreaterThanOrEqual(5);

        // Switching to Backend moves active state to #sb-left-shell-toggle and renders expected tabs.
        fakeNow += 500;
        leftBtn.click();
        expect(leftBtn.classList.contains('sb-settings-active')).toBe(true);
        expect(charBtn.classList.contains('sb-settings-active')).toBe(false);
        const leftTabIds = [...document.querySelectorAll('#sb-settings-tab-list [data-sb-settings-tab]')].map(b => b.dataset.sbSettingsTab);
        expect(leftTabIds).toEqual(['connections', 'sampling', 'prompting', 'editor', 'context', 'agents']);

        // Switching to Customize renders data-security and logs tabs too.
        fakeNow += 500;
        rightBtn.click();
        const rightTabIds = [...document.querySelectorAll('#sb-settings-tab-list [data-sb-settings-tab]')].map(b => b.dataset.sbSettingsTab);
        expect(rightTabIds).toContain('data-security');
        expect(rightTabIds).toContain('logs');

        // Re-clicking Customize closes the settings page.
        fakeNow += 500;
        rightBtn.click();
        expect(document.documentElement.dataset.sbSettingsOpen).toBeUndefined();
        expect(rightBtn.classList.contains('sb-settings-active')).toBe(false);

        // In icons-only mode, Characters still opens the settings page identically.
        loaded.shell.setTopbarIconsOnly('desktop', true);
        fakeNow += 500;
        charBtn.click();
        expect(document.documentElement.dataset.sbSettingsOpen).toBe('true');
        expect(charBtn.classList.contains('sb-settings-active')).toBe(true);
        fakeNow += 500;
        charBtn.click();
        expect(document.documentElement.dataset.sbSettingsOpen).toBeUndefined();
        await loaded.flush();
    });

    test('mounts one Desktop Icons Only toggle, seeds from legacy key without rewriting it, and clears retired nav attributes', async () => {
        window.localStorage.clear();
        window.localStorage.setItem('sb-topbar-icons-only', 'true');
        const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');

        loaded = await importTabsModule({ storage: null, autoInit: false });
        for (const retired of [
            'data-sb-mobile-nav-layout', 'data-sb-mobile-nav-mode', 'data-sb-mobile-nav-customize',
            'data-sb-mobile-nav-quick-actions', 'data-sb-mobile-nav-replacement',
            'data-sb-desktop-nav-layout', 'data-sb-desktop-nav-mode', 'data-sb-desktop-nav-customize',
            'data-sb-desktop-nav-quick-actions', 'data-sb-desktop-nav-replacement',
        ]) {
            document.documentElement.setAttribute(retired, 'vertical');
        }

        await loaded.eventSource.emit(loaded.event_types.APP_READY);
        loaded.shell.openTab('right', 'appearance');
        await loaded.flush();
        loaded.shell.openTab('right', 'interface');
        await loaded.flush();

        // Retired attributes removed; icons-only seeded from legacy key.
        expect(document.documentElement.hasAttribute('data-sb-mobile-nav-layout')).toBe(false);
        expect(document.documentElement.hasAttribute('data-sb-desktop-nav-layout')).toBe(false);
        expect(document.documentElement.dataset.sbTopbarIconsOnly).toBe('true');

        const toggle = /** @type {HTMLInputElement} */ (document.getElementById('sb-desktop-topbar-icons-only-input'));
        expect(toggle).toBeInstanceOf(HTMLInputElement);
        expect(toggle.checked).toBe(true);
        expect(document.getElementById('sb-mobile-topbar-icons-only-input')).toBeNull();
        expect(document.getElementById('sb-desktop-settings-outlet').contains(toggle)).toBe(true);

        // Changing toggle writes only the desktop key and never rewrites the legacy single key.
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        window.dispatchEvent(new Event('pagehide'));
        expect(window.localStorage.getItem('sb-desktop-topbar-icons-only')).toBe('false');
        expect(setItemSpy.mock.calls.map(([k]) => k)).not.toContain('sb-topbar-icons-only');
        expect(document.documentElement.dataset.sbTopbarIconsOnly).toBe('false');

        // Non-desktop mode calls are ignored.
        loaded.shell.setTopbarIconsOnly('mobile', true);
        expect(document.documentElement.dataset.sbTopbarIconsOnly).toBe('false');
    });

    test('registers proxy button touchstart handlers as passive so WebKit keeps compositor scrolling', async () => {
        const touchStartOptions = [];
        const origAdd = EventTarget.prototype.addEventListener;
        jest.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (type, listener, opts) {
            if (type === 'touchstart' && this instanceof HTMLElement && this.classList?.contains('sb-proxy-button')) {
                touchStartOptions.push(opts);
            }
            return origAdd.call(this, type, listener, opts);
        });

        loaded = await importTabsModule();
        expect(touchStartOptions.length).toBeGreaterThan(0);
        expect(touchStartOptions.every(opts => opts && typeof opts === 'object' && opts.passive === true)).toBe(true);
    });

    test('declares topbar grid, title truncation, divider, control radius, and overflow CSS contracts', () => {
        const baseRule = cssSource.match(/\.sb-topbar-cluster-divider \{[^}]*\}/);
        expect(baseRule).not.toBeNull();
        expect(baseRule[0]).toContain('display: none;');
        expect(baseRule[0]).toContain('width: 0;');
        expect(baseRule[0]).toContain('border-inline-start: 1px solid var(--sb-shell-border);');
        expect(cssSource).toMatch(/> #sb-topbar-divider-quick-left,\n\.sb-topbar-group-right:has\([^\n]*> #sb-topbar-divider-quick-right \{\n\s*display: inline-block;\n\}/);
        expect(cssSource).not.toMatch(/data-sb-topbar-icons-only='true'\][^{]*\.sb-topbar-cluster-divider/);
        expect(mobileCss).toMatch(/\.sb-topbar-cluster-divider \{\n\s*height: calc\(var\(--sb-mobile-toggle-size\) \* 0\.5\);\n\s*\}/);

        const innerRule = cssSource.match(/#sb-topbar-inner \{[^}]*\}/)[0];
        expect(innerRule).toContain('grid-template-columns: minmax(min-content, 1fr) minmax(0, auto) minmax(min-content, 1fr);');
        expect(innerRule).toContain('min-width: 0;');
        expect(cssSource).toMatch(/#sb-topbar-primary \{[^}]*min-width: 0;/);
        expect(cssSource).toMatch(/#sb-topbar-stack \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
        expect(mobileCss).not.toMatch(/#sb-topbar-inner \{[^}]*grid-template-columns/);
        expect(cssSource).toMatch(/\.sb-topbar-group \{[^}]*flex-wrap: nowrap;/);

        const brandRule = cssSource.match(/^\.sb-topbar-brand \{[^}]*\}/m)[0];
        expect(brandRule).toContain('min-width: 0;');
        expect(brandRule).toContain('overflow: hidden;');

        const titleRule = cssSource.match(/\.sb-brand-title \{[^}]*\}/)[0];
        expect(titleRule).toContain('text-overflow: ellipsis;');
        expect(titleRule).toContain('font-size: var(--sb-type-title);');
        expect(titleRule).toContain('font-weight: var(--sb-weight-title);');
        expect(cssSource).not.toContain('.sb-brand-title.is-chat');
        expect(mobileCss).not.toContain('.sb-brand-title');

        expect(cssSource).toMatch(/:root\[data-sb-topbar-title='hidden'\] #sb-topbar-inner \{\n\s*grid-template-columns: minmax\(min-content, 1fr\) minmax\(min-content, 1fr\);\n\}/);
        expect(cssSource).toMatch(/:root\[data-sb-topbar-title='hidden'\] \.sb-topbar-brand \{\n\s*display: none;\n\}/);
        expect(cssSource).toMatch(/#sb-topbar-overflow-toggle \{\n\s*display: none;\n\}/);
        expect(cssSource).toMatch(/:root\[data-sb-topbar-overflow='true'\] #sb-topbar-overflow-toggle \{\n\s*display: inline-flex;\n\}/);
        const hide = cssSource.match(/:root\[data-sb-topbar-overflow='true'\] :is\(([^)]*)\) \{\n\s*display: none;/)[1];
        for (const id of ['sb-shortcut-left', 'sb-shortcut-slot3', 'sb-shortcut-slot4', 'sb-shortcut-slot5', 'sb-shortcut-slot6', 'sb-shortcut-right']) {
            expect(hide).toContain(`#${id}`);
        }
        expect(mobileCss).not.toContain('sb-topbar-overflow');
    });
});

describe('top bar fit', () => {
    const FORMS = {
        labelled: { start: 340, end: 340, title: 400 },
        icons: { start: 190, end: 190, title: 400 },
        overflow: { start: 90, end: 140, title: 400 },
    };

    async function setupFitHarness({ forced = false, canOverflow = true, forms = FORMS, gap = 10 } = {}) {
        const storage = {};
        if (!canOverflow) {
            for (const slot of ['left', 'right', 'slot3', 'slot4', 'slot5', 'slot6']) {
                storage[`sb-shortcut-${slot}`] = 'none';
            }
        }
        if (forced) {
            storage['sb-desktop-topbar-icons-only'] = 'true';
        }
        loaded?.cleanup();
        loaded = await importTabsModule({ storage });

        const inner = document.getElementById('sb-topbar-inner');
        const startGroup = inner.querySelector(':scope > .sb-topbar-group-left');
        const endGroup = inner.querySelector(':scope > .sb-topbar-group-right');
        const title = document.getElementById('sb-topbar-title');

        inner.style.columnGap = `${gap}px`;
        let availableWidth = 1000;
        inner.getBoundingClientRect = () => ({ width: availableWidth, height: 44, top: 0, left: 0, right: availableWidth, bottom: 44 });

        const currentForm = () => {
            const ds = document.documentElement.dataset;
            if (ds.sbTopbarOverflow === 'true') return forms.overflow;
            if (ds.sbTopbarLabels === 'off') return forms.icons;
            return forms.labelled;
        };

        // Wire the first child of each group to report the group's natural width for the active fit state.
        const startProbe = startGroup.firstElementChild;
        const endProbe = endGroup.firstElementChild;
        startProbe.getClientRects = () => [{}];
        endProbe.getClientRects = () => [{}];
        startProbe.getBoundingClientRect = () => ({ width: currentForm().start, height: 32, top: 0, left: 0, right: currentForm().start, bottom: 32 });
        endProbe.getBoundingClientRect = () => ({ width: currentForm().end, height: 32, top: 0, left: 0, right: currentForm().end, bottom: 32 });
        Object.defineProperty(title, 'scrollWidth', { configurable: true, get: () => currentForm().title });

        const measureAt = width => {
            availableWidth = width;
            loaded.triggerResizeObservers(el => el === inner);
            const ds = document.documentElement.dataset;
            return {
                labelsOff: ds.sbTopbarLabels === 'off',
                overflow: ds.sbTopbarOverflow === 'true',
                titleHidden: ds.sbTopbarTitle === 'hidden',
            };
        };

        return { measureAt, loaded };
    }

    test('degrades monotonically through labelled -> icons with title -> icons without title -> overflow', async () => {
        const { measureAt } = await setupFitHarness();

        // 340 + 340 + 2*10 + 60 = 760
        expect(measureAt(1000)).toEqual({ labelsOff: false, overflow: false, titleHidden: false });
        expect(measureAt(760)).toEqual({ labelsOff: false, overflow: false, titleHidden: false });
        // Drops labels at 759 while keeping title; 190 + 190 + 2*10 + 60 = 460
        expect(measureAt(759)).toEqual({ labelsOff: true, overflow: false, titleHidden: false });
        expect(measureAt(460)).toEqual({ labelsOff: true, overflow: false, titleHidden: false });
        // Hides title at 459; 190 + 190 + 10 = 390
        expect(measureAt(459)).toEqual({ labelsOff: true, overflow: false, titleHidden: true });
        expect(measureAt(390)).toEqual({ labelsOff: true, overflow: false, titleHidden: true });
        // Moves Quick Access to overflow at 389 and below
        expect(measureAt(389)).toEqual({ labelsOff: true, overflow: true, titleHidden: true });
        expect(measureAt(240)).toEqual({ labelsOff: true, overflow: true, titleHidden: true });

        // Fit never writes to localStorage.
        const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');
        measureAt(500);
        measureAt(300);
        expect(setItemSpy).not.toHaveBeenCalled();
    });

    test('respects forced icons-only mode, empty Quick Access (no overflow), and short titles', async () => {
        const forcedHarness = await setupFitHarness({ forced: true });
        expect(forcedHarness.measureAt(1000)).toEqual({ labelsOff: true, overflow: false, titleHidden: false });
        expect(forcedHarness.measureAt(389)).toEqual({ labelsOff: true, overflow: true, titleHidden: true });

        const noOverflowHarness = await setupFitHarness({ canOverflow: false });
        expect(noOverflowHarness.measureAt(200)).toEqual({ labelsOff: true, overflow: false, titleHidden: true });

        const shortTitleHarness = await setupFitHarness({
            forms: { ...FORMS, labelled: { start: 340, end: 340, title: 40 } },
        });
        expect(shortTitleHarness.measureAt(740)).toEqual({ labelsOff: false, overflow: false, titleHidden: false });
        expect(shortTitleHarness.measureAt(739).labelsOff).toBe(true);
    });

    test('opens the Quick Access overflow menu with the active shortcut targets and activates the chosen target', async () => {
        loaded = await importTabsModule();
        const overflowBtn = document.getElementById('sb-topbar-overflow-toggle');
        expect(overflowBtn).not.toBeNull();
        expect(overflowBtn.getAttribute('aria-haspopup')).toBe('menu');
        expect(overflowBtn.title).toBe('Quick Access');

        overflowBtn.click();

        const openActionMenu = loaded.mocks['scripts/sillybunny-action-menu.js'].openActionMenu;
        expect(openActionMenu).toHaveBeenCalledTimes(1);
        const menuConfig = openActionMenu.mock.calls[0][0];
        expect(menuConfig.trigger).toBe(overflowBtn);
        expect(menuConfig.title).toBe('Quick Access');
        expect(menuConfig.sections[0].items.length).toBeGreaterThan(0);

        // Selecting an item opens the corresponding shell tab.
        const extensionsItem = menuConfig.sections[0].items.find(item => item.label === 'Extensions');
        expect(extensionsItem).toBeDefined();
        extensionsItem.onSelect();
        expect(document.documentElement.dataset.sbSettingsOpen).toBe('true');
    });
});
