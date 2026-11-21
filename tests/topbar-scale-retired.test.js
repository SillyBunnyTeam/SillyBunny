import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8').replace(/\r\n/g, '\n');

function getFunctionSource(name) {
    const match = tabsSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    expect(match).not.toBeNull();
    return match[0];
}

function createHarness(stored) {
    const reads = [];
    const writes = [];
    const rootStyle = [];
    const sbState = { topbarLabel: {}, chatbar: {}, bottomChatBar: {}, topbarIconsOnly: {} };
    const body = [
        'const SB_TOPBAR_SCALE = { min: 70, max: 150, step: 5, defaultValue: 100 };',
        tabsSource.match(/const SB_STORAGE_KEYS = Object\.freeze\(\{[\s\S]*?\n\}\);/)[0],
        getFunctionSource('normalizeTopbarScale'),
        getFunctionSource('seedTopbarScaleDefaults'),
        getFunctionSource('restorePersistedTopbarState'),
        'return { seedTopbarScaleDefaults, restorePersistedTopbarState };',
    ].join('\n');
    const factory = new Function(
        'safeGetItem', 'safeSetItem', 'sbState', 'readTopbarLabelParts', 'normalizeTopbarCustomText',
        'normalizeStoredBoolean', 'normalizeTopbarOffset', body,
    );
    const api = factory(
        (key) => {
            reads.push(key);
            return Object.hasOwn(stored, key) ? stored[key] : null;
        },
        (key, value) => writes.push([key, value]),
        sbState,
        () => [],
        () => '',
        (value, fallback) => fallback,
        () => ({ x: 0, y: 0 }),
    );
    return { api, reads, writes, rootStyle, sbState };
}

describe('retired top bar scale keys', () => {
    const stored = { 'sb-topbar-scale-desktop': '130', 'sb-topbar-scale-mobile': '80' };

    test('restoring and seeding neither read nor write the stored values', () => {
        const { api, reads, writes, sbState } = createHarness(stored);
        api.restorePersistedTopbarState();
        api.seedTopbarScaleDefaults();
        expect([...reads, ...writes.map(([key]) => key)].filter(key => key.startsWith('sb-topbar-scale-'))).toEqual([]);
        expect(sbState.topbarScale).toBeUndefined();
    });

    test('no script sets the top bar scale custom properties', () => {
        expect(tabsSource).not.toContain('--sb-topbar-scale-');
        expect(tabsSource).not.toContain('function setTopbarScale');
        expect(tabsSource).toContain('setTopbarScale() {},');
        expect(tabsSource).not.toContain('topbarScaleDesktop');
        expect(tabsSource).not.toContain('topbarScaleMobile');
    });

    test('getTopbarScale returns the default for both modes whatever is stored', () => {
        const method = tabsSource.match(/\n {8}getTopbarScale\([^)]*\) \{[\s\S]*?\n {8}\},/)[0];
        const getTopbarScale = new Function('SB_TOPBAR_SCALE', 'sbState', `return {${method}}.getTopbarScale;`)(
            { defaultValue: 100 }, { topbarScale: { desktop: 130, mobile: 80 } },
        );
        expect(getTopbarScale('desktop')).toBe(100);
        expect(getTopbarScale('mobile')).toBe(100);
    });
});
