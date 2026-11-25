import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import isDocker from 'is-docker';
import webpack from 'webpack';
import { isBunRuntime } from './src/runtime.js';
import { serverDirectory } from './src/server-directory.js';
import { getVersion, color } from './src/util.js';

// SillyBunny: cache signatures and input hashing cover Bun pre-minified aliases, slim hljs, and UI moment locales.
const BUN_LIB_BUNDLE_SIGNATURE = 'bun-premin-vendors-v3';
const PUBLIC_LIB_CONFIG_SIGNATURE = 'slim-hljs-moment-ui-locales-v3';
const WEBPACK_CACHE_KEEP_COUNT = 3;
const PUBLIC_LIB_FILENAME = 'lib.js';
const REGIONAL_MOMENT_LOCALES = ['en-au', 'en-ca', 'en-gb', 'pt-br'];

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

    // SillyBunny: invalidate cached /lib.js when webpack config or UI locale catalog changes.
    hashFileIfPresent(hasher, path.join(serverDirectory, 'webpack.config.js'));
    hashFileIfPresent(hasher, path.join(serverDirectory, 'public', 'locales', 'lang.json'));
    hashFileIfPresent(hasher, path.join(serverDirectory, 'public', 'lib.js'));
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
    return crypto.createHash('shake256', { outputLength: 8 })
        .update(JSON.stringify([
            appVersion.pkgVersion,
            webpack.version,
            PUBLIC_LIB_CONFIG_SIGNATURE,
            isBunRuntime() ? BUN_LIB_BUNDLE_SIGNATURE : 'default',
            getPublicLibInputsSignature(),
        ]))
        .digest('hex');
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

const appVersion = await getVersion();

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
    const cacheVersion = getWebpackCacheVersion();
    const cacheDirectory = getCacheDirectory(webpackRoot, cacheVersion);
    const outputDirectory = getOutputDirectory(webpackRoot, cacheVersion);
    const outputFile = PUBLIC_LIB_FILENAME;
    const outputFilePath = path.join(outputDirectory, outputFile);

    return {
        webpackRoot,
        cacheVersion,
        cacheDirectory,
        outputDirectory,
        outputFile,
        outputFilePath,
    };
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

// SillyBunny: resolve optional pre-minified vendor builds for Bun where Webpack/Terser minification is disabled.
function resolveOptionalVendorAlias(relativePath) {
    const absolutePath = path.resolve(serverDirectory, 'node_modules', relativePath);
    return fs.existsSync(absolutePath) ? absolutePath : false;
}

function getVendorResolveAliases({ usePreminified = false } = {}) {
    // Use Chevrotain's bundled ESM build to avoid Windows + Bun walking lodash-es source files.
    const chevrotainFallback = path.resolve(serverDirectory, 'node_modules/chevrotain/lib/chevrotain.mjs');

    if (!usePreminified) {
        return {
            chevrotain$: chevrotainFallback,
        };
    }

    // SillyBunny: alias large vendor libraries to their official pre-minified browser bundles on Bun,
    // leaving moment on its modular entry so ContextReplacementPlugin preserves all UI locales.
    const candidates = {
        chevrotain$: 'chevrotain/lib/chevrotain.min.mjs',
        handlebars$: 'handlebars/dist/handlebars.min.js',
        lodash$: 'lodash/lodash.min.js',
        showdown$: 'showdown/dist/showdown.min.js',
        localforage$: 'localforage/dist/localforage.min.js',
    };
    const aliases = {};
    for (const [specifier, relativePath] of Object.entries(candidates)) {
        const resolved = resolveOptionalVendorAlias(relativePath);
        if (resolved) {
            aliases[specifier] = resolved;
        }
    }
    if (!aliases.chevrotain$) {
        aliases.chevrotain$ = chevrotainFallback;
    }
    return aliases;
}

// SillyBunny: derive the kept moment locales from public/locales/lang.json plus regional English/Portuguese
// so localized timestamps and reasoning durations keep working while unused locales are pruned.
function getSupportedMomentLocaleRegExp() {
    const momentLocaleDir = path.join(serverDirectory, 'node_modules', 'moment', 'locale');
    const langCatalogPath = path.join(serverDirectory, 'public', 'locales', 'lang.json');
    const keptLocales = new Set(REGIONAL_MOMENT_LOCALES);

    try {
        const catalog = JSON.parse(fs.readFileSync(langCatalogPath, 'utf8'));
        if (Array.isArray(catalog)) {
            for (const entry of catalog) {
                const rawLang = typeof entry?.lang === 'string' ? entry.lang.trim().toLowerCase() : '';
                if (!rawLang) {
                    continue;
                }
                if (fs.existsSync(path.join(momentLocaleDir, `${rawLang}.js`))) {
                    keptLocales.add(rawLang);
                    continue;
                }
                const baseLang = rawLang.split('-')[0];
                if (baseLang && fs.existsSync(path.join(momentLocaleDir, `${baseLang}.js`))) {
                    keptLocales.add(baseLang);
                }
            }
        }
    } catch (error) {
        console.warn('Failed to read public/locales/lang.json for moment locale pruning; keeping fallback locale set.', error);
    }

    const escaped = Array.from(keptLocales)
        .filter(locale => fs.existsSync(path.join(momentLocaleDir, `${locale}.js`)))
        .sort()
        .map(locale => locale.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    return new RegExp(`^(?:\\.\\/)?(?:${escaped.join('|')})(?:\\.js)?$`);
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
        cacheDirectory,
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
        cache: isBunRuntime() ? false : {
            type: 'filesystem',
            cacheDirectory: cacheDirectory,
            store: 'pack',
            compression: 'gzip',
        },
        devtool: false,
        watch: false,
        resolve: {
            alias: getVendorResolveAliases({ usePreminified: !minimize }),
        },
        module: {},
        plugins: [
            // SillyBunny: keep only the moment locales used by SillyBunny's UI plus regional English/Portuguese.
            new webpack.ContextReplacementPlugin(/moment[/\\]locale$/, getSupportedMomentLocaleRegExp()),
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
        },
        output: {
            path: outputPath ?? outputDirectory,
            filename: PUBLIC_LIB_FILENAME,
            libraryTarget: 'module',
        },
    };
}
