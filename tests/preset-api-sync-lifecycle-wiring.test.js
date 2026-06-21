import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8');

function getFunctionSource(name) {
    const marker = `function ${name}(`;
    const start = tabsSource.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = tabsSource.indexOf('{', start);
    let depth = 0;

    for (let index = bodyStart; index < tabsSource.length; index++) {
        const char = tabsSource[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return tabsSource.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

describe('preset/API sync lifecycle wiring', () => {
    test('imports the preset/API sync lifecycle seam into the shell adapter', () => {
        expect(tabsSource).toContain('createPresetApiSyncLifecycle');
        expect(tabsSource).toContain('const sbPresetApiSyncLifecycle = createPresetApiSyncLifecycle();');
    });

    test('routes connection profile selection sync through the lifecycle seam', () => {
        const syncSource = getFunctionSource('syncConnectionProfileSelection');

        expect(syncSource).toContain('sbPresetApiSyncLifecycle.connectionProfiles.resolveSelectionSync({');
        expect(syncSource).toContain('requestedValue: value');
        expect(syncSource).toContain('currentValue: sourceSelect.value');
        expect(syncSource).toContain('sourceSelect.value = syncState.nextValue;');
        expect(syncSource).not.toContain('String(value ?? \'\').trim()');
    });

    test('routes active main API resolution through the lifecycle seam', () => {
        const mainApiSource = getFunctionSource('getCurrentMainApiValue');

        expect(mainApiSource).toContain('sbPresetApiSyncLifecycle.api.resolveMainValue({');
        expect(mainApiSource).toContain('selectValue: mainApiSelect instanceof HTMLSelectElement ? mainApiSelect.value : \'\'');
        expect(mainApiSource).toContain('contextMainApi: context?.mainApi');
        expect(mainApiSource).not.toContain('trim().toLowerCase()');
    });

    test('routes active API connect button selector mapping through the lifecycle seam', () => {
        const connectButtonSource = getFunctionSource('resolveActiveApiConnectButton');

        expect(connectButtonSource).toContain('sbPresetApiSyncLifecycle.api.resolveConnectButtonSelector(getCurrentMainApiValue())');
        expect(connectButtonSource).not.toContain('const selectorMap = {');
        expect(connectButtonSource).not.toContain('koboldhorde: \'#api_button\'');
    });

    test('routes connection profile mirror state through the lifecycle seam', () => {
        const refreshSource = getFunctionSource('refreshChatbarState');

        expect(refreshSource).toContain('sbPresetApiSyncLifecycle.connectionProfiles.resolveMirrorState({');
        expect(refreshSource).toContain('hasConnectionProfiles');
        expect(refreshSource).toContain('isConnectionStripOpen: isConnectionStripOpen()');
        expect(refreshSource).toContain('hasActiveConnectButton: hasConnectionProfiles && Boolean(resolveActiveApiConnectButton())');
        expect(refreshSource).toContain('connectionMirrorState.shouldShowToggle');
        expect(refreshSource).toContain('connectionMirrorState.shouldShowDesktopStrip');
        expect(refreshSource).toContain('connectionMirrorState.shouldCloseDesktopStrip');
        expect(refreshSource).toContain('connectionMirrorState.shouldClearMirrors');
        expect(refreshSource).toContain('connectionMirrorState.shouldShowMobileSection');
        expect(refreshSource).toContain('connectionMirrorState.shouldDisableConnectButton');
    });
});
