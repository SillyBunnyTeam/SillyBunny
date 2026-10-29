import { displayVersion } from '../script.js';
import { extension_settings, extensionNames } from './extensions.js';
import { t } from './i18n.js';
import { createArtPlaceholder } from './sillybunny-home/art.js';
import { markCopyPlaceholder } from './sillybunny-home/copy.js';
import { openDialog } from './sillybunny-editor/dialog.js';
import { createPrefGroup, createPropertyRow, createRow } from './sillybunny-editor/rows.js';
import { ensureWindowStyles } from './sillybunny-window-styles.js';
import { copyText, download } from './utils.js';

const WEBSITE_URL = 'https://github.com/SillyBunnyTeam/SillyBunny';
const ISSUES_URL = 'https://github.com/SillyBunnyTeam/SillyBunny/issues';
const VERSION_TIMEOUT_MS = 3000;
const DEBUG_INFO_FILE_NAME = 'sillybunny-debug-info.txt';
const COPIED_LABEL_MS = 2000;
/** Stands where the branch and commit go until the server has answered. */
const PENDING_VALUE = '…';

/**
 * @typedef {object} AboutInfo
 * @property {string} version
 * @property {string} branch
 * @property {string} commit
 * @property {string} userAgent
 * @property {string} viewport
 * @property {number} extensionCount
 */

/**
 * @param {string[]} installed Names of the installed extensions.
 * @param {string[]} disabled Names the user turned off.
 * @returns {number}
 */
export function countEnabledExtensions(installed, disabled) {
    return installed.filter(name => !disabled.includes(name)).length;
}

/**
 * Plain text for a bug report. The labels stay English on purpose, so a report reads the same in every language.
 * @param {AboutInfo} info
 * @returns {string}
 */
export function formatDebugInfo({ version, branch, commit, userAgent, viewport, extensionCount }) {
    return [
        `Version: ${version}`,
        `Branch: ${branch}`,
        `Commit: ${commit}`,
        `User agent: ${userAgent}`,
        `Viewport: ${viewport}`,
        `Enabled extensions: ${extensionCount}`,
    ].join('\n');
}

