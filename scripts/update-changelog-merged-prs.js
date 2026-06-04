#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const changelogPath = path.join(repoRoot, 'changelog.md');
const packagePath = path.join(repoRoot, 'package.json');

const mergedPrHeading = '### Merged Staging PRs';
const stagingBranch = 'staging';

function printHelp() {
    console.log(`Usage: node scripts/update-changelog-merged-prs.js [--pr <number>] [--pr <number>] [--version <version>] [--dry-run]

Adds merged staging pull requests to the current changelog version section.

Options:
  --pr <number>       Pull request number to record. Can be repeated or comma-separated.
                      Defaults to merged PRs found in the GitHub event payload.
  --version <version> Changelog version heading to update. Defaults to package.json version.
  --dry-run           Report whether changelog.md would change without writing it.
  --help              Show this help text.
`);
}

function parseArgs(argv) {
    const options = {
        dryRun: false,
        help: false,
        prNumbers: [],
        version: undefined,
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];

        if (arg === '--dry-run') {
            options.dryRun = true;
            continue;
        }

        if (arg === '--help' || arg === '-h') {
            options.help = true;
            continue;
        }

        if (arg === '--pr') {
            const value = readArgValue(argv, ++index, arg);
            options.prNumbers.push(...value.split(','));
            continue;
        }

        if (arg === '--version') {
            options.version = readArgValue(argv, ++index, arg);
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    const eventPrNumbers = readEventPrNumbers();
    if (!options.prNumbers.length && eventPrNumbers.length) {
        options.prNumbers.push(...eventPrNumbers);
    }

    return options;
}

function readArgValue(argv, index, flag) {
    const value = argv[index];
    if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${flag}`);
    }

    return value;
}

function readEventPrNumbers() {
    const prNumbers = [];

    if (process.env.CHANGELOG_PR_NUMBER) {
        prNumbers.push(...process.env.CHANGELOG_PR_NUMBER.split(','));
    }

    if (!process.env.GITHUB_EVENT_PATH || !fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
        return prNumbers;
    }

    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));

    if (event.pull_request?.number) {
        prNumbers.push(String(event.pull_request.number));
    }

    const commits = [...(event.commits || [])];
    if (event.head_commit) {
        commits.push(event.head_commit);
    }

    for (const commit of commits) {
        prNumbers.push(...extractMergedPrNumbers(commit.message));
    }

    return prNumbers;
}

export function extractMergedPrNumbers(message) {
    const numbers = new Set();
    const text = String(message || '');

    for (const match of text.matchAll(/^Merge pull request #(\d+)\b/gm)) {
        numbers.add(match[1]);
    }

    const [subject = ''] = text.split(/\r?\n/, 1);
    const squashMatch = /\(#(\d+)\)\s*$/.exec(subject);
    if (squashMatch) {
        numbers.add(squashMatch[1]);
    }

    return [...numbers];
}

function normalizePrNumbers(values) {
    const numbers = new Set();

    for (const value of values) {
        const trimmed = String(value).trim();
        if (!trimmed) {
            continue;
        }

        const number = Number.parseInt(trimmed, 10);
        if (!Number.isInteger(number) || number <= 0 || String(number) !== trimmed) {
            throw new Error(`Invalid pull request number: ${value}`);
        }

        numbers.add(number);
    }

    return [...numbers];
}

function readPackageVersion() {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (!pkg.version) {
        throw new Error('package.json does not define a version.');
    }

    return pkg.version;
}

function normalizeVersion(value) {
    const version = String(value).trim();
    return version.startsWith('v') ? version : `v${version}`;
}

function runGhJson(args) {
    try {
        const output = execFileSync('gh', args, {
            cwd: repoRoot,
            encoding: 'utf8',
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        return JSON.parse(output);
    } catch (error) {
        const stderr = error.stderr?.toString().trim();
        const detail = stderr ? `: ${stderr}` : '';
        throw new Error(`Failed to read pull request metadata with gh${detail}`);
    }
}

function fetchPullRequest(number) {
    return runGhJson([
        'pr',
        'view',
        String(number),
        '--json',
        'number,title,mergedAt,baseRefName,mergeCommit,url',
    ]);
}

function filterMergedStagingPrs(prs) {
    return prs.filter((pr) => {
        if (!pr.mergedAt) {
            console.log(`Skipping PR #${pr.number}: it has not been merged.`);
            return false;
        }

        if (pr.baseRefName !== stagingBranch) {
            console.log(`Skipping PR #${pr.number}: base branch is ${pr.baseRefName}, not ${stagingBranch}.`);
            return false;
        }

        return true;
    });
}

