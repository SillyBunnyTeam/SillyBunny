#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The two markers of copy that still waits for its words. `lorum` is the misspelling that the project uses on
 * purpose, so upstream's real "Lorem ipsum" sample text does not match.
 */
export const PLACEHOLDER_PATTERN = /lorum ipsum|TODO\(copy\)/i;

/** Folders of tooling and documentation, which name the markers to state or test the rule and are never shown. */
const EXCLUDED_FOLDERS = Object.freeze(['.github/', 'assets-src/', 'docs/', 'scripts/', 'tests/']);

/** The installers print to the user, so they are checked although the rest of `scripts/` is not. */
const INCLUDED_TOOLING = Object.freeze(['scripts/bootstrap/']);

/** Git's own test for a binary file: a NUL byte in the first 8000 bytes. */
const BINARY_PROBE_BYTES = 8000;

/**
 * @param {string} file Path relative to the repository root, with forward slashes.
 * @returns {boolean} Whether the file is tooling or documentation that the program never shows.
 */
export function isExcluded(file) {
    if (INCLUDED_TOOLING.some(prefix => file.startsWith(prefix))) return false;
    if (EXCLUDED_FOLDERS.some(prefix => file.startsWith(prefix))) return true;
    // Root documents (AGENTS.md, DESIGN.md, LESSONS.md and the others) describe the rule; NOTICE is shipped text.
    return !file.includes('/') && (file.endsWith('.md') || file === 'DESIGN.json');
}

/**
 * @param {string} repoRoot
 * @returns {string[]} The tracked files that the check reads.
 */
export function listCheckedFiles(repoRoot = defaultRepoRoot) {
    const output = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return output.split('\0').filter(file => file && !isExcluded(file));
}

/**
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string[]} options.files Paths relative to `repoRoot`.
 * @returns {{ file: string, line: number, text: string }[]}
 */
export function findPlaceholders({ repoRoot = defaultRepoRoot, files }) {
    const findings = [];
    for (const file of files) {
        const fullPath = path.join(repoRoot, file);
        let stats;
        try {
            stats = fs.lstatSync(fullPath);
        } catch {
            continue;
        }
        // A symlink or a submodule entry is not text of its own.
        if (!stats.isFile()) continue;

        const buffer = fs.readFileSync(fullPath);
        if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) continue;

        const lines = buffer.toString('utf8').split(/\r?\n/);
        lines.forEach((text, index) => {
            const match = PLACEHOLDER_PATTERN.exec(text);
            if (!match) return;
            // Minified vendor files can hold a whole library on one line, so only the text around the match is kept.
            const excerpt = text.slice(Math.max(0, match.index - 60), match.index + match[0].length + 60).trim();
            findings.push({ file, line: index + 1, text: excerpt });
        });
    }
    return findings;
}

/** Escapes a property of a GitHub Actions workflow command, as the runner's command parser expects. */
function escapeCommandProperty(value) {
    return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function escapeCommandMessage(value) {
    return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function main() {
    const findings = findPlaceholders({ repoRoot: defaultRepoRoot, files: listCheckedFiles(defaultRepoRoot) });
    if (findings.length === 0) {
        console.log('No placeholder copy found.');
        return;
    }

    const annotate = process.env.GITHUB_ACTIONS === 'true';
    for (const { file, line, text } of findings) {
        console.log(`${file}:${line}: ${text}`);
        if (annotate) {
            console.log(`::error file=${escapeCommandProperty(file)},line=${line}::${escapeCommandMessage(`Placeholder copy: ${text}`)}`);
        }
    }

    const fileCount = new Set(findings.map(finding => finding.file)).size;
    console.error(`${findings.length} lines in ${fileCount} files hold placeholder copy (TODO(copy) or lorum ipsum). A release needs the final words.`);
    process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
