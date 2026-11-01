import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { approvedName, sha256 } from './log.mjs';

const MIN_HASH_PREFIX = 8;

const toLogPath = (rootDir, path) => relative(rootDir, path).split(sep).join('/');

const PIXEL_SNAP = 'pixel-snap';

/** A snapped still, or a scene composed on the pixel grid: art that is kept apart from the smooth masters, under approved/pixel/. */
const isPixelArt = (entry) => entry.template === PIXEL_SNAP || (entry.template === 'compose-scene' && entry.vars?.grid !== undefined);

/**
 * Where an output's approved copy goes. Pixel art is kept under approved/pixel/, a snap by the id of the picture it came from and a grid
 * scene by its own file name, so it can never take the name of a smooth master and both stay approved side by side.
 */
function approvalName(entry, output) {
    if (output.approvedAs || !isPixelArt(entry)) {
        return approvedName(output);
    }
    if (entry.template === PIXEL_SNAP) {
        if (typeof entry.vars?.id !== 'string' || !/^[\w-]+$/.test(entry.vars.id)) {
            throw new Error(`${output.file} is a pixel snap without a usable id in its log entry, so the name it is approved under is unknown.`);
        }
        return `pixel/${entry.vars.id}.png`;
    }
    return `pixel/${basename(output.file)}`;
}

/**
 * Finds the one logged output a target names. A target is a file path (from the working directory or the package root) or a sha256, in
 * full or as a prefix of at least 8 hex digits.
 *
 * A file that was written again under the same path (a re-run) is logged more than once. For a path, the entries whose sha256 is the file's
 * current one are the candidates: an older entry of the same path with a different sha is the old picture and is never picked. For a
 * sha256, the candidates are the entries with that sha256. When several candidates are left, they are identical re-runs of one file and the
 * latest is taken; the earlier entries are not touched. Candidates that are different files, or a prefix that starts more than one
 * sha256, are ambiguous.
 */
function findOutput(entries, rootDir, target) {
    const absolute = isAbsolute(target) || existsSync(target) ? resolve(target) : resolve(rootDir, target);
    const asPath = target ? toLogPath(rootDir, absolute) : '';
    const isHash = new RegExp(`^[0-9a-f]{${MIN_HASH_PREFIX},64}$`, 'i').test(target);
    const matches = [];
    for (const entry of entries) {
        for (const output of entry.outputs ?? []) {
            if (output.file === asPath || (isHash && output.sha256.startsWith(target.toLowerCase()))) {
                matches.push({ entry, output });
            }
        }
    }
    if (matches.length === 0) {
        throw new Error(`"${target}" is not in the log.`);
    }
    const byPath = matches.some(({ output }) => output.file === asPath);
    const candidates = byPath ? currentFileEntries(matches, rootDir, target, asPath) : matches;

    const hashes = [...new Set(candidates.map(({ output }) => output.sha256))];
    if (hashes.length > 1) {
        throw new Error(`"${target}" is the start of more than one sha256 (${hashes.map((hash) => hash.slice(0, 16)).join(', ')}). Give more digits, or the file path.`);
    }
    const files = [...new Set(candidates.map(({ output }) => output.file))];
    if (files.length > 1) {
        throw new Error(`"${target}" matches more than one logged file (${files.join(', ')}). Use the file path of the one you mean.`);
    }
    return candidates.at(-1);
}

/**
 * The entries of a path that logged the file as it is now. With one entry it is returned as it is, so the usual checks name what is
 * wrong with it; with several, a file that is missing or is none of them cannot be told from the rest, and that is said.
 */
function currentFileEntries(matches, rootDir, target, asPath) {
    const logged = matches.filter(({ output }) => output.file === asPath);
    if (logged.length === 1) {
        return logged;
    }
    const source = resolve(rootDir, asPath);
    if (!existsSync(source)) {
        throw new Error(`"${target}" is logged ${logged.length} times and the file is missing on disk, so the entry to approve cannot be told.`);
    }
    const current = sha256(readFileSync(source));
    const same = logged.filter(({ output }) => output.sha256 === current);
    if (same.length === 0) {
        throw new Error(`"${target}" is logged ${logged.length} times, and the file on disk (sha256 ${current.slice(0, 16)}) is none of them (${[...new Set(logged.map(({ output }) => output.sha256.slice(0, 16)))].join(', ')}): it was changed after it was logged. Refusing to approve a file that is not one that was generated.`);
    }
    return same;
}

