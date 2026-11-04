import { getRequestHeaders, name1, refreshCsrfToken, setUserName } from '../script.js';
import { fetchWithCsrfRetry } from './csrf-token-refresh.js';
import { t } from './i18n.js';
import { getUserAvatar, persona_description_positions, user_avatar } from './personas.js';
import { power_user } from './power-user.js';
import { eventSource, event_types } from './events.js';
import { HOME_DESTINATIONS } from './sillybunny-home/destinations.js';
import { formatProgress, getSharedGettingStartedState } from './sillybunny-home/getting-started.js';
import { openShellTarget } from './sillybunny-home/shell-targets.js';
import { getWelcomeStartup } from './sillybunny-home/welcome-boot.js';
import { createArtIntro } from './sillybunny-home/art-intro.js';
import { openBundledExtras, openFromHomeTile, openGettingStarted, openHelp } from './sillybunny-home/windows.js';
import { openAlert, openDialog } from './sillybunny-editor/dialog.js';
import { createEntryRow, createPrefGroup, createRow, createSwitchRow } from './sillybunny-editor/rows.js';
import { createSelectRow } from './sillybunny-editor/select-row.js';
import { createSillyTavernImport } from './sillybunny-welcome-import.js';
import { DEFAULT_USER_NAME, isUntouchedDefaultPersona, savePersonaName } from './sillybunny-welcome-persona.js';
import { ensureWindowStyles } from './sillybunny-window-styles.js';

const PAGE_COUNT = 3;
const LANGUAGE_SELECT_ID = 'onboarding_ui_language_select';
const GETTING_STARTED_KEY = 'getting-started';

function createTextBlock(text) {
    const block = document.createElement('p');
    block.textContent = text;
    return block;
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
    const { intro: greeting } = createArtIntro({ art: 'welcome-both', text: t`Hello, and welcome to SillyBunny! I'm Reisen, and this is Tewi. We'll help you settle in. So, what should we call you, brave hero?` });

    const intro = document.createElement('div');
    intro.className = 'sbWelcomeIntro';
    intro.append(
        createTextBlock(t`SillyBunny is a place to chat, tell stories, and interact with characters, powered by an external AI model you connect yourself.`),
        createTextBlock(t`Oh, and don't forget - SillyBunny is a fork of SillyTavern. Your characters, chats, presets, and extensions should all work here.`),
    );

    const importRow = createRow({
        label: t`Import From SillyTavern`,
        subtitle: t`Coming from SillyTavern? Show me where your folder is and bring everything along!`,
        field: 'welcome-import',
        activatable: true,
        onActivate: openImport,
    });
    const rows = [...(language ? [language] : []), importRow];

    const fanWork = createTextBlock(t`Note: Reisen and Tewi are from Touhou Project by Team Shanghai Alice. They are used under a non-commercial fan work interpretation.`);
    fanWork.classList.add('sbWelcomeNote');
    body.append(greeting, intro, createPrefGroup({ field: 'welcome-hello-group', rows }).section, fanWork, createPosition(1));
}

/**
 * The server answers an import with JSON, or with plain text when something in front of it failed.
 * @param {string} endpoint
 * @param {{ body: unknown, useFormData?: boolean }} options
 * @returns {Promise<{ message?: string }>}
 */
async function requestImport(endpoint, { body, useFormData = false }) {
    const response = await fetchWithCsrfRetry(endpoint, () => ({
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: useFormData }),
        body: useFormData ? /** @type {FormData} */ (body) : JSON.stringify(body),
    }), { refreshCsrfToken });
    const text = await response.text();
    let data;
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { message: text };
    }
    if (!response.ok) {
        throw new Error(data?.error || data?.message || text || `Request failed with status ${response.status}.`);
    }
    return data;
}

/**
 * Asks before an import replaces the data of the account. The title is the name of the page.
 * @param {string} sourceName The folder path or the file name.
 * @returns {Promise<boolean>}
 */
