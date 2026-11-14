import { yaml } from '../lib.js';
import { openAlert } from './sillybunny-editor/dialog.js';
import { loadListEditorStyles } from './sillybunny-editor/list-shell.js';
import { createButtonRow, createPropertyRow, createRow, createSpinRow, createSwitchRow, createTextAreaField } from './sillybunny-editor/rows.js';
import { createSelectRow } from './sillybunny-editor/select-row.js';
import { createDataSecurityGroup } from './sillybunny-data-security.js';
import { t } from './i18n.js';

const SB_CONSOLE_LOG_LIMIT = 260;
const SB_CONSOLE_LOG_REFRESH_MS = 2500;
const SB_CONSOLE_LOG_STICKY_THRESHOLD = 28;
const SB_INSTALLER_URL = 'https://github.com/SillyBunnyTeam/SillyBunny/releases/latest';

// SillyBunny: server administration is loaded only when its panels or settings search are used.
export function createServerTools({ createElement, createShellPanel, hasServerReturnedAfterRestart, isShellOpen, isShellTabOpen, setButtonDisabled, setServerAdminMessage, setServerAdminPill, wait, waitForAuthorizedRequestHeaders }) {
    const sbState = {
        serverAdmin: {
            refs: null,
            originalConfig: '',
            lastModifiedMs: 0,
            thumbnailLastModifiedMs: 0,
            thumbnailSettingsLoaded: false,
            lastStatusData: null,
            busy: false,
            restarting: false,
            configLoaded: false,
            autoStashEnabled: false,
        },
        consoleLogs: {
            /** @type {{ statusPill: HTMLElement, refreshRow: { setDisabled: (disabled: boolean) => void }, pauseLabel: HTMLElement, statusNote: HTMLElement, output: HTMLElement, verboseLoggingStatus: HTMLElement, verboseLoggingActionButton: HTMLInputElement } | null} */
            refs: null,
            entries: [],
            latestId: 0,
            captureStartedAt: 0,
            totalBuffered: 0,
            refreshTimer: 0,
            busy: false,
            paused: false,
            lastUpdatedAt: 0,
            lastError: '',
            configBusy: false,
            configLoaded: false,
            configPath: '',
            configLastModifiedMs: 0,
            verboseLoggingEnabled: false,
        },
    };

    function getServerAdminState() {
        return sbState.serverAdmin;
    }

    function getServerAdminRefs() {
        return getServerAdminState().refs;
    }

    function getConsoleLogsState() {
        return sbState.consoleLogs;
    }

    function getConsoleLogsRefs() {
        return getConsoleLogsState().refs;
    }

    function isConsoleLogsTabActive() {
        return isShellTabOpen('right', 'console-logs');
    }

    function formatConsoleLogTime(timestamp) {
        const date = new Date(Number(timestamp));
        if (Number.isNaN(date.getTime())) {
            return '00:00:00';
        }

        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
    }

    function formatConsoleLogDateTime(timestamp) {
        const date = new Date(Number(timestamp));
        if (Number.isNaN(date.getTime())) {
            return 'Unknown';
        }

        return date.toLocaleString([], {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
    }

    function formatConsoleLogEntry(entry) {
        const stream = String(entry?.stream ?? 'stdout').toUpperCase().padEnd(6);
        const message = String(entry?.message ?? '');
        return `[${formatConsoleLogTime(entry?.timestamp)}] ${stream} ${message}`;
    }

    function isScrolledNearBottom(element, threshold = SB_CONSOLE_LOG_STICKY_THRESHOLD) {
        if (!(element instanceof HTMLElement)) {
            return true;
        }

        return (element.scrollHeight - element.scrollTop - element.clientHeight) <= threshold;
    }

    function updateConsoleLogsInteractivity() {
        const state = getConsoleLogsState();
        const refs = getConsoleLogsRefs();

        if (!refs) {
            return;
        }

        refs.pauseLabel.textContent = state.paused ? 'Resume Live' : 'Pause Live';
        refs.refreshRow.setDisabled(state.busy);
        refs.verboseLoggingActionButton.disabled = state.busy || state.configBusy || !state.configLoaded;
    }

    function setConsoleLogsVerboseLoggingUI(value) {
        const state = getConsoleLogsState();
        const refs = getConsoleLogsRefs();
        const enabled = Number(value) === 0;

        state.verboseLoggingEnabled = enabled;

        if (refs?.verboseLoggingStatus instanceof HTMLElement) {
            refs.verboseLoggingStatus.textContent = enabled
                ? 'Verbose logging is enabled.'
                : 'Standard logging is enabled.';
            refs.verboseLoggingStatus.dataset.state = enabled ? 'warn' : 'neutral';
        }

        if (refs?.verboseLoggingActionButton instanceof HTMLInputElement) {
            refs.verboseLoggingActionButton.checked = enabled;
        }

        updateConsoleLogsInteractivity();
    }

    function getLoggingConfigTextFromYaml(content) {
        if (typeof content !== 'string' || !content.trim()) {
            return 1;
        }

        const match = content.match(/^\s*minLogLevel:\s*(\d+)\s*$/m);
        return match ? Number(match[1]) : 1;
    }

    function replaceLoggingMinLogLevel(content, nextLevel) {
        const desiredLevel = Number(nextLevel) === 0 ? 0 : 1;
        const minLogLevelPattern = /^(\s*minLogLevel:\s*)(\d+)\s*$/m;

        if (minLogLevelPattern.test(content)) {
            return content.replace(minLogLevelPattern, `$1${desiredLevel}`);
        }

        const loggingHeaderPattern = /^(logging:\s*\n)(?:\s*#.*\n)*?/m;
        if (loggingHeaderPattern.test(content)) {
            return content.replace(loggingHeaderPattern, (match) => `${match}  minLogLevel: ${desiredLevel}\n`);
        }

        return `${content.trimEnd()}\n\nlogging:\n  minLogLevel: ${desiredLevel}\n`;
    }

    async function refreshConsoleLogsConfig() {
        const state = getConsoleLogsState();
        const refs = getConsoleLogsRefs();

        if (!refs) {
            return;
        }

        state.configBusy = true;
        updateConsoleLogsInteractivity();

        try {
            const data = await requestServerAdmin('/api/server-admin/config/get');
            const content = String(data?.content ?? '');
            const enabled = getLoggingConfigTextFromYaml(content) === 0;

            state.configLoaded = true;
            state.configPath = String(data?.path ?? '');
            state.configLastModifiedMs = Number(data?.lastModifiedMs ?? 0) || 0;
            setConsoleLogsVerboseLoggingUI(enabled ? 0 : 1);
        } catch (error) {
            state.configLoaded = false;
            state.verboseLoggingEnabled = false;
            if (refs?.verboseLoggingStatus instanceof HTMLElement) {
                refs.verboseLoggingStatus.textContent = error?.message || 'Failed to load config.yaml.';
                refs.verboseLoggingStatus.dataset.state = 'danger';
            }
            console.error('Failed to load logging config for Console Logs.', error);
        } finally {
            state.configBusy = false;
            updateConsoleLogsInteractivity();
        }
    }

    async function toggleConsoleLogsVerboseLogging() {
        const state = getConsoleLogsState();
        const refs = getConsoleLogsRefs();

        if (!refs || !state.configLoaded || state.configBusy || state.busy) {
            return;
        }

        state.configBusy = true;
        updateConsoleLogsInteractivity();

        try {
            const data = await requestServerAdmin('/api/server-admin/config/get');
            const content = String(data?.content ?? '');
            const nextEnabled = !state.verboseLoggingEnabled;
            const nextContent = replaceLoggingMinLogLevel(content, nextEnabled ? 0 : 1);
            const result = await requestServerAdmin('/api/server-admin/config/save', {
                content: nextContent,
                expectedLastModifiedMs: Number(data?.lastModifiedMs ?? 0) || state.configLastModifiedMs,
                restart: false,
            });

            state.configPath = String(result?.path ?? state.configPath);
            state.configLastModifiedMs = Number(result?.lastModifiedMs ?? 0) || state.configLastModifiedMs;
            setConsoleLogsVerboseLoggingUI(nextEnabled ? 0 : 1);
            if (refs.verboseLoggingStatus instanceof HTMLElement) {
                refs.verboseLoggingStatus.textContent = result?.message || 'Logging config saved.';
                refs.verboseLoggingStatus.dataset.state = 'saved';
            }
            globalThis.toastr?.success?.('Logging config saved. Restart SillyBunny to apply it.', 'Console logs');
        } catch (error) {
            setConsoleLogsVerboseLoggingUI(state.verboseLoggingEnabled ? 0 : 1);
            console.error('Failed to save logging config for Console Logs.', error);
            if (refs?.verboseLoggingStatus instanceof HTMLElement) {
                refs.verboseLoggingStatus.textContent = error?.message || 'Failed to save logging config.';
                refs.verboseLoggingStatus.dataset.state = 'danger';
            }
            globalThis.toastr?.error?.(error?.message || 'Failed to save logging config.', 'Console logs');
        } finally {
            state.configBusy = false;
            updateConsoleLogsInteractivity();
        }
    }

    function renderConsoleLogsStatus() {
        const state = getConsoleLogsState();
        const refs = getConsoleLogsRefs();

        if (!refs) {
            return;
        }

        if (state.lastError) {
            setServerAdminPill(refs.statusPill, 'Unavailable', 'danger');
            setServerAdminMessage(refs.statusNote, state.lastError, 'danger');
            return;
        }

        const linesShown = state.entries.length;
        const totalBuffered = state.totalBuffered || linesShown;
        const noteParts = [`Showing ${linesShown} of ${totalBuffered} recent console line${totalBuffered === 1 ? '' : 's'}.`];

        if (state.captureStartedAt) {
            noteParts.push(`Capture started ${formatConsoleLogDateTime(state.captureStartedAt)}.`);
        }

        if (state.lastUpdatedAt) {
            noteParts.push(`Last updated ${formatConsoleLogTime(state.lastUpdatedAt)}.`);
        }

        noteParts.push(state.paused
            ? 'Live polling is paused.'
            : `Refreshes every ${(SB_CONSOLE_LOG_REFRESH_MS / 1000).toFixed(1).replace(/\.0$/, '')} seconds while this tab is open.`);

        setServerAdminPill(refs.statusPill, state.busy ? 'Loading…' : state.paused ? 'Paused' : 'Live', state.paused ? 'warn' : 'good');
        setServerAdminMessage(refs.statusNote, noteParts.join(' '), state.paused ? 'warn' : 'neutral');
    }

    function renderConsoleLogsOutput({ preserveScroll = true } = {}) {
        const state = getConsoleLogsState();
        const refs = getConsoleLogsRefs();
        const output = refs?.output;

        if (!(output instanceof HTMLElement)) {
            return;
        }

        const shouldStickToBottom = !preserveScroll || isScrolledNearBottom(output);
        output.textContent = state.entries.length
            ? state.entries.map(formatConsoleLogEntry).join('\n')
            : 'No console output has been captured yet for this server process.';
        output.classList.toggle('is-empty', state.entries.length === 0);

        if (shouldStickToBottom) {
            output.scrollTop = output.scrollHeight;
        }

        renderConsoleLogsStatus();
    }

    function scheduleConsoleLogsRefresh(delay = SB_CONSOLE_LOG_REFRESH_MS) {
        const state = getConsoleLogsState();
        window.clearTimeout(state.refreshTimer);
        state.refreshTimer = 0;

        if (state.paused || !isConsoleLogsTabActive()) {
            return;
        }

        state.refreshTimer = window.setTimeout(() => {
            void refreshConsoleLogs();
        }, delay);
    }

    async function refreshConsoleLogs({ forceFull = false } = {}) {
        const state = getConsoleLogsState();
        const refs = getConsoleLogsRefs();

        if (!refs) {
            return;
        }

        window.clearTimeout(state.refreshTimer);
        state.refreshTimer = 0;

        if (state.busy) {
            scheduleConsoleLogsRefresh();
            return;
        }

        state.busy = true;
        updateConsoleLogsInteractivity();
        renderConsoleLogsStatus();

        const requestBody = {
            limit: SB_CONSOLE_LOG_LIMIT,
        };

        if (!forceFull && state.latestId > 0) {
            requestBody.afterId = state.latestId;
        }

        try {
            const data = await requestServerAdmin('/api/server-admin/logs', requestBody);
            const nextEntries = Array.isArray(data?.entries)
                ? data.entries.map(entry => ({
                    id: Number(entry?.id ?? 0) || 0,
                    timestamp: Number(entry?.timestamp ?? 0) || 0,
                    stream: String(entry?.stream ?? 'stdout'),
                    message: String(entry?.message ?? ''),
                })).filter(entry => entry.id > 0)
                : [];

            if (forceFull || !requestBody.afterId || data?.truncated) {
                state.entries = nextEntries.slice(-SB_CONSOLE_LOG_LIMIT);
            } else if (nextEntries.length > 0) {
                const mergedEntries = new Map(state.entries.map(entry => [entry.id, entry]));

                for (const entry of nextEntries) {
                    mergedEntries.set(entry.id, entry);
                }

                state.entries = Array.from(mergedEntries.values())
                    .sort((left, right) => left.id - right.id)
                    .slice(-SB_CONSOLE_LOG_LIMIT);
            }

            state.latestId = Number(data?.latestId ?? state.latestId) || state.latestId;
            state.captureStartedAt = Number(data?.captureStartedAt ?? state.captureStartedAt) || state.captureStartedAt;
            state.totalBuffered = Number(data?.totalBuffered ?? state.totalBuffered) || state.totalBuffered;
            state.lastUpdatedAt = Date.now();
            state.lastError = '';
            renderConsoleLogsOutput();
        } catch (error) {
            console.error('Failed to refresh console logs panel.', error);
            state.lastError = error.message || 'Failed to read console logs.';
            renderConsoleLogsStatus();
        } finally {
            state.busy = false;
            updateConsoleLogsInteractivity();
            renderConsoleLogsStatus();
            scheduleConsoleLogsRefresh();
        }
    }

    function toggleConsoleLogsPolling() {
        const state = getConsoleLogsState();
        state.paused = !state.paused;

        if (state.paused) {
            window.clearTimeout(state.refreshTimer);
            state.refreshTimer = 0;
        }

        updateConsoleLogsInteractivity();
        renderConsoleLogsStatus();

        if (!state.paused) {
            void refreshConsoleLogs({ forceFull: state.latestId === 0 });
        }
    }

    async function requestServerAdmin(endpoint, body = {}, { signal } = {}) {
        const headers = await waitForAuthorizedRequestHeaders();
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
        });

        const text = await response.text();
        let data = null;

        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = { message: text };
        }

        if (!response.ok) {
            const message = response.status === 403
                ? 'Server tools are only available after an admin session is ready.'
                : data?.error || data?.message || text || `Request failed with status ${response.status}.`;
            const error = new Error(message);
            error.status = response.status;
            error.data = data;
            throw error;
        }

        return data;
    }

    /** A button row keeps its text in `.ds-row-label`; setting the button's own text would drop the label node. */
    function getServerButtonLabel(button) {
        return button.querySelector('.ds-row-label') ?? button;
    }

    function setServerAdminButtonLabel(button, isBusy, busyLabel) {
        if (!(button instanceof HTMLButtonElement)) {
            return;
        }

        const label = getServerButtonLabel(button);

        if (!button.dataset.idleLabel) {
            button.dataset.idleLabel = label.textContent || '';
        }

        label.textContent = isBusy ? busyLabel : button.dataset.idleLabel;
    }

    function describeAutoStashState(result) {
        if (!result?.stashed) {
            return '';
        }

        if (result?.stashPopWarning) {
            return result.stashPopWarning;
        }

        return 'Local tracked and untracked changes were auto-stashed and restored.';
    }

    function getThumbnailSettingsFromRefs(refs = getServerAdminRefs()) {
        const parseSize = (input, fallback) => {
            const value = Number.parseInt(input?.value, 10);
            return Number.isFinite(value) ? Math.min(4096, Math.max(1, value)) : fallback;
        };

        return {
            settings: {
                enabled: Boolean(refs?.thumbnailEnabled?.checked),
                format: refs?.thumbnailFormat?.value === 'jpg' ? 'jpg' : 'png',
                quality: parseSize(refs?.thumbnailQuality, 100),
                dimensions: {
                    bg: [
                        parseSize(refs?.thumbnailBgWidth, 240),
                        parseSize(refs?.thumbnailBgHeight, 135),
                    ],
                    avatar: [
                        parseSize(refs?.thumbnailAvatarWidth, 864),
                        parseSize(refs?.thumbnailAvatarHeight, 1280),
                    ],
                    persona: [
                        parseSize(refs?.thumbnailPersonaWidth, 864),
                        parseSize(refs?.thumbnailPersonaHeight, 1280),
                    ],
                },
            },
            mobileSettings: {
                enabled: Boolean(refs?.thumbnailMobileEnabled?.checked),
                format: refs?.thumbnailMobileFormat?.value === 'jpg' ? 'jpg' : 'png',
                quality: parseSize(refs?.thumbnailMobileQuality, 82),
                dimensions: {
                    bg: [
                        parseSize(refs?.thumbnailMobileBgWidth, 240),
                        parseSize(refs?.thumbnailMobileBgHeight, 135),
                    ],
                    avatar: [
                        parseSize(refs?.thumbnailMobileAvatarWidth, 320),
                        parseSize(refs?.thumbnailMobileAvatarHeight, 480),
                    ],
                    persona: [
                        parseSize(refs?.thumbnailMobilePersonaWidth, 320),
                        parseSize(refs?.thumbnailMobilePersonaHeight, 480),
                    ],
                },
            },
        };
    }

    function setThumbnailInputValues({ settings = {}, mobileSettings = {} } = {}, refs = getServerAdminRefs()) {
        if (!refs) {
            return;
        }

        refs.thumbnailEnabled.checked = Boolean(settings.enabled);
        refs.thumbnailFormat.value = settings.format === 'jpg' ? 'jpg' : 'png';
        refs.thumbnailQuality.value = String(settings.quality ?? 100);
        refs.thumbnailBgWidth.value = String(settings.dimensions?.bg?.[0] ?? 240);
        refs.thumbnailBgHeight.value = String(settings.dimensions?.bg?.[1] ?? 135);
        refs.thumbnailAvatarWidth.value = String(settings.dimensions?.avatar?.[0] ?? 864);
        refs.thumbnailAvatarHeight.value = String(settings.dimensions?.avatar?.[1] ?? 1280);
        refs.thumbnailPersonaWidth.value = String(settings.dimensions?.persona?.[0] ?? 864);
        refs.thumbnailPersonaHeight.value = String(settings.dimensions?.persona?.[1] ?? 1280);

        refs.thumbnailMobileEnabled.checked = Boolean(mobileSettings.enabled);
        refs.thumbnailMobileFormat.value = mobileSettings.format === 'jpg' ? 'jpg' : 'png';
        refs.thumbnailMobileQuality.value = String(mobileSettings.quality ?? 82);
        refs.thumbnailMobileBgWidth.value = String(mobileSettings.dimensions?.bg?.[0] ?? 240);
        refs.thumbnailMobileBgHeight.value = String(mobileSettings.dimensions?.bg?.[1] ?? 135);
        refs.thumbnailMobileAvatarWidth.value = String(mobileSettings.dimensions?.avatar?.[0] ?? 320);
        refs.thumbnailMobileAvatarHeight.value = String(mobileSettings.dimensions?.avatar?.[1] ?? 480);
        refs.thumbnailMobilePersonaWidth.value = String(mobileSettings.dimensions?.persona?.[0] ?? 320);
        refs.thumbnailMobilePersonaHeight.value = String(mobileSettings.dimensions?.persona?.[1] ?? 480);

        // The picker rows show the select's value only when asked; the switches decide which rows are available.
        refs.thumbnailFormatRow.sync();
        refs.thumbnailMobileFormatRow.sync();
        setThumbnailInputsDisabled(isThumbnailLocked(), refs);
    }

    function isThumbnailLocked() {
        const state = getServerAdminState();
        return state.busy || state.restarting || !state.thumbnailSettingsLoaded;
    }

    function setThumbnailRowDisabled(row, disabled) {
        row.setDisabled(disabled);
        if (row.control instanceof HTMLSelectElement) {
            row.control.disabled = disabled;
        }
    }

    /**
     * Every thumbnail control follows `locked`. The rows of a preset also wait for its switch, because
     * nothing is generated while it is off.
     */
    function setThumbnailInputsDisabled(locked, refs = getServerAdminRefs()) {
        if (!refs?.thumbnailRows) {
            return;
        }

        refs.thumbnailEnabledRow.setDisabled(locked);
        refs.thumbnailMobileEnabledRow.setDisabled(locked);

        const desktopOff = locked || !refs.thumbnailEnabled.checked;
        const mobileOff = locked || !refs.thumbnailMobileEnabled.checked;
        refs.thumbnailRows.desktop.forEach(row => setThumbnailRowDisabled(row, desktopOff));
        refs.thumbnailRows.mobile.forEach(row => setThumbnailRowDisabled(row, mobileOff));

        for (const button of [
            refs.thumbnailUseRecommendedButton,
            refs.thumbnailUseRecommendedMobileButton,
            refs.thumbnailSaveButton,
            refs.thumbnailSaveClearButton,
            refs.thumbnailClearButton,
        ]) {
            button.disabled = locked;
        }
    }

    function createServerToolsHeading(title, description) {
        const header = createElement('div', { className: 'sb-settings-flat-header sb-settings-category-header' });
        const heading = createElement('div', { className: 'flex-container flexFlowColumn sb-settings-category-heading' });
        heading.append(
            createElement('h3', { className: 'ds-pref-group-heading sb-settings-category-title', text: title }),
            createElement('small', { text: description }),
        );
        header.append(heading);
        return header;
    }

    function createServerToolsGroup(title, description, className) {
        const section = createElement('section', { className: 'sb-settings-flat-section sb-settings-category', attrs: { 'data-sb-presentation': 'manual' } });
        const header = createServerToolsHeading(title, description);
        const body = createElement('div', { className: `ds-pref-group sb-settings-category-body ${className}` });
        section.append(header, body);
        return { section, header, body };
    }

    /** A group of the Data & Security page, built from the shared boxed-list factories. */
    function createServerSection(title, description, field, headerSuffix) {
        return createDataSecurityGroup({ title, description, field, headerSuffix });
    }

    /** A note under the rows of a group. The element takes the text, tone and `hidden` of `setServerAdminMessage`. */
    function createServerStatusRow(text = '') {
        return createElement('div', { className: 'ds-row sb-server-note', text });
    }

    function createServerButtonRow(label, field, onActivate) {
        return createButtonRow({ label, field, onActivate }).row;
    }

    /** The status rows exist while a status is shown; each render replaces them and keeps the notes after them. */
    function clearServerAdminStats() {
        const refs = getServerAdminRefs();
        refs?.statusRows.splice(0).forEach(row => row.destroy());
    }

    function appendServerAdminStat(label, value, { monospace = false } = {}) {
        const refs = getServerAdminRefs();
        if (!refs) {
            return;
        }

        const stat = createPropertyRow({ label, value: value || '—', field: `status-${label.toLowerCase()}` });
        stat.row.querySelector('.ds-row-property__value').classList.add('sb-server-stat-value');
        if (monospace) {
            stat.row.querySelector('.ds-row-property__value').classList.add('is-monospace');
        }
        refs.statusGrid.insertBefore(stat.row, refs.statusNote);
        refs.statusRows.push(stat);
    }

    function updateServerConfigDirtyState() {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();

        if (!refs?.configEditor || !refs.configState) {
            return false;
        }

        const isDirty = refs.configEditor.value !== state.originalConfig;
        refs.configState.textContent = isDirty ? 'Unsaved changes' : 'Saved';
        refs.configState.dataset.state = isDirty ? 'dirty' : 'saved';
        return isDirty;
    }

    function updateServerAdminInteractivity() {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();

        if (!refs) {
            return;
        }

        const locked = state.busy || state.restarting;
        const thumbnailLocked = locked || !state.thumbnailSettingsLoaded;
        const canUpdate = refs.updateButton?.dataset.sbCanUpdate === 'true';
        const hasConfigContent = Boolean(refs.configEditor?.value.trim());

        setButtonDisabled(refs.refreshButton, locked);
        setButtonDisabled(refs.reloadConfigButton, locked);
        setButtonDisabled(refs.updateButton, locked || !canUpdate);
        setButtonDisabled(refs.restartButton, locked);
        setButtonDisabled(refs.saveConfigButton, locked || !hasConfigContent);
        setButtonDisabled(refs.saveConfigRestartButton, locked || !hasConfigContent);
        const repository = state.lastStatusData?.repository;
        refs.autoStashRow.setDisabled(locked || !state.configLoaded
            || state.lastStatusData?.installType === 'docker' || !repository?.supported || !repository?.isRepo);
        setThumbnailInputsDisabled(thumbnailLocked);

        if (refs.configEditor instanceof HTMLTextAreaElement) {
            refs.configEditor.disabled = locked;
        }
    }

    function renderServerAdminStatus(data) {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();

        if (!refs) {
            return;
        }

        const repository = data?.repository ?? {};
        const version = data?.version ?? {};
        const installType = data?.installType || (repository?.isRepo ? 'git' : 'unsupported');
        const isDockerInstall = installType === 'docker';
        const isGitInstall = !isDockerInstall && Boolean(repository?.supported && repository?.isRepo);
        clearServerAdminStats();

        appendServerAdminStat('Runtime', data?.runtime || 'Unknown');
        appendServerAdminStat('Version', version?.pkgVersion ? `v${version.pkgVersion}` : 'Unknown');

        // Branch selector instead of static text
        const branchSelect = createElement('select', {
            id: 'sb-branch-select',
            className: 'text_pole ds-control-flex',
        });
        branchSelect.disabled = !isGitInstall;
        const currentBranch = isGitInstall
            ? (repository?.displayBranch || repository?.branch || version?.gitBranch || '')
            : isDockerInstall ? 'Docker' : 'Unsupported';
        const currentOptionAttributes = { value: currentBranch, selected: 'selected' };
        if (!currentBranch || !isGitInstall) {
            currentOptionAttributes.disabled = 'disabled';
        }
        const currentOption = createElement('option', { attrs: currentOptionAttributes });
        currentOption.textContent = currentBranch || 'Unknown';
        branchSelect.appendChild(currentOption);
        const branchRow = createSelectRow({ select: branchSelect, label: isGitInstall ? 'Branch' : 'Install', field: 'status-branch' });
        refs.statusGrid.insertBefore(branchRow.row, refs.statusNote);
        refs.statusRows.push(branchRow);

        // Load available branches
        if (isGitInstall) {
            loadServerAdminBranches(branchSelect, currentBranch, branchRow);
        }

        if (isGitInstall) {
            appendServerAdminStat('Commit', repository?.currentCommit || version?.gitRevision || 'Unknown', { monospace: true });
            appendServerAdminStat('Tracking', repository?.trackingBranch || 'Not set');
            appendServerAdminStat('Ahead', String(repository?.ahead ?? 0));
            appendServerAdminStat('Behind', String(repository?.behind ?? 0));
        }
        appendServerAdminStat('Config', data?.configPath || 'Unknown', { monospace: true });

        state.lastStatusData = {
            runtime: data?.runtime || '',
            configPath: data?.configPath || '',
            installType,
            version,
            repository,
        };

        let pillLabel = 'Unavailable';
        let pillTone = 'neutral';

        if (isGitInstall) {
            if (repository?.hasLocalChanges && !repository?.autoStash) {
                pillLabel = 'Update Blocked';
                pillTone = 'danger';
            } else if (repository?.hasLocalChanges && repository?.autoStash) {
                pillLabel = (repository?.behind ?? 0) > 0 ? 'Update Ready (Auto-stash)' : 'Auto-stash Enabled';
                pillTone = 'warn';
            } else if ((repository?.behind ?? 0) > 0) {
                pillLabel = 'Update Ready';
                pillTone = 'warn';
            } else if ((repository?.ahead ?? 0) > 0) {
                pillLabel = 'Patched Local';
                pillTone = 'neutral';
            } else {
                pillLabel = 'Up To Date';
                pillTone = 'good';
            }
        } else if (isDockerInstall) {
            pillLabel = 'Docker';
            pillTone = 'neutral';
        } else {
            pillLabel = 'Unsupported Install';
            pillTone = 'warn';
        }

        setServerAdminPill(refs.statusPill, pillLabel, pillTone);
        const updateMode = isGitInstall && repository?.canUpdate ? 'git' : '';
        refs.updateButton.dataset.sbCanUpdate = String(Boolean(updateMode));
        refs.updateButton.dataset.sbUpdateMode = updateMode;
        refs.updateButton.hidden = !isGitInstall;
        getServerButtonLabel(refs.refreshButton).textContent = isGitInstall ? 'Check for updates' : 'Refresh status';

        // SillyBunny: Docker and non-Git copies have no in-app updater; the note explains how they update instead.
        const installNote = isDockerInstall
            ? 'Running in Docker. Update by pulling the new image and recreating the container.'
            : !isGitInstall
                ? 'This copy was not installed with Git, so it cannot update in the app.'
                : '';
        const noteParts = [String((isGitInstall ? repository?.message : installNote) ?? '').trim()].filter(Boolean);

        if ((repository?.changedFilesCount ?? 0) > 0) {
            const changedPreview = Array.isArray(repository?.changedFiles)
                ? repository.changedFiles.map(file => file?.path).filter(Boolean).join(', ')
                : '';
            noteParts.push(`Changed files: ${repository.changedFilesCount}${changedPreview ? ` (${changedPreview})` : ''}`);
        }

        setServerAdminMessage(refs.statusNote, noteParts.join('\n'), pillTone);

        if (refs.installLink instanceof HTMLElement) {
            refs.installLink.hidden = isGitInstall || isDockerInstall;
        }

        if (refs.autoStashCheckbox) {
            // The saved setting can differ from the running server until its next restart.
            refs.autoStashCheckbox.checked = state.configLoaded ? state.autoStashEnabled : Boolean(repository?.autoStash);
        }
        updateServerAdminInteractivity();
    }

    function renderServerAdminConfig(data, { overwrite = true } = {}) {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();

        if (!refs) {
            return;
        }

        refs.configPath.textContent = data?.path || 'config.yaml';
        syncSavedAutoStash(String(data?.content ?? ''));
        state.configLoaded = true;

        if (overwrite && refs.configEditor instanceof HTMLTextAreaElement) {
            refs.configEditor.value = String(data?.content ?? '');
            state.originalConfig = refs.configEditor.value;
            state.lastModifiedMs = Number(data?.lastModifiedMs ?? 0) || 0;
            updateServerConfigDirtyState();
        }
    }

    function parseServerConfig(content) {
        const configDocument = yaml.parseDocument(content, { prettyErrors: true });
        if (configDocument.errors.length) {
            throw new Error(configDocument.errors.map(error => error.message).join('\n\n'));
        }
        return configDocument;
    }

    /**
     * Capture the top-level setting separately from its spacing and trailing comment.
     */
    const AUTO_STASH_LINE_PATTERN = /^(autoStashBeforePull:)([ \t]*)([^#\s][^#\r\n]*?)?([ \t]*)(#.*)?$/m;

    /**
     * Replace only the setting value so YAML formatting and unrelated content survive.
     * @param {string} content YAML text
     * @param {boolean} enabled Setting value
     * @returns {string} YAML text with only the autoStashBeforePull line changed or appended
     */
    function setAutoStashLine(content, enabled) {
        const value = enabled ? 'true' : 'false';
        if (!AUTO_STASH_LINE_PATTERN.test(content)) {
            // A CRLF file keeps one line ending style, so the appended line takes the file's own terminator.
            const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
            const separator = content === '' || content.endsWith('\n') ? '' : lineEnding;
            return `${content}${separator}autoStashBeforePull: ${value}${lineEnding}`;
        }
        return content.replace(AUTO_STASH_LINE_PATTERN, (_line, key, gap, oldValue, spacing, comment = '') => {
            // A line without a value holds its whitespace in the gap, so the comment gets its own separator.
            const commentGap = comment && oldValue === undefined ? ' ' : spacing;
            return `${key}${gap || ' '}${value}${commentGap}${comment}`;
        });
    }

    function syncSavedAutoStash(content) {
        const value = parseServerConfig(content).get('autoStashBeforePull');
        // Match the server's boolean conversion, including quoted YAML values.
        const enabled = typeof value === 'string' && value.trim().toLowerCase() === 'false' ? false : Boolean(value);
        getServerAdminState().autoStashEnabled = enabled;
        getServerAdminRefs().autoStashCheckbox.checked = enabled;
    }

    async function handleAutoStashChange() {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();
        if (!refs || state.busy || state.restarting || !state.configLoaded) return;

        const enabled = refs.autoStashCheckbox.checked;
        const draft = refs.configEditor.value;
        const isDirty = draft !== state.originalConfig;
        state.busy = true;
        updateServerAdminInteractivity();
        try {
            const data = await requestServerAdmin('/api/server-admin/config/get');
            // Only the autoStashBeforePull line of the file on disk changes; the rest is written back
            // byte for byte. Unrelated editor changes stay an unsaved draft with the same one-line edit.
            const content = setAutoStashLine(String(data?.content ?? ''), enabled);
            const configDocument = parseServerConfig(content);
            if (configDocument.get('autoStashBeforePull') !== enabled) {
                throw new Error('The autoStashBeforePull line in config.yaml could not be updated in place. Edit it in the config editor instead.');
            }
            const draftContent = isDirty ? setAutoStashLine(draft, enabled) : content;
            const result = await requestServerAdmin('/api/server-admin/config/save', {
                content,
                expectedLastModifiedMs: isDirty ? state.lastModifiedMs : Number(data?.lastModifiedMs ?? 0),
                restart: false,
            });
            refs.configEditor.value = draftContent;
            // A textarea folds CRLF to LF. The saved text is kept in that form so the dirty check compares like with like.
            state.originalConfig = isDirty ? content.replace(/\r\n?/g, '\n') : refs.configEditor.value;
            state.lastModifiedMs = Number(result?.lastModifiedMs ?? 0) || state.lastModifiedMs;
            syncSavedAutoStash(content);
            updateServerConfigDirtyState();
            setServerAdminMessage(refs.statusNote, result?.message || 'Config saved.', 'good');
            setServerAdminMessage(refs.configNote, result?.message || 'Config saved.', 'good');
        } catch (error) {
            refs.autoStashCheckbox.checked = state.autoStashEnabled;
            setServerAdminMessage(refs.statusNote, error.message || 'Failed to save config.yaml.', 'danger');
        } finally {
            state.busy = false;
            updateServerAdminInteractivity();
        }
    }

    function renderServerThumbnailSettings(data) {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();

        if (!refs) {
            return;
        }

        setThumbnailInputValues({ settings: data?.settings ?? {}, mobileSettings: data?.mobileSettings ?? {} });
        state.thumbnailLastModifiedMs = Number(data?.lastModifiedMs ?? 0) || state.thumbnailLastModifiedMs;
        state.thumbnailRecommended = data?.recommended ?? state.thumbnailRecommended;
        state.thumbnailRecommendedMobile = data?.recommendedMobile ?? state.thumbnailRecommendedMobile;
        state.thumbnailSettingsLoaded = true;
        setServerAdminMessage(refs.thumbnailNote, 'Thumbnail settings loaded. Saving applies to new thumbnails immediately.', 'neutral');
    }

    async function waitForServerReturn(expectedRevision = '', { clearCacheBeforeReload = false, previousServerBootId = '' } = {}) {
        let sawOffline = false;

        async function reloadAfterOptionalCacheClear() {
            if (clearCacheBeforeReload && typeof window.SillyBunnyClearFrontendCache === 'function') {
                await window.SillyBunnyClearFrontendCache({ skipConfirmation: true, saveBeforeClear: false });
            }
            location.reload();
        }
        const timeoutAt = Date.now() + 180000;

        while (Date.now() < timeoutAt) {
            try {
                const response = await fetch('/version', { cache: 'no-store' });

                if (!response.ok) {
                    throw new Error('Server is not ready yet.');
                }

                const version = await response.json().catch(() => ({}));
                if (hasServerReturnedAfterRestart(version, { expectedRevision, previousServerBootId, sawOffline })) {
                    await reloadAfterOptionalCacheClear();
                    return true;
                }
            } catch {
                sawOffline = true;
            }

            await wait(1500);
        }

        return false;
    }

    async function refreshServerAdminPanel({ includeConfig = false, forceConfig = false } = {}) {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();
        const shouldLoadConfig = includeConfig || forceConfig || !state.configLoaded;
        const shouldLoadThumbnails = forceConfig || !state.thumbnailSettingsLoaded;

        if (!refs || state.busy || state.restarting) {
            return;
        }

        state.busy = true;
        updateServerAdminInteractivity();
        setServerAdminMessage(refs.statusNote, 'Loading server status…');
        if (shouldLoadConfig) {
            refs.configState.textContent = state.configLoaded ? 'Refreshing…' : 'Loading…';
            refs.configState.dataset.state = 'loading';
        }

        const statusPromise = requestServerAdmin('/api/server-admin/status');
        const configPromise = shouldLoadConfig ? requestServerAdmin('/api/server-admin/config/get') : null;
        const thumbnailPromise = shouldLoadThumbnails
            ? requestServerAdmin('/api/server-admin/config/thumbnail-settings/get')
            : null;

        if (configPromise) {
            try {
                const configData = await configPromise;
                const configIsDirty = refs.configEditor.value !== state.originalConfig;

                if (forceConfig || !configIsDirty) {
                    renderServerAdminConfig(configData, { overwrite: true });
                } else {
                    renderServerAdminConfig(configData, { overwrite: false });
                    state.lastModifiedMs = Number(configData?.lastModifiedMs ?? 0) || state.lastModifiedMs;
                    refs.configPath.textContent = configData?.path || refs.configPath.textContent;
                    setServerAdminMessage(refs.configNote, 'The file was refreshed on disk, but your unsaved draft was kept locally.', 'warn');
                }
            } catch (error) {
                state.configLoaded = false;
                const tone = error?.status === 403 ? 'warn' : 'danger';
                refs.configState.textContent = error?.status === 403 ? 'Admin Only' : 'Unavailable';
                refs.configState.dataset.state = tone;
                setServerAdminMessage(refs.configNote, error.message || 'Failed to load config.yaml.', tone);
                if (error?.status !== 403) {
                    console.error('Failed to load config.yaml.', error);
                }
            }
        }

        if (thumbnailPromise) {
            try {
                renderServerThumbnailSettings(await thumbnailPromise);
            } catch (error) {
                state.thumbnailSettingsLoaded = false;
                const tone = error?.status === 403 ? 'warn' : 'danger';
                setServerAdminMessage(refs.thumbnailNote, error.message || 'Failed to load thumbnail settings.', tone);
                if (error?.status !== 403) {
                    console.error('Failed to load thumbnail settings.', error);
                }
            }
        }

        try {
            const statusData = await statusPromise;
            renderServerAdminStatus(statusData);
        } catch (error) {
            const tone = error?.status === 403 ? 'warn' : 'danger';
            if (error?.status !== 403) {
                console.error('Failed to refresh server admin panel.', error);
            }
            clearServerAdminStats();
            setServerAdminPill(getServerAdminRefs()?.statusPill, error?.status === 403 ? 'Admin Only' : 'Unavailable', tone);
            setServerAdminMessage(getServerAdminRefs()?.statusNote, error.message || 'Failed to load server tools.', tone);
        } finally {
            state.busy = false;
            updateServerAdminInteractivity();
        }
    }

    async function handleServerAdminReloadConfig() {
        const refs = getServerAdminRefs();

        if (!refs) {
            return;
        }

        if (updateServerConfigDirtyState()) {
            const response = await openAlert({
                heading: 'Discard your unsaved config edits and reload config.yaml from disk?',
                responses: [
                    { id: 'cancel', label: t`Cancel` },
                    { id: 'discard', label: t`Discard`, appearance: 'destructive' },
                ],
            });
            if (response !== 'discard') return;
        }

        await refreshServerAdminPanel({ includeConfig: true, forceConfig: true });
    }

    async function handleServerAdminSaveConfig({ restart = false } = {}) {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();

        if (!refs || state.busy || state.restarting) {
            return;
        }

        state.busy = true;
        updateServerAdminInteractivity();
        setServerAdminMessage(refs.configNote, restart ? 'Saving config and preparing restart…' : 'Saving config…');

        try {
            const normalizedContent = refs.configEditor.value.endsWith('\n')
                ? refs.configEditor.value
                : `${refs.configEditor.value}\n`;
            const result = await requestServerAdmin('/api/server-admin/config/save', {
                content: normalizedContent,
                expectedLastModifiedMs: state.lastModifiedMs,
                restart,
            });

            refs.configEditor.value = normalizedContent;
            state.originalConfig = normalizedContent;
            state.lastModifiedMs = Number(result?.lastModifiedMs ?? 0) || state.lastModifiedMs;
            syncSavedAutoStash(normalizedContent);
            updateServerConfigDirtyState();
            setServerAdminMessage(refs.configNote, result?.message || 'Config saved.', restart ? 'warn' : 'good');
            toastr.success(result?.message || 'Config saved.', 'Server config');

            if (restart) {
                state.busy = false;
                state.restarting = true;
                updateServerAdminInteractivity();
                const restarted = await waitForServerReturn();

                if (!restarted) {
                    state.restarting = false;
                    setServerAdminMessage(refs.configNote, 'Restart is taking longer than expected. Refresh the page once the server is back.', 'warn');
                    toastr.warning('Restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
                }
            }
        } catch (error) {
            console.error('Failed to save config.yaml.', error);
            setServerAdminMessage(refs.configNote, error.message || 'Failed to save config.yaml.', 'danger');
            toastr.error(error.message || 'Failed to save config.yaml.', 'Server config');
        } finally {
            if (!state.restarting) {
                state.busy = false;
                updateServerAdminInteractivity();
            }
        }
    }

    async function handleServerThumbnailSave({ clearCache = false } = {}) {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();

        if (!refs || state.busy || state.restarting) {
            return;
        }

        if (updateServerConfigDirtyState()) {
            setServerAdminMessage(refs.thumbnailNote, 'Save or reload the config.yaml editor before changing thumbnail settings.', 'warn');
            toastr.warning('Save or reload the config.yaml editor before changing thumbnail settings.', 'Thumbnails');
            return;
        }

        state.busy = true;
        updateServerAdminInteractivity();
        setServerAdminMessage(refs.thumbnailNote, clearCache ? 'Saving settings and clearing thumbnail cache…' : 'Saving thumbnail settings…');

        try {
            const { settings, mobileSettings } = getThumbnailSettingsFromRefs(refs);
            const result = await requestServerAdmin('/api/server-admin/config/thumbnail-settings/save', {
                settings,
                mobileSettings,
                expectedLastModifiedMs: state.thumbnailLastModifiedMs || state.lastModifiedMs,
                clearCache,
            });

            renderServerThumbnailSettings(result);
            state.lastModifiedMs = Number(result?.lastModifiedMs ?? 0) || state.lastModifiedMs;
            setServerAdminMessage(refs.thumbnailNote, result?.message || 'Thumbnail settings saved.', 'good');
            toastr.success(result?.message || 'Thumbnail settings saved.', 'Thumbnails');
            renderServerAdminConfig(await requestServerAdmin('/api/server-admin/config/get'), { overwrite: true });
        } catch (error) {
            console.error('Failed to save thumbnail settings.', error);
            setServerAdminMessage(refs.thumbnailNote, error.message || 'Failed to save thumbnail settings.', 'danger');
            toastr.error(error.message || 'Failed to save thumbnail settings.', 'Thumbnails');
        } finally {
            state.busy = false;
            updateServerAdminInteractivity();
        }
    }

    async function handleServerThumbnailClearCache() {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();

        if (!refs || state.busy || state.restarting) {
            return;
        }

        const response = await openAlert({
            heading: 'Clear cached thumbnails for this user?',
            body: 'They will be rebuilt as images are loaded.',
            responses: [
                { id: 'cancel', label: t`Cancel` },
                { id: 'clear', label: t`Yes`, appearance: 'suggested' },
            ],
            defaultResponse: 'clear',
        });
        if (response !== 'clear') {
            return;
        }

        state.busy = true;
        updateServerAdminInteractivity();
        setServerAdminMessage(refs.thumbnailNote, 'Clearing thumbnail cache…');

        try {
            const result = await requestServerAdmin('/api/server-admin/thumbnails/clear-cache');
            setServerAdminMessage(refs.thumbnailNote, result?.message || 'Thumbnail cache cleared.', 'good');
            toastr.success(result?.message || 'Thumbnail cache cleared.', 'Thumbnails');
        } catch (error) {
            console.error('Failed to clear thumbnail cache.', error);
            setServerAdminMessage(refs.thumbnailNote, error.message || 'Failed to clear thumbnail cache.', 'danger');
            toastr.error(error.message || 'Failed to clear thumbnail cache.', 'Thumbnails');
        } finally {
            state.busy = false;
            updateServerAdminInteractivity();
        }
    }

    function handleUseRecommendedThumbnailSettings() {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();
        const recommended = state.thumbnailRecommended ?? {
            enabled: true,
            format: 'png',
            quality: 100,
            dimensions: {
                bg: [240, 135],
                avatar: [864, 1280],
                persona: [864, 1280],
            },
        };

        setThumbnailInputValues({ settings: recommended, mobileSettings: getThumbnailSettingsFromRefs(refs).mobileSettings }, refs);
        setServerAdminMessage(refs.thumbnailNote, 'Recommended desktop thumbnail settings are staged. Save them when ready.', 'warn');
    }

    function handleUseRecommendedMobileThumbnailSettings() {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();
        const recommendedMobile = state.thumbnailRecommendedMobile ?? {
            enabled: true,
            format: 'jpg',
            quality: 82,
            dimensions: {
                bg: [240, 135],
                avatar: [320, 480],
                persona: [320, 480],
            },
        };

        setThumbnailInputValues({ settings: getThumbnailSettingsFromRefs(refs).settings, mobileSettings: recommendedMobile }, refs);
        setServerAdminMessage(refs.thumbnailNote, 'Recommended mobile thumbnail settings are staged. Save them when ready.', 'warn');
    }

    /** Width and height are one setting of two fields, so they share a row instead of taking a spin row each. */
    function createThumbnailSizeRow(label, key) {
        const widthInput = createElement('input', {
            className: 'text_pole',
            attrs: {
                type: 'number',
                inputmode: 'numeric',
                min: '1',
                max: '4096',
                step: '1',
                'aria-label': `${label} thumbnail width`,
            },
        });
        const separator = createElement('span', { className: 'sb-thumbnail-size-separator', text: 'x' });
        separator.setAttribute('aria-hidden', 'true');
        const heightInput = createElement('input', {
            className: 'text_pole',
            attrs: {
                type: 'number',
                inputmode: 'numeric',
                min: '1',
                max: '4096',
                step: '1',
                'aria-label': `${label} thumbnail height`,
            },
        });

        const row = createRow({ label, field: `thumbnail-size-${key}`, suffix: [widthInput, separator, heightInput] });
        row.row.classList.add('sb-thumbnail-size-row');
        row.row.dataset.thumbnailSize = key;
        return {
            ...row,
            widthInput,
            heightInput,
            setDisabled(disabled) {
                row.setDisabled(disabled);
                widthInput.disabled = Boolean(disabled);
                heightInput.disabled = Boolean(disabled);
            },
        };
    }

    function createThumbnailQualityRow(label, field) {
        const input = createElement('input', {
            className: 'text_pole',
            attrs: {
                type: 'number',
                inputmode: 'numeric',
                min: '1',
                max: '100',
                step: '1',
            },
        });
        return { input, row: createSpinRow({ label, field, input, normalize: false }) };
    }

    function createThumbnailFormatRow(label, field) {
        const select = createElement('select', { className: 'text_pole ds-control-flex' });
        select.append(
            createElement('option', { text: 'JPG', attrs: { value: 'jpg' } }),
            createElement('option', { text: 'PNG', attrs: { value: 'png' } }),
        );
        return { select, row: createSelectRow({ select, label, field }) };
    }

    async function handleServerAdminRestart() {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();

        if (!refs || state.busy || state.restarting) {
            return;
        }

        state.busy = true;
        updateServerAdminInteractivity();
        setServerAdminMessage(refs.updateNote, 'Restarting SillyBunny…');

        try {
            const result = await requestServerAdmin('/api/server-admin/restart');
            state.busy = false;
            state.restarting = true;
            updateServerAdminInteractivity();
            setServerAdminMessage(refs.updateNote, result?.message || 'Restarting SillyBunny…', 'warn');
            toastr.info(result?.message || 'Restarting SillyBunny…', 'Server');

            const restarted = await waitForServerReturn('', { previousServerBootId: result?.serverBootId });
            if (!restarted) {
                state.restarting = false;
                setServerAdminMessage(refs.updateNote, 'Restart is taking longer than expected. Refresh the page once the server is back.', 'warn');
                toastr.warning('Restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
            }
        } catch (error) {
            console.error('Failed to restart SillyBunny.', error);
            state.busy = false;
            updateServerAdminInteractivity();
            setServerAdminMessage(refs.updateNote, error.message || 'Failed to restart SillyBunny.', 'danger');
            toastr.error(error.message || 'Failed to restart SillyBunny.', 'Server');
        }
    }

    async function handleServerAdminUpdate() {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();

        if (!refs || state.busy || state.restarting) {
            return;
        }

        if (refs.updateButton?.dataset.sbUpdateMode !== 'git') {
            return;
        }

        state.busy = true;
        updateServerAdminInteractivity();
        setServerAdminButtonLabel(refs.updateButton, true, 'Updating…');
        setServerAdminMessage(refs.updateNote, 'Checking Git status and applying the latest update…');
        refs.updateOutput.hidden = true;
        refs.updateOutput.textContent = '';

        try {
            const result = await requestServerAdmin('/api/server-admin/update');
            const nextStatus = {
                ...(state.lastStatusData ?? {}),
                configPath: refs.configPath?.textContent || state.lastStatusData?.configPath || '',
                version: result?.version ?? state.lastStatusData?.version ?? {},
                repository: result?.repository ?? state.lastStatusData?.repository ?? {},
            };

            if (!result?.updated) {
                renderServerAdminStatus(nextStatus);
                const stashMessage = describeAutoStashState(result);
                setServerAdminMessage(refs.updateNote, [result?.message || 'Already up to date.', stashMessage].filter(Boolean).join('\n'), stashMessage ? 'warn' : 'good');
                if (stashMessage) {
                    toastr.info(stashMessage, 'Auto-stash');
                }
                toastr.success(result?.message || 'Already up to date.', 'Server update');
                return;
            }

            renderServerAdminStatus(nextStatus);

            const stashMessage = describeAutoStashState(result);
            if (result?.stashPopWarning) {
                toastr.warning(stashMessage, 'Auto-stash warning', { timeOut: 10000 });
            } else if (stashMessage) {
                toastr.info(stashMessage, 'Auto-stash');
            }

            if (result?.install?.stdout || result?.install?.stderr) {
                refs.updateOutput.hidden = false;
                refs.updateOutput.textContent = [result.install.command, result.install.stdout, result.install.stderr]
                    .filter(Boolean)
                    .join('\n\n');
            }

            state.busy = false;
            state.restarting = true;
            updateServerAdminInteractivity();
            setServerAdminMessage(refs.updateNote, result?.message || 'Update applied. Restarting SillyBunny…', 'warn');
            toastr.info(result?.message || 'Update applied. Restarting SillyBunny…', 'Server update');

            const expectedRevision = String(result?.version?.gitRevision ?? result?.repository?.currentCommit ?? '').trim();
            const autoClearCacheEnabled = Boolean(document.getElementById('auto_clear_cache_on_update')?.checked);
            const restarted = await waitForServerReturn(expectedRevision, { clearCacheBeforeReload: autoClearCacheEnabled });

            if (!restarted) {
                state.restarting = false;
                setServerAdminMessage(refs.updateNote, 'Update completed, but restart is taking longer than expected. Refresh manually once the server is back.', 'warn');
                toastr.warning('Update finished, but restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
            }
        } catch (error) {
            console.error('Failed to update SillyBunny.', error);
            state.busy = false;
            const stashMessage = describeAutoStashState(error?.data);
            if (stashMessage) {
                toastr.warning(stashMessage, 'Auto-stash warning', { timeOut: 10000 });
            }
            setServerAdminMessage(refs.updateNote, [error.message || 'Failed to update SillyBunny.', stashMessage].filter(Boolean).join('\n'), 'danger');
            toastr.error(error.message || 'Failed to update SillyBunny.', 'Server update');
        } finally {
            setServerAdminButtonLabel(refs.updateButton, false, 'Updating…');

            if (!state.restarting) {
                state.busy = false;
                updateServerAdminInteractivity();
            }
        }
    }

    async function loadServerAdminBranches(selectElement, currentBranch, branchRow) {
        try {
            const result = await requestServerAdmin('/api/server-admin/branches');
            const branches = result?.branches || [];

            selectElement.replaceChildren();

            for (const branch of branches) {
                const option = createElement('option', { attrs: { value: branch } });
                option.textContent = branch;
                if (branch === currentBranch) {
                    option.selected = true;
                }
                selectElement.appendChild(option);
            }

            // Add change handler
            selectElement.addEventListener('change', () => handleServerAdminBranchSwitch(selectElement, branchRow.sync));
        } catch (error) {
            console.error('Failed to load branches.', error);
            // Keep the current branch option if loading fails
        }
    }

    /** `syncRow` shows the select's value again in its picker row after the code resets it without an event. */
    async function handleServerAdminBranchSwitch(selectElement, syncRow = () => {}) {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();

        if (!refs || state.busy || state.restarting) {
            return;
        }

        const targetBranch = selectElement.value;
        const currentBranch = state.lastStatusData?.repository?.displayBranch || state.lastStatusData?.repository?.branch || '';

        if (targetBranch === currentBranch) {
            return;
        }

        // Show confirmation dialog
        const hasLocalChanges = state.lastStatusData?.repository?.hasLocalChanges || false;
        const changedFiles = state.lastStatusData?.repository?.changedFiles || [];
        const changedFilesText = changedFiles.length > 0
            ? `\n\nChanged files: ${changedFiles.map(f => f.path).join(', ')}`
            : '';

        const confirmHeading = hasLocalChanges
            ? 'You have local changes.'
            : `Switch to branch "${targetBranch}"?`;
        const confirmBody = hasLocalChanges
            ? `${changedFilesText}\n\nDo you want to auto-stash your changes and switch to "${targetBranch}"?\n\nThe server will restart after switching.`
            : 'The server will restart after switching.';
        const response = await openAlert({
            heading: confirmHeading,
            body: confirmBody,
            responses: [
                { id: 'cancel', label: t`Cancel` },
                { id: 'switch', label: t`Switch`, appearance: hasLocalChanges ? 'destructive' : 'suggested' },
            ],
            defaultResponse: hasLocalChanges ? null : 'switch',
        });

        if (response !== 'switch') {
            // Reset select to current branch
            selectElement.value = currentBranch;
            syncRow();
            return;
        }

        state.busy = true;
        updateServerAdminInteractivity();
        setServerAdminMessage(refs.updateNote, `Switching to branch "${targetBranch}"…`);

        const abortController = new AbortController();
        const abortTimeout = setTimeout(() => abortController.abort(), 45000);

        try {
            const result = await requestServerAdmin('/api/server-admin/switch-branch', {
                branch: targetBranch,
                autoStash: hasLocalChanges,
            }, { signal: abortController.signal });

            clearTimeout(abortTimeout);
            state.busy = false;
            state.restarting = true;
            updateServerAdminInteractivity();

            const message = result?.message || `Switched to branch "${targetBranch}". Restarting…`;
            setServerAdminMessage(refs.updateNote, message, 'warn');
            toastr.info(message, 'Branch Switch');

            if (result?.stashed && !result?.stashRestored) {
                toastr.warning('Your changes were stashed but could not be automatically restored. Use "git stash pop" after restart.', 'Stash Warning', { timeOut: 10000 });
            }

            const restarted = await waitForServerReturn();
            if (!restarted) {
                state.restarting = false;
                setServerAdminMessage(refs.updateNote, 'Branch switched, but restart is taking longer than expected. Refresh manually once the server is back.', 'warn');
                toastr.warning('Branch switched, but restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
            }
        } catch (error) {
            clearTimeout(abortTimeout);
            console.error('Failed to switch branch.', error);
            state.busy = false;
            updateServerAdminInteractivity();

            // Reset select to current branch
            selectElement.value = currentBranch;
            syncRow();

            if (error.name === 'AbortError') {
                const timeoutMessage = 'Branch switch is taking longer than expected. The server may still be working; refresh in a moment to see the result.';
                setServerAdminMessage(refs.updateNote, timeoutMessage, 'warn');
                toastr.warning(timeoutMessage, 'Branch Switch', { timeOut: 10000 });
                return;
            }

            const errorMessage = error.message || 'Failed to switch branch.';
            setServerAdminMessage(refs.updateNote, errorMessage, 'danger');
            toastr.error(errorMessage, 'Branch Switch');
        }
    }

    function buildServerAdminPanel() {
        const { panel, scroller } = createShellPanel({
            id: 'server',
        });

        const column = createElement('div', { className: 'sb-shell-column sb-server-column' });

        const statusPill = createElement('span', { className: 'sb-server-pill', text: 'Checking…' });
        const statusSection = createServerSection('App Status', 'Review the current runtime, branch, commit, and whether this workspace can update safely.', 'app-status', statusPill);
        const statusNote = createServerStatusRow();
        // SillyBunny: migration link for non-Git copies; the target is a placeholder until the bootstrap installer ships.
        const installLink = createServerStatusRow();
        installLink.dataset.tone = 'warn';
        installLink.appendChild(createElement('a', {
            text: 'Reinstall with the installer to get updates',
            attrs: { href: SB_INSTALLER_URL, target: '_blank', rel: 'noopener noreferrer' },
        }));
        installLink.hidden = true;
        statusSection.append(statusNote, installLink);

        const updateSection = createServerSection('Updates & Restart', 'Check upstream status, update the app, and relaunch automatically when it is safe to do so.', 'updates-restart');
        const autoStashCheckbox = createElement('input', { attrs: { type: 'checkbox', id: 'auto_stash_before_pull', 'aria-label': 'Auto-stash local changes before pulling' } });
        const autoStashRow = createSwitchRow({ label: 'Auto-stash local changes before pulling', field: 'auto-stash', input: autoStashCheckbox });
        const refreshButton = createServerButtonRow('Check for updates', 'check-for-updates', () => refreshServerAdminPanel({ includeConfig: false }));
        const updateButton = createServerButtonRow('Update & Restart', 'update-restart', handleServerAdminUpdate);
        const restartButton = createServerButtonRow('Restart server', 'restart-server', handleServerAdminRestart);
        const updateNote = createServerStatusRow('Git fast-forward updates restart automatically once they finish.');
        const updateOutput = createElement('pre', { className: 'sb-server-output' });
        updateOutput.hidden = true;
        updateSection.append(autoStashRow, refreshButton, updateButton, restartButton, updateNote, updateOutput);

        const thumbnailSection = createServerSection('Thumbnail Quality', 'Set thumbnail format, quality, and generated sizes without hand-editing config.yaml.', 'thumbnail-quality');
        const thumbnailEnabled = createElement('input', { attrs: { type: 'checkbox', 'aria-label': 'Generate thumbnails' } });
        const thumbnailEnabledRow = createSwitchRow({ label: 'Generate thumbnails', field: 'thumbnail-enabled', input: thumbnailEnabled });
        const { select: thumbnailFormat, row: thumbnailFormatRow } = createThumbnailFormatRow('Format', 'thumbnail-format');
        const { input: thumbnailQuality, row: thumbnailQualityRow } = createThumbnailQualityRow('Quality', 'thumbnail-quality');
        const bgSize = createThumbnailSizeRow('Background', 'bg');
        const avatarSize = createThumbnailSizeRow('Character', 'avatar');
        const personaSize = createThumbnailSizeRow('Persona', 'persona');
        thumbnailSection.append(thumbnailEnabledRow, thumbnailFormatRow, thumbnailQualityRow, bgSize, avatarSize, personaSize);

        const mobileSection = createServerSection('Mobile preset', 'Desktop thumbnails default to PNG at full resolution. Enable the mobile preset to serve smaller JPG thumbnails to phone-sized screens.', 'thumbnail-mobile');
        const thumbnailMobileEnabled = createElement('input', { attrs: { type: 'checkbox', 'aria-label': 'Generate mobile thumbnails' } });
        const thumbnailMobileEnabledRow = createSwitchRow({ label: 'Generate mobile thumbnails', field: 'thumbnail-mobile-enabled', input: thumbnailMobileEnabled });
        const { select: thumbnailMobileFormat, row: thumbnailMobileFormatRow } = createThumbnailFormatRow('Mobile format', 'thumbnail-mobile-format');
        const { input: thumbnailMobileQuality, row: thumbnailMobileQualityRow } = createThumbnailQualityRow('Mobile quality', 'thumbnail-mobile-quality');
        const mobileBgSize = createThumbnailSizeRow('Mobile background', 'mobile-bg');
        const mobileAvatarSize = createThumbnailSizeRow('Mobile character', 'mobile-avatar');
        const mobilePersonaSize = createThumbnailSizeRow('Mobile persona', 'mobile-persona');
        const thumbnailUseRecommendedButton = createServerButtonRow('Use desktop recommended', 'thumbnail-use-recommended', handleUseRecommendedThumbnailSettings);
        const thumbnailUseRecommendedMobileButton = createServerButtonRow('Use mobile recommended', 'thumbnail-use-recommended-mobile', handleUseRecommendedMobileThumbnailSettings);
        const thumbnailSaveButton = createServerButtonRow('Save thumbnails', 'thumbnail-save', () => handleServerThumbnailSave({ clearCache: false }));
        const thumbnailSaveClearButton = createServerButtonRow('Save & Clear Cache', 'thumbnail-save-clear', () => handleServerThumbnailSave({ clearCache: true }));
        const thumbnailClearButton = createServerButtonRow('Clear cache only', 'thumbnail-clear', handleServerThumbnailClearCache);
        const thumbnailNote = createServerStatusRow();
        thumbnailNote.hidden = true;
        mobileSection.append(
            thumbnailMobileEnabledRow, thumbnailMobileFormatRow, thumbnailMobileQualityRow,
            mobileBgSize, mobileAvatarSize, mobilePersonaSize,
            thumbnailUseRecommendedButton, thumbnailUseRecommendedMobileButton,
            thumbnailSaveButton, thumbnailSaveClearButton, thumbnailClearButton,
            thumbnailNote,
        );

        const configState = createElement('span', { className: 'sb-server-inline-state', text: 'Loading…' });
        const configPath = createElement('code', { text: 'config.yaml' });
        const configEditor = createElement('textarea', {
            className: 'text_pole sb-server-config-editor',
            attrs: {
                spellcheck: 'false',
                rows: '22',
                'aria-label': 'config.yaml editor',
            },
        });
        const configSection = createServerSection('config.yaml Editor', 'Edit the live config file directly here. Saves validate YAML before writing anything to disk.', 'config-editor');
        // The editor fills the width of the group, and a code file has no use for Expand.
        const configField = createTextAreaField({ label: 'config.yaml', field: 'config-file', input: configEditor, expand: false });
        configField.row.querySelector('.ds-row-textarea__label').replaceChildren(configPath);
        configField.labelRow.append(configState);
        const reloadConfigButton = createServerButtonRow('Reload file', 'config-reload', handleServerAdminReloadConfig);
        const saveConfigButton = createServerButtonRow('Save config', 'config-save', () => handleServerAdminSaveConfig({ restart: false }));
        const saveConfigRestartButton = createServerButtonRow('Save & Restart', 'config-save-restart', () => handleServerAdminSaveConfig({ restart: true }));
        const configNote = createServerStatusRow('Most config changes only take effect after a restart.');
        configSection.append(configField, reloadConfigButton, saveConfigButton, saveConfigRestartButton, configNote);

        column.append(statusSection.section, updateSection.section, thumbnailSection.section, mobileSection.section, configSection.section);
        scroller.appendChild(column);

        const state = getServerAdminState();
        state.refs = {
            statusPill,
            statusGrid: statusSection.group,
            statusRows: [],
            statusNote,
            installLink,
            refreshButton,
            updateButton,
            restartButton,
            updateNote,
            updateOutput,
            autoStashCheckbox,
            autoStashRow,
            thumbnailEnabled,
            thumbnailEnabledRow,
            thumbnailFormat,
            thumbnailFormatRow,
            thumbnailQuality,
            thumbnailBgWidth: bgSize.widthInput,
            thumbnailBgHeight: bgSize.heightInput,
            thumbnailAvatarWidth: avatarSize.widthInput,
            thumbnailAvatarHeight: avatarSize.heightInput,
            thumbnailPersonaWidth: personaSize.widthInput,
            thumbnailPersonaHeight: personaSize.heightInput,
            thumbnailUseRecommendedButton,
            thumbnailUseRecommendedMobileButton,
            thumbnailSaveButton,
            thumbnailSaveClearButton,
            thumbnailClearButton,
            thumbnailNote,
            thumbnailMobileEnabled,
            thumbnailMobileEnabledRow,
            thumbnailMobileFormat,
            thumbnailMobileFormatRow,
            thumbnailMobileQuality,
            thumbnailMobileBgWidth: mobileBgSize.widthInput,
            thumbnailMobileBgHeight: mobileBgSize.heightInput,
            thumbnailMobileAvatarWidth: mobileAvatarSize.widthInput,
            thumbnailMobileAvatarHeight: mobileAvatarSize.heightInput,
            thumbnailMobilePersonaWidth: mobilePersonaSize.widthInput,
            thumbnailMobilePersonaHeight: mobilePersonaSize.heightInput,
            thumbnailRows: {
                desktop: [thumbnailFormatRow, thumbnailQualityRow, bgSize, avatarSize, personaSize],
                mobile: [thumbnailMobileFormatRow, thumbnailMobileQualityRow, mobileBgSize, mobileAvatarSize, mobilePersonaSize],
            },
            configPath,
            configState,
            configEditor,
            reloadConfigButton,
            saveConfigButton,
            saveConfigRestartButton,
            configNote,
        };
        setServerAdminPill(statusPill, 'Idle', 'neutral');
        setServerAdminMessage(statusNote, 'Open this tab to load server status and update controls.', 'neutral');
        configState.textContent = 'Not loaded';
        configState.dataset.state = 'neutral';

        configEditor.addEventListener('input', () => {
            updateServerConfigDirtyState();
            updateServerAdminInteractivity();
        });
        autoStashCheckbox.addEventListener('change', handleAutoStashChange);
        thumbnailEnabled.addEventListener('change', () => setThumbnailInputsDisabled(isThumbnailLocked()));
        thumbnailMobileEnabled.addEventListener('change', () => setThumbnailInputsDisabled(isThumbnailLocked()));
        updateServerAdminInteractivity();

        return {
            id: 'server',
            panel,
            button: null,
            searchRoot: column,
            onActivate: () => {
                if (!isShellOpen('right')) {
                    return;
                }

                void refreshServerAdminPanel({ includeConfig: !getServerAdminState().configLoaded });
            },
        };
    }

    function buildConsoleLogsPanel() {
        const { panel, scroller } = createShellPanel({
            id: 'console-logs',
        });

        const column = createElement('div', { className: 'sb-shell-column sb-console-log-column' });
        const { section: card, body: cardBody } = createServerToolsGroup('Console Logs', 'Watch the recent terminal output from the running SillyBunny process here, without keeping a terminal window open on the side. This mirrors the current process output captured from stdout and stderr. Only logs from the current SillyBunny session are available here.', 'sb-console-log-card');
        const statusPill = createElement('span', { className: 'sb-server-pill', text: 'Loading…' });
        const statusNote = createElement('small', { className: 'ds-row-subtitle sb-console-log-note' });
        const { row: header } = createRow({ label: '', field: 'console-log-status' });
        header.querySelector('.ds-row-label')?.append(statusPill);
        header.querySelector('.ds-row-text')?.append(statusNote);
        const state = getConsoleLogsState();
        const refreshRow = createButtonRow({
            label: 'Refresh Now',
            field: 'console-log-refresh',
            onActivate: () => {
                void refreshConsoleLogs({ forceFull: state.latestId === 0 });
            },
        });
        const pauseRow = createButtonRow({ label: 'Pause Live', field: 'console-log-pause', onActivate: toggleConsoleLogsPolling });
        const pauseLabel = pauseRow.row.querySelector('.ds-row-label');

        const outputFrame = createElement('div', { className: 'sb-console-log-frame' });
        const output = createElement('pre', { className: 'sb-server-output sb-console-log-output', attrs: { tabindex: '0' } });
        const verboseLoggingActionButton = createElement('input', {
            className: 'sb-console-log-verbose-action',
            attrs: { type: 'checkbox', 'aria-label': 'Verbose Debug Logging' },
        });
        const { row: verboseLoggingRow } = createSwitchRow({
            label: 'Verbose Debug Logging',
            subtitle: 'Enable full debugging console output for advanced troubleshooting. Changes are saved to config.yaml and apply after a restart.',
            field: 'console-log-verbose',
            input: verboseLoggingActionButton,
        });
        const verboseLoggingStatus = createElement('small', { className: 'ds-row-subtitle sb-console-log-state', text: 'Loading…' });
        verboseLoggingRow.querySelector('.ds-row-text')?.append(verboseLoggingStatus);

        outputFrame.append(output);
        cardBody.append(header, outputFrame, refreshRow.row, pauseRow.row, verboseLoggingRow);
        column.append(card);
        scroller.appendChild(column);
        void loadListEditorStyles();

        state.refs = {
            statusPill,
            refreshRow,
            pauseLabel,
            statusNote,
            output,
            verboseLoggingStatus,
            verboseLoggingActionButton,
        };

        verboseLoggingActionButton.addEventListener('change', () => {
            void toggleConsoleLogsVerboseLogging();
        });
        verboseLoggingActionButton.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (!event.repeat && !verboseLoggingActionButton.disabled) verboseLoggingActionButton.click();
        });

        renderConsoleLogsOutput({ preserveScroll: false });
        updateConsoleLogsInteractivity();

        return {
            id: 'console-logs',
            panel,
            button: null,
            searchRoot: column,
            onActivate: () => {
                void refreshConsoleLogsConfig();
                void refreshConsoleLogs({ forceFull: getConsoleLogsState().latestId === 0 });
                scheduleConsoleLogsRefresh(0);
            },
            onDeactivate: () => {
                const state = getConsoleLogsState();
                window.clearTimeout(state.refreshTimer);
                state.refreshTimer = 0;
            },
        };
    }

    return { buildServerAdminPanel, buildConsoleLogsPanel };
}
