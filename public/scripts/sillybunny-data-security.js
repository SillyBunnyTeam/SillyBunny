import { createButtonRow, createEntryRow, createPrefGroup, createPropertyRow, createRow, createSwitchRow, moveCaption } from './sillybunny-editor/rows.js';
import { createSelectRow } from './sillybunny-editor/select-row.js';

/**
 * Data & Security groups. The upstream rows of General and Export are moved, never recreated, because
 * `user.js`, `script.js` and `power-user.js` bind to their nodes by ID.
 */

const GROUP_CLASS = 'sb-data-security-group';

const GENERAL_DESCRIPTION = 'Language, account, usage stats, version, and browser cache';
const EXPORT_DESCRIPTION = 'Full data backups and settings snapshots';
const IMPORT_DESCRIPTION = 'Import characters, chats, themes, and other SillyTavern data from a folder path or backup ZIP.';

function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

const textOf = node => node?.textContent.trim() ?? '';

/**
 * A boxed-list group that the settings normaliser leaves alone.
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.description
 * @param {string} options.field
 * @param {string} [options.id]
 * @param {Node} [options.headerSuffix]
 * @param {boolean} [options.translated=false]  Marks the title and description with their translation keys.
 */
export function createDataSecurityGroup({ title, description, field, id, headerSuffix, translated = false }) {
    const group = createPrefGroup({ title, subtitle: description, field, id, headerSuffix });
    group.section.classList.add(GROUP_CLASS);
    group.section.dataset.sbPresentation = 'manual';
    if (translated) {
        group.section.querySelector('.ds-pref-group-heading').dataset.i18n = title;
        group.section.querySelector('.ds-pref-group-subtitle').dataset.i18n = description;
    }
    return group;
}

/** Moves an upstream caption into a row's own, when both exist. */
function moveCopy(row, selector, source, options) {
    const target = row.querySelector(selector);
    if (target && source) moveCaption(target, source, options);
}

/**
 * Builds a row from an upstream row's title and subtitle, so their text and `data-i18n` survive.
 * @param {Element|null} oldRow
 * @param {object} options  Options of `createRow`; `label` and `subtitle` default to the old row's.
 */
function createRowFrom(oldRow, options) {
    const label = oldRow?.querySelector('.ds-row-label');
    const subtitle = oldRow?.querySelector('.ds-row-subtitle');
    const controller = createRow({ label: textOf(label), subtitle: textOf(subtitle) || undefined, ...options });
    moveCopy(controller.row, '.ds-row-label', label);
    moveCopy(controller.row, '.ds-row-subtitle', subtitle);
    return controller;
}

/** A row for one upstream button, titled like the button. */
function createButtonHostRow(button, options) {
    const caption = button.querySelector('span') ?? button;
    const controller = createRow({ label: textOf(caption), ...options, suffix: button });
    if (caption.dataset.i18n) controller.row.querySelector('.ds-row-label').dataset.i18n = caption.dataset.i18n;
    return controller;
}

/** jQuery shows and hides the Admin Panel and Logout buttons by their inline `display`; the row follows its button. */
function followVisibility(button, row) {
    const sync = () => {
        row.style.display = button.style.display === 'none' || button.hidden ? 'none' : '';
    };
    sync();
    new MutationObserver(sync).observe(button, { attributes: true, attributeFilter: ['style', 'hidden'] });
}

