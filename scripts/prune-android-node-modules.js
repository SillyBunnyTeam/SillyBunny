#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const NON_RUNTIME_DIR_NAMES = Object.freeze(new Set([
    'docs',
    'test',
    'tests',
    '__tests__',
    'example',
    'examples',
]));

export const DUPLICATE_ORT_WASM_FILES = Object.freeze([
    'ort-wasm.wasm',
    'ort-wasm-simd.wasm',
    'ort-wasm-threaded.wasm',
    'ort-wasm-simd-threaded.wasm',
]);

export const VERIFIED_UNUSED_PACKAGES = Object.freeze([
    'html2canvas',
    'archiver',
]);

const STRIP_FILE_RE = /\.(?:map|d\.(?:ts|mts|cts))$/i;

/**
 * Checks whether a filename is legally or structurally protected and must never be removed during pruning.
 * @param {string} filename Basename of the file.
 * @returns {boolean} True when the file must be preserved.
 */
export function isProtectedFileName(filename) {
    const lower = filename.toLowerCase();
    return lower === 'package.json'
        || lower.startsWith('license')
        || lower.startsWith('notice');
}

/**
 * Checks whether a file should be removed purely by its extension (source maps and TypeScript declarations).
 * @param {string} filename Basename of the file.
 * @returns {boolean} True when the file matches a strippable non-runtime extension.
 */
export function isStrippableArtifactFile(filename) {
    return !isProtectedFileName(filename) && STRIP_FILE_RE.test(filename);
}

/**
 * Verifies that `sillytavern-transformers/dist` holds all 4 active ONNX Runtime WASM binaries
 * referenced by `src/transformers.js:17`, making the duplicate copies in `onnxruntime-web/dist` safe to strip.
 * @param {string} nodeModulesDir Path to `node_modules`.
 * @returns {boolean} True only when every active WASM file exists as a non-empty regular file.
 */
export function hasActiveTransformersWasms(nodeModulesDir) {
    const activeDistDir = path.join(nodeModulesDir, 'sillytavern-transformers', 'dist');

    for (const wasmFile of DUPLICATE_ORT_WASM_FILES) {
        const activePath = path.join(activeDistDir, wasmFile);
        let stat;
        try {
            stat = fs.lstatSync(activePath);
        } catch {
            return false;
        }

        if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
            return false;
        }
    }

    return true;
}

/**
 * Reads a package's runtime entry metadata to avoid stripping a directory referenced by `main`/`exports`/`bin`.
 * @param {string} packageDir Root directory of an installed npm package.
 * @returns {Set<string>} Set of top-level directory names referenced by runtime entry fields.
 */
function getReferencedPackageDirs(packageDir) {
    const referenced = new Set();
    const pkgJsonPath = path.join(packageDir, 'package.json');

    if (!fs.existsSync(pkgJsonPath)) {
        return referenced;
    }

    try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        const serialized = JSON.stringify({
            main: pkg.main,
            module: pkg.module,
            browser: pkg.browser,
            bin: pkg.bin,
            exports: pkg.exports,
            imports: pkg.imports,
        }) ?? '';

        for (const dirName of NON_RUNTIME_DIR_NAMES) {
            const pattern = new RegExp(`["./]${dirName}/`, 'i');
            if (pattern.test(serialized)) {
                referenced.add(dirName);
            }
        }
    } catch {
        // Ignore malformed package.json files.
    }

    return referenced;
}

/**
 * Counts and optionally deletes a single regular file.
 * @param {string} filePath Absolute file path.
 * @param {boolean} dryRun When true, does not mutate the filesystem.
 * @param {{ removedFiles: number, savedBytes: number }} stats Mutable counters.
 * @returns {boolean} True when the file was counted/removed.
 */
function removeFile(filePath, dryRun, stats) {
    let stat;
    try {
        stat = fs.lstatSync(filePath);
    } catch {
        return false;
    }

    if (stat.isSymbolicLink() || !stat.isFile()) {
        return false;
    }

    stats.removedFiles += 1;
    stats.savedBytes += stat.size;

    if (!dryRun) {
        fs.unlinkSync(filePath);
    }
    return true;
}

/**
 * Removes all non-protected files inside a non-runtime directory (docs/test/tests/__tests__/example/examples)
 * and deletes subdirectories only when they become empty.
 * @param {string} dirPath Directory to prune.
 * @param {boolean} dryRun When true, computes exact savings without modifying disk.
 * @param {{ removedFiles: number, removedDirectories: number, savedBytes: number }} stats Mutable counters.
 * @returns {boolean} True when no entries remain in `dirPath` (so parent may remove it).
 */
