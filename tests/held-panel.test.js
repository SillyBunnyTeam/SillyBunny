/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { clearPanelPage, holdPanel, isPanelHeld, releasePanel, showPanelPage } from '../public/scripts/deferred-panel.js';
import { createStatusPage, STATUS_PAGE_LOADING_DELAY } from '../public/scripts/sillybunny-editor/status-page.js';

const tabsSource = readFileSync(new URL('../public/scripts/sillybunny-tabs.js', import.meta.url), 'utf8');
const tabsCss = readFileSync(new URL('../public/css/sillybunny-tabs.css', import.meta.url), 'utf8');

/** The rule that hides a busy direct child of the settings scroller, as the stylesheet has it. */
const busyRule = /\.sb-shell-panel-scroller > \[aria-busy='true'\] \{[^}]*\}/.exec(tabsCss)?.[0] ?? '';

function createPanel(...contentIds) {
    const panel = document.createElement('section');
    panel.dataset.sbPanel = 'prompting';
    const scroller = document.createElement('div');
    scroller.className = 'sb-shell-panel-scroller';
    for (const id of contentIds) {
        const content = document.createElement('div');
        content.id = id;
        content.append(document.createElement('input'));
        scroller.append(content);
    }
    panel.append(scroller);
    document.body.append(panel);
    return { panel, scroller };
}

const isHidden = element => getComputedStyle(element).visibility === 'hidden';

beforeEach(() => {
    jest.useFakeTimers();
    document.body.replaceChildren();
    const style = document.createElement('style');
    style.textContent = busyRule;
    document.head.append(style);
});

afterEach(() => {
    jest.useRealTimers();
    document.head.replaceChildren();
    document.body.replaceChildren();
});

describe('a page that a deferred module builds is held until it is built', () => {
    test('the stylesheet rule that hides a busy page is in the stylesheet', () => {
        expect(busyRule).toContain('visibility: hidden');
    });

    test('holding marks the panel and every direct child of its scroller busy, and the stylesheet hides those children', () => {
        const { panel, scroller } = createPanel('raw-one', 'raw-two');
        const [one, two] = scroller.children;
        expect(isHidden(one)).toBe(false);

        holdPanel(panel);

        expect(isPanelHeld(panel)).toBe(true);
        expect(panel.getAttribute('aria-busy')).toBe('true');
        expect(one.getAttribute('aria-busy')).toBe('true');
        expect(two.getAttribute('aria-busy')).toBe('true');
        expect(isHidden(one)).toBe(true);
        expect(isHidden(two)).toBe(true);
    });

    test('the scroller is out of the Tab order while the page is held, because its hidden rows still give it something to scroll', () => {
        const { panel, scroller } = createPanel('raw');
        const { panel: other, scroller: otherScroller } = createPanel('raw');
        otherScroller.setAttribute('tabindex', '0');

        holdPanel(panel);
        holdPanel(other);
        expect(scroller.getAttribute('tabindex')).toBe('-1');
        expect(otherScroller.getAttribute('tabindex')).toBe('-1');

        releasePanel(panel);
        releasePanel(other);
        expect(scroller.hasAttribute('tabindex')).toBe(false);
        expect(otherScroller.getAttribute('tabindex')).toBe('0');
    });

    test('a status page shows first in the scroller, replaces the one before it, and is not itself hidden', () => {
        const { panel, scroller } = createPanel('raw');
        holdPanel(panel);
        const loading = createStatusPage({ state: 'loading', title: 'Loading Settings', compact: true });
        showPanelPage(panel, loading);
        expect(scroller.firstElementChild).toBe(loading.element);
        expect(isHidden(loading.element)).toBe(false);

        const failed = createStatusPage({ state: 'error', title: 'Settings Not Loaded', compact: true });
        showPanelPage(panel, failed);
        expect(scroller.querySelectorAll(':scope > .sb-status-page')).toHaveLength(1);
        expect(scroller.firstElementChild).toBe(failed.element);
        expect(isHidden(scroller.querySelector('#raw'))).toBe(true);
    });

    test('releasing shows the page and takes away every mark and the status page', () => {
        const { panel, scroller } = createPanel('raw');
        holdPanel(panel);
        showPanelPage(panel, createStatusPage({ state: 'loading', title: 'Loading Settings', compact: true, busy: panel }));

        releasePanel(panel);

        expect(isPanelHeld(panel)).toBe(false);
        expect(panel.hasAttribute('aria-busy')).toBe(false);
        expect(scroller.querySelector('#raw').hasAttribute('aria-busy')).toBe(false);
        expect(isHidden(scroller.querySelector('#raw'))).toBe(false);
        expect(scroller.querySelector('.sb-status-page')).toBeNull();
    });

    test('releasing and replacing a page report whether the keyboard focus was inside the page that went away', () => {
        const { panel } = createPanel('raw');
        holdPanel(panel);
        const failed = createStatusPage({
            state: 'error', title: 'Settings Not Loaded', compact: true, actions: [{ label: 'Retry', onActivate: () => {} }],
        });
        showPanelPage(panel, failed);
        const retry = failed.element.querySelector('button');
        retry.focus();
        expect(document.activeElement).toBe(retry);

        expect(showPanelPage(panel, createStatusPage({ state: 'loading', title: 'Loading Settings', compact: true }))).toBe(true);
        expect(releasePanel(panel)).toBe(false);
    });
});