async function fetchServerVersion() {
    try {
        const response = await fetch('/version', { cache: 'no-store', signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
        return response.ok ? await response.json() : {};
    } catch (error) {
        console.warn('Could not read the server version for the About window.', error);
        return {};
    }
}

/** @returns {Omit<AboutInfo, 'branch' | 'commit'>} */
function readClientInfo() {
    return {
        version: String(displayVersion).replace(/^SillyBunny\s+/i, ''),
        userAgent: navigator.userAgent,
        viewport: `${window.innerWidth}×${window.innerHeight}`,
        extensionCount: countEnabledExtensions(extensionNames, extension_settings.disabledExtensions ?? []),
    };
}

/**
 * The branch and commit come from the server. The window opens without them, so the values start as a
 * stand-in and every listener hears when the answer arrives.
 */
function requestServerDetails() {
    const details = { branch: PENDING_VALUE, commit: PENDING_VALUE };
    const listeners = new Set();
    void fetchServerVersion().then((server) => {
        const unknown = t`Unknown`;
        details.branch = server.gitBranch || unknown;
        details.commit = server.gitRevision || unknown;
        listeners.forEach(listener => listener());
    });
    return { details, onChange: listener => listeners.add(listener) };
}

function createCopyBlock(slot) {
    return markCopyPlaceholder(document.createElement('p'), slot);
}

/** A row that opens an address in a new tab, so it is a link and not a button. */
function createLinkRow({ label, href, field }) {
    const { row: button } = createRow({ label, field, activatable: true });
    const link = document.createElement('a');
    link.className = button.className;
    link.dataset.sbEditorField = field;
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.append(...button.childNodes);
    link.querySelector('.ds-row__chevron').className = 'fa-solid fa-arrow-up-right-from-square ds-row__chevron';
    return { row: link };
}

function createSection(title, body) {
    const section = document.createElement('section');
    section.className = 'sbWindowSection';
    const heading = document.createElement('h3');
    heading.className = 'ds-pref-group-heading';
    heading.textContent = title;
    section.append(heading, body);
    return section;
}

function createMainContent(server, pages) {
    const header = document.createElement('div');
    header.className = 'sbAboutHeader';
    const name = document.createElement('h3');
    name.className = 'sbAboutName';
    name.textContent = 'SillyBunny';
    header.append(createArtPlaceholder('logo-64'), name, createCopyBlock('AB-DEVELOPER'));

    const branch = createPropertyRow({ label: t`Branch`, value: server.details.branch, field: 'about-branch' });
    const commit = createPropertyRow({ label: t`Commit`, value: server.details.commit, field: 'about-commit' });
    server.onChange(() => {
        branch.setValue(server.details.branch);
        commit.setValue(server.details.commit);
    });
    const details = createPrefGroup({
        field: 'about-details',
        rows: [createPropertyRow({ label: t`Version`, value: readClientInfo().version, field: 'about-version' }), branch, commit],
    });
    const whatsNew = createPrefGroup({
        field: 'about-whats-new',
        rows: [createRow({ label: t`What’s New`, field: 'about-whats-new-row', activatable: true, onActivate: pages.whatsNew })],
    });
    const links = createPrefGroup({
        field: 'about-links',
        rows: [
            createLinkRow({ label: t`Website`, href: WEBSITE_URL, field: 'about-website' }),
            createLinkRow({ label: t`Report an Issue`, href: ISSUES_URL, field: 'about-issues' }),
        ],
    });
    const troubleshooting = createPrefGroup({
        field: 'about-troubleshooting',
        rows: [createRow({ label: t`Troubleshooting`, field: 'about-troubleshooting-row', activatable: true, onActivate: pages.troubleshooting })],
    });
    const more = createPrefGroup({
        field: 'about-more',
        rows: [
            createRow({ label: t`Credits`, field: 'about-credits', activatable: true, onActivate: pages.credits }),
            createRow({ label: t`Legal`, field: 'about-legal', activatable: true, onActivate: pages.legal }),
        ],
    });
    return [header, details.section, whatsNew.section, links.section, troubleshooting.section, more.section];
}

function fillWhatsNew(body) {
    body.append(createCopyBlock('AB-RELEASE-NOTES'));
}

function fillCredits(body) {
    const groups = [
        [t`Developers`, 'AB-CREDITS-DEVELOPERS'],
        [t`Designers`, 'AB-CREDITS-DESIGNERS'],
        [t`Artists`, 'AB-CREDITS-ARTISTS'],
        [t`Documenters`, 'AB-CREDITS-DOCUMENTERS'],
        [t`Translators`, 'AB-CREDITS-TRANSLATORS'],
        [t`Acknowledgements`, 'AB-CREDITS-ACKNOWLEDGEMENTS'],
    ];
    body.append(...groups.map(([title, slot]) => createSection(title, createCopyBlock(slot))));
}

function fillLegal(body) {
    const groups = [
        [t`Fan Work`, 'AB-FANWORK'],
        [t`Art Licence`, 'AB-ART-LICENCE'],
        [t`Nahida`, 'AB-NAHIDA'],
        [t`Third-Party Software`, 'AB-THIRD-PARTY'],
    ];
    body.append(...groups.map(([title, slot]) => createSection(title, createCopyBlock(slot))));
}

function fillTroubleshooting(body, server) {
    const read = () => formatDebugInfo({ ...readClientInfo(), ...server.details });
    const block = document.createElement('textarea');
    block.className = 'sbDebugInfo';
    block.readOnly = true;
    block.value = read();
    server.onChange(() => { block.value = read(); });
    block.rows = 8;
    block.spellcheck = false;
    block.setAttribute('aria-label', t`Debug Information`);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'menu_button';
    copy.textContent = t`Copy`;
    // A label change alone is not announced to a screen reader that keeps focus on the button.
    const copied = document.createElement('span');
    copied.className = 'sr-only';
    copied.setAttribute('aria-live', 'polite');
    let copiedTimer = 0;
    copy.addEventListener('click', () => {
        Promise.resolve(copyText(block.value)).then(() => {
            clearTimeout(copiedTimer);
            copy.textContent = t`Copied`;
            copied.textContent = t`Copied`;
            copiedTimer = setTimeout(() => {
                copy.textContent = t`Copy`;
                copied.textContent = '';
            }, COPIED_LABEL_MS);
        }).catch(error => console.warn('Could not copy the debug information.', error));
    });

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'menu_button';
    save.textContent = t`Save`;
    save.addEventListener('click', () => download(block.value, DEBUG_INFO_FILE_NAME, 'text/plain'));

    const actions = document.createElement('div');
    actions.className = 'sbWindowActions';
    actions.append(copy, save, copied);
    body.append(block, actions);
}

/**
 * Opens the About window.
 * @returns {Promise<ReturnType<typeof openDialog>>}
 */
export async function openAboutWindow() {
    await ensureWindowStyles();
    const server = requestServerDetails();
    /** @type {ReturnType<typeof openDialog>} */
    let dialog;
    const push = (title, fill) => () => dialog.push({ title, content: fill });
    dialog = openDialog({
        tier: 'dialog',
        title: t`About SillyBunny`,
        className: 'sbAboutDialog',
        content: (body) => {
            body.append(...createMainContent(server, {
                whatsNew: push(t`What’s New`, fillWhatsNew),
                troubleshooting: push(t`Troubleshooting`, body => fillTroubleshooting(body, server)),
                credits: push(t`Credits`, fillCredits),
                legal: push(t`Legal`, fillLegal),
            }));
        },
    });
    return dialog;
}
