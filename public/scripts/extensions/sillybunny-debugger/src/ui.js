/**
 * All DOM/context code: settings drawer, wand menu item, debug-menu entries,
 * the eruda loader, and the diagnostic report popup.
 */

import { button, copyToClipboard, el, flashButtonText } from './dom.js';
import { getCounters, getEntries, getRequests } from './capture.js';
import { buildReport, formatLayoutRows } from './report.js';

const DRAWER_ID = 'sbdbg-settings';
const MENU_ITEM_ID = 'sbdbg-menu-item';
const ENTRY_KEY = 'SBDebugger_showEntry';
const FETCH_TIMEOUT = 5000;
const ERUDA_BUILD = 'eruda-3.4.3-chobitsu-1.8.6-sbdbg';
const ERUDA_TOOLS = ['console', 'elements', 'network', 'info'];
const LAYOUT_SELECTORS = [
    'body', '#top-bar', '#left-nav-panel', '#right-nav-panel', '#sheld',
    '#chat', '#form_sheld', '#send_form', '#sb-bottom-chat-bar', '.sb-shell-root',
];

let active = false;
let activationGeneration = 0;
let debugFunctionsRegistered = false;
let erudaLoading = null;
let erudaInstance = null;
let erudaScript = null;
let erudaOwned = false;
let erudaReady = false;

function ctx() {
    return SillyTavern.getContext();
}

export function setActive(value) {
    active = Boolean(value);
    activationGeneration += 1;
}

// --- eruda -----------------------------------------------------------------

function loadEruda() {
    if (erudaInstance) {
        if (globalThis.eruda && globalThis.eruda !== erudaInstance) {
            return Promise.reject(new Error('another Eruda instance already exists'));
        }
        if (!globalThis.eruda && erudaOwned && !Reflect.set(globalThis, 'eruda', erudaInstance)) {
            return Promise.reject(new Error('could not expose the Eruda instance'));
        }
        return Promise.resolve(erudaInstance);
    }
    if (erudaLoading) return erudaLoading;
    if ('eruda' in globalThis) {
        return Promise.reject(new Error('another Eruda instance already exists'));
    }

    let loadedInstance;
    let foreignInstance;
    let foreignAssigned = false;
    let slotActive = true;
    const restoreSlot = () => {
        if (!slotActive) return;
        slotActive = false;
        Reflect.deleteProperty(globalThis, 'eruda');
        const exposed = foreignAssigned ? foreignInstance : loadedInstance;
        if (foreignAssigned || exposed !== undefined) Reflect.set(globalThis, 'eruda', exposed);
    };
    try {
        Object.defineProperty(globalThis, 'eruda', {
            configurable: true,
            enumerable: true,
            get: () => (foreignAssigned ? foreignInstance : loadedInstance),
            set: (value) => {
                if (value?.sillyBunnyDebuggerBuild === ERUDA_BUILD) loadedInstance = value;
                else {
                    foreignAssigned = true;
                    foreignInstance = value;
                }
            },
        });
    } catch {
        return Promise.reject(new Error('could not reserve the Eruda global'));
    }

    const script = document.createElement('script');
    erudaScript = script;
    script.src = new URL('../lib/eruda.js', import.meta.url).href;
    let resolveLoad;
    let rejectLoad;
    const loading = new Promise((resolve, reject) => {
        resolveLoad = resolve;
        rejectLoad = reject;
    });
    erudaLoading = loading;
    script.onload = () => {
        erudaLoading = null;
        restoreSlot();
        erudaInstance = loadedInstance ?? null;
        erudaOwned = Boolean(erudaInstance);
        if (!erudaInstance) {
            erudaScript = null;
            script.remove();
            rejectLoad(new Error('eruda.js loaded without the expected Eruda instance'));
            return;
        }
        if (foreignAssigned) {
            releaseOwnedEruda();
            rejectLoad(new Error('another Eruda instance appeared while loading'));
            return;
        }
        if (!active) {
            releaseOwnedEruda();
            rejectLoad(new Error('debugger disabled while loading'));
            return;
        }
        resolveLoad(erudaInstance);
    };
    script.onerror = () => {
        erudaLoading = null;
        erudaScript = null;
        restoreSlot();
        script.remove();
        rejectLoad(new Error('failed to load eruda.js'));
    };
    try {
        document.body.appendChild(script);
    } catch (error) {
        erudaLoading = null;
        erudaScript = null;
        restoreSlot();
        rejectLoad(error);
    }
    return loading;
}

