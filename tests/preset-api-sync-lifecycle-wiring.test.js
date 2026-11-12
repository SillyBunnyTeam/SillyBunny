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

    test('routes active main API resolution through the lifecycle seam', () => {
        const mainApiSource = getFunctionSource('getCurrentMainApiValue');

        expect(mainApiSource).toContain('sbPresetApiSyncLifecycle.api.resolveMainValue({');
        expect(mainApiSource).toContain('selectValue: mainApiSelect instanceof HTMLSelectElement ? mainApiSelect.value : \'\'');
        expect(mainApiSource).toContain('contextMainApi: context?.mainApi');
        expect(mainApiSource).not.toContain('trim().toLowerCase()');
    });
});