async function confirmImport(sourceName) {
    const body = document.createElement('div');
    const explanation = createTextBlock(t`Files in your account that match the import will be replaced and SillyBunny will reload. This skips this Welcome page. Continue?`);
    const source = document.createElement('code');
    source.textContent = sourceName;
    body.append(explanation, source);
    const response = await openAlert({
        heading: t`Import From SillyTavern`,
        bodyNode: body,
        responses: [
            { id: 'cancel', label: t`Cancel` },
            { id: 'import', label: t`Import`, appearance: 'destructive' },
        ],
    });
    return response === 'import';
}

/**
 * Fills the import page. A failed import shows the message of the server below the buttons, because the account
 * is as it was and the user may try another folder.
 * @param {HTMLElement} body
 * @param {{ importer: ReturnType<typeof createSillyTavernImport> }} options
 */
function fillImport(body, { importer }) {
    const folder = createEntryRow({ label: t`Folder Path`, field: 'welcome-import-folder', floating: true });
    const folderButton = createActionButton(t`Import Folder`);
    const zipButton = createActionButton(t`Import Backup ZIP`);
    const zipInput = document.createElement('input');
    zipInput.type = 'file';
    zipInput.accept = '.zip,application/zip';
    zipInput.hidden = true;
    const status = document.createElement('p');
    status.className = 'sbWelcomeImportStatus';
    status.setAttribute('role', 'status');
    status.hidden = true;
    const buttons = [folderButton, zipButton];

    /** @param {() => Promise<import('./sillybunny-welcome-import.js').ImportResult>} start */
    const run = async (start) => {
        status.hidden = true;
        folder.control.removeAttribute('aria-invalid');
        buttons.forEach((button) => { button.disabled = true; });
        const result = await start();
        // An import that went through reloads the page, so its buttons stay off.
        if (result.status !== 'imported') {
            buttons.forEach((button) => { button.disabled = false; });
        }
        if (result.status === 'failed') {
            status.textContent = result.message;
            status.hidden = false;
        }
        if (result.status === 'empty') {
            folder.control.setAttribute('aria-invalid', 'true');
            folder.control.focus();
        }
    };

    folderButton.addEventListener('click', () => void run(() => importer.importFolder(folder.control.value)));
    zipButton.addEventListener('click', () => zipInput.click());
    zipInput.addEventListener('change', () => {
        const file = zipInput.files?.[0];
        zipInput.value = '';
        if (file) {
            void run(() => importer.importZip(file));
        }
    });

    const actions = document.createElement('div');
    actions.className = 'sbWindowActions';
    actions.append(folderButton, zipButton, zipInput);
    body.append(
        createTextBlock(t`Enter the path of a SillyTavern folder on the computer running SillyBunny, or upload a backup ZIP. We'll try to transfer everything over, though files with the same name will be replaced.`),
        createPrefGroup({ field: 'welcome-import-group', rows: [folder] }).section,
        actions,
        status,
    );
}

/**
 * How the persona page asks for the name. A first run requires one. A reopen of an account whose persona is still the
 * untouched default offers the field, with the default name as its hint, and Next works without a name. Any other
 * reopen shows the persona the account has.
 * @typedef {'required' | 'optional' | 'none'} NameMode
 */

/**
 * Fills the persona page. Where it has a name field, the page asks for nothing else but the persona's name. After that
 * it shows the persona the account has, and sends the user to Characters, Personas to change it. An untouched default
 * persona gets both the field and that way to Characters, Personas.
 * @param {HTMLElement} body
 * @param {object} options
 * @param {NameMode} options.nameMode
 * @param {(name: string) => void} options.onNameInput Called while the user types, when the name is required.
 * @param {() => void} options.managePersonas
 * @returns {{ getName: () => string }}
 */
