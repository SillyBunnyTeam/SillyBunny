const SB_CONSOLE_LOG_LIMIT = 260;
const SB_CONSOLE_LOG_REFRESH_MS = 2500;
const SB_CONSOLE_LOG_STICKY_THRESHOLD = 28;

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
        },
        consoleLogs: {
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

        refs.pauseButton.textContent = state.paused ? 'Resume Live' : 'Pause Live';
        setButtonDisabled(refs.refreshButton, state.busy);
        setButtonDisabled(refs.verboseLoggingActionButton, state.busy || state.configBusy || !state.configLoaded);
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

        if (refs?.verboseLoggingActionButton instanceof HTMLButtonElement) {
            refs.verboseLoggingActionButton.textContent = enabled
                ? 'Debug Logging: Enabled'
                : 'Debug Logging: Disabled';
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

    function setServerAdminButtonLabel(button, isBusy, busyLabel) {
        if (!(button instanceof HTMLButtonElement)) {
            return;
        }

        if (!button.dataset.idleLabel) {
            button.dataset.idleLabel = button.textContent || '';
        }

        button.textContent = isBusy ? busyLabel : button.dataset.idleLabel;
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
    }

    function setThumbnailInputsDisabled(disabled, refs = getServerAdminRefs()) {
        const controls = [
            refs?.thumbnailEnabled,
            refs?.thumbnailFormat,
            refs?.thumbnailQuality,
            refs?.thumbnailBgWidth,
            refs?.thumbnailBgHeight,
            refs?.thumbnailAvatarWidth,
            refs?.thumbnailAvatarHeight,
            refs?.thumbnailPersonaWidth,
            refs?.thumbnailPersonaHeight,
            refs?.thumbnailUseRecommendedButton,
            refs?.thumbnailUseRecommendedMobileButton,
            refs?.thumbnailSaveButton,
            refs?.thumbnailSaveClearButton,
            refs?.thumbnailClearButton,
            refs?.thumbnailMobileEnabled,
            refs?.thumbnailMobileFormat,
            refs?.thumbnailMobileQuality,
            refs?.thumbnailMobileBgWidth,
            refs?.thumbnailMobileBgHeight,
            refs?.thumbnailMobileAvatarWidth,
            refs?.thumbnailMobileAvatarHeight,
            refs?.thumbnailMobilePersonaWidth,
            refs?.thumbnailMobilePersonaHeight,
        ];

        for (const control of controls) {
            if (control instanceof HTMLElement) {
                control.disabled = disabled;
            }
        }
    }

    function appendServerAdminStat(target, label, value) {
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const item = createElement('div', { className: 'sb-server-stat' });
        const title = createElement('small', { className: 'sb-server-stat-label', text: label });
        const content = createElement('strong', { className: 'sb-server-stat-value', text: value || '—' });
        item.append(title, content);
        target.appendChild(item);
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
        const release = data?.release ?? null;
        const version = data?.version ?? {};
        const isGitInstall = Boolean(repository?.supported && repository?.isRepo);
        const statusGrid = refs.statusGrid;
        statusGrid.replaceChildren();

        appendServerAdminStat(statusGrid, 'Runtime', data?.runtime || 'Unknown');
        appendServerAdminStat(statusGrid, 'Version', version?.pkgVersion ? `v${version.pkgVersion}` : 'Unknown');

        // Branch selector instead of static text
        const branchContainer = createElement('div', { className: 'sb-server-stat' });
        const branchLabel = createElement('div', { className: 'sb-server-stat-label' });
        branchLabel.textContent = isGitInstall ? 'Branch' : 'Install';
        const branchValue = createElement('div', { className: 'sb-server-stat-value' });
        const branchSelect = createElement('select', {
            id: 'sb-branch-select',
            className: 'text_pole',
            attrs: { style: 'width: 100%; max-width: 200px;' },
        });
        branchSelect.disabled = !isGitInstall;
        const currentBranch = isGitInstall ? (repository?.displayBranch || repository?.branch || version?.gitBranch || '') : 'Release ZIP';
        const currentOptionAttributes = { value: currentBranch, selected: 'selected' };
        if (!currentBranch || !isGitInstall) {
            currentOptionAttributes.disabled = 'disabled';
        }
        const currentOption = createElement('option', { attrs: currentOptionAttributes });
        currentOption.textContent = currentBranch || 'Unknown';
        branchSelect.appendChild(currentOption);
        branchValue.appendChild(branchSelect);
        branchContainer.append(branchLabel, branchValue);
        statusGrid.appendChild(branchContainer);

        // Load available branches
        if (isGitInstall) {
            loadServerAdminBranches(branchSelect, currentBranch);
        }

        appendServerAdminStat(statusGrid, 'Commit', repository?.currentCommit || version?.gitRevision || 'Unknown');
        appendServerAdminStat(statusGrid, 'Tracking', repository?.trackingBranch || 'Not set');
        appendServerAdminStat(statusGrid, 'Ahead', String(repository?.ahead ?? 0));
        appendServerAdminStat(statusGrid, 'Behind', String(repository?.behind ?? 0));
        if (release) {
            appendServerAdminStat(statusGrid, 'Latest ZIP', release?.latestVersion ? `v${release.latestVersion}` : 'Unknown');
        }
        appendServerAdminStat(statusGrid, 'Config', data?.configPath || 'Unknown');

        state.lastStatusData = {
            runtime: data?.runtime || '',
            configPath: data?.configPath || '',
            version,
            repository,
            release,
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
        } else if (release?.canUpdate) {
            pillLabel = release?.latestVersion ? `Update Available (v${release.latestVersion})` : 'Update Available';
            pillTone = 'warn';
        } else if (release?.checked && release?.assetAvailable && release?.latestVersion === release?.currentVersion) {
            pillLabel = 'Up To Date';
            pillTone = 'good';
        } else if (release?.checked && release?.assetAvailable) {
            pillLabel = 'ZIP Install';
            pillTone = 'neutral';
        } else if (release?.checked && !release?.assetAvailable) {
            pillLabel = 'ZIP Unavailable';
            pillTone = 'warn';
        } else if (release?.supported && !release?.checked) {
            pillLabel = 'Check Failed';
            pillTone = 'warn';
        }

        setServerAdminPill(refs.statusPill, pillLabel, pillTone);
        const updateMode = repository?.canUpdate ? 'git' : release?.canUpdate ? 'zip' : '';
        refs.updateButton.dataset.sbCanUpdate = String(Boolean(updateMode));
        refs.updateButton.dataset.sbUpdateMode = updateMode;

        const noteParts = [String((isGitInstall ? repository?.message : release?.message || repository?.message) ?? '').trim()].filter(Boolean);

        if ((repository?.changedFilesCount ?? 0) > 0) {
            const changedPreview = Array.isArray(repository?.changedFiles)
                ? repository.changedFiles.map(file => file?.path).filter(Boolean).join(', ')
                : '';
            noteParts.push(`Changed files: ${repository.changedFilesCount}${changedPreview ? ` (${changedPreview})` : ''}`);
        }

        setServerAdminMessage(refs.statusNote, noteParts.join('\n'), pillTone);

        if (refs.autoStashCheckbox) {
            refs.autoStashCheckbox.checked = Boolean(repository?.autoStash);
            refs.autoStashCheckbox.disabled = !isGitInstall;
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
        state.configLoaded = true;

        if (overwrite && refs.configEditor instanceof HTMLTextAreaElement) {
            refs.configEditor.value = String(data?.content ?? '');
            state.originalConfig = refs.configEditor.value;
            state.lastModifiedMs = Number(data?.lastModifiedMs ?? 0) || 0;
            updateServerConfigDirtyState();
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

    async function waitForServerReturn(expectedRevision = '', { clearCacheBeforeReload = false, expectedVersion = '', previousServerBootId = '' } = {}) {
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
                if (hasServerReturnedAfterRestart(version, { expectedRevision, expectedVersion, previousServerBootId, sawOffline })) {
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
            getServerAdminRefs()?.statusGrid.replaceChildren();
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

        if (updateServerConfigDirtyState() && !window.confirm('Discard your unsaved config edits and reload config.yaml from disk?')) {
            return;
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

        if (!window.confirm('Clear cached thumbnails for this user? They will be rebuilt as images are loaded.')) {
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

    function createThumbnailSizeRow(label, key) {
        const row = createElement('div', { className: 'sb-thumbnail-size-row' });
        const rowLabel = createElement('span', { className: 'sb-thumbnail-size-label', text: label });
        const widthInput = createElement('input', {
            className: 'text_pole sb-thumbnail-number',
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
        const heightInput = createElement('input', {
            className: 'text_pole sb-thumbnail-number',
            attrs: {
                type: 'number',
                inputmode: 'numeric',
                min: '1',
                max: '4096',
                step: '1',
                'aria-label': `${label} thumbnail height`,
            },
        });

        row.dataset.thumbnailSize = key;
        row.append(rowLabel, widthInput, separator, heightInput);
        return { row, widthInput, heightInput };
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

        if (refs.updateButton?.dataset.sbUpdateMode === 'zip') {
            await handleServerAdminZipUpdate();
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

    async function handleServerAdminZipUpdate() {
        const state = getServerAdminState();
        const refs = getServerAdminRefs();

        if (!refs || state.busy || state.restarting) {
            return;
        }

        state.busy = true;
        updateServerAdminInteractivity();
        setServerAdminButtonLabel(refs.updateButton, true, 'Updating…');
        setServerAdminMessage(refs.updateNote, 'Downloading the latest GitHub release ZIP and preparing a safe restart…');
        refs.updateOutput.hidden = true;
        refs.updateOutput.textContent = '';

        try {
            const result = await requestServerAdmin('/api/server-admin/zip-update');
            const nextStatus = {
                ...(state.lastStatusData ?? {}),
                configPath: refs.configPath?.textContent || state.lastStatusData?.configPath || '',
                version: result?.version ?? state.lastStatusData?.version ?? {},
                repository: result?.repository ?? state.lastStatusData?.repository ?? {},
                release: result?.release ?? state.lastStatusData?.release ?? null,
            };

            if (!result?.updated) {
                renderServerAdminStatus(nextStatus);
                setServerAdminMessage(refs.updateNote, result?.message || 'Already up to date.', 'good');
                toastr.success(result?.message || 'Already up to date.', 'Server update');
                return;
            }

            renderServerAdminStatus(nextStatus);
            state.busy = false;
            state.restarting = true;
            updateServerAdminInteractivity();
            setServerAdminMessage(refs.updateNote, result?.message || 'ZIP update downloaded. Restarting SillyBunny…', 'warn');
            toastr.info(result?.message || 'ZIP update downloaded. Restarting SillyBunny…', 'Server update');

            const expectedVersion = String(result?.release?.latestVersion ?? '').trim();
            const autoClearCacheEnabled = Boolean(document.getElementById('auto_clear_cache_on_update')?.checked);
            const restarted = await waitForServerReturn('', { clearCacheBeforeReload: autoClearCacheEnabled, expectedVersion });

            if (!restarted) {
                state.restarting = false;
                setServerAdminMessage(refs.updateNote, 'ZIP update started, but restart is taking longer than expected. Refresh manually once the server is back.', 'warn');
                toastr.warning('ZIP update started, but restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
            }
        } catch (error) {
            console.error('Failed to update SillyBunny from release ZIP.', error);
            state.busy = false;
            setServerAdminMessage(refs.updateNote, error.message || 'Failed to update SillyBunny from release ZIP.', 'danger');
            toastr.error(error.message || 'Failed to update SillyBunny from release ZIP.', 'Server update');
        } finally {
            setServerAdminButtonLabel(refs.updateButton, false, 'Updating…');

            if (!state.restarting) {
                state.busy = false;
                updateServerAdminInteractivity();
            }
        }
    }

    async function loadServerAdminBranches(selectElement, currentBranch) {
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
            selectElement.addEventListener('change', () => handleServerAdminBranchSwitch(selectElement));
        } catch (error) {
            console.error('Failed to load branches.', error);
            // Keep the current branch option if loading fails
        }
    }

    async function handleServerAdminBranchSwitch(selectElement) {
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

        const confirmMessage = hasLocalChanges
            ? `You have local changes.${changedFilesText}\n\nDo you want to auto-stash your changes and switch to "${targetBranch}"?\n\nThe server will restart after switching.`
            : `Switch to branch "${targetBranch}"?\n\nThe server will restart after switching.`;

        const confirmed = confirm(confirmMessage);

        if (!confirmed) {
            // Reset select to current branch
            selectElement.value = currentBranch;
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
        const callout = createElement('div', { className: 'sb-shell-callout' });
        callout.innerHTML = `
            <strong>Server Tools</strong>
            <p>Edit <code>config.yaml</code>, check for Git or release ZIP updates, and restart the app from inside Customize. Git auto-update only runs when the repository can fast-forward cleanly.</p>
        `;

        const statusCard = createElement('section', { className: 'sb-admin-card sb-server-card' });
        const statusHeader = createElement('div', { className: 'sb-admin-card-header' });
        const statusCopy = createElement('div', { className: 'sb-admin-card-copy' });
        const statusTitle = createElement('strong', { text: 'App Status' });
        const statusDescription = createElement('p', { text: 'Review the current runtime, branch, commit, and whether this workspace can update safely.' });
        const statusPill = createElement('span', { className: 'sb-server-pill', text: 'Checking…' });
        const statusGrid = createElement('div', { className: 'sb-server-grid' });
        const statusNote = createElement('div', { className: 'sb-server-note' });
        statusCopy.append(statusTitle, statusDescription);
        statusHeader.append(statusCopy, statusPill);
        statusCard.append(statusHeader, statusGrid, statusNote);

        const updateCard = createElement('section', { className: 'sb-admin-card sb-server-card' });
        const updateHeader = createElement('div', { className: 'sb-admin-card-header' });
        const updateCopy = createElement('div', { className: 'sb-admin-card-copy' });
        const updateTitle = createElement('strong', { text: 'Updates & Restart' });
        const updateDescription = createElement('p', { text: 'Check upstream status, update the app, and relaunch automatically when it is safe to do so.' });
        const updateActions = createElement('div', { className: 'sb-server-actions' });
        const refreshButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Check for updates', attrs: { type: 'button' } });
        const updateButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action menu_button_primary', text: 'Update & Restart', attrs: { type: 'button' } });
        const restartButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Restart server', attrs: { type: 'button' } });
        const updateNote = createElement('div', { className: 'sb-server-note', text: 'Git fast-forward updates and release ZIP updates restart automatically after preparation finishes.' });
        const autoStashLabel = createElement('label', { className: 'checkbox_label' });
        const autoStashCheckbox = createElement('input', { attrs: { type: 'checkbox', id: 'auto_stash_before_pull' } });
        const autoStashText = createElement('small', { text: 'Auto-stash local changes before pulling' });
        autoStashLabel.append(autoStashCheckbox, autoStashText);
        const updateOutput = createElement('pre', { className: 'sb-server-output' });
        updateOutput.hidden = true;
        updateCopy.append(updateTitle, updateDescription);
        updateActions.append(refreshButton, updateButton, restartButton);
        updateHeader.append(updateCopy);
        updateCard.append(updateHeader, updateActions, autoStashLabel, updateNote, updateOutput);

        const thumbnailCard = createElement('section', { className: 'sb-admin-card sb-server-card sb-thumbnail-card' });
        const thumbnailHeader = createElement('div', { className: 'sb-admin-card-header' });
        const thumbnailCopy = createElement('div', { className: 'sb-admin-card-copy' });
        const thumbnailTitle = createElement('strong', { text: 'Thumbnail Quality' });
        const thumbnailDescription = createElement('p', { text: 'Set thumbnail format, quality, and generated sizes without hand-editing config.yaml.' });
        thumbnailCopy.append(thumbnailTitle, thumbnailDescription);
        thumbnailHeader.append(thumbnailCopy);

        const thumbnailControls = createElement('div', { className: 'sb-thumbnail-controls' });
        const thumbnailEnabledLabel = createElement('label', { className: 'checkbox_label sb-thumbnail-enabled' });
        const thumbnailEnabled = createElement('input', { attrs: { type: 'checkbox' } });
        const thumbnailEnabledText = createElement('small', { text: 'Generate thumbnails' });
        thumbnailEnabledLabel.append(thumbnailEnabled, thumbnailEnabledText);

        const thumbnailFormatGroup = createElement('label', { className: 'sb-thumbnail-field' });
        const thumbnailFormatText = createElement('span', { text: 'Format' });
        const thumbnailFormat = createElement('select', { className: 'text_pole' });
        thumbnailFormat.append(
            createElement('option', { text: 'JPG', attrs: { value: 'jpg' } }),
            createElement('option', { text: 'PNG', attrs: { value: 'png' } }),
        );
        thumbnailFormatGroup.append(thumbnailFormatText, thumbnailFormat);

        const thumbnailQualityGroup = createElement('label', { className: 'sb-thumbnail-field' });
        const thumbnailQualityText = createElement('span', { text: 'Quality' });
        const thumbnailQuality = createElement('input', {
            className: 'text_pole sb-thumbnail-number',
            attrs: {
                type: 'number',
                inputmode: 'numeric',
                min: '1',
                max: '100',
                step: '1',
            },
        });
        thumbnailQualityGroup.append(thumbnailQualityText, thumbnailQuality);
        thumbnailControls.append(thumbnailEnabledLabel, thumbnailFormatGroup, thumbnailQualityGroup);

        const thumbnailSizes = createElement('div', { className: 'sb-thumbnail-sizes' });
        const bgSize = createThumbnailSizeRow('Background', 'bg');
        const avatarSize = createThumbnailSizeRow('Character', 'avatar');
        const personaSize = createThumbnailSizeRow('Persona', 'persona');
        thumbnailSizes.append(bgSize.row, avatarSize.row, personaSize.row);

        const thumbnailActions = createElement('div', { className: 'sb-server-actions' });
        const thumbnailUseRecommendedButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Use desktop recommended', attrs: { type: 'button' } });
        const thumbnailUseRecommendedMobileButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Use mobile recommended', attrs: { type: 'button' } });
        const thumbnailSaveButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Save thumbnails', attrs: { type: 'button' } });
        const thumbnailSaveClearButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action menu_button_primary', text: 'Save & Clear Cache', attrs: { type: 'button' } });
        const thumbnailClearButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Clear cache only', attrs: { type: 'button' } });
        const thumbnailNote = createElement('div', { className: 'sb-server-note', text: 'Desktop thumbnails default to PNG at full resolution. Enable the mobile preset to serve smaller JPG thumbnails to phone-sized screens.' });

        const thumbnailMobileHeading = createElement('div', { className: 'sb-thumbnail-mobile-heading', text: 'Mobile preset' });
        const thumbnailMobileControls = createElement('div', { className: 'sb-thumbnail-controls' });
        const thumbnailMobileEnabledLabel = createElement('label', { className: 'checkbox_label sb-thumbnail-enabled' });
        const thumbnailMobileEnabled = createElement('input', { attrs: { type: 'checkbox' } });
        const thumbnailMobileEnabledText = createElement('small', { text: 'Generate mobile thumbnails' });
        thumbnailMobileEnabledLabel.append(thumbnailMobileEnabled, thumbnailMobileEnabledText);

        const thumbnailMobileFormatGroup = createElement('label', { className: 'sb-thumbnail-field' });
        const thumbnailMobileFormatText = createElement('span', { text: 'Mobile format' });
        const thumbnailMobileFormat = createElement('select', { className: 'text_pole' });
        thumbnailMobileFormat.append(
            createElement('option', { text: 'JPG', attrs: { value: 'jpg' } }),
            createElement('option', { text: 'PNG', attrs: { value: 'png' } }),
        );
        thumbnailMobileFormatGroup.append(thumbnailMobileFormatText, thumbnailMobileFormat);

        const thumbnailMobileQualityGroup = createElement('label', { className: 'sb-thumbnail-field' });
        const thumbnailMobileQualityText = createElement('span', { text: 'Mobile quality' });
        const thumbnailMobileQuality = createElement('input', {
            className: 'text_pole sb-thumbnail-number',
            attrs: {
                type: 'number',
                inputmode: 'numeric',
                min: '1',
                max: '100',
                step: '1',
            },
        });
        thumbnailMobileQualityGroup.append(thumbnailMobileQualityText, thumbnailMobileQuality);
        thumbnailMobileControls.append(thumbnailMobileEnabledLabel, thumbnailMobileFormatGroup, thumbnailMobileQualityGroup);

        const thumbnailMobileSizes = createElement('div', { className: 'sb-thumbnail-sizes' });
        const mobileBgSize = createThumbnailSizeRow('Mobile background', 'mobile-bg');
        const mobileAvatarSize = createThumbnailSizeRow('Mobile character', 'mobile-avatar');
        const mobilePersonaSize = createThumbnailSizeRow('Mobile persona', 'mobile-persona');
        thumbnailMobileSizes.append(mobileBgSize.row, mobileAvatarSize.row, mobilePersonaSize.row);

        thumbnailActions.append(thumbnailUseRecommendedButton, thumbnailUseRecommendedMobileButton, thumbnailSaveButton, thumbnailSaveClearButton, thumbnailClearButton);
        thumbnailCard.append(thumbnailHeader, thumbnailControls, thumbnailSizes, thumbnailMobileHeading, thumbnailMobileControls, thumbnailMobileSizes, thumbnailActions, thumbnailNote);

        const configCard = createElement('section', { className: 'sb-admin-card sb-server-card' });
        const configHeader = createElement('div', { className: 'sb-admin-card-header' });
        const configCopy = createElement('div', { className: 'sb-admin-card-copy' });
        const configTitle = createElement('strong', { text: 'config.yaml Editor' });
        const configDescription = createElement('p', { text: 'Edit the live config file directly here. Saves validate YAML before writing anything to disk.' });
        const configState = createElement('span', { className: 'sb-server-inline-state', text: 'Loading…' });
        const configPath = createElement('code', { className: 'sb-server-config-path', text: 'config.yaml' });
        const configMeta = createElement('div', { className: 'sb-server-config-meta' });
        const configEditor = createElement('textarea', {
            className: 'text_pole sb-server-config-editor',
            attrs: {
                spellcheck: 'false',
                rows: '22',
                'aria-label': 'config.yaml editor',
            },
        });
        const configActions = createElement('div', { className: 'sb-server-actions' });
        const reloadConfigButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Reload file', attrs: { type: 'button' } });
        const saveConfigButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Save config', attrs: { type: 'button' } });
        const saveConfigRestartButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action menu_button_primary', text: 'Save & Restart', attrs: { type: 'button' } });
        const configNote = createElement('div', { className: 'sb-server-note', text: 'Most config changes only take effect after a restart.' });
        configCopy.append(configTitle, configDescription);
        configHeader.append(configCopy, configState);
        configMeta.append(configPath);
        configActions.append(reloadConfigButton, saveConfigButton, saveConfigRestartButton);
        configCard.append(configHeader, configMeta, configEditor, configActions, configNote);

        column.append(callout, statusCard, updateCard, thumbnailCard, configCard);
        scroller.appendChild(column);

        const state = getServerAdminState();
        state.refs = {
            statusPill,
            statusGrid,
            statusNote,
            refreshButton,
            updateButton,
            restartButton,
            updateNote,
            updateOutput,
            autoStashCheckbox,
            thumbnailEnabled,
            thumbnailFormat,
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
            thumbnailMobileFormat,
            thumbnailMobileQuality,
            thumbnailMobileBgWidth: mobileBgSize.widthInput,
            thumbnailMobileBgHeight: mobileBgSize.heightInput,
            thumbnailMobileAvatarWidth: mobileAvatarSize.widthInput,
            thumbnailMobileAvatarHeight: mobileAvatarSize.heightInput,
            thumbnailMobilePersonaWidth: mobilePersonaSize.widthInput,
            thumbnailMobilePersonaHeight: mobilePersonaSize.heightInput,
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

        refreshButton.addEventListener('click', () => refreshServerAdminPanel({ includeConfig: false }));
        updateButton.addEventListener('click', handleServerAdminUpdate);
        restartButton.addEventListener('click', handleServerAdminRestart);
        thumbnailUseRecommendedButton.addEventListener('click', handleUseRecommendedThumbnailSettings);
        thumbnailUseRecommendedMobileButton.addEventListener('click', handleUseRecommendedMobileThumbnailSettings);
        thumbnailSaveButton.addEventListener('click', () => handleServerThumbnailSave({ clearCache: false }));
        thumbnailSaveClearButton.addEventListener('click', () => handleServerThumbnailSave({ clearCache: true }));
        thumbnailClearButton.addEventListener('click', handleServerThumbnailClearCache);
        reloadConfigButton.addEventListener('click', handleServerAdminReloadConfig);
        saveConfigButton.addEventListener('click', () => handleServerAdminSaveConfig({ restart: false }));
        saveConfigRestartButton.addEventListener('click', () => handleServerAdminSaveConfig({ restart: true }));
        configEditor.addEventListener('input', () => {
            updateServerConfigDirtyState();
            updateServerAdminInteractivity();
        });
        autoStashCheckbox.addEventListener('change', function () {
            const refs = getServerAdminRefs();
            if (!refs?.configEditor) return;
            const yaml = refs.configEditor.value;
            const newValue = this.checked ? 'true' : 'false';
            if (/^autoStashBeforePull:\s*(true|false)/m.test(yaml)) {
                refs.configEditor.value = yaml.replace(/^(autoStashBeforePull:\s*)(true|false)/m, `$1${newValue}`);
            } else {
                refs.configEditor.value = yaml + `\nautoStashBeforePull: ${newValue}\n`;
            }
            refs.configEditor.dispatchEvent(new Event('input'));
        });
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
        const callout = createElement('div', { className: 'sb-shell-callout' });
        callout.innerHTML = `
            <strong>Console Logs</strong>
            <p>Watch the recent terminal output from the running SillyBunny process here, without keeping a terminal window open on the side.</p>
        `;

        const card = createElement('section', { className: 'sb-admin-card sb-server-card sb-console-log-card' });
        const header = createElement('div', { className: 'sb-admin-card-header' });
        const copy = createElement('div', { className: 'sb-admin-card-copy' });
        const title = createElement('strong', { text: 'Live Server Console' });
        const description = createElement('p', { text: 'This mirrors the current process output captured from stdout and stderr. Only logs from the current SillyBunny session are available here.' });
        const statusPill = createElement('span', { className: 'sb-server-pill', text: 'Loading…' });
        const actions = createElement('div', { className: 'sb-server-actions sb-console-log-actions' });
        const refreshButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Refresh Now', attrs: { type: 'button' } });
        const pauseButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Pause Live', attrs: { type: 'button' } });
        const statusNote = createElement('div', { className: 'sb-server-note' });
        const output = createElement('pre', { className: 'sb-server-output sb-console-log-output' });
        const verboseLoggingCard = createElement('section', { className: 'sb-admin-card sb-server-card sb-console-log-verbose-card' });
        const verboseLoggingHeader = createElement('div', { className: 'sb-admin-card-header' });
        const verboseLoggingCopy = createElement('div', { className: 'sb-admin-card-copy' });
        const verboseLoggingTitle = createElement('strong', { text: 'Verbose Debug Logging' });
        const verboseLoggingDescription = createElement('p', { text: 'Enable full debugging console output for advanced troubleshooting. Changes are saved to config.yaml and apply after a restart.' });
        const verboseLoggingStatus = createElement('span', { className: 'sb-server-inline-state', text: 'Loading…' });
        const verboseLoggingActionButton = createElement('button', {
            className: 'menu_button menu_button_icon sb-server-action interactable sb-console-log-verbose-action',
            text: 'Debug Logging: Disabled',
            attrs: { type: 'button' },
        });

        copy.append(title, description);
        header.append(copy, statusPill);
        actions.append(refreshButton, pauseButton);
        card.append(header, actions, statusNote, output);
        verboseLoggingCopy.append(verboseLoggingTitle, verboseLoggingDescription);
        verboseLoggingHeader.append(verboseLoggingCopy, verboseLoggingStatus);
        verboseLoggingCard.append(verboseLoggingHeader, verboseLoggingActionButton);
        column.append(callout, card);
        column.append(verboseLoggingCard);
        scroller.appendChild(column);

        const state = getConsoleLogsState();
        state.refs = {
            statusPill,
            refreshButton,
            pauseButton,
            statusNote,
            output,
            verboseLoggingStatus,
            verboseLoggingActionButton,
        };

        refreshButton.addEventListener('click', () => {
            void refreshConsoleLogs({ forceFull: state.latestId === 0 });
        });
        pauseButton.addEventListener('click', toggleConsoleLogsPolling);
        verboseLoggingActionButton.addEventListener('click', () => {
            void toggleConsoleLogsVerboseLogging();
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