function pruneNonRuntimeDirectory(dirPath, dryRun, stats) {
    let dirents;
    try {
        dirents = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
        return false;
    }

    let keptAnyEntry = false;

    for (const dirent of dirents) {
        const fullPath = path.join(dirPath, dirent.name);

        if (dirent.isSymbolicLink()) {
            keptAnyEntry = true;
            continue;
        }

        if (dirent.isDirectory()) {
            const emptied = pruneNonRuntimeDirectory(fullPath, dryRun, stats);
            if (!emptied) {
                keptAnyEntry = true;
            }
            continue;
        }

        if (dirent.isFile()) {
            if (isProtectedFileName(dirent.name)) {
                keptAnyEntry = true;
                continue;
            }
            removeFile(fullPath, dryRun, stats);
            continue;
        }

        keptAnyEntry = true;
    }

    if (!keptAnyEntry) {
        stats.removedDirectories += 1;
        if (!dryRun) {
            try {
                fs.rmdirSync(dirPath);
            } catch {
                return false;
            }
        }
        return true;
    }

    return false;
}

/**
 * Recursively removes an entire verified-unused package directory while tallying every removed file and byte.
 * @param {string} dirPath Package directory to remove.
 * @param {boolean} dryRun When true, computes exact savings without modifying disk.
 * @param {{ removedFiles: number, removedDirectories: number, savedBytes: number }} stats Mutable counters.
 * @returns {boolean} True when the directory existed and was processed.
 */
function removePackageDirectory(dirPath, dryRun, stats) {
    let rootStat;
    try {
        rootStat = fs.lstatSync(dirPath);
    } catch {
        return false;
    }

    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        return false;
    }

    function tallyTree(currentDir) {
        const dirents = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const dirent of dirents) {
            const fullPath = path.join(currentDir, dirent.name);
            if (dirent.isSymbolicLink()) {
                stats.removedFiles += 1;
                continue;
            }
            if (dirent.isDirectory()) {
                tallyTree(fullPath);
            } else if (dirent.isFile()) {
                const stat = fs.lstatSync(fullPath);
                stats.removedFiles += 1;
                stats.savedBytes += stat.size;
            }
        }
        stats.removedDirectories += 1;
    }

    tallyTree(dirPath);
    if (!dryRun) {
        fs.rmSync(dirPath, { recursive: true, force: true });
    }
    return true;
}

/**
 * Prunes non-runtime artifacts inside a single installed package directory.
 * @param {string} packageDir Installed package root directory.
 * @param {boolean} dryRun Dry-run mode flag.
 * @param {{ removedFiles: number, removedDirectories: number, savedBytes: number }} stats Mutable counters.
 * @returns {void}
 */
function prunePackageTree(packageDir, dryRun, stats) {
    const referencedDirs = getReferencedPackageDirs(packageDir);

    function walk(currentDir, depthInsidePackage) {
        let dirents;
        try {
            dirents = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const dirent of dirents) {
            const fullPath = path.join(currentDir, dirent.name);

            if (dirent.isSymbolicLink()) {
                continue;
            }

            if (dirent.isDirectory()) {
                if (dirent.name === 'node_modules') {
                    pruneNodeModulesContainer(fullPath, dryRun, stats);
                    continue;
                }

                const lowerName = dirent.name.toLowerCase();
                const isReferencedTopLevel = depthInsidePackage === 0 && referencedDirs.has(lowerName);
                if (NON_RUNTIME_DIR_NAMES.has(lowerName) && !isReferencedTopLevel) {
                    pruneNonRuntimeDirectory(fullPath, dryRun, stats);
                    continue;
                }

                walk(fullPath, depthInsidePackage + 1);
                continue;
            }

            if (dirent.isFile() && isStrippableArtifactFile(dirent.name)) {
                removeFile(fullPath, dryRun, stats);
            }
        }
    }

    walk(packageDir, 0);
}

/**
 * Walks a `node_modules` directory, handling scoped `@org/pkg` directories cleanly.
 * @param {string} containerDir Path to a `node_modules` folder.
 * @param {boolean} dryRun Dry-run mode flag.
 * @param {{ removedFiles: number, removedDirectories: number, savedBytes: number }} stats Mutable counters.
 * @param {Set<string>} [skipTopLevelPackages] Package names already removed in this run.
 * @returns {void}
 */