function fillPersona(body, { nameMode, onNameInput, managePersonas }) {
    const intro = createArtIntro({ art: 'welcome-persona-tewi', text: t`Hey, what should we call you? Characters will know you by the name and persona you set here. You can change it later under Characters ▸ Persona, if you'd like.` }).intro;
    if (nameMode === 'required') {
        const name = createEntryRow({ label: t`Your Name`, field: 'welcome-persona-name', floating: true, onInput: onNameInput });
        body.append(intro, createPrefGroup({ field: 'welcome-persona-group', rows: [name] }).section, createPosition(2));
        return { getName: () => name.control.value };
    }
    const manage = createRow({ label: t`Manage Personas`, field: 'welcome-persona-manage', activatable: true, onActivate: managePersonas });
    if (nameMode === 'optional') {
        const name = createEntryRow({ label: t`Your Name`, field: 'welcome-persona-name', floating: true });
        // A floating row keeps its placeholder blank, so the hint is set after the row is built and the row raises its title to make room.
        name.control.placeholder = name1;
        name.row.classList.add('sbWelcomeNameHint');
        body.append(intro, createPrefGroup({ field: 'welcome-persona-group', rows: [name, manage] }).section, createPosition(2));
        return { getName: () => name.control.value };
    }
    const avatar = document.createElement('img');
    avatar.className = 'sbWelcomePersonaAvatar';
    avatar.alt = '';
    avatar.src = getUserAvatar(user_avatar);
    const current = createRow({ label: name1, field: 'welcome-persona-current', prefix: avatar });
    body.append(intro, createPrefGroup({ field: 'welcome-persona-group', rows: [current, manage] }).section, createPosition(2));
    return { getName: () => name1 };
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
        subtitle: destination.getLine(),
        field: `welcome-destination-${destination.key}`,
        prefix: icon,
        suffix: status,
        activatable: true,
        onActivate,
    });
    row.row.dataset.sbWelcomeDestination = destination.key;
    return row;
}

/**
 * Fills What's Next: the places Home has tiles for, and the Show at Startup switch. Like the Getting Started
 * tile, its row follows the shared state: it shows the progress, and it is gone while the state hides it.
 * @returns {() => void} Stops following the Getting Started state.
 */
function fillWhatsNext(body, { openDestination, startup }) {
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

    const showAtStartup = createSwitchRow({
        label: t`Show at Startup`,
        field: 'welcome-show-at-startup',
        checked: startup.isShownAtStartup(),
        onChange: checked => startup.setShownAtStartup(checked),
    });
    body.append(
        createArtIntro({ art: 'welcome-next-reisen', text: t`All set! Here's where to go next. We'll be around whenever you need us.` }).intro,
        group.section,
        createPrefGroup({ field: 'welcome-startup-group', rows: [showAtStartup] }).section,
        createPosition(3),
    );
    return state.subscribe(sync);
}

/**
 * Runs `open` once the app is ready. Welcome that ends before startup is over, as the first run does, cannot open a
 * window of Home yet.
 * @param {() => void} open
 */
function whenAppReady(open) {
    eventSource.once(event_types.APP_READY, open);
}

/**
 * Opens the Welcome dialog on its first page. Next pushes the following page, the page header's Back pops it.
 * @param {object} [options]
 * @param {boolean} [options.firstRun=false] The persona is required: the dialog cannot end until it has a name, and
 *   naming it ends the first run.
 * @param {string} [options.avatarId] The avatar of the persona that a first run names.
 * @param {() => void} [options.onNamed] Called on a first run once the persona has a name, while the dialog stays open.
 * @returns {Promise<ReturnType<typeof openDialog>>}
 */
