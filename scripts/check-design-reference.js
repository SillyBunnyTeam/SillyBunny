#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '..');

const GITLAB = 'https://gitlab.gnome.org';
const GITLAB_API = `${GITLAB}/api/v4/projects`;
const LIBADWAITA_PROJECT = 'GNOME/libadwaita';
const HIG_PROJECT = 'Teams/Design/hig-www';
const SHELL_PROJECT = 'GNOME/gnome-shell';
/** The sources of GNOME Shell's notification banner that the in-app notification follows. */
const SHELL_BANNER_SOURCES = Object.freeze([
    'js/ui/messageTray.js',
    'js/ui/messageList.js',
    'data/theme/gnome-shell-sass/widgets/_notifications.scss',
    'data/theme/gnome-shell-sass/widgets/_message-list.scss',
]);
const REQUEST_TIMEOUT_MS = 20_000;

/** Exit codes: the reference is the recorded one, it has moved, or it could not be read. */
export const EXIT = Object.freeze({ current: 0, moved: 1, unknown: 2 });

function printHelp() {
    console.log(`Usage: node scripts/check-design-reference.js [--json | --markdown]

Compares the reference that DESIGN.md records (a libadwaita release, a commit of the GNOME HIG and,
when the statement names one, a GNOME Shell release) with the latest stable libadwaita tag, the head
of the HIG repository and the latest stable GNOME Shell tag on gitlab.gnome.org.

The Design Reference workflow runs it when staging starts a new development version. It needs the
network, so the test suite never runs it.

Exit codes: ${EXIT.current} the recorded reference is current, ${EXIT.moved} the reference has moved,
${EXIT.unknown} the recorded reference or the remote state could not be read.

Options:
  --json        Print JSON instead of text.
  --markdown    Print Markdown with links and a review checklist, as the workflow's issue body.
  -h, --help`);
}

/**
 * @typedef {object} Reference
 * @property {string | null} libadwaita A stable release such as `1.10.0`.
 * @property {string | null} higCommit A commit id of the HIG repository, in full or shortened.
 * @property {string | null} shell A GNOME Shell release such as `51.1`. A statement that names no release for the Shell has none.
 */

/**
 * Reads the libadwaita release, the HIG commit and the GNOME Shell release out of a reference version statement, such as the
 * "Reference version" line of DESIGN.md or `narrative.referenceVersion` of DESIGN.json.
 * @param {string} text
 * @returns {Reference}
 */
