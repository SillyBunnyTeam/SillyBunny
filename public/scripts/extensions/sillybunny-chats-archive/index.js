import { closeArchive, openArchive } from './src/ui.js';

const PANEL_SELECTOR = '#right-nav-panel';
const BUTTON_ID = 'sbca_drawer_button';
const OBSERVER_DEBOUNCE_MS = 150;

let active = false;
let observer = null;
let observerTarget = null;
let pending = null;
let readyHandler = null;
let closing = null;
let lifecycleGeneration = 0;

function onOpen(event) {
    event.preventDefault();
    event.stopPropagation();
    const ctx = globalThis.SillyTavern.getContext();
    void openArchive(ctx, event.currentTarget).catch(error => {
        console.error('[Chat Archive] failed to open:', error);
        globalThis.toastr?.error(ctx.translate?.('Could not open Chat Archive.') ?? 'Could not open Chat Archive.');
    });
}

function ensureButton() {
    const container = document.getElementById('rm_buttons_container');
    if (!container) {
        return;
    }
    let button = document.getElementById(BUTTON_ID);
    if (!button) {
        const ctx = globalThis.SillyTavern.getContext();
        const label = ctx.translate?.('Chat Archive') ?? 'Chat Archive';
        button = document.createElement('button');
        button.id = BUTTON_ID;
        button.className = 'menu_button sbca-drawer-button';
        button.type = 'button';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-haspopup', 'dialog');
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-box-archive';
        icon.setAttribute('aria-hidden', 'true');
        button.append(icon);
        button.addEventListener('click', onOpen);
    }
    if (button.parentElement !== container) {
        container.append(button);
    }
}

function ensureEntryPoints() {
    ensureButton();
}

function install() {
    ensureEntryPoints();
    const target = document.querySelector(PANEL_SELECTOR) ?? document.body;
    if (!observer) {
        // The fork re-renders the character shell in places; re-assert cheaply.
        observer = new MutationObserver(() => {
            if (pending !== null) {
                return;
            }
            pending = setTimeout(() => {
                pending = null;
                install();
            }, OBSERVER_DEBOUNCE_MS);
        });
    }
    if (observerTarget !== target) {
        observer.disconnect();
        observer.observe(target, { childList: true, subtree: true });
        if (target !== document.body && target.parentElement) {
            observer.observe(target.parentElement, { childList: true });
        }
        observerTarget = target;
    }
}

async function init() {
    const generation = ++lifecycleGeneration;
    if (closing) {
        await closing;
    }
    if (generation !== lifecycleGeneration || active) {
        return;
    }
    active = true;
    const ctx = globalThis.SillyTavern.getContext();
    readyHandler = () => install();
    ctx.eventSource.on(ctx.eventTypes.APP_READY, readyHandler);
    install();
}

async function deactivate() {
    lifecycleGeneration++;
    if (!active) {
        return closing;
    }
    active = false;
    const ctx = globalThis.SillyTavern.getContext();
    if (readyHandler) {
        ctx.eventSource.removeListener(ctx.eventTypes.APP_READY, readyHandler);
        readyHandler = null;
    }
    if (pending !== null) {
        clearTimeout(pending);
        pending = null;
    }
    observer?.disconnect();
    observer = null;
    observerTarget = null;
    document.getElementById(BUTTON_ID)?.remove();
    const operation = closeArchive();
    closing = operation;
    try {
        await operation;
    } finally {
        if (closing === operation) {
            closing = null;
        }
    }
}

export function activate() {
    return init();
}

export function enable() {
    return init();
}

export function disable() {
    return deactivate();
}
