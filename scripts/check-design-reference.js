#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '..');

const GITLAB_API = 'https://gitlab.gnome.org/api/v4/projects';
const LIBADWAITA_PROJECT = 'GNOME/libadwaita';
const HIG_PROJECT = 'Teams/Design/hig-www';
const REQUEST_TIMEOUT_MS = 20_000;

/** Exit codes: the reference is the recorded one, it has moved, or it could not be read. */
export const EXIT = Object.freeze({ current: 0, moved: 1, unknown: 2 });

function printHelp() {
    console.log(`Usage: node scripts/check-design-reference.js [--json]

Compares the reference that DESIGN.md records (a libadwaita release and a commit of the GNOME HIG)
with the latest stable libadwaita tag and the head of the HIG repository on gitlab.gnome.org.

Run it by hand, or from a scheduled job. It needs the network, so the test suite never runs it.

Exit codes: ${EXIT.current} the recorded reference is current, ${EXIT.moved} the reference has moved,
${EXIT.unknown} the recorded reference or the remote state could not be read.

Options:
  --json    Print JSON instead of text.
  -h, --help`);
}

/**
 * Reads the libadwaita release and the HIG commit out of a reference version statement, such as the "Reference version" line of
 * DESIGN.md or `narrative.referenceVersion` of DESIGN.json.
 * @param {string} text
 * @returns {{ libadwaita: string | null, higCommit: string | null }}
 */
export function parseRecordedReference(text) {
    const libadwaita = /libadwaita\s+(\d+\.\d+\.\d+)/i.exec(text);
    const higCommit = /HIG[^`\n]*commit\s+`([0-9a-f]{7,40})`/i.exec(text);
    return { libadwaita: libadwaita ? libadwaita[1] : null, higCommit: higCommit ? higCommit[1] : null };
}

/** The reference version line of DESIGN.md, or an empty string when the document has none. */
export function readReferenceLine(repoRoot = defaultRepoRoot) {
    const design = fs.readFileSync(path.join(repoRoot, 'DESIGN.md'), 'utf8');
    return design.split('\n').find(line => /^\*\*Reference version:\*\*/.test(line)) ?? '';
}

/** @returns {number} negative, zero or positive, as `a` is older than, equal to or newer than `b` */
export function compareVersions(a, b) {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
}

/**
 * The newest stable release among tag names. libadwaita tags its development snapshots `1.11.alpha`, `1.11.beta` and `1.11.rc`,
 * and only three plain numbers name a stable release.
 * @param {readonly string[]} tagNames
 * @returns {string | null}
 */
export function latestStableTag(tagNames) {
    const stable = tagNames.filter(name => /^\d+\.\d+\.\d+$/.test(name));
    return stable.length ? stable.sort(compareVersions).at(-1) : null;
}

/**
 * @param {{ libadwaita: string | null, higCommit: string | null }} recorded
 * @param {{ libadwaita: string | null, higCommit: string | null }} remote
 * @returns {{ status: keyof typeof EXIT, libadwaitaMoved: boolean, higMoved: boolean }}
 */
export function compareReference(recorded, remote) {
    if (!recorded.libadwaita || !recorded.higCommit || !remote.libadwaita || !remote.higCommit) {
        return { status: 'unknown', libadwaitaMoved: false, higMoved: false };
    }
    const libadwaitaMoved = compareVersions(remote.libadwaita, recorded.libadwaita) > 0;
    // The document records a short commit id, so the remote id is compared by that prefix.
    const higMoved = !remote.higCommit.startsWith(recorded.higCommit);
    return { status: libadwaitaMoved || higMoved ? 'moved' : 'current', libadwaitaMoved, higMoved };
}

async function fetchJson(url) {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
    }
    return response.json();
}

async function readRemoteReference() {
    const tags = await fetchJson(`${GITLAB_API}/${encodeURIComponent(LIBADWAITA_PROJECT)}/repository/tags?per_page=100`);
    const commits = await fetchJson(`${GITLAB_API}/${encodeURIComponent(HIG_PROJECT)}/repository/commits?per_page=1`);
    return {
        libadwaita: latestStableTag(tags.map(tag => tag.name)),
        higCommit: commits[0]?.id ?? null,
        higDate: commits[0]?.committed_date?.slice(0, 10) ?? null,
    };
}

function formatReport(recorded, remote, comparison) {
    const lines = [
        `Recorded in DESIGN.md: libadwaita ${recorded.libadwaita ?? 'not found'}; HIG commit ${recorded.higCommit ?? 'not found'}`,
        `On gitlab.gnome.org:   libadwaita ${remote.libadwaita ?? 'not found'}; HIG commit ${remote.higCommit?.slice(0, 12) ?? 'not found'}${remote.higDate ? ` (${remote.higDate})` : ''}`,
    ];
    if (comparison.status === 'unknown') {
        lines.push('The two could not be compared.');
    } else if (comparison.status === 'current') {
        lines.push('The recorded reference is current.');
    } else {
        if (comparison.libadwaitaMoved) {
            lines.push(`libadwaita has a newer stable release (${remote.libadwaita}). Read its NEWS and the diff of src/stylesheet/ since ${recorded.libadwaita}.`);
        }
        if (comparison.higMoved) {
            lines.push(`The HIG has commits after ${recorded.higCommit}. Read the log of hig-www since that commit.`);
        }
        lines.push('Review the changed rules in DESIGN.md and DESIGN.json, then update the reference version line of both.');
    }
    return lines.join('\n');
}

async function runCli(argv = process.argv.slice(2)) {
    if (argv.includes('--help') || argv.includes('-h')) {
        printHelp();
        return;
    }
    const recorded = parseRecordedReference(readReferenceLine());
    let remote;
    try {
        remote = await readRemoteReference();
    } catch (error) {
        console.error(`The remote reference could not be read: ${error.message}`);
        process.exitCode = EXIT.unknown;
        return;
    }
    const comparison = compareReference(recorded, remote);
    console.log(argv.includes('--json') ? JSON.stringify({ recorded, remote, ...comparison }, null, 2) : formatReport(recorded, remote, comparison));
    process.exitCode = EXIT[comparison.status];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runCli();
}
