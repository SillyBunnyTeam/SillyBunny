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
const LIBADWAITA_QUOTE_COLORS = {
    Libadwaita: 'rgba(129, 208, 255, 1)',
    'Libadwaita Light': 'rgba(4, 97, 190, 1)',
};

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
            expect(JSON.parse(reconciled.toString('utf8')).quote_text_color).toBe(LIBADWAITA_QUOTE_COLORS[path.parse(name).name]);
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

    test('bundled Libadwaita themes keep a blue accent that reads on their own surfaces', () => {
        for (const name of ['Libadwaita.json', 'Libadwaita Light.json']) {
            const theme = JSON.parse(fs.readFileSync(path.join(bundledThemesDirectory, name), 'utf8'));
            expect(theme.quote_text_color).toBe(LIBADWAITA_QUOTE_COLORS[path.parse(name).name]);
        }
    });

    test('is a no-op when the themes directory is missing', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bundled-themes-'));
        tempRoots.push(root);

        expect(() => contentManager.reconcileManagedBundledThemes({ root, themes: path.join(root, 'themes') })).not.toThrow();
    });
});

describe('bundled theme text contrast revision', () => {
    const themeFile = 'Everforest Dark.json';
    const previousCopy = () => fs.readFileSync(path.join(process.cwd(), 'fixtures', 'stale-bundled-themes', themeFile));

    test('replaces an unmodified copy of the previous bundled theme with the revised one', () => {
        const directories = makeThemesDirectory();
        const targetPath = path.join(directories.themes, themeFile);
        fs.writeFileSync(targetPath, previousCopy());

        contentManager.reconcileManagedBundledThemes(directories);

        const reconciled = fs.readFileSync(targetPath);
        expect(sha256(reconciled)).toBe(sha256(fs.readFileSync(path.join(bundledThemesDirectory, themeFile))));
        expect(sha256(reconciled)).not.toBe(sha256(previousCopy()));
    });

    test('leaves an edited copy of the previous bundled theme untouched', () => {
        const directories = makeThemesDirectory();
        const targetPath = path.join(directories.themes, themeFile);
        const edited = JSON.parse(previousCopy().toString('utf8'));
        edited.italics_text_color = 'rgba(200, 120, 90, 0.5)';
        const userContent = `${JSON.stringify(edited, null, 4)}\n`;
        fs.writeFileSync(targetPath, userContent);

        contentManager.reconcileManagedBundledThemes(directories);

        expect(fs.readFileSync(targetPath, 'utf8')).toBe(userContent);
    });

    test('does not create a copy the user no longer has', () => {
        const directories = makeThemesDirectory();

        contentManager.reconcileManagedBundledThemes(directories);

        expect(fs.existsSync(path.join(directories.themes, themeFile))).toBe(false);
    });
});