describe('markPanelsBusyUntilBuilt and registerShellTab', () => {
    function extract(name) {
        const match = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(tabsSource);
        expect(match).not.toBeNull();
        const bodyStart = tabsSource.indexOf('{', tabsSource.indexOf(')', match.index + match[0].length - 1));
        let depth = 0;
        let end = bodyStart;
        for (; end < tabsSource.length; end++) {
            if (tabsSource[end] === '{') depth++;
            else if (tabsSource[end] === '}' && --depth === 0) break;
        }
        return tabsSource.slice(match.index, end + 1);
    }

    /** The shell's own helpers, with the shell state and the strings stubbed. */
    function createShell() {
        const tabs = new Map();
        const sidebar = document.createElement('div');
        const settingsTab = document.createElement('button');
        settingsTab.className = 'sb-settings-tab';
        settingsTab.setAttribute('aria-selected', 'true');
        sidebar.append(settingsTab);
        const closeButton = document.createElement('button');
        closeButton.id = 'sb-settings-close';
        document.body.append(sidebar, closeButton);
        const sandbox = {
            document,
            HTMLElement,
            Promise,
            String,
            console: { error() {} },
            t: strings => strings[0],
            createStatusPage,
            holdPanel,
            clearPanelPage,
            showPanelPage,
            releasePanel,
            getShellState: () => ({ tabs }),
            applyPageWidth() {},
        };
        const names = ['markPanelsBusyUntilBuilt', 'restoreSettingsFocus', 'registerShellTab'];
        const functions = vm.runInNewContext(`${names.map(extract).join('\n')}\n({ ${names.join(', ')} })`, sandbox);
        return { ...functions, tabs, settingsTab, sidebar, closeButton };
    }

    const flush = async () => {
        for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    };

    test('a tab flagged as built by a deferred module is held when it is registered, before it can be activated', () => {
        const { registerShellTab, tabs } = createShell();
        const flagged = createPanel('raw');
        const plain = createPanel('other');
        registerShellTab('left', { id: 'prompting' }, { panel: flagged.panel, scroller: flagged.scroller, holdUntilBuilt: true });
        registerShellTab('left', { id: 'plain' }, { panel: plain.panel, scroller: plain.scroller });

        expect(tabs.has('prompting')).toBe(true);
        expect(isPanelHeld(flagged.panel)).toBe(true);
        expect(isHidden(flagged.scroller.firstElementChild)).toBe(true);
        expect(isPanelHeld(plain.panel)).toBe(false);
        expect(isHidden(plain.scroller.firstElementChild)).toBe(false);
    });

    test('while the build runs the raw page stays hidden and a loading page shows after its delay, not before', async () => {
        const shell = createShell();
        const { panel, scroller } = createPanel('raw');
        shell.registerShellTab('left', { id: 'prompting' }, { panel, scroller, holdUntilBuilt: true });
        let finish;
        const build = new Promise(resolve => { finish = resolve; });

        shell.markPanelsBusyUntilBuilt('left', ['prompting'], build, jest.fn());

        const page = scroller.querySelector(':scope > .sb-status-page');
        expect(page.dataset.state).toBe('loading');
        expect(page.querySelector('h3').textContent).toBe('Loading Settings');
        expect(page.hidden).toBe(true);
        expect(isHidden(scroller.querySelector('#raw'))).toBe(true);
        jest.advanceTimersByTime(STATUS_PAGE_LOADING_DELAY - 1);
        expect(page.hidden).toBe(true);
        jest.advanceTimersByTime(1);
        expect(page.hidden).toBe(false);
        expect(panel.getAttribute('aria-busy')).toBe('true');

        finish();
        await flush();

        expect(isPanelHeld(panel)).toBe(false);
        expect(panel.hasAttribute('aria-busy')).toBe(false);
        expect(scroller.querySelector('.sb-status-page')).toBeNull();
        expect(isHidden(scroller.querySelector('#raw'))).toBe(false);
    });

    test('a fast build shows no loading page at all', async () => {
        const shell = createShell();
        const { panel, scroller } = createPanel('raw');
        shell.registerShellTab('left', { id: 'prompting' }, { panel, scroller, holdUntilBuilt: true });

        shell.markPanelsBusyUntilBuilt('left', ['prompting'], Promise.resolve(), jest.fn());
        await flush();
        jest.advanceTimersByTime(STATUS_PAGE_LOADING_DELAY * 2);

        expect(scroller.querySelector('.sb-status-page')).toBeNull();
        expect(isHidden(scroller.querySelector('#raw'))).toBe(false);
    });

    test('a failed build leaves the busy state, keeps the raw page hidden and shows the error page with Retry', async () => {
        const shell = createShell();
        const { panel, scroller } = createPanel('raw');
        shell.registerShellTab('left', { id: 'prompting' }, { panel, scroller, holdUntilBuilt: true });
        const retry = jest.fn(() => Promise.resolve());

        const build = Promise.reject(new Error('Failed to fetch dynamically imported module'));
        build.catch(() => {});
        shell.markPanelsBusyUntilBuilt('left', ['prompting'], build, retry);
        await flush();

        expect(panel.hasAttribute('aria-busy')).toBe(false);
        expect(isHidden(scroller.querySelector('#raw'))).toBe(true);
        const page = scroller.querySelector(':scope > .sb-status-page');
        expect(page.dataset.state).toBe('error');
        expect(page.hidden).toBe(false);
        expect(page.textContent).toContain('Settings Not Loaded');
        expect(page.textContent).toContain('Failed to fetch dynamically imported module');
        page.querySelector('button').click();
        expect(retry).toHaveBeenCalledTimes(1);
    });

    test('a retry that builds the page shows it and puts the keyboard focus on the active page tab, not on a removed button', async () => {
        const shell = createShell();
        const { panel, scroller } = createPanel('raw');
        shell.registerShellTab('left', { id: 'prompting' }, { panel, scroller, holdUntilBuilt: true });
        const failed = Promise.reject(new Error('offline'));
        failed.catch(() => {});
        let finish;
        const retry = jest.fn(() => shell.markPanelsBusyUntilBuilt('left', ['prompting'], new Promise(resolve => { finish = resolve; }), retry));
        shell.markPanelsBusyUntilBuilt('left', ['prompting'], failed, retry);
        await flush();

        const button = scroller.querySelector('.sb-status-page button');
        button.focus();
        button.click();
        expect(scroller.querySelector('.sb-status-page').dataset.state).toBe('loading');
        expect(isHidden(scroller.querySelector('#raw'))).toBe(true);
        expect(document.activeElement).toBe(shell.settingsTab);

        finish();
        await flush();
        expect(scroller.querySelector('.sb-status-page')).toBeNull();
        expect(isHidden(scroller.querySelector('#raw'))).toBe(false);
        expect(document.activeElement).toBe(shell.settingsTab);
    });

    test('on a phone, where the sidebar with the tabs is inert, a retry puts the focus on the Close button', async () => {
        const shell = createShell();
        shell.sidebar.setAttribute('inert', '');
        const { panel, scroller } = createPanel('raw');
        shell.registerShellTab('left', { id: 'prompting' }, { panel, scroller, holdUntilBuilt: true });
        const failed = Promise.reject(new Error('offline'));
        failed.catch(() => {});
        const retry = jest.fn(() => shell.markPanelsBusyUntilBuilt('left', ['prompting'], Promise.resolve(), retry));
        shell.markPanelsBusyUntilBuilt('left', ['prompting'], failed, retry);
        await flush();

        const button = scroller.querySelector('.sb-status-page button');
        button.focus();
        button.click();
        await flush();

        expect(scroller.querySelector('.sb-status-page')).toBeNull();
        expect(document.activeElement).toBe(shell.closeButton);
    });
});

