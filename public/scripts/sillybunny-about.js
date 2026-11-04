import { displayVersion } from '../script.js';
import { extension_settings, extensionNames } from './extensions.js';
import { t } from './i18n.js';
import { readBootMarks } from './sillybunny-boot-marks.js';
import { createArtPanel } from './sillybunny-home/art-layout.js';
import { markCopyPlaceholder } from './sillybunny-home/copy.js';
import { createArtIntro } from './sillybunny-home/art-intro.js';
import { openDialog } from './sillybunny-editor/dialog.js';
import { createPrefGroup, createPropertyRow, createRow } from './sillybunny-editor/rows.js';
import { ensureWindowStyles } from './sillybunny-window-styles.js';
import { copyText, download } from './utils.js';

const WEBSITE_URL = 'https://github.com/SillyBunnyTeam/SillyBunny';
const CONTRIBUTORS_URL = 'https://github.com/SillyTavern/SillyTavern/graphs/contributors';
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
 * @property {{ name: string, startTime: number }[]} [bootMarks]
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
export function formatDebugInfo({ version, branch, commit, userAgent, viewport, extensionCount, bootMarks = [] }) {
    const bootLines = bootMarks.length > 0
        ? bootMarks.map(({ name, startTime }) => `Boot mark ${name}: ${Math.round(startTime)} ms`)
        : ['Boot marks: not recorded'];
    return [
        `Version: ${version}`,
        `Branch: ${branch}`,
        `Commit: ${commit}`,
        `User agent: ${userAgent}`,
        `Viewport: ${viewport}`,
        `Enabled extensions: ${extensionCount}`,
        ...bootLines,
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
        bootMarks: readBootMarks(),
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

function createTextBlock(text) {
    const block = document.createElement('p');
    block.textContent = text;
    return block;
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

/** The logo is decoration: the name below it says what it is. */
function createLogo() {
    const logo = document.createElement('img');
    logo.className = 'sbAboutLogo';
    logo.src = 'img/sillybunny/logo-64.png';
    logo.srcset = 'img/sillybunny/logo-64.png 1x, img/sillybunny/logo.svg 2x';
    logo.width = 64;
    logo.height = 64;
    logo.alt = '';
    logo.setAttribute('aria-hidden', 'true');
    logo.decoding = 'async';
    return logo;
}

function createMainContent(server, pages) {
    const header = document.createElement('div');
    header.className = 'sbAboutHeader';
    const name = document.createElement('h3');
    name.className = 'sbAboutName';
    name.textContent = 'SillyBunny';
    const developer = document.createElement('p');
    developer.className = 'sbAboutDeveloper';
    developer.textContent = 'SillyBunnyTeam';
    header.append(createLogo(), name, developer);
    // Both characters share one panel at one step, so Tewi stands at her own height beside Reisen. The logo stays in the header.
    const { panel: characters } = createArtPanel(['about-reisen', 'about-tewi']);

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
    return [characters, header, details.section, whatsNew.section, links.section, troubleshooting.section, more.section];
}

function fillWhatsNew(body) {
    body.append(createCopyBlock('AB-RELEASE-NOTES'));
}

const CREDITED_NAMES = ['Geechan', 'TheLonelyDevil', 'voldomero'];

const slugOf = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** One non-activatable row per name, in the order given, which is how the GNOME About dialog lists credits. */
function createNameGroup(role, names) {
    return createPrefGroup({
        field: `about-credits-${role}`,
        rows: names.map(name => createRow({ label: name, field: `about-credits-${role}-${slugOf(name)}` })),
    });
}

function createAcknowledgements() {
    const people = [
        { name: 'purachina', note: t`For initially creating and contributing to the program` },
        { name: 'ZUN', note: t`For Reisen and Tewi from the Touhou Project` },
        { name: 'RivelleDays', note: t`For the usage of Moonlit Echoes' chat styles` },
        { name: 'Cohee, Wolfsblvt and RossAscends', note: t`For their work on SillyTavern, without which SillyBunny wouldn't be possible` },
    ];
    return createPrefGroup({
        field: 'about-credits-acknowledgements',
        rows: [
            ...people.map(({ name, note }) => createRow({ label: name, subtitle: note, field: `about-credits-acknowledgements-${slugOf(name)}` })),
            createLinkRow({ label: t`Other SillyTavern contributors`, href: CONTRIBUTORS_URL, field: 'about-credits-acknowledgements-contributors' }),
        ],
    });
}

// A role with no names is left out, as AdwAboutDialog does.
function fillCredits(body) {
    const groups = [
        [t`Developers`, createNameGroup('developers', CREDITED_NAMES)],
        [t`Designers`, createNameGroup('designers', CREDITED_NAMES)],
        [t`Documenters`, createNameGroup('documenters', CREDITED_NAMES)],
        [t`Acknowledgements`, createAcknowledgements()],
    ];
    body.append(...groups.map(([title, group]) => createSection(title, group.section)));
}

function fillLegal(body) {
    const groups = [
        [t`Fan Work`, t`Reisen Udongein Inaba and Tewi Inaba are characters from Touhou Project by Team Shanghai Alice. SillyBunny's artwork of them is unofficial fan work, and SillyBunny is not affiliated with or endorsed by Team Shanghai Alice. It is free and non-commercial.`],
        [t`Art Licence`, t`SillyBunny's artwork, including the logo and icons, is AI-generated and licensed under CC BY-NC-SA 4.0, separately from the program's AGPL-3.0 licence. You may share and adapt it if you credit SillyBunny, use it non-commercially and share alike.`],
        [t`Third-Party Software`, t`SillyBunny is licensed under the AGPL-3.0, like SillyTavern, which it is based on. It includes Adwaita Sans and Adwaita Mono (SIL OFL 1.1), Font Awesome Free (icons CC BY 4.0, fonts SIL OFL 1.1, code MIT), pdf.js (Apache-2.0), and other open-source libraries such as jQuery, jQuery UI, JSZip, html2canvas, DOMPurify, highlight.js, Handlebars, Showdown, Lodash and Fuse.js, each under its own licence.`],
    ];
    body.append(...groups.map(([title, text]) => createSection(title, createTextBlock(text))));
}

/**
 * A textarea does not grow with its text, and a phone wraps the long user agent line over more rows than
 * `rows` allows. The block takes the height of its text and `.sbDebugInfo` caps it, so the last line is never hidden.
 * The size is measured from a collapsed block, whose scrollHeight is the text plus its padding.
 * @param {HTMLTextAreaElement} block
 * @returns {() => void} Measures again; call it after the text changes.
 */
function fitToText(block) {
    const fit = () => {
        block.style.blockSize = '0';
        const { scrollHeight, offsetHeight, clientHeight } = block;
        // A block that is not laid out measures 0 and keeps the height of its rows until it is shown.
        block.style.blockSize = scrollHeight > 0 ? `${scrollHeight + offsetHeight - clientHeight}px` : '';
    };
    let lastWidth = 0;
    new ResizeObserver(([entry]) => {
        if (entry.contentRect.width === lastWidth) return;
        lastWidth = entry.contentRect.width;
        fit();
    }).observe(block);
    return fit;
}

function fillTroubleshooting(body, server) {
    const read = () => formatDebugInfo({ ...readClientInfo(), ...server.details });
    const block = document.createElement('textarea');
    block.className = 'sbDebugInfo';
    block.readOnly = true;
    block.value = read();
    const fit = fitToText(block);
    server.onChange(() => { block.value = read(); fit(); });
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
    body.append(createArtIntro({ art: 'troubleshooting-reisen', text: t`Having an issue, brave hero? Sorry to hear. Copy or save this information and include it when you ask for help or report an issue. It will help us diagnose the problem for you.` }).intro, block, actions);
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
