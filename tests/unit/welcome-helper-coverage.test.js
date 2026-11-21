import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

/*
 * A browser spec or helper that serves settings of an existing account must keep Welcome closed, or the dialog covers the
 * page under test on any data root that has not met it. This guard reads test files only, never product source.
 */

const TESTS_ROOT = new URL('../', import.meta.url);
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'unit', 'fixtures', '__snapshots__', 'test-results', 'playwright-report']);
/** The helpers that define the Welcome settings; they name the pattern in their own documentation. */
const DEFINITIONS = new Set(['helpers/welcome-dialog.js', 'helpers/getting-started-state.js']);
/** Each of these closes Welcome for the settings it serves: the two functions edit them, the stub serves them. */
const WELCOME_HELPERS = ['applyWelcomeSettings', 'applyHomeTestSettings', 'stubGettingStarted'];
/** `firstRun = false` and `firstRun: false`, which is how a file serves or seeds the settings of an existing account. */
const FIRST_RUN_FALSE = /\bfirstRun\s*[:=]\s*false\b/;
const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g;

/** @param {string} source */
function importsWelcomeHelper(source) {
    return [...source.matchAll(NAMED_IMPORT)].some(([, names, from]) => {
        const imported = names.split(',').map(name => name.trim().split(/\s+as\s+/)[0]);
        return /(?:welcome-dialog|getting-started-state)\.js$/.test(from) && imported.some(name => WELCOME_HELPERS.includes(name));
    });
}

/**
 * @param {Record<string, string>} files Source text by path under tests/.
 * @returns {string[]} The paths that serve `firstRun: false` and do not import a Welcome helper.
 */
function findFilesThatLeaveWelcomeOpen(files) {
    return Object.entries(files)
        .filter(([path, source]) => !DEFINITIONS.has(path) && FIRST_RUN_FALSE.test(source) && !importsWelcomeHelper(source))
        .map(([path]) => path);
}

/** @returns {Record<string, string>} */
function readBrowserTestFiles(directory = TESTS_ROOT, prefix = '') {
    return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory()) {
            return SKIPPED_DIRECTORIES.has(entry.name) ? [] : Object.entries(readBrowserTestFiles(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`));
        }
        const isBrowserFile = entry.name.endsWith('.js') && !entry.name.endsWith('.test.js');
        return isBrowserFile ? [[`${prefix}${entry.name}`, readFileSync(new URL(entry.name, directory), 'utf8')]] : [];
    }));
}

describe('the guard that keeps Welcome closed in browser tests', () => {
    test.each([
        ['an assignment', 'settings.firstRun = false;'],
        ['an object property', '{ ...JSON.parse(data.settings), firstRun: false }'],
        ['an option of a helper', 'applyGettingStartedSettings(settings, { firstRun: false });'],
    ])('flags %s that serves an existing account without a Welcome helper', (_label, line) => {
        expect(findFilesThatLeaveWelcomeOpen({ 'a.e2e.js': line })).toEqual(['a.e2e.js']);
    });

    test.each([
        ['a first run', 'settings.firstRun = true;'],
        ['a variable', 'settings.firstRun = firstRun;'],
        ['a longer name', 'settings.firstRunSeen = false;'],
    ])('leaves %s alone', (_label, line) => {
        expect(findFilesThatLeaveWelcomeOpen({ 'a.e2e.js': line })).toEqual([]);
    });

    test.each([
        ['applyWelcomeSettings', 'import { applyWelcomeSettings } from \'./helpers/welcome-dialog.js\';'],
        ['applyHomeTestSettings', 'import { applyHomeTestSettings } from \'./helpers/getting-started-state.js\';'],
        ['stubGettingStarted', 'import { stubGettingStarted } from \'./helpers/getting-started-state.js\';'],
        ['a renamed import', 'import { applyWelcomeSettings as keepClosed } from \'../helpers/welcome-dialog.js\';'],
    ])('accepts a file that imports %s', (_label, importLine) => {
        expect(findFilesThatLeaveWelcomeOpen({ 'a.e2e.js': `${importLine}\nsettings.firstRun = false;` })).toEqual([]);
    });

    test('does not accept an import of an unrelated helper from the same module', () => {
        const source = 'import { answerFirstRunWelcome } from \'./helpers/welcome-dialog.js\';\nsettings.firstRun = false;';

        expect(findFilesThatLeaveWelcomeOpen({ 'a.e2e.js': source })).toEqual(['a.e2e.js']);
    });

    test('every browser spec and helper under tests/ that serves firstRun false keeps Welcome closed', () => {
        const files = readBrowserTestFiles();
        const serving = Object.entries(files).filter(([path, source]) => !DEFINITIONS.has(path) && FIRST_RUN_FALSE.test(source));

        expect(serving.length).toBeGreaterThan(10);
        expect(findFilesThatLeaveWelcomeOpen(files)).toEqual([]);
    });
});
