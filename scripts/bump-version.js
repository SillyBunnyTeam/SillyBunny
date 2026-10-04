#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, '..');

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const VERSION_CAPTURE = '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)';

/**
 * Every hardcoded copy of the app version outside package.json and package-lock.json.
 * Each pattern must match exactly once and capture the bare version.
 */
export const VERSION_SOURCES = [
    {
        file: 'public/script.js',
        pattern: new RegExp(`const SILLYBUNNY_UI_VERSION = 'SillyBunny v${VERSION_CAPTURE}';`),
    },
    {
        file: 'public/script.js',
        pattern: new RegExp(`export let CLIENT_VERSION = 'SillyBunny:v${VERSION_CAPTURE}';`),
    },
    {
        file: 'src/endpoints/horde.js',
        pattern: new RegExp(`return version\\?\\.agent \\|\\| 'SillyBunny:${VERSION_CAPTURE}';`),
    },
];

function printHelp() {
    console.log(`Usage: node scripts/bump-version.js <version> [--dry-run]
       node scripts/bump-version.js --check

Sets the SillyBunny version in package.json, package-lock.json, and every hardcoded copy.

Options:
  --check    Exit non-zero if any copy differs from package.json.
  --dry-run  Report the files that would change without writing them.
  --help     Show this help text.
`);
}

export function normalizeVersion(value) {
    const version = String(value ?? '').trim().replace(/^v/, '');
    if (!SEMVER_PATTERN.test(version)) {
        throw new Error(`Invalid version: ${value}`);
    }

    return version;
}

function readText(repoRoot, file) {
    return fs.readFileSync(path.join(repoRoot, file), 'utf8');
}

function replaceJsonVersion(text, version, file) {
    const data = JSON.parse(text);
    data.version = version;
    if (file === 'package-lock.json' && data.packages?.['']) {
        data.packages[''].version = version;
    }

    const indent = /^\{\r?\n([ \t]+)/.exec(text)?.[1] ?? '    ';
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const body = JSON.stringify(data, null, indent).replace(/\n/g, eol);
    return text.endsWith(eol) ? `${body}${eol}` : body;
}

/**
 * Reads every version copy.
 * @param {string} [repoRoot]
 * @returns {{ file: string, version: string | null }[]}
 */
export function readVersions(repoRoot = defaultRepoRoot) {
    const pkg = JSON.parse(readText(repoRoot, 'package.json'));
    const lock = JSON.parse(readText(repoRoot, 'package-lock.json'));
    const results = [
        { file: 'package.json', version: pkg.version ?? null },
        { file: 'package-lock.json', version: lock.version ?? null },
        { file: 'package-lock.json (packages[""])', version: lock.packages?.['']?.version ?? null },
    ];

    for (const source of VERSION_SOURCES) {
        const text = readText(repoRoot, source.file);
        const matches = [...text.matchAll(new RegExp(source.pattern, 'g'))];
        results.push({ file: source.file, version: matches.length === 1 ? matches[0][1] : null });
    }

    return results;
}

/**
 * Lists copies that disagree with package.json.
 * @param {string} [repoRoot]
 * @returns {{ file: string, version: string | null }[]}
 */
export function findVersionMismatches(repoRoot = defaultRepoRoot) {
    const versions = readVersions(repoRoot);
    const expected = versions[0].version;
    return versions.filter(entry => entry.version !== expected);
}

/**
 * Writes the version to every copy.
 * @param {string} nextVersion
 * @param {{ repoRoot?: string, dryRun?: boolean }} [options]
 * @returns {string[]} Files that changed.
 */
export function bumpVersion(nextVersion, { repoRoot = defaultRepoRoot, dryRun = false } = {}) {
    const version = normalizeVersion(nextVersion);
    const pending = new Map();
    const getText = file => pending.get(file) ?? readText(repoRoot, file);

    for (const file of ['package.json', 'package-lock.json']) {
        pending.set(file, replaceJsonVersion(getText(file), version, file));
    }

    for (const source of VERSION_SOURCES) {
        const text = getText(source.file);
        const matches = [...text.matchAll(new RegExp(source.pattern, 'g'))];
        if (matches.length !== 1) {
            throw new Error(`Expected one version match in ${source.file} for ${source.pattern}, found ${matches.length}.`);
        }

        const [match] = matches;
        const replaced = match[0].replace(match[1], version);
        pending.set(source.file, text.slice(0, match.index) + replaced + text.slice(match.index + match[0].length));
    }

    const changed = [];
    for (const [file, text] of pending) {
        if (text !== readText(repoRoot, file)) {
            changed.push(file);
            if (!dryRun) {
                fs.writeFileSync(path.join(repoRoot, file), text);
            }
        }
    }

    return changed;
}

function main(argv) {
    if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
        printHelp();
        return;
    }

    if (argv.includes('--check')) {
        const mismatches = findVersionMismatches();
        if (mismatches.length) {
            const expected = readVersions()[0].version;
            console.error(`Version copies differ from package.json (${expected}):`);
            for (const entry of mismatches) {
                console.error(`  ${entry.file}: ${entry.version ?? 'not found'}`);
            }
            process.exitCode = 1;
            return;
        }

        console.log('All version copies match package.json.');
        return;
    }

    const dryRun = argv.includes('--dry-run');
    const [target] = argv.filter(arg => !arg.startsWith('--'));
    const changed = bumpVersion(target, { dryRun });
    const verb = dryRun ? 'Would update' : 'Updated';
    console.log(changed.length ? `${verb}: ${changed.join(', ')}` : 'Version already set; nothing to change.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
