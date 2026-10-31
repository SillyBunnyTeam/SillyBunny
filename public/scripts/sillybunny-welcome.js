import { t } from './i18n.js';
import { createArtIntro } from './sillybunny-home/art-intro.js';
import { COPY_PLACEHOLDER, markCopyPlaceholder, markRowSubtitle } from './sillybunny-home/copy.js';
import { HOME_DESTINATIONS } from './sillybunny-home/destinations.js';
import { formatProgress, getSharedGettingStartedState } from './sillybunny-home/getting-started.js';
import { openBundledExtras, openFromHomeTile, openGettingStarted, openHelp } from './sillybunny-home/windows.js';
import { openDialog } from './sillybunny-editor/dialog.js';
import { createEntryRow, createPrefGroup, createRow, createSwitchRow } from './sillybunny-editor/rows.js';
import { createSelectRow } from './sillybunny-editor/select-row.js';
import { ensureWindowStyles } from './sillybunny-window-styles.js';

const PAGE_COUNT = 3;
const LANGUAGE_SELECT_ID = 'onboarding_ui_language_select';
const GETTING_STARTED_KEY = 'getting-started';

function createCopyBlock(slot) {
    return markCopyPlaceholder(document.createElement('p'), slot);
}

/** Dots for the eye, and one translatable sentence for assistive technology. */
function createPosition(position) {
    const wrapper = document.createElement('div');
    wrapper.className = 'sbWelcomeSteps';
    const dots = document.createElement('span');
    dots.className = 'sbWelcomeDots';
    dots.setAttribute('aria-hidden', 'true');
    for (let index = 1; index <= PAGE_COUNT; index++) {
        const dot = document.createElement('i');
        dot.classList.toggle('is-current', index === position);
        dots.append(dot);
    }
    const label = document.createElement('span');
    label.className = 'sr-only';
    label.textContent = t`Step ${position} of ${PAGE_COUNT}`;
    wrapper.append(dots, label);
    return wrapper;
}

function createActionButton(label, { stub = false } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button';
    button.textContent = label;
    if (stub) {
        button.dataset.sbStub = 'true';
    }
    return button;
}

/**
 * The language select belongs to the first-run template. The row adopts it and puts it back when the
 * dialog closes, so the template keeps working for the first-run popup.
 */
function createLanguageRow() {
    const select = document.getElementById(LANGUAGE_SELECT_ID);
    if (!(select instanceof HTMLSelectElement)) {
        console.debug(`#${LANGUAGE_SELECT_ID} is not in the document, so the Welcome dialog shows no Language row.`);
        return null;
    }
    return createSelectRow({ select, label: t`Language`, field: 'welcome-language', searchLabel: t`Search` });
}

function fillHello(body, { language, openImport }) {
    const { intro: greeting } = createArtIntro({ art: 'welcome-both', slot: 'WD-1-GREETING' });

    const intro = document.createElement('div');
    intro.className = 'sbWelcomeIntro';
    intro.append(createCopyBlock('WD-1-ABOUT'), createCopyBlock('WD-1-FORK'));

    const importRow = createRow({
        label: t`Import From SillyTavern`,
        subtitle: COPY_PLACEHOLDER,
        field: 'welcome-import',
        activatable: true,
        onActivate: openImport,
    });
    markRowSubtitle(importRow, 'WD-1-IMPORT-ROW');
    const rows = [...(language ? [language] : []), importRow];

    const fanWork = createCopyBlock('WD-1-FANWORK');
    fanWork.classList.add('sbWelcomeNote');
    body.append(greeting, intro, createPrefGroup({ field: 'welcome-hello-group', rows }).section, fanWork, createPosition(1));
}

function fillImport(body) {
    const folder = createEntryRow({ label: t`Folder Path`, field: 'welcome-import-folder', floating: true });
    const actions = document.createElement('div');
    actions.className = 'sbWindowActions';
    actions.append(createActionButton(t`Import Folder`, { stub: true }), createActionButton(t`Import Backup ZIP`, { stub: true }));
    body.append(
        createCopyBlock('WD-IMPORT-EXPLANATION'),
        createPrefGroup({ field: 'welcome-import-group', rows: [folder] }).section,
        actions,
    );
}

function fillPersona(body) {
    const name = createEntryRow({ label: t`Your Name`, field: 'welcome-persona-name', floating: true });
    body.append(
        createArtIntro({ art: 'welcome-persona-tewi', slot: 'WD-2-PROMPT' }).intro,
        createPrefGroup({ field: 'welcome-persona-group', rows: [name] }).section,
        createPosition(2),
    );
}

/**
 * One of the places Home offers, as a boxed row with the icon, title and voiced line of its tile.
 * @param {object} options
 * @param {typeof HOME_DESTINATIONS[number]} options.destination
 * @param {HTMLElement} [options.status] Shown before the arrow.
 * @param {() => void} options.onActivate
 */
