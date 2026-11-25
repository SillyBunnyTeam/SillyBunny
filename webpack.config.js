import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import chalk from 'chalk';
import isDocker from 'is-docker';
import { isBunRuntime, isNativeTermuxEnvironment } from './src/runtime.js';
import { serverDirectory } from './src/server-directory.js';

const color = chalk;
const moduleRequire = createRequire(import.meta.url);

const BUN_LIB_BUNDLE_SIGNATURE = 'bun-no-minify-v1';
const PUBLIC_LIB_CONFIG_SIGNATURE = 'chevrotain-esm-alias-moment-locales-v2';
const WEBPACK_CACHE_KEEP_COUNT = 3;
const PUBLIC_LIB_FILENAME = 'lib.js';
const FALLBACK_UI_MOMENT_LOCALES = [
    'ar-sa', 'ar', 'zh-cn', 'zh-tw', 'zh', 'nl', 'de', 'fr',
    'is', 'it', 'ja', 'ko', 'pt', 'ru', 'es', 'uk', 'vi', 'th',
];

function readJsonVersion(filePath, fallback) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return typeof parsed?.version === 'string' && parsed.version ? parsed.version : fallback;
    } catch {
        return fallback;
    }
}

function findPackageJsonFromEntry(entryPath) {
    let dir = path.dirname(entryPath);
    for (let depth = 0; depth < 6; depth++) {
        const candidate = path.join(dir, 'package.json');
        if (fs.existsSync(candidate)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
                if (parsed?.name === 'webpack') {
                    return candidate;
                }
            } catch {
                // Continue walking upward when a package.json cannot be parsed.
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return null;
}

function resolveWebpackPackageJsonFile(baseRequire = moduleRequire) {
    try {
        return baseRequire.resolve('webpack/package.json');
    } catch {
        // Fall back to resolving webpack's main entry if exports restrict ./package.json.
    }

    try {
        const mainEntry = baseRequire.resolve('webpack');
        const found = findPackageJsonFromEntry(mainEntry);
        if (found) {
            return found;
        }
    } catch {
        // Fall back to serverDirectory lookup below.
    }

    return null;
}

function resolveWebpackPackageJsonPath() {
    const directPath = path.join(serverDirectory, 'node_modules', 'webpack', 'package.json');
    if (fs.existsSync(directPath)) {
        return directPath;
    }

    return resolveWebpackPackageJsonFile();
}

// SillyBunny: read package versions directly from JSON so importing webpack.config.js never loads webpack or spawns git.
const webpackPackageJsonPath = resolveWebpackPackageJsonPath();
const appPkgVersion = readJsonVersion(path.join(serverDirectory, 'package.json'), 'UNKNOWN');
const webpackVersion = webpackPackageJsonPath ? readJsonVersion(webpackPackageJsonPath, 'unknown') : 'unknown';

/** @type {{ runtimeKey: string, value: string } | null} */
let cachedWebpackVersionEntry = null;
/** @type {{ kind: 'minimizer-webpack-plugin' | 'terser-webpack-plugin', pluginPath: string } | null | undefined} */
let cachedMinimizerSpec;
/** @type {Map<string, { webpackRoot: string, cacheVersion: string, cacheDirectory: string, outputDirectory: string, outputFile: string, outputFilePath: string }>} */
const publicLibCacheInfoMemo = new Map();

const WEBPACK_MINIMIZER_PACKAGES = /** @type {const} */ ([
    'minimizer-webpack-plugin',
    'terser-webpack-plugin',
]);

// SillyBunny: webpack 5.106+ replaced terser-webpack-plugin with minimizer-webpack-plugin; resolve either from webpack's real package root first.
export function resolveWebpackMinimizerSpec({
    baseRequire = moduleRequire,
    createRequireFromPath = createRequire,
    realpathSync = fs.realpathSync,
    fallbackWebpackPkgPath = webpackPackageJsonPath,
} = {}) {
    const candidateAnchors = [];
    const addAnchor = (anchor) => {
        if (!anchor) {
            return;
        }
        try {
            const real = realpathSync(anchor);
            if (!candidateAnchors.includes(real)) {
                candidateAnchors.push(real);
            }
        } catch {
            // Keep the unresolved path when realpath fails.
        }
        if (!candidateAnchors.includes(anchor)) {
            candidateAnchors.push(anchor);
        }
    };

    addAnchor(resolveWebpackPackageJsonFile(baseRequire));
    addAnchor(fallbackWebpackPkgPath);

    for (const anchorPath of candidateAnchors) {
        let anchoredRequire;
        try {
            anchoredRequire = createRequireFromPath(anchorPath);
        } catch {
            continue;
        }
        for (const pkgName of WEBPACK_MINIMIZER_PACKAGES) {
            try {
                return {
                    kind: pkgName,
                    pluginPath: anchoredRequire.resolve(pkgName),
                };
            } catch {
                // Try the next package or anchor.
            }
        }
    }

    for (const pkgName of WEBPACK_MINIMIZER_PACKAGES) {
        try {
            return {
                kind: pkgName,
                pluginPath: baseRequire.resolve(pkgName),
            };
        } catch {
            // Try the next package.
        }
    }

    return null;
}

export function resolveTerserPluginPath(options = {}) {
    return resolveWebpackMinimizerSpec(options)?.pluginPath ?? null;
}

function isTermuxEnv(env) {
    if (env === process.env) {
        return isNativeTermuxEnvironment();
    }
    return Boolean(env?.TERMUX_VERSION)
        || env?.PREFIX === '/data/data/com.termux/files/usr'
        || (typeof env?.HOME === 'string' && env.HOME.startsWith('/data/data/com.termux/files/home'));
}

export function buildPublicLibMinimizer({
    env = process.env,
    platform = process.platform,
    resolveMinimizerSpec = () => {
        if (cachedMinimizerSpec === undefined) {
            cachedMinimizerSpec = resolveWebpackMinimizerSpec();
        }
        return cachedMinimizerSpec;
    },
    resolvePluginPath = undefined,
    loadPlugin = (pluginPath) => moduleRequire(pluginPath),
} = {}) {
    let spec = null;
    try {
        if (typeof resolvePluginPath === 'function') {
            const legacyPath = resolvePluginPath();
            spec = legacyPath ? { kind: 'terser-webpack-plugin', pluginPath: legacyPath } : null;
        } else {
            spec = resolveMinimizerSpec();
        }
    } catch {
        spec = null;
    }

    if (!spec?.pluginPath) {
        return ['...'];
    }

    const isAndroidHost = env.SILLYBUNNY_ANDROID_APP === '1'
        || platform === 'android'
        || isTermuxEnv(env);
    const parallel = isAndroidHost ? false : 2;
    return [
        {
            apply(compiler) {
                let MinimizerPlugin;
                try {
                    MinimizerPlugin = loadPlugin(spec.pluginPath);
                } catch (error) {
                    console.warn(`Failed to load webpack minimizer plugin at ${spec.pluginPath}; continuing without custom minimizer.`, error);
                    return;
                }
                // SillyBunny: cap worker fan-out on desktop and run in-process on Android (APK and Termux) to prevent memory spikes.
                const pluginOptions = spec.kind === 'minimizer-webpack-plugin'
                    ? {
                        parallel,
                        test: /^[^?#]*\.[cm]?js(?:[?#].*)?$/i,
                        minify: {
                            path: spec.pluginPath,
                            export: 'terserMinify',
                        },
                        minimizerOptions: {
                            compress: {
                                passes: 2,
                            },
                        },
                    }
                    : {
                        parallel,
                        terserOptions: {
                            compress: {
                                passes: 2,
                            },
                        },
                    };
                new MinimizerPlugin(pluginOptions).apply(compiler);
            },
        },
    ];
}

// SillyBunny: public/scripts/utils.js and reasoning.js pass getCurrentLocale() to moment.locale(), so retain UI locales from lang.json and strip the rest.
function getSupportedMomentLocalePattern() {
    const codes = new Set(['en-gb', 'en-au', 'en-ca', 'pt-br']);
    try {
        const langListPath = path.join(serverDirectory, 'public', 'locales', 'lang.json');
        const langs = JSON.parse(fs.readFileSync(langListPath, 'utf8'));
        if (Array.isArray(langs)) {
            for (const entry of langs) {
                const code = typeof entry?.lang === 'string' ? entry.lang.trim().toLowerCase() : '';
                if (!code) {
                    continue;
                }
                codes.add(code);
                codes.add(code.split('-')[0]);
            }
        }
    } catch {
        for (const fallback of FALLBACK_UI_MOMENT_LOCALES) {
            codes.add(fallback);
        }
    }

    const escaped = [...codes].map(code => code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^\\./(${escaped.join('|')})(\\.js)?$`);
}

function hashFileIfPresent(hasher, filePath) {
    if (!fs.existsSync(filePath)) {
        hasher.update(`${filePath}:missing`);
        return;
    }

    hasher.update(filePath);
    hasher.update(fs.readFileSync(filePath));
}

function getPublicLibInputsSignature() {
    const hasher = crypto.createHash('sha256');

    hashFileIfPresent(hasher, path.join(serverDirectory, 'public', 'lib.js'));
    hashFileIfPresent(hasher, path.join(serverDirectory, 'public', 'locales', 'lang.json'));
    hashFileIfPresent(hasher, path.join(serverDirectory, 'package.json'));
    hashFileIfPresent(hasher, path.join(serverDirectory, 'package-lock.json'));
    hashFileIfPresent(hasher, path.join(serverDirectory, 'bun.lock'));

    return hasher.digest('hex');
}

/**
 * Generate a cache version string based on the application version, Webpack version, runtime, and public lib inputs.
 * @returns {string} The cache version string.
 */
function getWebpackCacheVersion() {
    const runtimeKey = isBunRuntime() ? BUN_LIB_BUNDLE_SIGNATURE : 'default';
    if (cachedWebpackVersionEntry && cachedWebpackVersionEntry.runtimeKey === runtimeKey) {
        return cachedWebpackVersionEntry.value;
    }

    const value = crypto.createHash('shake256', { outputLength: 8 })
        .update(JSON.stringify([
            appPkgVersion,
            webpackVersion,
            PUBLIC_LIB_CONFIG_SIGNATURE,
            runtimeKey,
            getPublicLibInputsSignature(),
        ]))
        .digest('hex');

    cachedWebpackVersionEntry = { runtimeKey, value };
    return value;
}

export function invalidatePublicLibCacheInfo() {
    cachedWebpackVersionEntry = null;
    cachedMinimizerSpec = undefined;
    publicLibCacheInfoMemo.clear();
}

/**
 * Prune old Webpack cache directories that do not match the current cache version.
 * @param {string} webpackRoot The root directory where Webpack caches are stored.
 * @param {string} currentCacheVersion The current cache version to keep.
 * @param {object} options Options.
 * @param {number} [options.keepCount=WEBPACK_CACHE_KEEP_COUNT] Number of recent cache directories to keep.
 */
function pruneWebpackCache(webpackRoot, currentCacheVersion, { keepCount = WEBPACK_CACHE_KEEP_COUNT } = {}) {
    try {
        if (!fs.existsSync(webpackRoot)) {
            return;
        }

        const cacheDirectories = fs.readdirSync(webpackRoot, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map((dirent) => {
                const dirPath = path.join(webpackRoot, dirent.name);
                return {
                    name: dirent.name,
                    path: dirPath,
                    mtimeMs: fs.statSync(dirPath).mtimeMs,
                };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);

        const keepDirectories = new Set([currentCacheVersion]);
        for (const dir of cacheDirectories) {
            if (keepDirectories.size >= keepCount) {
                break;
            }

            keepDirectories.add(dir.name);
        }

        for (const dir of cacheDirectories) {
            if (!keepDirectories.has(dir.name)) {
                try {
                    fs.rmSync(dir.path, { recursive: true, force: true });
                    console.debug(`Removed outdated cache directory: ${color.yellow(dir.name)}`);
                } catch (error) {
                    console.error(`Failed to remove Webpack cache directory: ${color.red(dir.name)}`, error);
                }
            }
        }
    } catch (error) {
        console.error('Failed to read Webpack cache directories for pruning.', error);
    }
}

function getWebpackRoot({ forceDist = false } = {}) {
    if (forceDist || isDocker()) {
        return path.resolve(process.cwd(), 'dist', '_webpack');
    }

    if (typeof globalThis.DATA_ROOT === 'string') {
        return path.resolve(globalThis.DATA_ROOT, '_webpack');
    }

    throw new Error('DATA_ROOT variable is not set.');
}

function getCacheDirectory(webpackRoot, cacheVersion) {
    return path.join(webpackRoot, cacheVersion, 'cache');
}

function getOutputDirectory(webpackRoot, cacheVersion) {
    return path.join(webpackRoot, cacheVersion, 'output');
}

/**
 * Get the resolved output paths for the public lib bundle.
 * @param {object} options Configuration options.
 * @param {boolean} [options.forceDist=false] Whether to force the use the /dist folder.
 * @returns {{ webpackRoot: string, cacheVersion: string, cacheDirectory: string, outputDirectory: string, outputFile: string, outputFilePath: string }}
 */
export function getPublicLibCacheInfo({ forceDist = false } = {}) {
    const webpackRoot = getWebpackRoot({ forceDist });
    const runtimeKey = isBunRuntime() ? BUN_LIB_BUNDLE_SIGNATURE : 'default';
    const memoKey = `${Boolean(forceDist)}:${runtimeKey}:${webpackRoot}`;
    const cached = publicLibCacheInfoMemo.get(memoKey);
    if (cached) {
        return { ...cached };
    }

    const cacheVersion = getWebpackCacheVersion();
    const cacheDirectory = getCacheDirectory(webpackRoot, cacheVersion);
    const outputDirectory = getOutputDirectory(webpackRoot, cacheVersion);
    const outputFile = PUBLIC_LIB_FILENAME;
    const outputFilePath = path.join(outputDirectory, outputFile);
    const cacheInfo = {
        webpackRoot,
        cacheVersion,
        cacheDirectory,
        outputDirectory,
        outputFile,
        outputFilePath,
    };

    publicLibCacheInfoMemo.set(memoKey, cacheInfo);
    return { ...cacheInfo };
}

/**
 * Prune older public lib cache directories after a successful compile.
 * @param {object} options Options.
 * @param {boolean} [options.forceDist=false] Whether to force the use the /dist folder.
 * @param {string} [options.currentCacheVersion] Cache version to preserve.
 * @param {number} [options.keepCount=WEBPACK_CACHE_KEEP_COUNT] Number of recent cache directories to keep.
 * @returns {void}
 */
export function prunePublicLibCache({ forceDist = false, currentCacheVersion = undefined, keepCount = WEBPACK_CACHE_KEEP_COUNT } = {}) {
    const webpackRoot = getWebpackRoot({ forceDist });
    const cacheVersion = currentCacheVersion ?? getWebpackCacheVersion();
    pruneWebpackCache(webpackRoot, cacheVersion, { keepCount });
}

/**
 * Get the Webpack configuration for the public/lib.js file.
 * 1. Docker has got cache and the output file pre-baked.
 * 2. Non-Docker environments use the global DATA_ROOT variable to determine the cache and output directories.
 * @param {object} options Configuration options.
 * @param {boolean} [options.forceDist=false] Whether to force the use the /dist folder.
 * @param {boolean} [options.pruneCache=false] Whether to prune old cache directories.
 * @param {string} [options.outputPath] Override for the Webpack output directory.
 * @returns {import('webpack').Configuration}
 * @throws {Error} If the DATA_ROOT variable is not set.
 * */
export default function getPublicLibConfig({ forceDist = false, pruneCache = false, outputPath = undefined } = {}) {
    const {
        webpackRoot,
        cacheVersion,
        outputDirectory,
    } = getPublicLibCacheInfo({ forceDist });

    if (pruneCache) {
        pruneWebpackCache(webpackRoot, cacheVersion);
    }

    // Bun's Webpack/Terser path can emit invalid syntax in the generated lib.js bundle.
    // Keeping the vendor bundle unminified avoids the bad output while preserving Bun at runtime.
    const minimize = !isBunRuntime();

    return {
        mode: 'production',
        entry: path.join(serverDirectory, 'public/lib.js'),
        // SillyBunny: cacheVersion already scopes each output directory to one input hash, so a pack cache never gets a hit.
        cache: false,
        devtool: false,
        watch: false,
        resolve: {
            alias: {
                // Use Chevrotain's bundled ESM build to avoid Windows + Bun walking lodash-es source files.
                chevrotain$: path.resolve(serverDirectory, 'node_modules/chevrotain/lib/chevrotain.mjs'),
            },
        },
        module: {},
        plugins: [
            {
                apply(compiler) {
                    new compiler.webpack.ContextReplacementPlugin(
                        /moment(?:[/\\]dist)?[/\\]locale$/,
                        getSupportedMomentLocalePattern(),
                    ).apply(compiler);
                },
            },
        ],
        stats: {
            preset: 'minimal',
            assets: false,
            modules: false,
            colors: true,
            timings: true,
        },
        experiments: {
            outputModule: true,
        },
        performance: {
            hints: false,
        },
        optimization: {
            minimize,
            ...(minimize ? {
                minimizer: buildPublicLibMinimizer(),
            } : {}),
        },
        output: {
            path: outputPath ?? outputDirectory,
            filename: PUBLIC_LIB_FILENAME,
            libraryTarget: 'module',
        },
    };
}