async function initEruda() {
    if (!active) throw new Error('debugger is disabled');
    const generation = activationGeneration;
    const instance = await loadEruda();
    if (!active || generation !== activationGeneration || instance !== erudaInstance) {
        throw new Error('debugger activation changed while loading');
    }
    if (!erudaReady) {
        try {
            instance.init({ tool: ERUDA_TOOLS });
            instance.get?.('console')?.config?.set?.('maxLogNum', '250');
            instance.get?.('console')?.config?.set?.('displayGetterVal', false);
            instance.get?.('elements')?.config?.set?.('overrideEventTarget', false);
            erudaReady = true;
        } catch (error) {
            releaseOwnedEruda();
            throw error;
        }
    }
    return instance;
}

export async function openDebugger() {
    try {
        if (!erudaInstance) {
            globalThis.toastr?.info?.('Loading debugger…');
        }
        const instance = await initEruda();
        if (active && instance === erudaInstance) instance.show();
    } catch (error) {
        globalThis.toastr?.error?.(`Bunny Debugger: ${error.message}`);
    }
}

function autoStartEnabled() {
    try {
        return localStorage.getItem(ENTRY_KEY) === 'true';
    } catch {
        return false;
    }
}

function setAutoStart(enabled) {
    try {
        if (enabled) localStorage.setItem(ENTRY_KEY, 'true');
        else localStorage.removeItem(ENTRY_KEY);
        return true;
    } catch {
        // Storage can be blocked in private or hardened browser contexts.
        return false;
    }
}

/** Eager start when the per-device toggle is on: eruda's console/network are live from boot. */
export async function maybeAutoStart() {
    if (active && autoStartEnabled()) {
        try {
            await initEruda();
        } catch {
            // The floating button just won't show; the wand item still works.
        }
    }
}

function disableErudaDomains(instance) {
    for (const name of ['Overlay', 'Network', 'DOM']) {
        try {
            instance?.chobitsu?.domain?.(name)?.disable?.();
        } catch {
            // A partially initialized domain should not block the others.
        }
    }
}

function releaseOwnedEruda() {
    const instance = erudaInstance;
    const owned = erudaOwned;
    const root = instance?._container;
    erudaReady = false;

    if (!instance) return;
    if (!owned) return;

    try {
        instance.chobitsu?.domain?.('Overlay')?.setInspectMode?.({ mode: 'none' });
        if (instance._isInit) instance.destroy();
    } catch {
        // Continue with domain cleanup after partial initialization.
    } finally {
        disableErudaDomains(instance);
        root?.remove();
        erudaScript?.remove();
        erudaScript = null;
        if (globalThis.eruda === instance) {
            Reflect.deleteProperty(globalThis, 'eruda');
        }
    }
}

export function destroyEruda() {
    releaseOwnedEruda();
}

// --- report gathering --------------------------------------------------------

function safeAreaInsets() {
    const probe = el('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;'
        + 'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
    document.body.appendChild(probe);
    try {
        const style = getComputedStyle(probe);
        return `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`;
    } finally {
        probe.remove();
    }
}

async function gatherExtensions() {
    try {
        const response = await fetchWithTimeout('/api/extensions/discover', { headers: ctx().getRequestHeaders() });
        if (!response.ok) {
            throw new Error(String(response.status));
        }
        const names = (await response.json()).map((item) => (typeof item === 'string' ? item : item.name));
        const disabled = ctx().extensionSettings?.disabledExtensions ?? [];
        const thirdParty = names.filter((name) => name.includes('third-party/') && !disabled.includes(name));
        return {
            enabled: thirdParty.join(', ') || 'none',
            disabled: disabled.join(', ') || 'none',
        };
    } catch {
        return { enabled: 'unavailable', disabled: 'unavailable' };
    }
}

async function extensionVersion() {
    try {
        const response = await fetchWithTimeout(new URL('../manifest.json', import.meta.url));
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()).version ?? 'unknown';
    } catch {
        return 'unknown';
    }
}