export function parseRecordedReference(text) {
    const libadwaita = /libadwaita\s+(\d+\.\d+\.\d+)/i.exec(text);
    const higCommit = /HIG[^`\n]*commit\s+`([0-9a-f]{7,40})`/i.exec(text);
    const shell = /GNOME\s+Shell\s+(\d+\.\d+)(?!\.?\d)/i.exec(text);
    return { libadwaita: libadwaita ? libadwaita[1] : null, higCommit: higCommit ? higCommit[1] : null, shell: shell ? shell[1] : null };
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
 * The newest stable release among the tag names of GNOME Shell. A release is `major.point`, such as `51.1`, and every cycle has
 * snapshots (`51.alpha`, `51.beta`, `51.rc`). The tags of an older cycle that still gets point releases are older by number.
 * @param {readonly string[]} tagNames
 * @returns {string | null}
 */
export function latestStableShellTag(tagNames) {
    const stable = tagNames.filter(name => /^\d+\.\d+$/.test(name));
    return stable.length ? stable.sort(compareVersions).at(-1) : null;
}

/**
 * GNOME Shell is compared only when the recorded statement names a release for it, so a document that does not follow the Shell
 * yet is not reported as unreadable.
 * @param {Reference} recorded
 * @param {Reference} remote
 * @returns {{ status: keyof typeof EXIT, libadwaitaMoved: boolean, higMoved: boolean, shellMoved: boolean }}
 */
export function compareReference(recorded, remote) {
    const shellTracked = Boolean(recorded.shell);
    if (!recorded.libadwaita || !recorded.higCommit || !remote.libadwaita || !remote.higCommit || (shellTracked && !remote.shell)) {
        return { status: 'unknown', libadwaitaMoved: false, higMoved: false, shellMoved: false };
    }
    const libadwaitaMoved = compareVersions(remote.libadwaita, recorded.libadwaita) > 0;
    // The document records a short commit id, so the remote id is compared by that prefix.
    const higMoved = !remote.higCommit.startsWith(recorded.higCommit);
    const shellMoved = shellTracked && compareVersions(remote.shell, recorded.shell) > 0;
    return { status: libadwaitaMoved || higMoved || shellMoved ? 'moved' : 'current', libadwaitaMoved, higMoved, shellMoved };
}

async function fetchJson(url) {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
    }
    return response.json();
}

/** @param {{ includeShell: boolean }} options The Shell is read only when DESIGN.md follows it, so its tags cannot make the check fail otherwise. */
async function readRemoteReference({ includeShell }) {
    const tags = await fetchJson(`${GITLAB_API}/${encodeURIComponent(LIBADWAITA_PROJECT)}/repository/tags?per_page=100`);
    const commits = await fetchJson(`${GITLAB_API}/${encodeURIComponent(HIG_PROJECT)}/repository/commits?per_page=1`);
    // GNOME Shell has hundreds of tags, and the newest are the ones that were updated last, which the first page lists.
    const shellTags = includeShell ? await fetchJson(`${GITLAB_API}/${encodeURIComponent(SHELL_PROJECT)}/repository/tags?per_page=100`) : [];
    return {
        libadwaita: latestStableTag(tags.map(tag => tag.name)),
        higCommit: commits[0]?.id ?? null,
        higDate: commits[0]?.committed_date?.slice(0, 10) ?? null,
        shell: includeShell ? latestStableShellTag(shellTags.map(tag => tag.name)) : null,
    };
}

const SHELL_NOT_COMPARED = 'DESIGN.md records no GNOME Shell release, so the Shell is not compared.';

/**
 * @param {Reference} recorded
 * @param {Reference & { higDate?: string | null }} remote
 * @param {ReturnType<typeof compareReference>} comparison
 * @returns {string}
 */
export function formatReport(recorded, remote, comparison) {
    const shellTracked = Boolean(recorded.shell);
    const lines = [
        `Recorded in DESIGN.md: libadwaita ${recorded.libadwaita ?? 'not found'}; HIG commit ${recorded.higCommit ?? 'not found'}; GNOME Shell ${recorded.shell ?? 'not recorded'}`,
        `On gitlab.gnome.org:   libadwaita ${remote.libadwaita ?? 'not found'}; HIG commit ${remote.higCommit?.slice(0, 12) ?? 'not found'}${remote.higDate ? ` (${remote.higDate})` : ''}${shellTracked ? `; GNOME Shell ${remote.shell ?? 'not found'}` : ''}`,
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
            lines.push(`The HIG has commits after ${recorded.higCommit}. Read the log of ${HIG_PROJECT.split('/').at(-1)} since that commit.`);
        }
        if (comparison.shellMoved) {
            lines.push(`GNOME Shell has a newer stable release (${remote.shell}). Read the diff of ${SHELL_BANNER_SOURCES.join(', ')} since ${recorded.shell}.`);
        }
        lines.push('Review the changed rules in DESIGN.md and DESIGN.json, then update the reference version line of both.');
    }
    if (comparison.status !== 'unknown' && !shellTracked) {
        lines.push(SHELL_NOT_COMPARED);
    }
    return lines.join('\n');
}

const REVIEW_CHECKLIST = Object.freeze([
    'Read what changed: the NEWS of each new libadwaita release and the diff of `src/stylesheet/`; the diff of each HIG page under `source/`; the diff of the banner sources of GNOME Shell that its line names.',
    'For each change, find the rules of `DESIGN.md` and `DESIGN.json` that it touches, by value, by class or widget name, and by HIG page.',
    'A stated deviation whose "Review when" condition has come true goes to the maintainers, with the new reference text, the rule, and what the code does.',
    'A value that now differs from the reference without a stated deviation is corrected where the rule says "as libadwaita"; otherwise it goes to the maintainers.',
    'A new widget or HIG page is written into the documents as a pattern.',
    'Both documents change together, keep the deviation form, and name no feature of the application (`tests/unit/design-documents-generality.test.js`).',
    'A changed value is carried into the parity rules (`tests/helpers/parity/`) and the stylesheets, or recorded as work.',
    'The reference version line of both documents names the new libadwaita release, HIG commit and GNOME Shell release.',
]);

/**
 * The Markdown that the Design Reference workflow writes to its summary, and to an issue when the reference has moved.
 * @param {Reference} recorded
 * @param {Reference & { higDate?: string | null }} remote
 * @param {ReturnType<typeof compareReference>} comparison
 * @returns {string}
 */
export function formatMarkdown(recorded, remote, comparison) {
    const code = value => (value ? `\`${value}\`` : 'not found');
    const shellTracked = Boolean(recorded.shell);
    const lines = [
        '| | Recorded in `DESIGN.md` | Latest on gitlab.gnome.org |',
        '|---|---|---|',
        `| libadwaita | ${code(recorded.libadwaita)} | ${code(remote.libadwaita)} |`,
        `| GNOME HIG | ${code(recorded.higCommit)} | ${code(remote.higCommit?.slice(0, 12))}${remote.higDate ? ` (${remote.higDate})` : ''} |`,
        ...(shellTracked ? [`| GNOME Shell | ${code(recorded.shell)} | ${code(remote.shell)} |`] : []),
        '',
    ];
    if (comparison.status === 'unknown') {
        lines.push('The two could not be compared. `DESIGN.md` needs a reference version line that names a libadwaita release and a HIG commit, and gitlab.gnome.org has to answer, for the GNOME Shell too when the line names a Shell release.');
        return lines.join('\n');
    }
    if (comparison.status === 'current') {
        lines.push('The recorded reference is current.');
        if (!shellTracked) {
            lines.push('', SHELL_NOT_COMPARED);
        }
        return lines.join('\n');
    }
    if (comparison.libadwaitaMoved) {
        const libadwaita = `${GITLAB}/${LIBADWAITA_PROJECT}`;
        lines.push(`- libadwaita: [NEWS of ${remote.libadwaita}](${libadwaita}/-/blob/${remote.libadwaita}/NEWS), [changes from ${recorded.libadwaita} to ${remote.libadwaita}](${libadwaita}/-/compare/${recorded.libadwaita}...${remote.libadwaita})`);
    }
    if (comparison.higMoved) {
        lines.push(`- GNOME HIG: [changes since \`${recorded.higCommit}\`](${GITLAB}/${HIG_PROJECT}/-/compare/${recorded.higCommit}...${remote.higCommit})`);
    }
    if (comparison.shellMoved) {
        const shell = `${GITLAB}/${SHELL_PROJECT}`;
        lines.push(`- GNOME Shell: [NEWS of ${remote.shell}](${shell}/-/blob/${remote.shell}/NEWS), [changes from ${recorded.shell} to ${remote.shell}](${shell}/-/compare/${recorded.shell}...${remote.shell}); read ${SHELL_BANNER_SOURCES.map(source => `\`${source}\``).join(', ')}`);
    }
    lines.push('', '### Review', '', ...REVIEW_CHECKLIST.map(step => `- [ ] ${step}`));
    return lines.join('\n');
}

async function runCli(argv = process.argv.slice(2)) {
    if (argv.includes('--help') || argv.includes('-h')) {
        printHelp();
        return;
    }
    const recorded = parseRecordedReference(readReferenceLine());
    let remote = { libadwaita: null, higCommit: null, higDate: null, shell: null };
    try {
        remote = await readRemoteReference({ includeShell: Boolean(recorded.shell) });
    } catch (error) {
        console.error(`The remote reference could not be read: ${error.message}`);
    }
    const comparison = compareReference(recorded, remote);
    if (argv.includes('--json')) {
        console.log(JSON.stringify({ recorded, remote, ...comparison }, null, 2));
    } else if (argv.includes('--markdown')) {
        console.log(formatMarkdown(recorded, remote, comparison));
    } else {
        console.log(formatReport(recorded, remote, comparison));
    }
    process.exitCode = EXIT[comparison.status];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runCli();
}
