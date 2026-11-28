import { eventSource, event_types } from '../events.js';
import { isAdmin } from '../user.js';

function getExtensionSyncStatusTone(status) {
    if (status === 'failed') {
        return 'danger';
    }

    if (status === 'warning') {
        return 'warn';
    }

    return 'good';
}

function getExtensionSyncStatusLabel(status) {
    if (status === 'failed') {
        return 'Failed';
    }

    if (status === 'warning') {
        return 'Needs Attention';
    }

    return 'Ready';
}

function getExtensionSyncCheckSummary(result) {
    const checks = [];
    const manifestFound = result?.checks?.manifestFound === true;
    const manifestValid = result?.checks?.manifestValid === true;
    const jsEntry = typeof result?.checks?.jsEntry === 'string' ? result.checks.jsEntry.trim() : '';
    const jsEntryExists = result?.checks?.jsEntryExists === true;
    const gitMetadataSkipped = result?.checks?.gitMetadataSkipped === true;

    checks.push(!manifestFound
        ? 'manifest missing'
        : manifestValid
            ? 'manifest OK'
            : 'manifest invalid');
    checks.push(jsEntry
        ? jsEntryExists
            ? `JS entry: ${jsEntry}`
            : `JS missing: ${jsEntry}`
        : 'no JS entry');

    if (gitMetadataSkipped) {
        checks.push('git metadata skipped');
    }

    return checks.join(' · ');
}