function presentGeneral(container) {
    const find = selector => container.querySelector(selector);
    const old = ['#UI-language-block', '#account_controls', '#user_stats_controls', '#user-settings-utility-actions'].map(find);
    const rows = [];

    const select = find('#ui_language_select');
    if (select) {
        const oldRow = find('#UI-language-block');
        const row = createSelectRow({ select, label: textOf(oldRow?.querySelector('label')), subtitle: textOf(oldRow?.querySelector('.ds-row-subtitle')) || undefined, field: 'language', id: 'UI-language-block' });
        moveCopy(row.row, '.ds-row-label', oldRow?.querySelector('label'), { stripColon: true });
        moveCopy(row.row, '.ds-row-subtitle', oldRow?.querySelector('.ds-row-subtitle'));
        rows.push(row);
    }

    const accountButton = find('#account_button');
    if (accountButton) rows.push(createRowFrom(find('#account_controls'), { field: 'account', id: 'account_controls', suffix: accountButton }));

    for (const [id, field] of [['#admin_button', 'admin'], ['#logout_button', 'logout']]) {
        const button = find(id);
        if (!button) continue;
        const row = createButtonHostRow(button, { field });
        followVisibility(button, row.row);
        rows.push(row);
    }

    const usageButton = find('#user_stats_controls .user_stats_button');
    if (usageButton) rows.push(createRowFrom(find('#user_stats_controls'), { field: 'usage-stats', id: 'user_stats_controls', suffix: usageButton }));

    const version = find('#version_display');
    if (version) {
        const oldRow = version.closest('.ds-row');
        const label = oldRow?.querySelector('.ds-row-label');
        const property = createPropertyRow({ label: textOf(label) || 'Version', value: '', field: 'version' });
        if (label?.dataset.i18n) property.row.querySelector('.ds-row-subtitle').dataset.i18n = label.dataset.i18n;
        version.classList.add('ds-row-label', 'ds-row-property__value');
        property.row.querySelector('.ds-row-property__value').replaceWith(version);
        old.push(oldRow);
        rows.push(property);
    }

    const clearButtons = ['#clear_all_cache_button', '#clear_cookies_cache_button'].map(find).filter(Boolean);
    if (clearButtons.length) {
        const clearRow = createRowFrom(clearButtons[0].closest('.ds-row'), { field: 'clear-cache', id: 'user-settings-utility-actions', suffix: clearButtons });
        clearRow.row.classList.add('ds-row-actions');
        rows.push(clearRow);
    }

    const autoClear = find('#auto_clear_cache_on_update');
    if (autoClear) {
        const oldLabel = autoClear.closest('label');
        // The settings normaliser pointed these at captions that this row replaces.
        autoClear.removeAttribute('aria-labelledby');
        autoClear.removeAttribute('aria-describedby');
        rows.push(createSwitchRow({
            label: textOf(oldLabel?.querySelector('.ds-row-label, span')),
            subtitle: textOf(oldLabel?.querySelector('.ds-row-subtitle')) || oldLabel?.title || undefined,
            field: 'auto-clear-cache',
            input: autoClear,
        }));
        old.push(oldLabel);
    }

    const general = createDataSecurityGroup({ title: 'General', description: GENERAL_DESCRIPTION, field: 'general', translated: true });
    general.section.dataset.sbCategory = 'general';
    general.append(...rows);
    for (const node of old) node?.remove();
    container.prepend(general.section);
    return general;
}

function presentExport(container) {
    const rows = [
        ['#user_backup_controls', '#user_backup_button', 'download-backup'],
        ['#settings_snapshots_controls', '#settings_snapshots_button', 'settings-snapshots'],
    ].flatMap(([rowSelector, buttonSelector, field]) => {
        const oldRow = container.querySelector(rowSelector);
        const button = container.querySelector(buttonSelector);
        if (!button) return [];
        const row = createRowFrom(oldRow, { field, id: oldRow?.id || undefined, suffix: button });
        oldRow?.remove();
        return [row];
    });
    const exported = createDataSecurityGroup({ title: 'Export', description: EXPORT_DESCRIPTION, field: 'export', translated: true });
    exported.section.dataset.sbCategory = 'export';
    exported.append(...rows);
    container.append(exported.section);
    return exported;
}

/**
 * Regroups the live General and Export rows of the Data & Security container into boxed-list groups.
 * Import & Restore stays where it is until its group replaces it (see `buildImportGroup`).
 * @param {HTMLElement} container
 * @returns {{ general: object, exported: object } | null}  Null when the container was presented already.
 */
export function presentDataSecurity(container) {
    if (!(container instanceof HTMLElement) || container.dataset.sbDataSecurityPresented === 'true') return null;
    container.dataset.sbDataSecurityPresented = 'true';
    const general = presentGeneral(container);
    const exported = presentExport(container);
    return { general, exported };
}