async function fetchWithTimeout(input, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
        return await fetch(input, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function gatherHeader() {
    const viewport = window.visualViewport;
    const [extensions, version] = await Promise.all([gatherExtensions(), extensionVersion()]);
    let safeAreas = 'unavailable';
    try {
        safeAreas = safeAreaInsets();
    } catch {
        // A report is still useful when layout probing fails.
    }
    return [
        ['Generated', new Date().toISOString()],
        ['Client', document.getElementById('version_display')?.textContent?.trim() || 'unknown'],
        ['Debugger', `v${version} (eruda ${erudaInstance?.version ?? globalThis.eruda?.version ?? 'not loaded'})`],
        ['UA', navigator.userAgent],
        ['Platform', `${navigator.platform}, ${navigator.maxTouchPoints} touch points, dpr ${window.devicePixelRatio}, online ${navigator.onLine}`],
        ['Screen', `${screen.width}x${screen.height}, ${screen.orientation?.type ?? 'unknown orientation'}`],
        ['Viewport', `inner ${window.innerWidth}x${window.innerHeight}`
            + (viewport ? ` | visual ${Math.round(viewport.width)}x${Math.round(viewport.height)} scale ${viewport.scale} offset ${Math.round(viewport.offsetLeft)},${Math.round(viewport.offsetTop)}` : '')
            + ` | scroll ${window.scrollX},${window.scrollY}`],
        ['Safe areas', safeAreas],
        ['Third-party extensions', extensions.enabled],
        ['Disabled extensions', extensions.disabled],
    ];
}

export function gatherLayout() {
    return LAYOUT_SELECTORS.map((selector) => {
        const node = document.querySelector(selector);
        if (!node) {
            return { selector, found: false };
        }
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
            selector,
            found: true,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            position: style.position,
            display: style.display,
            overflow: style.overflow,
            transform: style.transform,
        };
    });
}

function layoutHeader() {
    const viewport = window.visualViewport;
    return `viewport ${window.innerWidth}x${window.innerHeight}`
        + (viewport ? `, visual ${Math.round(viewport.width)}x${Math.round(viewport.height)} scale ${viewport.scale}` : '')
        + `, scroll ${window.scrollX},${window.scrollY}, dpr ${window.devicePixelRatio}`;
}

// --- report popup ------------------------------------------------------------

function downloadReport(report) {
    const link = document.createElement('a');
    const blob = new Blob([report], { type: 'text/markdown' });
    link.href = URL.createObjectURL(blob);
    link.download = `sillybunny-report-${new Date().toISOString().replaceAll(':', '-')}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

function textPopup(content) {
    const { callGenericPopup, POPUP_TYPE } = ctx();
    callGenericPopup(content, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
}

async function showReportPopup() {
    const generation = activationGeneration;
    try {
        const header = await gatherHeader();
        if (!active || generation !== activationGeneration) return;
        const report = buildReport({
            header,
            entries: getEntries(),
            counters: getCounters(),
            requests: getRequests(),
            layout: formatLayoutRows(gatherLayout()),
        });

        const content = el('div', 'sbdbg-report');
        content.appendChild(el('h3', undefined, 'Diagnostic report'));
        const actions = el('div', 'sbdbg-actions');
        const copyButton = button('menu_button', 'Copy to clipboard', async () => {
            flashButtonText(copyButton, await copyToClipboard(report) ? 'Copied!' : 'Copy failed — select the text below');
        });
        actions.appendChild(copyButton);
        actions.appendChild(button('menu_button', 'Download .md', () => downloadReport(report)));
        content.appendChild(actions);
        const textarea = el('textarea', 'sbdbg-report-text');
        textarea.readOnly = true;
        textarea.value = report;
        content.appendChild(textarea);
        textPopup(content);
    } catch {
        globalThis.toastr?.error?.('Bunny Debugger could not build the diagnostic report');
    }
}

async function copyLayoutSnapshot() {
    const text = `${layoutHeader()}\n${formatLayoutRows(gatherLayout())}`;
    if (await copyToClipboard(text)) {
        globalThis.toastr?.success?.('Layout snapshot copied');
        return;
    }
    // Clipboard unavailable (e.g. http over LAN on iOS) — show it for manual copy.
    const content = el('div', 'sbdbg-report');
    const textarea = el('textarea', 'sbdbg-report-text');
    textarea.readOnly = true;
    textarea.value = text;
    content.appendChild(textarea);
    textPopup(content);
}

// --- mounting ------------------------------------------------------------------

function ensureDrawer() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById(DRAWER_ID)) {
        return;
    }

    const drawer = el('div', 'inline-drawer');
    drawer.id = DRAWER_ID;
    // Strongest key for the fork's settings-drawer dedupe guard.
    drawer.dataset.extensionName = 'SillyBunny-Debugger';

    const toggle = el('div', 'inline-drawer-toggle inline-drawer-header');
    toggle.appendChild(el('b', undefined, 'Bunny Debugger'));
    toggle.appendChild(el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
    drawer.appendChild(toggle);

    const content = el('div', 'inline-drawer-content');

    const actions = el('div', 'sbdbg-actions');
    actions.appendChild(button('menu_button', 'Open debugger', () => openDebugger()));
    actions.appendChild(button('menu_button', 'Diagnostic report', () => void showReportPopup()));
    actions.appendChild(button('menu_button', 'Copy layout snapshot', () => void copyLayoutSnapshot()));
    content.appendChild(actions);

    const checkboxLabel = el('label', 'checkbox_label');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.checked = autoStartEnabled();
    let savedAutoStart = checkbox.checked;
    checkbox.addEventListener('change', () => {
        if (!setAutoStart(checkbox.checked)) {
            checkbox.checked = savedAutoStart;
            globalThis.toastr?.error?.('Bunny Debugger could not save the startup setting');
            return;
        }
        savedAutoStart = checkbox.checked;
        if (checkbox.checked) {
            initEruda().catch(() => {});
        }
    });
    checkboxLabel.appendChild(checkbox);
    checkboxLabel.appendChild(el('span', undefined, 'Show debugger button on this device at startup'));
    content.appendChild(checkboxLabel);

    content.appendChild(el('div', 'sbdbg-hint',
        'Console output, errors and failed requests are recorded from the moment this extension loads. '
        + 'Reports include serialized warning/error excerpts and redacted failed-request URLs — read one before sharing it.'));

    drawer.appendChild(content);
    host.appendChild(drawer);
}

function ensureMenuItem() {
    const host = document.getElementById('extensionsMenu');
    if (!host || document.getElementById(MENU_ITEM_ID)) {
        return;
    }

    const item = el('button', 'list-group-item flex-container flexGap5 interactable');
    item.id = MENU_ITEM_ID;
    item.type = 'button';
    item.title = 'Open the in-app debugger console';
    const icon = el('span', 'fa-solid fa-bug extensionsMenuExtensionButton');
    icon.setAttribute('aria-hidden', 'true');
    item.append(icon, el('span', undefined, 'Debugger'));
    item.addEventListener('click', () => openDebugger());
    host.appendChild(item);
}

function registerDebugFunctions() {
    if (debugFunctionsRegistered) {
        return;
    }
    const register = ctx().registerDebugFunction;
    if (typeof register !== 'function') {
        return;
    }
    debugFunctionsRegistered = true;
    // There is no unregister API, so the callbacks are flag-guarded instead.
    const guard = (fn) => () => (active ? fn() : globalThis.toastr?.warning?.('Bunny Debugger is disabled'));
    register('sbdbg-open', 'Bunny Debugger: open', 'Open the in-app devtools panel (eruda).', guard(openDebugger));
    register('sbdbg-report', 'Bunny Debugger: diagnostic report', 'Build a shareable report: errors, environment, failed requests, layout.', guard(showReportPopup));
    register('sbdbg-layout', 'Bunny Debugger: copy layout snapshot', 'Copy positions and sizes of the main UI landmarks for layout-bug diffing.', guard(copyLayoutSnapshot));
}

export function mountUi() {
    ensureDrawer();
    ensureMenuItem();
    registerDebugFunctions();
}

export function removeUi() {
    document.getElementById(DRAWER_ID)?.remove();
    document.getElementById(MENU_ITEM_ID)?.remove();
}
