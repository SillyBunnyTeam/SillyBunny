import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../src/util.js', () => ({
    color: {
        blue: value => value,
        yellow: value => value,
    },
    getConfigValue: jest.fn((_key, defaultValue) => defaultValue),
    isValidUrl: jest.fn(() => false),
    recoverFileWriteSync: jest.fn(),
    setPermissionsSync: jest.fn(),
}));

/** @type {import('../src/endpoints/content-manager.js')} */
let contentManager;

const tempRoots = [];
const bundledThemesDirectory = path.join(process.cwd(), '..', 'default', 'content', 'themes');

// Dark V 1.0 palette shipped under the Libadwaita name by pre-release seeds.
const STALE_LIBADWAITA_SEED = {
    name: 'Libadwaita',
    blur_strength: 13,
    main_text_color: 'rgba(207, 207, 197, 1)',
    quote_text_color: 'rgba(198, 193, 151, 1)',
};

function makeThemesDirectory() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bundled-themes-'));
    tempRoots.push(root);
    const themes = path.join(root, 'themes');
    fs.mkdirSync(themes, { recursive: true });
    return { root, themes };
}

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

beforeAll(async () => {
    contentManager = await import('../src/endpoints/content-manager.js');
});

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

describe('bundled Libadwaita theme reconcile', () => {
    test('replaces byte-identical stale pre-release seeds with the bundled theme', () => {
        const directories = makeThemesDirectory();
        const staleDirectory = path.join(process.cwd(), 'fixtures', 'stale-libadwaita-themes');

        for (const name of ['Libadwaita.json', 'Libadwaita Light.json']) {
            fs.copyFileSync(path.join(staleDirectory, name), path.join(directories.themes, name));
        }

        contentManager.reconcileManagedBundledThemes(directories);

        for (const name of ['Libadwaita.json', 'Libadwaita Light.json']) {
            const reconciled = fs.readFileSync(path.join(directories.themes, name));
            expect(sha256(reconciled)).toBe(sha256(fs.readFileSync(path.join(bundledThemesDirectory, name))));
            expect(JSON.parse(reconciled.toString('utf8')).quote_text_color).toBe('rgba(53, 132, 228, 1)');
        }
    });

    test('leaves user-edited Libadwaita theme files untouched', () => {
        const directories = makeThemesDirectory();
        const targetPath = path.join(directories.themes, 'Libadwaita.json');
        const userContent = `${JSON.stringify(STALE_LIBADWAITA_SEED, null, 4)}\n`;
        fs.writeFileSync(targetPath, userContent);

        contentManager.reconcileManagedBundledThemes(directories);

        expect(fs.readFileSync(targetPath, 'utf8')).toBe(userContent);
    });

    test('leaves current bundled copies byte-identical', () => {
        const directories = makeThemesDirectory();
        const bundled = fs.readFileSync(path.join(bundledThemesDirectory, 'Libadwaita Light.json'));
        const targetPath = path.join(directories.themes, 'Libadwaita Light.json');
        fs.writeFileSync(targetPath, bundled);

        contentManager.reconcileManagedBundledThemes(directories);

        expect(sha256(fs.readFileSync(targetPath))).toBe(sha256(bundled));
    });

    test('bundled Libadwaita themes default to the libadwaita blue accent', () => {
        for (const name of ['Libadwaita.json', 'Libadwaita Light.json']) {
            const theme = JSON.parse(fs.readFileSync(path.join(bundledThemesDirectory, name), 'utf8'));
            expect(theme.quote_text_color).toBe('rgba(53, 132, 228, 1)');
        }
    });

    test('is a no-op when the themes directory is missing', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bundled-themes-'));
        tempRoots.push(root);

        expect(() => contentManager.reconcileManagedBundledThemes({ root, themes: path.join(root, 'themes') })).not.toThrow();
    });
});