export function createImporterUiController({
    createElement,
    getImporterState,
    getImporterRefs,
    setButtonDisabled,
    setServerAdminPill,
    handleSillyTavernFolderImport,
    handleSillyTavernExtensionSync,
    handleSillyTavernZipImport,
}) {
    function updateSillyTavernImportInteractivity() {
        const state = getImporterState();
        const refs = getImporterRefs();

        if (!refs) {
            return;
        }

        setButtonDisabled(refs.folderButton, state.busy);
        setButtonDisabled(refs.syncButton, state.busy);
        setButtonDisabled(refs.zipButton, state.busy);

        if (refs.pathInput instanceof HTMLInputElement) {
            refs.pathInput.disabled = state.busy;
        }
    }

    /**
     * Shows the folder import pane only to admins, because the server refuses the folder import and the extension sync to other users.
     * With accounts off, isAdmin() is true.
     */
    function updateFolderImportVisibility() {
        // .ds-row sets display: flex, which the hidden attribute does not override.
        for (const row of getImporterRefs()?.folderRows ?? []) {
            if (row instanceof HTMLElement) {
                row.style.display = isAdmin() ? '' : 'none';
            }
        }
    }

    function setSillyTavernImportBusy(isBusy) {
        getImporterState().busy = Boolean(isBusy);
        updateSillyTavernImportInteractivity();
    }

    function renderSillyTavernExtensionSyncReport(reportData = null) {
        const refs = getImporterRefs();
        const report = refs?.report;
        const summary = refs?.reportSummary;
        const help = refs?.reportHelp;
        const list = refs?.reportList;
        const state = getImporterState();

        state.report = reportData;

        if (!(report instanceof HTMLElement) || !(summary instanceof HTMLElement) || !(help instanceof HTMLElement) || !(list instanceof HTMLElement)) {
            return;
        }

        if (!reportData || !Array.isArray(reportData.results) || reportData.results.length === 0) {
            report.hidden = true;
            summary.textContent = '';
            help.textContent = '';
            list.replaceChildren();
            return;
        }

        const results = reportData.results;
        const readyCount = Number(reportData.readyCount ?? 0) || 0;
        const warningCount = Number(reportData.warningCount ?? 0) || 0;
        const failedCount = Number(reportData.failedCount ?? 0) || 0;
        const syncedCount = readyCount + warningCount;
        const needsAttention = warningCount + failedCount > 0;
        const gitMetadataSkippedCount = Number(reportData.gitMetadataSkippedCount ?? 0)
            || results.filter(result => result?.checks?.gitMetadataSkipped === true).length;

        summary.textContent = reportData.message
            || `Synced ${syncedCount} of ${results.length} third-party extensions.`;
        help.textContent = needsAttention
            ? `If an extension still misbehaves after a reload, contact purachina with the extension name and the report below.${gitMetadataSkippedCount > 0 ? ` Git metadata was skipped on ${gitMetadataSkippedCount} extension${gitMetadataSkippedCount === 1 ? '' : 's'} to avoid permission issues, so built-in update tooling may need a reinstall later.` : ''}`
            : gitMetadataSkippedCount > 0
                ? `Reload when you are ready to activate the synced extensions. Git metadata was skipped on ${gitMetadataSkippedCount} extension${gitMetadataSkippedCount === 1 ? '' : 's'} to avoid permission issues, so built-in update tooling may need a reinstall later.`
                : 'Reload when you are ready to activate the synced extensions.';

        const items = results.map(result => {
            const card = createElement('article', { className: `sb-import-report-item is-${result?.status || 'warning'}` });
            const header = createElement('div', { className: 'sb-import-report-item-header' });
            const titleGroup = createElement('div', { className: 'sb-import-report-item-title' });
            const title = createElement('strong', { text: result?.displayName || result?.name || 'Unknown Extension' });
            const metaParts = [];

            if (result?.version) {
                metaParts.push(`v${result.version}`);
            }

            if (result?.author) {
                metaParts.push(result.author);
            }

            const meta = createElement('small', {
                className: 'sb-import-report-item-meta',
                text: metaParts.join(' • '),
            });
            const pill = createElement('span', { className: 'sb-server-pill' });

            setServerAdminPill(pill, getExtensionSyncStatusLabel(result?.status), getExtensionSyncStatusTone(result?.status));
            titleGroup.append(title);

            if (metaParts.length > 0) {
                titleGroup.append(meta);
            }

            header.append(titleGroup, pill);

            const body = createElement('div', { className: 'sb-import-report-item-body' });
            const copiedFiles = Number(result?.copiedFiles ?? 0) || 0;
            const statusLine = createElement('p', {
                className: 'sb-import-report-item-copy',
                text: result?.status === 'failed'
                    ? (result?.error || 'This extension could not be synced.')
                    : `Copied ${copiedFiles} file${copiedFiles === 1 ? '' : 's'} into ${result?.name || 'extension'}.`,
            });
            const checksLine = createElement('p', {
                className: 'sb-import-report-item-checks',
                text: getExtensionSyncCheckSummary(result),
            });

            body.append(statusLine, checksLine);

            if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
                const warningList = createElement('ul', { className: 'sb-import-report-warnings' });

                for (const warning of result.warnings) {
                    warningList.appendChild(createElement('li', { text: warning }));
                }

                body.appendChild(warningList);
            }

            card.append(header, body);
            return card;
        });

        list.replaceChildren(...items);
        report.hidden = false;
    }

    function logSillyTavernExtensionSyncReport(reportData) {
        if (!reportData || !Array.isArray(reportData.results)) {
            return;
        }

        console.groupCollapsed(`[SillyBunny] Third-party extension sync report (${reportData.results.length})`);
        console.table(reportData.results.map(result => ({
            name: result?.name || '',
            displayName: result?.displayName || '',
            status: result?.status || '',
            copiedFiles: Number(result?.copiedFiles ?? 0) || 0,
            manifestFound: result?.checks?.manifestFound === true,
            manifestValid: result?.checks?.manifestValid === true,
            jsEntry: result?.checks?.jsEntry || '',
            jsEntryExists: result?.checks?.jsEntryExists === true,
            gitMetadataSkipped: result?.checks?.gitMetadataSkipped === true,
            warningCount: Array.isArray(result?.warnings) ? result.warnings.length : 0,
            error: result?.error || '',
        })));
        console.groupEnd();
    }

    function injectSillyTavernImportCard(host, { buildImportGroup }) {
        // Import & Restore lives on the Data & Security tab. It is injected only when that panel is built:
        // before then the settings container is detached, and an earlier call would paint the group into
        // another tab.
        if (!(host instanceof HTMLElement) || host.querySelector('#sb-import-card')) {
            return;
        }

        const built = buildImportGroup();
        const placeholder = host.querySelector('#SillyTavernImportSection');
        if (placeholder) {
            placeholder.replaceWith(built.section);
        } else {
            host.prepend(built.section);
        }

        const { folderButton, syncButton, pathInput, zipButton, zipFileInput, zipFileName } = built;
        getImporterState().refs = {
            card: built.card,
            folderPane: built.folderPane,
            folderRows: built.folderRows,
            pathInput,
            folderButton,
            syncButton,
            zipButton,
            zipFileInput,
            zipFileName,
            note: built.note,
            report: built.report,
            reportSummary: built.reportSummary,
            reportHelp: built.reportHelp,
            reportList: built.reportList,
        };

        folderButton.addEventListener('click', handleSillyTavernFolderImport);
        syncButton.addEventListener('click', handleSillyTavernExtensionSync);
        pathInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                void handleSillyTavernFolderImport();
            }
        });

        zipButton.addEventListener('click', () => zipFileInput.click());
        zipFileInput.addEventListener('change', () => {
            const [file] = Array.from(zipFileInput.files ?? []);
            zipFileName.textContent = file?.name || 'No ZIP selected yet';

            if (file) {
                void handleSillyTavernZipImport(file);
            }
        });

        updateSillyTavernImportInteractivity();
        updateFolderImportVisibility();
        // isAdmin() is true until the client knows that accounts are on, and then false until /api/users/me answers.
        // getSettings() does both before it emits SETTINGS_LOADED, so a card built after that event already sees the final value.
        eventSource.on(event_types.SETTINGS_LOADED, updateFolderImportVisibility);
    }

    return {
        updateSillyTavernImportInteractivity,
        updateFolderImportVisibility,
        setSillyTavernImportBusy,
        renderSillyTavernExtensionSyncReport,
        logSillyTavernExtensionSyncReport,
        injectSillyTavernImportCard,
    };
}