export async function openWelcomeDialog({ firstRun = false, avatarId = user_avatar, onNamed } = {}) {
    await ensureWindowStyles();
    const startup = getWelcomeStartup();
    /** @type {ReturnType<typeof openDialog>} */
    let dialog;
    // The row adopts the select before the dialog exists, so a failure while the dialog is built must give it back.
    const language = createLanguageRow();
    const importer = createSillyTavernImport({
        request: requestImport,
        confirm: confirmImport,
        reload: () => location.reload(),
        markImportPending: () => startup.markImportPending(),
        clearImportPending: () => startup.clearImportPending(),
    });

    // The backdrop never ends Welcome. Escape goes back a page, except on the first page, where it does nothing.
    const stepGuard = (advance, { escape = true } = {}) => (reason) => {
        if (reason === 'scrim') {
            return false;
        }
        if (reason === 'escape') {
            return escape;
        }
        // Next is an affirmative response, which would close a page. The page vetoes the close and moves on.
        if (reason === 'affirmative') {
            advance();
            return false;
        }
        return true;
    };
    const openers = { 'getting-started': openGettingStarted, help: openHelp, extras: openBundledExtras };
    /** Start, every destination and Manage Personas end Welcome the same way; `afterClosed` then opens the place. */
    const finish = afterClosed => queueMicrotask(() => {
        void dialog.close('start');
        if (afterClosed) {
            void dialog.closed.then(() => whenAppReady(afterClosed));
        }
    });
    const openDestination = destination => finish(() => openFromHomeTile(destination, openers[destination]));
    const managePersonas = () => finish(() => openShellTarget('personas'));
    const pushWhatsNext = () => {
        let stopProgress = () => {};
        const page = dialog.push({
            title: t`What’s Next`,
            content: (body) => { stopProgress = fillWhatsNext(body, { openDestination, startup }); },
            responses: { affirmative: { id: 'start', label: t`Start` }, cancel: { label: t`Back` } },
            canClose: stepGuard(() => finish()),
        });
        void page.closed.then(() => stopProgress());
        return page;
    };
    const pushPersona = () => {
        let persona;
        const personaDeps = { setUserName, powerUser: power_user, positions: persona_description_positions };
        /** @type {NameMode} */
        let nameMode = 'none';
        if (firstRun) {
            nameMode = 'required';
        } else if (isUntouchedDefaultPersona({ avatarId, userName: name1 }, { powerUser: power_user })) {
            nameMode = 'optional';
        }
        const page = dialog.push({
            title: t`Your Persona`,
            content: (body) => { persona = fillPersona(body, { nameMode, onNameInput, managePersonas }); },
            responses: { affirmative: { id: 'next', label: t`Next` }, cancel: { label: t`Back` } },
            canClose: stepGuard(() => {
                const saved = nameMode !== 'none' && savePersonaName({ avatarId, name: persona.getName() }, personaDeps);
                if (!firstRun) {
                    // The persona editor follows renames by event, and the first run ends before it exists.
                    if (saved) void eventSource.emit(event_types.PERSONA_RENAMED, { avatarId, oldName: DEFAULT_USER_NAME, newName: name1 });
                    pushWhatsNext();
                    return;
                }
                if (saved) {
                    startup.completeFirstRun();
                    onNamed?.();
                    pushWhatsNext();
                }
            }),
        });
        function onNameInput(name) {
            page.setResponseEnabled('next', name.trim() !== '');
        }
        page.setResponseEnabled('next', !firstRun);
        return page;
    };
    const pushImport = () => dialog.push({ title: t`Import From SillyTavern`, content: body => fillImport(body, { importer }), canClose: stepGuard(() => {}) });

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
    // The dialog of a first run ends only once the persona has a name, so its first page offers no Close.
    if (firstRun) {
        dialog.page.querySelector('.sb-dialog__cancel')?.setAttribute('hidden', '');
    }
    void dialog.closed.then(() => language?.destroy());
    return dialog;
}

/**
 * The first run of an account, in place of the onboarding popup of upstream. It resolves once the persona has a name,
 * which is where the popup ended, so startup goes on with a named user while the dialog finishes on What's Next.
 * A dialog that ends before that, which only a failure does, releases startup as well.
 * @param {string} avatarId The avatar of the persona to name.
 */
export async function runFirstRunWelcome(avatarId) {
    /** @type {() => void} */
    let markNamed = () => {};
    const named = new Promise((resolve) => { markNamed = resolve; });
    const dialog = await openWelcomeDialog({ firstRun: true, avatarId, onNamed: markNamed });
    await Promise.race([named, dialog.closed]);
}