function readLogLines(logPath) {
    const lines = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n') : [];
    const parsed = lines.map((line) => (line.trim() ? JSON.parse(line) : undefined));
    return { lines, parsed, entries: parsed.filter(Boolean) };
}

/** Rewrites only the lines of the changed entries, so hand-formatted lines stay as they were. */
function writeLogLines(logPath, { lines, parsed }, changedEntries) {
    const rewritten = lines.map((line, index) => (parsed[index] && changedEntries.includes(parsed[index]) ? JSON.stringify(parsed[index]) : line));
    const temporary = `${logPath}.tmp`;
    writeFileSync(temporary, rewritten.join('\n'));
    renameSync(temporary, logPath);
}

/**
 * The checks on a logged file before it is copied anywhere: it lies inside the package, exists, and has the sha256 the log
 * recorded. `action` completes "Refusing to ...". Returns the file's absolute path.
 */
function loggedFile(rootDir, output, action) {
    const source = resolve(rootDir, output.file);
    if (!source.startsWith(rootDir + sep)) {
        throw new Error(`${output.file} points outside the package.`);
    }
    if (!existsSync(source)) {
        throw new Error(`${output.file} is missing on disk.`);
    }
    if (sha256(readFileSync(source)) !== output.sha256) {
        throw new Error(`${output.file}: sha256 does not match the log. Refusing to ${action} a file that is not the one that was generated.`);
    }
    return source;
}

/** The checks every approval starts with: the output is not superseded, and its file is the logged one. */
function approvableSource(rootDir, output) {
    if (output.superseded) {
        throw new Error(`${output.file} was superseded by ${output.superseded.slice(0, 16)} and cannot be approved again.`);
    }
    return loggedFile(rootDir, output, 'approve');
}

/**
 * Marks outputs approved and copies them. Every target is checked first (it is in the log, the file exists,
 * its sha256 is the logged one, no different file is in the way); only then is anything written.
 * With `dryRun` it runs every check and reports what it would do, and writes nothing.
 * @param {{ rootDir: string, targets: string[], ref: boolean, dryRun?: boolean }} request
 */
export function approveOutputs({ rootDir, targets, ref, dryRun = false }) {
    const logPath = join(rootDir, 'log', 'generations.jsonl');
    const log = readLogLines(logPath);

    const plan = targets.map((target) => {
        const { entry, output } = findOutput(log.entries, rootDir, target);
        const source = approvableSource(rootDir, output);
        const name = approvalName(entry, output);
        const destinations = ['approved', ...(ref ? ['refs'] : [])].map((folder) => join(rootDir, folder, name));
        for (const destination of destinations) {
            if (existsSync(destination) && sha256(readFileSync(destination)) !== output.sha256) {
                throw new Error(`${toLogPath(rootDir, destination)} already exists with different content.${isPixelArt(entry) ? ' To replace approved pixel art, use --supersede <old> --by <new> --in-place.' : ''}`);
            }
        }
        return { entry, output, source, destinations, name };
    });

    const summary = plan.map(({ output, destinations }) => ({
        file: output.file,
        sha256: output.sha256,
        copiedTo: destinations.map((destination) => toLogPath(rootDir, destination)),
    }));
    if (dryRun) {
        return summary;
    }

    for (const { entry, output, source, destinations, name } of plan) {
        for (const destination of destinations) {
            mkdirSync(join(destination, '..'), { recursive: true });
            copyFileSync(source, destination);
        }
        if (name !== approvedName(output)) {
            output.approvedAs = name;
        }
        output.approved = true;
        entry.approved = true;
    }
    writeLogLines(logPath, log, plan.map(({ entry }) => entry));
    return summary;
}

/**
 * Replaces an approved output with a newer approved one. The old output stays in the log, marked with the
 * new sha256. Every check runs before anything is changed.
 *
 * By default the old output's copies leave approved/ and refs/. With `inPlace` the new output is approved first
 * when it is not yet, and its bytes are written under the old output's copy names, so files that point at those
 * names keep working. The new output's entry records that name as `approvedAs`.
 * @param {{ rootDir: string, oldTarget: string, newTarget: string, inPlace?: boolean, dryRun?: boolean }} request
 */