describe('one failed module load is one report', () => {
    function extractFunction(name) {
        const match = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(tabsSource);
        expect(match).not.toBeNull();
        const bodyStart = tabsSource.indexOf('{', tabsSource.indexOf(')', match.index + match[0].length - 1));
        let depth = 0;
        let end = bodyStart;
        for (; end < tabsSource.length; end++) {
            if (tabsSource[end] === '{') depth++;
            else if (tabsSource[end] === '}' && --depth === 0) break;
        }
        return tabsSource.slice(match.index, end + 1);
    }

    /** The shell's own functions against stubbed loaders; every toast and every console error is counted. */
    function compile(names, globals = {}) {
        const toastr = { error: jest.fn() };
        const logged = [];
        const tabs = new Map();
        const sandbox = {
            document,
            HTMLElement,
            Promise,
            String,
            WeakSet,
            toastr,
            console: { error: (...args) => logged.push(args) },
            t: strings => strings[0],
            createStatusPage,
            holdPanel,
            clearPanelPage,
            showPanelPage,
            releasePanel,
            applyPageWidth() {},
            getShellState: () => ({ tabs }),
            sbReportedLazyFailures: new WeakSet(),
            ...globals,
        };
        const all = ['reportLazyModuleFailure', 'logHeldPageFailure', 'loadControllerOrReport', 'markPanelsBusyUntilBuilt', 'restoreSettingsFocus', 'registerShellTab', ...names];
        const functions = vm.runInNewContext(`${all.map(extractFunction).join('\n')}\n({ ${all.join(', ')} })`, sandbox);
        return { ...functions, toastr, logged, tabs, sandbox };
    }

    const importError = () => new Error('Failed to fetch dynamically imported module: /scripts/sillybunny-tabs/backend-panels.js');
    const flush = async () => {
        for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    };
    const statusOf = scroller => scroller.querySelector(':scope > .sb-status-page');

    test('the Editor page: a failed load shows the error page and no toast, and a Retry that fails again shows the page again, still no toast', async () => {
        const { scroller, panel } = createPanel();
        let attempts = 0;
        const loadBackendPanelsController = jest.fn(() => { attempts++; return Promise.reject(importError()); });
        const shell = compile(['buildEditorPanel'], {
            loadBackendPanelsController,
            backendPanelsController: null,
            createElement: (tag, { className } = {}) => Object.assign(document.createElement(tag), { className }),
            createShellPanel: () => ({ panel, scroller }),
        });
        const bundle = shell.buildEditorPanel();
        shell.registerShellTab('left', { id: 'editor' }, bundle);

        bundle.onActivate();
        await flush();

        expect(statusOf(scroller).dataset.state).toBe('error');
        expect(statusOf(scroller).textContent).toContain('Settings Not Loaded');
        expect(statusOf(scroller).querySelector('button').textContent).toBe('Retry');
        expect(shell.toastr.error).not.toHaveBeenCalled();
        expect(attempts).toBe(1);

        statusOf(scroller).querySelector('button').click();
        await flush();

        expect(attempts).toBe(2);
        expect(statusOf(scroller).dataset.state).toBe('error');
        expect(scroller.querySelectorAll(':scope > .sb-status-page')).toHaveLength(1);
        expect(shell.toastr.error).not.toHaveBeenCalled();
    });

    test.each([
        ['updateEditorPanel', [{}]],
        ['updatePromptingPanel', [document.createElement('section')]],
        ['groupAdvancedFormattingIntoDrawers', []],
        ['updateFormattingGroupVisibility', [document.createElement('div')]],
    ])('%s: a failed load of the backend panels module makes no toast, because the held page shows it', async (name, args) => {
        const loadBackendPanelsController = jest.fn(() => Promise.reject(importError()));
        const shell = compile([name], { loadBackendPanelsController, backendPanelsController: null, getShellState: () => ({ tabs: new Map() }) });

        shell[name](...args);
        await flush();

        expect(loadBackendPanelsController).toHaveBeenCalledTimes(1);
        expect(shell.toastr.error).not.toHaveBeenCalled();
        expect(shell.logged).toHaveLength(1);
    });

    test('the Customize pages: a failed settings build makes no toast, because each held page shows the error page', async () => {
        const initializeSettingsPanel = jest.fn(() => Promise.reject(importError()));
        const shell = compile(['activateHeldSettingsPages'], { initializeSettingsPanel });

        await expect(shell.activateHeldSettingsPages()).resolves.toBeUndefined();

        expect(shell.toastr.error).not.toHaveBeenCalled();
        expect(shell.logged).toHaveLength(1);
    });

    test('a shell action that needs a module and has no page to show the failure makes exactly one toast', async () => {
        const loadChatActionsSearchController = jest.fn(() => Promise.reject(importError()));
        const shell = compile(['openChatById'], { loadChatActionsSearchController });

        await shell.openChatById('chat');

        expect(shell.toastr.error).toHaveBeenCalledTimes(1);
        expect(shell.logged).toHaveLength(1);
    });

    test('callers that share one failed import share one report, and a later failure is a new report', async () => {
        const failure = importError();
        const loadChatActionsSearchController = jest.fn(() => Promise.reject(failure));
        const shell = compile(['openChatById', 'handleRenameChat'], { loadChatActionsSearchController });

        await Promise.all([shell.openChatById('chat'), shell.handleRenameChat(), shell.openChatById('other')]);
        expect(shell.toastr.error).toHaveBeenCalledTimes(1);
        expect(shell.logged).toHaveLength(1);

        loadChatActionsSearchController.mockImplementation(() => Promise.reject(importError()));
        await shell.openChatById('chat');
        expect(shell.toastr.error).toHaveBeenCalledTimes(2);
    });
});
