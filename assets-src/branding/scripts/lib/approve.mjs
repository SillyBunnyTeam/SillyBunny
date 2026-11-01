import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sha256 } from './log.mjs';

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
        if (output.superseded) {
            throw new Error(`${output.file} was superseded by ${output.superseded.slice(0, 16)} and cannot be approved again.`);
        }
        const source = resolve(rootDir, output.file);
        if (!source.startsWith(rootDir + sep)) {
            throw new Error(`${output.file} points outside the package.`);
        }
        if (!existsSync(source)) {
            throw new Error(`${output.file} is missing on disk.`);
        }
        if (sha256(readFileSync(source)) !== output.sha256) {
            throw new Error(`${output.file}: sha256 does not match the log. Refusing to approve a file that is not the one that was generated.`);
        }
        const destinations = ['approved', ...(ref ? ['refs'] : [])].map((folder) => join(rootDir, folder, basename(output.file)));
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
 * new sha256, and its copies leave approved/ and refs/. Every check runs before anything is changed.
 * @param {{ rootDir: string, oldTarget: string, newTarget: string, dryRun?: boolean }} request
 */
export function supersedeOutput({ rootDir, oldTarget, newTarget, dryRun = false }) {
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
    if (!replacement.output.approved) {
        throw new Error(`${replacement.output.file} is not approved yet. Approve it first, then supersede the old one.`);
    }

    const copies = ['approved', 'refs'].map((folder) => join(rootDir, folder, basename(old.output.file))).filter((path) => existsSync(path));
    for (const copy of copies) {
        if (sha256(readFileSync(copy)) !== old.output.sha256) {
            throw new Error(`${toLogPath(rootDir, copy)} is not the approved file ${old.output.file}, so it will not be deleted.`);
        }
    }

    const summary = {
        old: { file: old.output.file, sha256: old.output.sha256 },
        new: { file: replacement.output.file, sha256: replacement.output.sha256 },
        removed: copies.map((copy) => toLogPath(rootDir, copy)),
    };
    if (dryRun) {
        return summary;
    }
    old.output.superseded = replacement.output.sha256;
    writeLogLines(logPath, log, [old.entry]);
    for (const copy of copies) {
        unlinkSync(copy);
    }
    return summary;
}