function escapeInlineCode(value) {
    return String(value).replace(/`/g, '\'').replace(/\s+/g, ' ').trim();
}

function formatPrEntry(pr) {
    const date = pr.mergedAt.slice(0, 10);
    return `- PR #${pr.number} (${date}) \`${escapeInlineCode(pr.title)}\``;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mergePrLines(existingText, prs) {
    const byNumber = new Map();

    for (const line of existingText.split(/\r?\n/)) {
        const trimmed = line.trim();
        const match = /^- PR #(\d+)\b/.exec(trimmed);

        if (match) {
            byNumber.set(Number(match[1]), trimmed);
        }
    }

    for (const pr of prs) {
        const number = Number(pr.number);
        if (!byNumber.has(number)) {
            byNumber.set(number, formatPrEntry(pr));
        }
    }

    return [...byNumber.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, line]) => line);
}

function updateVersionBlock(block, prs) {
    const sectionPattern = /### Merged Staging PRs\r?\n([\s\S]*?)(?=\r?\n### |\r?\n## |$)/;
    const match = sectionPattern.exec(block);

    if (match) {
        const nextLines = mergePrLines(match[1], prs);
        const replacement = `${mergedPrHeading}\n${nextLines.join('\n')}\n`;
        return block.slice(0, match.index) + replacement + block.slice(match.index + match[0].length);
    }

    const entries = mergePrLines('', prs);
    const section = `${mergedPrHeading}\n${entries.join('\n')}\n\n`;
    const localCommitsIndex = block.indexOf('### Local Commits');

    if (localCommitsIndex !== -1) {
        return block.slice(0, localCommitsIndex) + section + block.slice(localCommitsIndex);
    }

    return `${block.replace(/\s*$/, '\n\n')}${section}`;
}

function createVersionBlock(version, prs) {
    const entries = mergePrLines('', prs);
    return `## ${version}\n\n${mergedPrHeading}\n${entries.join('\n')}\n`;
}

function insertMissingVersionBlock(changelog, version, prs) {
    const block = `${createVersionBlock(version, prs)}\n`;
    const titleMatch = /^# Changelog\r?\n/.exec(changelog);

    if (!titleMatch) {
        return `${block}${changelog.replace(/^\s*/, '')}`;
    }

    const insertAt = titleMatch[0].length;
    const rest = changelog.slice(insertAt).replace(/^\r?\n/, '');
    return `${changelog.slice(0, insertAt)}\n${block}${rest}`;
}

export function updateChangelog(changelog, version, prs) {
    const versionHeadingPattern = new RegExp(`(^|\\r?\\n)## ${escapeRegExp(version)}\\r?\\n`);
    const versionHeadingMatch = versionHeadingPattern.exec(changelog);

    if (!versionHeadingMatch) {
        return insertMissingVersionBlock(changelog, version, prs);
    }

    const versionStart = versionHeadingMatch.index + versionHeadingMatch[1].length;
    const versionHeadingEnd = versionStart + versionHeadingMatch[0].length - versionHeadingMatch[1].length;
    const nextVersionMatch = /\r?\n## /.exec(changelog.slice(versionHeadingEnd));
    const versionEnd = nextVersionMatch ? versionHeadingEnd + nextVersionMatch.index : changelog.length;
    const block = changelog.slice(versionStart, versionEnd);
    const updatedBlock = updateVersionBlock(block, prs);

    return changelog.slice(0, versionStart) + updatedBlock + changelog.slice(versionEnd);
}

function main() {
    try {
        const options = parseArgs(process.argv.slice(2));

        if (options.help) {
            printHelp();
            return;
        }

        const prNumbers = normalizePrNumbers(options.prNumbers);
        if (!prNumbers.length && process.env.GITHUB_EVENT_NAME === 'push') {
            console.log('No merged staging pull requests found in this push.');
            return;
        }

        if (!prNumbers.length) {
            throw new Error('At least one --pr <number> is required.');
        }

        const version = normalizeVersion(options.version || readPackageVersion());
        const prs = filterMergedStagingPrs(prNumbers.map(fetchPullRequest));

        if (!prs.length) {
            console.log('No merged staging pull requests to record.');
            return;
        }

        const changelog = fs.readFileSync(changelogPath, 'utf8');
        const updated = updateChangelog(changelog, version, prs);

        if (updated === changelog) {
            console.log('changelog.md already contains the merged pull request entries.');
            return;
        }

        if (options.dryRun) {
            console.log('changelog.md would be updated.');
            return;
        }

        fs.writeFileSync(changelogPath, updated);
        console.log(`Updated changelog.md ${version} merged PR entries.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