function createDestinationRow({ destination, status, onActivate }) {
    const icon = document.createElement('i');
    icon.className = `${destination.icon} fa-fw sbWelcomeRowIcon`;
    icon.setAttribute('aria-hidden', 'true');
    const row = createRow({
        label: destination.getTitle(),
        subtitle: COPY_PLACEHOLDER,
        field: `welcome-destination-${destination.key}`,
        prefix: icon,
        suffix: status,
        activatable: true,
        onActivate,
    });
    markRowSubtitle(row, destination.lineSlot);
    row.row.dataset.sbWelcomeDestination = destination.key;
    return row;
}

/**
 * Fills What's Next: the places Home has tiles for, and the Show at Startup switch. Like the Getting Started
 * tile, its row follows the shared state: it shows the progress, and it is gone while the state hides it.
 * @returns {() => void} Stops following the Getting Started state.
 */
function fillWhatsNext(body, { openDestination }) {
    const state = getSharedGettingStartedState();
    const progress = document.createElement('span');
    progress.className = 'sbWelcomeRowProgress';

    const rows = HOME_DESTINATIONS.map(destination => createDestinationRow({
        destination,
        status: destination.key === GETTING_STARTED_KEY ? progress : undefined,
        onActivate: () => openDestination(destination.key),
    }));
    const group = createPrefGroup({ field: 'welcome-destinations-group', rows });
    const gettingStartedRow = group.group.querySelector(`[data-sb-welcome-destination="${GETTING_STARTED_KEY}"]`);
    const sync = () => {
        progress.textContent = formatProgress(state.getResolvedCount(), state.getTotal());
        if (state.isHidden()) {
            gettingStartedRow.remove();
        } else if (!gettingStartedRow.isConnected) {
            group.group.prepend(gettingStartedRow);
        }
    };
    sync();

    const showAtStartup = createSwitchRow({ label: t`Show at Startup`, field: 'welcome-show-at-startup', checked: false });
    body.append(
        createArtIntro({ art: 'welcome-next-reisen', slot: 'WD-3-INTRO' }).intro,
        group.section,
        createPrefGroup({ field: 'welcome-startup-group', rows: [showAtStartup] }).section,
        createPosition(3),
    );
    return state.subscribe(sync);
}

/**
 * Opens the Welcome dialog on its first page. Next pushes the following page, the page header's Back pops it.
 * @returns {Promise<ReturnType<typeof openDialog>>}
 */
export async function openWelcomeDialog() {
    await ensureWindowStyles();
    /** @type {ReturnType<typeof openDialog>} */
    let dialog;
    // The row adopts the select before the dialog exists, so a failure while the dialog is built must give it back.
    const language = createLanguageRow();

    // The backdrop never ends Welcome. Escape goes back a page, except on the first page, where it does nothing.
    const stepGuard = (advance, { escape = true } = {}) => (reason) => {
        if (reason === 'scrim') {
            return false;
        }
        if (reason === 'escape') {
            return escape;
        }
        // Next is an affirmative response, which would close a page. The page vetoes the close and moves on.
        if (reason !== 'affirmative') {
            return true;
        }
        advance();
        return false;
    };
    const openers = { 'getting-started': openGettingStarted, help: openHelp, extras: openBundledExtras };
    /** Start and every destination end Welcome the same way; a destination then opens its window. */
    const finish = destination => queueMicrotask(() => {
        void dialog.close('start');
        if (destination) {
            // While Welcome is open, openDialog would push the window as a page over it.
            void dialog.closed.then(() => openFromHomeTile(destination, openers[destination]));
        }
    });
    const pushWhatsNext = () => {
        let stopProgress = () => {};
        const page = dialog.push({
            title: t`What’s Next`,
            content: (body) => { stopProgress = fillWhatsNext(body, { openDestination: finish }); },
            responses: { affirmative: { id: 'start', label: t`Start` }, cancel: { label: t`Back` } },
            canClose: stepGuard(() => finish()),
        });
        void page.closed.then(() => stopProgress());
        return page;
    };
    const pushPersona = () => dialog.push({
        title: t`Your Persona`,
        content: fillPersona,
        responses: { affirmative: { id: 'next', label: t`Next` }, cancel: { label: t`Back` } },
        canClose: stepGuard(pushWhatsNext),
    });
    const pushImport = () => dialog.push({ title: t`Import From SillyTavern`, content: fillImport, canClose: stepGuard(() => {}) });

    try {
        dialog = openDialog({
            tier: 'dialog',
            title: t`Welcome`,
            className: 'sbWelcomeDialog',
            responses: { affirmative: { id: 'next', label: t`Next` }, cancel: { label: t`Close` } },
            canClose: stepGuard(pushPersona, { escape: false }),
            swipeToDismiss: false,
            content: body => fillHello(body, { language, openImport: pushImport }),
        });
    } catch (error) {
        language?.destroy();
        throw error;
    }
    void dialog.closed.then(() => language?.destroy());
    return dialog;
}
