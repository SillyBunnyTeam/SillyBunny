import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { approvedName, sha256 } from './log.mjs';

const MIN_HASH_PREFIX = 8;

const toLogPath = (rootDir, path) => relative(rootDir, path).split(sep).join('/');

/**
 * Finds the single logged output a target names. A target is a file path (from the working
 * directory or the package root) or a sha256, in full or as a prefix of at least 8 hex digits.
 */
function findOutput(entries, rootDir, target) {
    const matches = [];
    const absolute = isAbsolute(target) || existsSync(target) ? resolve(target) : resolve(rootDir, target);
    const asPath = target ? toLogPath(rootDir, absolute) : '';
    const isHash = new RegExp(`^[0-9a-f]{${MIN_HASH_PREFIX},64}$`, 'i').test(target);
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
    if (matches.length > 1) {
        throw new Error(`"${target}" matches more than one logged file (${matches.map((m) => m.output.file).join(', ')}). Use the file path.`);
    }
    return matches[0];
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
        const destinations = ['approved', ...(ref ? ['refs'] : [])].map((folder) => join(rootDir, folder, approvedName(output)));
        for (const destination of destinations) {
            if (existsSync(destination) && sha256(readFileSync(destination)) !== output.sha256) {
                throw new Error(`${toLogPath(rootDir, destination)} already exists with different content.`);
            }
        }
        return { entry, output, source, destinations };
    });

    const summary = plan.map(({ output, destinations }) => ({
        file: output.file,
        sha256: output.sha256,
        copiedTo: destinations.map((destination) => toLogPath(rootDir, destination)),
    }));
    if (dryRun) {
        return summary;
    }

    for (const { entry, output, source, destinations } of plan) {
        for (const destination of destinations) {
            mkdirSync(join(destination, '..'), { recursive: true });
            copyFileSync(source, destination);
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
 * Every check runs before anything is changed.
 * @param {{ rootDir: string, newTarget: string, dryRun?: boolean }} request
 */
export function revertSupersede({ rootDir, newTarget, dryRun = false }) {
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
    if (replaced.length > 1) {
        throw new Error(`${replaced.length} outputs were superseded by ${replacement.output.file} (${replaced.map(({ output }) => output.file).join(', ')}). Revert is only for one.`);
    }
    const [old] = replaced;
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