export function supersedeOutput({ rootDir, oldTarget, newTarget, inPlace = false, dryRun = false }) {
    const logPath = join(rootDir, 'log', 'generations.jsonl');
    const log = readLogLines(logPath);
    const old = findOutput(log.entries, rootDir, oldTarget);
    const replacement = findOutput(log.entries, rootDir, newTarget);

    if (old.output.sha256 === replacement.output.sha256) {
        throw new Error(`${old.output.file} and ${replacement.output.file} are the same image; an output cannot replace itself.`);
    }
    if (old.output.superseded) {
        throw new Error(`${old.output.file} is already superseded by ${old.output.superseded.slice(0, 16)}.`);
    }
    if (!old.output.approved) {
        throw new Error(`${old.output.file} is not approved, so there is nothing to supersede.`);
    }
    if (replacement.output.superseded) {
        throw new Error(`${replacement.output.file} is superseded and cannot replace anything.`);
    }
    if (isPixelArt(replacement.entry) && !isPixelArt(old.entry)) {
        throw new Error(`${replacement.output.file} is pixel art and ${old.output.file} is not. A snap never replaces approved art; both stay approved.`);
    }
    if (!inPlace && !replacement.output.approved) {
        throw new Error(`${replacement.output.file} is not approved yet. Approve it first, then supersede the old one, or pass --in-place to do both.`);
    }

    const copyName = approvedName(old.output);
    const copies = ['approved', 'refs'].map((folder) => join(rootDir, folder, copyName)).filter((path) => existsSync(path));
    for (const copy of copies) {
        if (sha256(readFileSync(copy)) !== old.output.sha256) {
            throw new Error(`${toLogPath(rootDir, copy)} is not the approved file ${old.output.file}, so it will not be ${inPlace ? 'overwritten' : 'deleted'}.`);
        }
    }

    const summary = {
        old: { file: old.output.file, sha256: old.output.sha256 },
        new: { file: replacement.output.file, sha256: replacement.output.sha256 },
        removed: inPlace ? [] : copies.map((copy) => toLogPath(rootDir, copy)),
        written: inPlace ? copies.map((copy) => toLogPath(rootDir, copy)) : [],
        approvedNew: inPlace && !replacement.output.approved,
    };
    const newSource = inPlace ? checkedInPlaceSource({ rootDir, old, replacement, copyName, copies }) : undefined;
    if (dryRun) {
        return summary;
    }

    old.output.superseded = replacement.output.sha256;
    if (!inPlace) {
        writeLogLines(logPath, log, [old.entry]);
        for (const copy of copies) {
            unlinkSync(copy);
        }
        return summary;
    }
    const bytes = readFileSync(newSource);
    for (const copy of copies) {
        copyOver(copy, bytes);
    }
    replacement.output.approved = true;
    replacement.output.approvedAs = copyName;
    replacement.entry.approved = true;
    writeLogLines(logPath, log, [old.entry, replacement.entry]);
    return summary;
}

/** The checks only --in-place needs. Returns the path of the file whose bytes take over the old copies. */
function checkedInPlaceSource({ rootDir, old, replacement, copyName, copies }) {
    const takenName = approvedName(replacement.output);
    if (replacement.output.approved && takenName !== copyName) {
        throw new Error(`${replacement.output.file} is already approved as ${takenName}, so it cannot also take over ${copyName}.`);
    }
    if (!copies.includes(join(rootDir, 'approved', copyName))) {
        throw new Error(`approved/${copyName} is missing, so it is not the approved file ${old.output.file} and will not be replaced.`);
    }
    return approvableSource(rootDir, replacement.output);
}

/** Replaces a file through a temporary neighbour, so a reader never sees half of the new bytes. */
function copyOver(destination, bytes) {
    const temporary = `${destination}.tmp`;
    writeFileSync(temporary, bytes);
    renameSync(temporary, destination);
}