function pruneNodeModulesContainer(containerDir, dryRun, stats, skipTopLevelPackages = new Set()) {
    let dirents;
    try {
        dirents = fs.readdirSync(containerDir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const dirent of dirents) {
        if (dirent.isSymbolicLink() || !dirent.isDirectory()) {
            continue;
        }

        if (dirent.name === '.bin' || dirent.name === '.cache') {
            continue;
        }

        const entryPath = path.join(containerDir, dirent.name);

        if (dirent.name.startsWith('@')) {
            let scopedDirents;
            try {
                scopedDirents = fs.readdirSync(entryPath, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const scoped of scopedDirents) {
                if (scoped.isSymbolicLink() || !scoped.isDirectory()) {
                    continue;
                }
                const scopedPkgName = `${dirent.name}/${scoped.name}`;
                if (skipTopLevelPackages.has(scopedPkgName)) {
                    continue;
                }
                prunePackageTree(path.join(entryPath, scoped.name), dryRun, stats);
            }
            continue;
        }

        if (skipTopLevelPackages.has(dirent.name)) {
            continue;
        }

        prunePackageTree(entryPath, dryRun, stats);
    }
}

/**
 * Performs idempotent zero-feature-loss pruning of `node_modules` for Android/mobile installs.
 * Preserves local AI (`sillytavern-transformers` active WASMs per `src/transformers.js:17`) and all `package.json`/`LICENSE*`/`NOTICE*` files.
 * @param {object} [options] Pruning options.
 * @param {string} [options.nodeModulesDir] Path to `node_modules` (defaults to `<repo>/node_modules`).
 * @param {boolean} [options.dryRun=false] When true, reports savings without deleting any files.
 * @param {boolean} [options.includeUnused=false] When true, also removes `html2canvas` (vendored in `public/lib/`) and optional ZIP64 backup fallback `archiver` (only used when a backup exceeds 4 GiB or 65,535 files).
 * @returns {{ removedFiles: number, removedDirectories: number, savedBytes: number, removedDuplicateWasms: string[], removedUnusedPackages: string[], dryRun: boolean }} Pruning summary.
 */
export function pruneAndroidNodeModules({
    nodeModulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules'),
    dryRun = false,
    includeUnused = false,
} = {}) {
    const resolvedDir = path.resolve(nodeModulesDir);
    const stats = {
        removedFiles: 0,
        removedDirectories: 0,
        savedBytes: 0,
    };
    const removedDuplicateWasms = [];
    const removedUnusedPackages = [];
    const skippedTopLevelPackages = new Set();

    if (!fs.existsSync(resolvedDir)) {
        return {
            ...stats,
            removedDuplicateWasms,
            removedUnusedPackages,
            dryRun: Boolean(dryRun),
        };
    }

    // 1. Optional verified-unused package removal (explicit opt-in flag).
    if (includeUnused) {
        for (const pkgName of VERIFIED_UNUSED_PACKAGES) {
            const pkgPath = path.join(resolvedDir, pkgName);
            if (removePackageDirectory(pkgPath, dryRun, stats)) {
                removedUnusedPackages.push(pkgName);
                skippedTopLevelPackages.add(pkgName);
            }
        }
    }

    // 2. Duplicate onnxruntime-web WASM removal (ONLY when sillytavern-transformers/dist holds all 4 active WASMs).
    if (hasActiveTransformersWasms(resolvedDir)) {
        const duplicateDistDir = path.join(resolvedDir, 'onnxruntime-web', 'dist');
        for (const wasmFile of DUPLICATE_ORT_WASM_FILES) {
            const duplicatePath = path.join(duplicateDistDir, wasmFile);
            if (removeFile(duplicatePath, dryRun, stats)) {
                removedDuplicateWasms.push(wasmFile);
            }
        }
    }

    // 3. Strip source maps, TS declarations, and non-runtime docs/test/example trees across packages.
    pruneNodeModulesContainer(resolvedDir, dryRun, stats, skippedTopLevelPackages);

    return {
        removedFiles: stats.removedFiles,
        removedDirectories: stats.removedDirectories,
        savedBytes: stats.savedBytes,
        removedDuplicateWasms,
        removedUnusedPackages,
        dryRun: Boolean(dryRun),
    };
}

function parseArgs(argv) {
    let nodeModulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');
    let dryRun = false;
    let includeUnused = false;
    let json = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') {
            dryRun = true;
        } else if (arg === '--include-unused') {
            includeUnused = true;
        } else if (arg === '--json') {
            json = true;
        } else if (arg === '--node-modules') {
            const value = argv[i + 1];
            if (!value || value.startsWith('--')) {
                throw new Error('--node-modules requires a directory path.');
            }
            nodeModulesDir = value;
            i++;
        } else if (arg.startsWith('--node-modules=')) {
            nodeModulesDir = arg.slice('--node-modules='.length);
            if (!nodeModulesDir) {
                throw new Error('--node-modules requires a directory path.');
            }
        } else if (arg === '--help' || arg === '-h') {
            console.log('Usage: node scripts/prune-android-node-modules.js [--node-modules <dir>] [--dry-run] [--include-unused] [--json]');
            console.log('  --include-unused  Also remove html2canvas (vendored) and optional archiver ZIP64 fallback (>4 GiB or >65,535 files).');
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return { nodeModulesDir, dryRun, includeUnused, json };
}

function isDirectExecution() {
    if (!process.argv[1]) {
        return false;
    }
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
    try {
        const options = parseArgs(process.argv.slice(2));
        const result = pruneAndroidNodeModules(options);
        if (options.json) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            const savedMb = (result.savedBytes / (1024 * 1024)).toFixed(2);
            const prefix = result.dryRun ? '[dry-run] Would remove' : 'Removed';
            console.log(
                `${prefix} ${result.removedFiles} files (${result.removedDirectories} dirs), saving ${savedMb} MiB (${result.savedBytes} bytes).`,
            );
            if (result.removedDuplicateWasms.length > 0) {
                console.log(`Duplicate ONNX WASMs: ${result.removedDuplicateWasms.join(', ')}`);
            }
            if (result.removedUnusedPackages.length > 0) {
                console.log(`Unused packages: ${result.removedUnusedPackages.join(', ')}`);
            }
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