/**
 * Builds the Import & Restore group. The caller binds the handlers to the returned nodes.
 * @returns {object}  The `section`, the boxed `card`, and the controls the importer reads.
 */
export function buildImportGroup() {
    const group = createDataSecurityGroup({ title: 'Import & Restore', description: IMPORT_DESCRIPTION, field: 'import', id: 'SillyTavernImportSection' });
    group.group.id = 'sb-import-card';

    const pathInput = element('input', '');
    pathInput.id = 'sb-import-path-input';
    pathInput.type = 'text';
    pathInput.placeholder = '/path/to/SillyTavern';
    pathInput.autocomplete = 'off';
    pathInput.spellcheck = false;
    pathInput.setAttribute('aria-label', 'SillyTavern folder path');
    pathInput.title = 'You can paste a full SillyTavern install path, its data folder, or a specific user folder.';
    const caption = 'Paste the path to your SillyTavern install, its data folder, or the specific user folder you want to import. Use the full import for everything, or sync just your third-party extensions with a detailed report.';
    const pathRow = createEntryRow({ label: 'Import From Folder Path', subtitle: caption, field: 'import-folder-path', input: pathInput, floating: true });
    pathRow.row.classList.add('sb-import-pane');
    pathRow.row.querySelector('.ds-row-entry__caption').innerHTML = 'Paste the path to your SillyTavern install, its <code>data</code> folder, or the specific user folder you want to import. Use the full import for everything, or sync just your third-party extensions with a detailed report.';

    const folderRow = createButtonRow({ label: 'Import Folder', icon: 'folder-open', field: 'import-folder' });
    const syncRow = createButtonRow({ label: 'Sync Extensions', icon: 'puzzle-piece', field: 'import-sync-extensions' });

    const zipButton = element('button', 'menu_button menu_button_icon');
    zipButton.type = 'button';
    zipButton.innerHTML = '<i class="fa-solid fa-file-zipper" aria-hidden="true"></i><span>Import Backup ZIP</span>';
    const zipFileInput = element('input', 'sb-import-file-input');
    zipFileInput.id = 'sb-import-zip-input';
    zipFileInput.type = 'file';
    zipFileInput.accept = '.zip,application/zip,application/x-zip-compressed';
    zipFileInput.setAttribute('aria-label', 'Choose a SillyTavern backup ZIP');
    const zipRow = createRow({
        label: 'Import From Backup ZIP',
        subtitle: 'Use the backup ZIP that SillyTavern exports. Pick the file here and SillyBunny will import it into this account.',
        field: 'import-zip',
        suffix: [zipButton, zipFileInput],
    });
    zipRow.row.classList.add('sb-import-pane');
    const zipFileName = element('small', 'ds-row-subtitle sb-import-file-name', 'No ZIP selected yet.');
    zipRow.row.querySelector('.ds-row-text').append(zipFileName);

    const note = element('div', 'ds-row sb-server-note sb-import-note', 'Full imports replace matching files and reload automatically. Extension sync replaces matching third-party extension folders, then shows a report so you can review it before reloading.');
    const report = element('section', 'sb-import-report');
    report.setAttribute('aria-live', 'polite');
    const reportHeader = element('div', 'sb-import-report-header');
    reportHeader.append(element('strong', '', 'Third-Party Extension Sync Report'));
    const reportSummary = element('p', 'sb-import-report-summary');
    const reportHelp = element('p', 'sb-import-report-help');
    const reportList = element('div', 'sb-import-report-list');
    report.append(reportHeader, reportSummary, reportHelp, reportList);
    report.hidden = true;

    group.append(pathRow, folderRow, syncRow, zipRow, note, report);

    return {
        section: group.section,
        card: group.group,
        folderPane: pathRow.row,
        folderRows: [pathRow.row, folderRow.row, syncRow.row],
        pathInput,
        folderButton: folderRow.row,
        syncButton: syncRow.row,
        zipButton,
        zipFileInput,
        zipFileName,
        note,
        report,
        reportSummary,
        reportHelp,
        reportList,
    };
}