/**
 * Undoes a supersede: the output that `<new>` superseded is approved again and `<new>` is superseded by it, which keeps `<new>`
 * in the log as history. The old bytes go back under the approved name in every folder where `<new>` has a copy. When `<new>`
 * took over the old name (`--in-place`) they replace its bytes there; when it lived under its own name, its copies are removed.
 * When several outputs were superseded by `<new>` (a chain of supersedes on one slot, reverted step by step), `toTarget` picks the one
 * to restore; the others keep their `superseded` as history. Every check runs before anything is changed.
 * @param {{ rootDir: string, newTarget: string, toTarget?: string, dryRun?: boolean }} request
 */
export function revertSupersede({ rootDir, newTarget, toTarget, dryRun = false }) {
    const logPath = join(rootDir, 'log', 'generations.jsonl');
    const log = readLogLines(logPath);
    const replacement = findOutput(log.entries, rootDir, newTarget);
    if (!replacement.output.approved) {
        throw new Error(`${replacement.output.file} is not approved, so there is nothing to revert.`);
    }
    if (replacement.output.superseded) {
        throw new Error(`${replacement.output.file} is superseded by ${replacement.output.superseded.slice(0, 16)}, so it is not a current approval and cannot be reverted.`);
    }
    const replaced = log.entries.flatMap((entry) => (entry.outputs ?? []).map((output) => ({ entry, output })))
        .filter(({ output }) => output.superseded === replacement.output.sha256);
    if (replaced.length === 0) {
        throw new Error(`Nothing was superseded by ${replacement.output.file}, so there is nothing to revert.`);
    }
    const candidates = replaced.map(({ output }) => output.file).join(', ');
    if (toTarget === undefined && replaced.length > 1) {
        throw new Error(`${replaced.length} outputs were superseded by ${replacement.output.file} (${candidates}). Pass --to <file-or-sha256> with one of them to say which to restore.`);
    }
    const old = toTarget === undefined ? replaced[0] : replaced.find(({ output }) => output === findOutput(log.entries, rootDir, toTarget).output);
    if (!old) {
        throw new Error(`${toTarget} is not one of the outputs superseded by ${replacement.output.file}. Candidates: ${candidates}.`);
    }
    const oldSource = loggedFile(rootDir, old.output, 'restore');

    const newName = approvedName(replacement.output);
    const oldName = approvedName(old.output);
    const newCopies = ['approved', 'refs'].map((folder) => ({ folder, path: join(rootDir, folder, newName) })).filter(({ path }) => existsSync(path));
    if (!newCopies.some(({ folder }) => folder === 'approved')) {
        throw new Error(`approved/${newName} is missing, so it is not the approved file ${replacement.output.file} and will not be replaced.`);
    }
    for (const { path } of newCopies) {
        if (sha256(readFileSync(path)) !== replacement.output.sha256) {
            throw new Error(`${toLogPath(rootDir, path)} is not the approved file ${replacement.output.file}, so it will not be ${newName === oldName ? 'overwritten' : 'deleted'}.`);
        }
    }
    const restoreTo = newCopies.map(({ folder }) => join(rootDir, folder, oldName));
    if (newName !== oldName) {
        for (const destination of restoreTo.filter((path) => existsSync(path))) {
            if (sha256(readFileSync(destination)) !== old.output.sha256) {
                throw new Error(`${toLogPath(rootDir, destination)} already exists with different content.`);
            }
        }
    }

    const summary = {
        old: { file: old.output.file, sha256: old.output.sha256 },
        new: { file: replacement.output.file, sha256: replacement.output.sha256 },
        restored: restoreTo.map((path) => toLogPath(rootDir, path)),
        removed: newName === oldName ? [] : newCopies.map(({ path }) => toLogPath(rootDir, path)),
    };
    if (dryRun) {
        return summary;
    }

    const bytes = readFileSync(oldSource);
    for (const destination of restoreTo) {
        copyOver(destination, bytes);
    }
    delete old.output.superseded;
    old.output.approved = true;
    old.entry.approved = true;
    replacement.output.superseded = old.output.sha256;
    writeLogLines(logPath, log, [old.entry, replacement.entry]);
    for (const path of summary.removed) {
        unlinkSync(join(rootDir, path));
    }
    return summary;
}
