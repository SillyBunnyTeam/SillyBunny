import fs from 'node:fs';
import path from 'node:path';
import webpack from 'webpack';
import getPublicLibConfig, {
    getPublicLibCacheInfo,
    prunePublicLibCache,
} from '../../webpack.config.js';
// SillyBunny: serve /lib.js from the bounded compressed static LRU for remote/proxied clients.
import { createCompressedStaticMiddleware } from './response-compression.js';

export default function getWebpackServeMiddleware({ forceDist = false } = {}) {
    const resolvePublicLibConfig = ({ forceDist: overrideForceDist = forceDist, pruneCache = false } = {}) =>
        getPublicLibConfig({ forceDist: overrideForceDist, pruneCache });
    /** @type {import('webpack').Configuration | null} */
    let activePublicLibConfig = null;
    /** @type {Promise<void> | null} */
    let compilePromise = null;
    /** @type {string | null} */
    let cachedCompressedRoot = null;
    /** @type {import('express').RequestHandler | null} */
    let cachedCompressedHandler = null;

    function getCompressedLibHandler(outputPath) {
        if (cachedCompressedRoot !== outputPath || !cachedCompressedHandler) {
            cachedCompressedRoot = outputPath;
            cachedCompressedHandler = createCompressedStaticMiddleware(outputPath, {
                setHeaders: (response) => {
                    response.setHeader('Cache-Control', 'no-cache');
                },
            });
        }
        return cachedCompressedHandler;
    }

    function getCompiledOutputPath(publicLibConfig) {
        const outputPath = publicLibConfig.output?.path;
        const outputFile = publicLibConfig.output?.filename;

        return typeof outputPath === 'string' && typeof outputFile === 'string'
            ? path.join(outputPath, outputFile)
            : null;
    }

    function cleanupTemporaryOutput(temporaryOutputPath) {
        try {
            fs.rmSync(temporaryOutputPath, { recursive: true, force: true });
        } catch (error) {
            console.error('Failed to remove temporary Webpack output directory.', error);
        }
    }

    function sendPublicLib(publicLibConfig, req, res, next, { recoverMissing = true } = {}) {
        const outputPath = publicLibConfig.output?.path;
        const outputFile = publicLibConfig.output?.filename;

        const sendFallback = () => {
            res.setHeader('Cache-Control', 'no-cache');
            return res.sendFile(outputFile, { root: outputPath }, (error) => {
                if (!error) {
                    return;
                }

                if (error.code !== 'ENOENT' || !recoverMissing || res.headersSent) {
                    return next(error);
                }

                console.warn(`Frontend library bundle was missing at ${path.join(outputPath, outputFile)}. Rebuilding...`);
                runWebpackCompiler({ forceDist, pruneCache: true })
                    .then(() => {
                        sendPublicLib(activePublicLibConfig ?? resolvePublicLibConfig(), req, res, next, { recoverMissing: false });
                    })
                    .catch(next);
            });
        };

        if (typeof outputPath === 'string' && outputPath) {
            return getCompressedLibHandler(outputPath)(req, res, (err) => {
                if (err) {
                    return next(err);
                }
                return sendFallback();
            });
        }

        return sendFallback();
    }

    /**
     * A very spartan recreation of webpack-dev-middleware.
     * @param {import('express').Request} req Request object.
     * @param {import('express').Response} res Response object.
     * @param {import('express').NextFunction} next Next function.
     * @type {import('express').RequestHandler}
     */
    function devMiddleware(req, res, next) {
        const publicLibConfig = activePublicLibConfig ?? resolvePublicLibConfig();
        const outputFile = publicLibConfig.output?.filename;
        const parsedPath = path.parse(req.path);

        if (req.method === 'GET' && parsedPath.dir === '/' && parsedPath.base === outputFile) {
            return sendPublicLib(publicLibConfig, req, res, next);
        }

        next();
    }

    /**
     * Wait until Webpack is done compiling.
     * @param {object} param Parameters.
     * @param {boolean} [param.forceDist=forceDist] Whether to force the use the /dist folder.
     * @param {boolean} [param.pruneCache=false] Whether to prune old cache directories before compiling.
     * @returns {Promise<void>}
     */
    function compilePublicLib({ forceDist: overrideForceDist = forceDist, pruneCache = false } = {}) {
        const cacheInfo = getPublicLibCacheInfo({ forceDist: overrideForceDist });
        const publicLibConfig = resolvePublicLibConfig({ forceDist: overrideForceDist });
        const compiledOutputPath = getCompiledOutputPath(publicLibConfig);

        if (compiledOutputPath && fs.existsSync(compiledOutputPath)) {
            console.log();
            console.log('Reusing precompiled frontend libraries...');
            activePublicLibConfig = publicLibConfig;
            if (pruneCache) {
                prunePublicLibCache({ forceDist: overrideForceDist, currentCacheVersion: cacheInfo.cacheVersion });
            }
            return Promise.resolve();
        }

        const temporaryOutputPath = path.join(cacheInfo.webpackRoot, cacheInfo.cacheVersion, 'output.tmp');
        const temporaryOutputFilePath = path.join(temporaryOutputPath, cacheInfo.outputFile);
        const temporaryPublicLibConfig = getPublicLibConfig({
            forceDist: overrideForceDist,
            outputPath: temporaryOutputPath,
        });

        console.log();
        console.log('Compiling frontend libraries...');

        const compiler = webpack(temporaryPublicLibConfig);

        return new Promise((resolve, reject) => {
            compiler.run((error, stats) => {
                const output = stats?.toString(temporaryPublicLibConfig.stats);
                if (output) {
                    console.log(output);
                    console.log();
                }

                compiler.close((closeError) => {
                    try {
                        const compileError = error ?? closeError;
                        if (compileError) {
                            cleanupTemporaryOutput(temporaryOutputPath);
                            reject(compileError);
                            return;
                        }

                        if (stats?.hasErrors()) {
                            cleanupTemporaryOutput(temporaryOutputPath);
                            reject(new Error('Webpack failed to compile frontend libraries.'));
                            return;
                        }

                        if (!fs.existsSync(temporaryOutputFilePath)) {
                            cleanupTemporaryOutput(temporaryOutputPath);
                            reject(new Error(`Webpack did not produce ${cacheInfo.outputFile}.`));
                            return;
                        }

                        fs.rmSync(cacheInfo.outputDirectory, { recursive: true, force: true });
                        fs.mkdirSync(path.dirname(cacheInfo.outputDirectory), { recursive: true });
                        fs.renameSync(temporaryOutputPath, cacheInfo.outputDirectory);

                        activePublicLibConfig = publicLibConfig;
                        if (pruneCache) {
                            prunePublicLibCache({ forceDist: overrideForceDist, currentCacheVersion: cacheInfo.cacheVersion });
                        }
                        resolve();
                    } catch (error) {
                        cleanupTemporaryOutput(temporaryOutputPath);
                        reject(error);
                    }
                });
            });
        });
    }

    function runWebpackCompiler({ forceDist: overrideForceDist = forceDist, pruneCache = false } = {}) {
        if (!compilePromise) {
            compilePromise = compilePublicLib({ forceDist: overrideForceDist, pruneCache })
                .finally(() => {
                    compilePromise = null;
                });
        }

        return compilePromise;
    }

    devMiddleware.runWebpackCompiler = ({ forceDist: overrideForceDist = forceDist, pruneCache = false } = {}) => {
        return runWebpackCompiler({ forceDist: overrideForceDist, pruneCache });
    };

    return devMiddleware;
}
