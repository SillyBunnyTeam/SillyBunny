import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import { APP_NAME } from './runtime.js';
import { BUN_SOCKET_INHERIT_ISSUE_URL, hasBunSocketInheritBug, isAddressInUseError, reportPortHolders, retryOnAddressInUse, trackListeningServer, diagnosePortConflict, formatPortConflictBanner } from './server-listen.js';
import { color, urlHostnameToIPv6, getHasIP } from './util.js';

// SillyBunny: core routers stay eager; optional integration routers lazy-load on demand (see createLazyRouter below).
import { router as userDataRouter } from './users.js';
import { router as usersPrivateRouter } from './endpoints/users-private.js';
import { router as usersAdminRouter } from './endpoints/users-admin.js';
import { router as movingUIRouter } from './endpoints/moving-ui.js';
import { router as imagesRouter } from './endpoints/images.js';
import { router as quickRepliesRouter } from './endpoints/quick-replies.js';
import { router as avatarsRouter } from './endpoints/avatars.js';
import { router as themesRouter } from './endpoints/themes.js';
import { router as openAiRouter } from './endpoints/openai.js';
import { router as googleRouter } from './endpoints/google.js';
import { router as anthropicRouter } from './endpoints/anthropic.js';
import { router as tokenizersRouter } from './endpoints/tokenizers.js';
import { router as presetsRouter } from './endpoints/presets.js';
import { router as secretsRouter } from './endpoints/secrets.js';
import { router as thumbnailRouter } from './endpoints/thumbnails.js';
import { router as extensionsRouter } from './endpoints/extensions.js';
import { router as assetsRouter } from './endpoints/assets.js';
import { router as filesRouter } from './endpoints/files.js';
import { router as charactersRouter } from './endpoints/characters.js';
import { router as chatsRouter } from './endpoints/chats.js';
import { router as groupsRouter } from './endpoints/groups.js';
import { router as worldInfoRouter } from './endpoints/worldinfo.js';
import { router as statsRouter } from './endpoints/stats.js';
import { router as contentManagerRouter } from './endpoints/content-manager.js';
import { router as settingsRouter } from './endpoints/settings.js';
import { router as backgroundsRouter } from './endpoints/backgrounds.js';
import { router as spritesRouter } from './endpoints/sprites.js';
import { router as chatCompletionsRouter } from './endpoints/backends/chat-completions.js';
import { router as backupsRouter } from './endpoints/backups.js';
import { router as imageMetadataRouter } from './endpoints/image-metadata.js';
import { router as serverAdminRouter } from './endpoints/server-admin.js';
import { router as inChatAgentsRouter } from './endpoints/in-chat-agents.js';
import { resumableGenerationMiddleware, router as resumableGenerationsRouter } from './resumable-generations.js';

// SillyBunny: defer importing heavy non-boot Express routers until their first request to reduce startup RSS and boot time.
/**
 * Creates an Express middleware that dynamically imports and caches a router module on first request.
 * @param {() => Promise<{ router: import('express').Router }>} loader Dynamic import function returning a router module
 * @returns {import('express').RequestHandler}
 */
export function createLazyRouter(loader) {
    /** @type {import('express').Router | null} */
    let resolvedRouter = null;
    /** @type {Promise<import('express').Router> | null} */
    let pendingLoad = null;

    return function lazyRouterMiddleware(req, res, next) {
        if (resolvedRouter) {
            return resolvedRouter(req, res, next);
        }

        pendingLoad ??= Promise.resolve()
            .then(loader)
            .then(mod => {
                if (typeof mod?.router !== 'function') {
                    throw new TypeError('Lazy router module did not export a router function.');
                }
                resolvedRouter = mod.router;
                return resolvedRouter;
            })
            .catch(error => {
                pendingLoad = null;
                throw error;
            });

        // The first dispatch runs inside a promise callback, where Express cannot catch a
        // synchronous throw. Without this the request gets no answer.
        return pendingLoad.then(router => {
            try {
                return router(req, res, next);
            } catch (error) {
                return next(error);
            }
        }, next);
    };
}

// SillyBunny: lazy-mounted non-boot endpoint routers (loaded on first request).
const novelAiRouter = createLazyRouter(() => import('./endpoints/novelai.js'));
// SillyBunny divergence: keep archive inventory and read-only orphan access isolated from upstream chat and Data Maid routes.
const chatArchiveRouter = createLazyRouter(() => import('./endpoints/chat-archive.js'));
const stableDiffusionRouter = createLazyRouter(() => import('./endpoints/stable-diffusion.js'));
const hordeRouter = createLazyRouter(() => import('./endpoints/horde.js'));
const vectorsRouter = createLazyRouter(() => import('./endpoints/vectors.js'));
const translateRouter = createLazyRouter(() => import('./endpoints/translate.js'));
const classifyRouter = createLazyRouter(() => import('./endpoints/classify.js'));
const captionRouter = createLazyRouter(() => import('./endpoints/caption.js'));
const searchRouter = createLazyRouter(() => import('./endpoints/search.js'));
const openRouterRouter = createLazyRouter(() => import('./endpoints/openrouter.js'));
const nanogptRouter = createLazyRouter(() => import('./endpoints/nanogpt.js'));
const koboldRouter = createLazyRouter(() => import('./endpoints/backends/kobold.js'));
const textCompletionsRouter = createLazyRouter(() => import('./endpoints/backends/text-completions.js'));
const speechRouter = createLazyRouter(() => import('./endpoints/speech.js'));
const azureRouter = createLazyRouter(() => import('./endpoints/azure.js'));
const minimaxRouter = createLazyRouter(() => import('./endpoints/minimax.js'));
const dataMaidRouter = createLazyRouter(() => import('./endpoints/data-maid.js'));
const volcengineRouter = createLazyRouter(() => import('./endpoints/volcengine.js'));
// SillyBunny: storage routes of conversation mode; the router and everything behind it are fork-owned.
const sillyBunnyConversationRouter = createLazyRouter(() => import('./endpoints/sillybunny-conversation.js'));
// SillyBunny: pinned third-party CSS themes for Bundled Extras; the router is fork-owned.
const sillyBunnyBundledThemesRouter = createLazyRouter(() => import('./endpoints/sillybunny-bundled-themes.js'));
// SillyBunny: status, update and restore of the bundled assistant content; the router is fork-owned.
const sillyBunnyManagedContentRouter = createLazyRouter(() => import('./endpoints/sillybunny-managed-content.js'));

/**
 * @typedef {object} ServerStartupResult
 * @property {boolean} v6Failed If the server failed to start on IPv6
 * @property {boolean} v4Failed If the server failed to start on IPv4
 * @property {unknown} [v6Error] The IPv6 server startup error
 * @property {unknown} [v4Error] The IPv4 server startup error
 * @property {boolean} useIPv6 If use IPv6
 * @property {boolean} useIPv4 If use IPv4
 */

/**
 * Setup the routers for the endpoints.
 * @param {import('express').Express} app The Express app to use
 */
export function setupPrivateEndpoints(app) {
    app.use('/', userDataRouter);
    // SillyBunny: resumable generations. The router is mounted first so its own requests never register as generations.
    app.use('/api/resumable-generations', resumableGenerationsRouter);
    app.use(resumableGenerationMiddleware);
    app.use('/api/users', usersPrivateRouter);
    app.use('/api/users', usersAdminRouter);
    app.use('/api/moving-ui', movingUIRouter);
    app.use('/api/images', imagesRouter);
    app.use('/api/quick-replies', quickRepliesRouter);
    app.use('/api/avatars', avatarsRouter);
    app.use('/api/themes', themesRouter);
    app.use('/api/openai', openAiRouter);
    app.use('/api/google', googleRouter);
    app.use('/api/anthropic', anthropicRouter);
    app.use('/api/tokenizers', tokenizersRouter);
    app.use('/api/presets', presetsRouter);
    app.use('/api/secrets', secretsRouter);
    app.use('/thumbnail', thumbnailRouter);
    app.use('/api/novelai', novelAiRouter);
    app.use('/api/extensions', extensionsRouter);
    app.use('/api/assets', assetsRouter);
    app.use('/api/files', filesRouter);
    app.use('/api/characters', charactersRouter);
    app.use('/api/chats/archive', chatArchiveRouter);
    app.use('/api/chats', chatsRouter);
    app.use('/api/groups', groupsRouter);
    app.use('/api/worldinfo', worldInfoRouter);
    app.use('/api/stats', statsRouter);
    app.use('/api/backgrounds', backgroundsRouter);
    app.use('/api/sprites', spritesRouter);
    app.use('/api/content', contentManagerRouter);
    app.use('/api/settings', settingsRouter);
    app.use('/api/sd', stableDiffusionRouter);
    app.use('/api/horde', hordeRouter);
    app.use('/api/vector', vectorsRouter);
    app.use('/api/translate', translateRouter);
    app.use('/api/extra/classify', classifyRouter);
    app.use('/api/extra/caption', captionRouter);
    app.use('/api/search', searchRouter);
    app.use('/api/backends/text-completions', textCompletionsRouter);
    app.use('/api/openrouter', openRouterRouter);
    app.use('/api/nanogpt', nanogptRouter);
    app.use('/api/backends/kobold', koboldRouter);
    app.use('/api/backends/chat-completions', chatCompletionsRouter);
    app.use('/api/speech', speechRouter);
    app.use('/api/azure', azureRouter);
    app.use('/api/volcengine', volcengineRouter);
    app.use('/api/minimax', minimaxRouter);
    app.use('/api/data-maid', dataMaidRouter);
    app.use('/api/backups', backupsRouter);
    app.use('/api/image-metadata', imageMetadataRouter);
    app.use('/api/server-admin', serverAdminRouter);
    app.use('/api/in-chat-agents', inChatAgentsRouter);
    // SillyBunny: one mount for the conversation storage routes, behind the same login and CSRF checks as the rest.
    app.use('/api/sillybunny-conversation', sillyBunnyConversationRouter);
    // SillyBunny: Bundled Extras installs pinned third-party CSS themes through its own route.
    app.use('/api/sillybunny/themes', sillyBunnyBundledThemesRouter);
    // SillyBunny: managed bundled content has its own route, behind the same login and CSRF checks.
    app.use('/api/sillybunny/managed-content', sillyBunnyManagedContentRouter);
}

/**
 * Utilities for starting the express server.
 */
export class ServerStartup {
    /**
     * Creates a new ServerStartup instance.
     * @param {import('express').Express} app The Express app to use
     * @param {import('./command-line.js').CommandLineArguments} cliArgs The command-line arguments
     */
    constructor(app, cliArgs) {
        this.app = app;
        this.cliArgs = cliArgs;
    }

    /**
     * Prints a fatal error message and exits the process.
     * @param {string} message
     */
    #fatal(message) {
        console.error(color.red(message));
        process.exit(1);
    }

    /**
     * Checks if the error was caused by an occupied port.
     * @param {unknown} error
     * @returns {error is NodeJS.ErrnoException}
     */
    #isAddressInUseError(error) {
        return isAddressInUseError(error);
    }

    /**
     * Gets a readable listen address for an IP version.
     * @param {URL} url The URL to listen on
     * @param {number} ipVersion The IP version to use
     * @returns {string}
     */
    #getListenAddress(url, ipVersion) {
        const host = ipVersion === 6 ? urlHostnameToIPv6(url.hostname) : url.hostname;
        return `${host}:${this.#getListenPort(url)}`;
    }

    /**
     * Resolves the effective listen port of a URL.
     * @param {URL} url The URL to inspect
     * @returns {number}
     */
    #getListenPort(url) {
        return Number(url.port || (this.cliArgs.ssl ? 443 : 80));
    }

    /**
     * Builds a user-facing error for an occupied port.
     * @param {URL} url The URL that failed to bind
     * @param {number} ipVersion The IP version that failed
     * @returns {string}
     */
    #getAddressInUseMessage(url, ipVersion) {
        const listenAddress = this.#getListenAddress(url, ipVersion);
        let message = `Address ${listenAddress} is already in use. Another ${APP_NAME} instance may already be running. Stop the other process or change "port" in config.yaml.`;
        // SillyBunny: Bun builds before 1.4.0 create inheritable socket handles
        // on Windows, so a process spawned by the previous instance (git,
        // package install, browser launch) can keep the port bound after that
        // instance exited.
        if (hasBunSocketInheritBug()) {
            message += ` If no other instance is running, this is a known Bun-on-Windows bug (${BUN_SOCKET_INHERIT_ISSUE_URL}): wait a minute and relaunch, or start with Start-Node.bat.`;
        }
        return message;
    }

    /**
     * Checks if SSL options are valid. If not, it will print an error message and exit the process.
     * @returns {void}
     */
    #verifySslOptions() {
        if (!this.cliArgs.ssl) return;

        if (!this.cliArgs.certPath) {
            this.#fatal('Error: SSL certificate path is required when using HTTPS. Check your config');
        }

        if (!this.cliArgs.keyPath) {
            this.#fatal('Error: SSL key path is required when using HTTPS. Check your config');
        }

        if (!fs.existsSync(this.cliArgs.certPath)) {
            this.#fatal('Error: SSL certificate path does not exist');
        }

        if (!fs.existsSync(this.cliArgs.keyPath)) {
            this.#fatal('Error: SSL key path does not exist');
        }
    }

    /**
     * Creates an HTTPS server.
     * @param {URL} url The URL to listen on
     * @param {number} ipVersion the ip version to use
     * @returns {Promise<void>} A promise that resolves when the server is listening
     */
    #createHttpsServer(url, ipVersion) {
        this.#verifySslOptions();
        return new Promise((resolve, reject) => {
            /** @type {import('https').ServerOptions} */
            const sslOptions = {
                cert: fs.readFileSync(this.cliArgs.certPath),
                key: fs.readFileSync(this.cliArgs.keyPath),
                passphrase: String(this.cliArgs.keyPassphrase ?? ''),
            };
            const server = https.createServer(sslOptions, this.app);
            server.on('error', (error) => {
                // Drop the half-built server so a retry does not leak it. A
                // server that already bound stays up: only the bind attempt is
                // being abandoned here.
                if (!server.listening) {
                    server.close(() => { });
                }
                reject(error);
            });
            server.on('listening', () => {
                trackListeningServer(server);
                resolve();
            });

            let host = url.hostname;
            if (ipVersion === 6) host = urlHostnameToIPv6(url.hostname);
            server.listen({
                host: host,
                port: Number(url.port || 443),
                // see https://nodejs.org/api/net.html#serverlisten for why ipv6Only is used
                ipv6Only: true,
            });
        });
    }

    /**
     * Creates an HTTP server.
     * @param {URL} url The URL to listen on
     * @param {number} ipVersion the ip version to use
     * @returns {Promise<void>} A promise that resolves when the server is listening
     */
    #createHttpServer(url, ipVersion) {
        return new Promise((resolve, reject) => {
            const server = http.createServer(this.app);
            server.on('error', (error) => {
                // Drop the half-built server so a retry does not leak it. A
                // server that already bound stays up: only the bind attempt is
                // being abandoned here.
                if (!server.listening) {
                    server.close(() => { });
                }
                reject(error);
            });
            server.on('listening', () => {
                trackListeningServer(server);
                resolve();
            });

            let host = url.hostname;
            if (ipVersion === 6) host = urlHostnameToIPv6(url.hostname);
            server.listen({
                host: host,
                port: Number(url.port || 80),
                // see https://nodejs.org/api/net.html#serverlisten for why ipv6Only is used
                ipv6Only: true,
            });
        });
    }

    /**
     * Starts the server using http or https depending on config
     * @param {boolean} useIPv6 If use IPv6
     * @param {boolean} useIPv4 If use IPv4
     * @returns {Promise<[boolean, boolean, unknown, unknown]>} A promise that resolves with an array of booleans indicating if the server failed to start on IPv6 and IPv4, respectively, and the corresponding errors
     */
    async #startHTTPorHTTPS(useIPv6, useIPv4) {
        let v6Failed = false;
        let v4Failed = false;
        let v6Error;
        let v4Error;

        const createFunc = this.cliArgs.ssl ? this.#createHttpsServer.bind(this) : this.#createHttpServer.bind(this);

        // A restart can outrun the previous process releasing the port, so wait
        // it out briefly instead of aborting the relaunch on the first failure.
        const listen = (url, ipVersion) => retryOnAddressInUse(() => createFunc(url, ipVersion), {
            onRetry: (attempt, attempts) => {
                if (attempt === 1 || attempt % 10 === 0) {
                    console.warn(`${this.#getListenAddress(url, ipVersion)} is still in use; waiting for it to be released (attempt ${attempt} of ${attempts}).`);
                }
                if (attempt === 1) {
                    // Fire-and-forget: names the holder while the retries run.
                    void reportPortHolders(this.#getListenPort(url));
                }
            },
        });

        const startIPv6 = (async () => {
            if (!useIPv6) return;
            try {
                await listen(this.cliArgs.getIPv6ListenUrl(), 6);
            } catch (error) {
                console.error('Warning: failed to start server on IPv6');
                if (this.#isAddressInUseError(error)) {
                    console.error(this.#getAddressInUseMessage(this.cliArgs.getIPv6ListenUrl(), 6));
                } else {
                    console.error(error);
                }

                v6Failed = true;
                v6Error = error;
            }
        })();

        const startIPv4 = (async () => {
            if (!useIPv4) return;
            try {
                await listen(this.cliArgs.getIPv4ListenUrl(), 4);
            } catch (error) {
                console.error('Warning: failed to start server on IPv4');
                if (this.#isAddressInUseError(error)) {
                    console.error(this.#getAddressInUseMessage(this.cliArgs.getIPv4ListenUrl(), 4));
                } else {
                    console.error(error);
                }

                v4Failed = true;
                v4Error = error;
            }
        })();

        await Promise.all([startIPv6, startIPv4]);

        return [v6Failed, v4Failed, v6Error, v4Error];
    }

    /**
     * Handles the case where the server failed to start on one or both protocols.
     * @param {ServerStartupResult} result The results of the server startup
     * @returns {void}
     */
    async #handleServerListenFail({ v6Failed, v4Failed, v6Error, v4Error, useIPv6, useIPv4 }) {
        // A final look at who occupies the port makes the abort actionable: a
        // still-listed holder after thirty seconds of retries is not a transient race.
        const reportBeforeFatal = async (...urls) => {
            const ports = [...new Set(urls.map(url => this.#getListenPort(url)))];
            for (const port of ports) {
                await reportPortHolders(port);
            }
        };

        const emitDiagnostic = async (url, ipVersion) => {
            const port = this.#getListenPort(url);
            const listenAddress = this.#getListenAddress(url, ipVersion);
            try {
                const diagnosis = await diagnosePortConflict(port, listenAddress);
                const banner = formatPortConflictBanner(diagnosis);
                console.error(banner);
            } catch {
                // Diagnostics must never break startup.
            }
        };

        if (v6Failed && !useIPv4) {
            if (this.#isAddressInUseError(v6Error)) {
                await reportBeforeFatal(this.cliArgs.getIPv6ListenUrl());
                await emitDiagnostic(this.cliArgs.getIPv6ListenUrl(), 6);
                this.#fatal('Error: Startup aborted because IPv6 is the only enabled protocol and its listen port is already in use.');
            }
            this.#fatal('Error: Failed to start server on IPv6 and IPv4 disabled');
        }

        if (v4Failed && !useIPv6) {
            if (this.#isAddressInUseError(v4Error)) {
                await reportBeforeFatal(this.cliArgs.getIPv4ListenUrl());
                await emitDiagnostic(this.cliArgs.getIPv4ListenUrl(), 4);
                this.#fatal('Error: Startup aborted because IPv4 is the only enabled protocol and its listen port is already in use.');
            }
            this.#fatal('Error: Failed to start server on IPv4 and IPv6 disabled');
        }

        if (v6Failed && v4Failed) {
            if (this.#isAddressInUseError(v6Error) || this.#isAddressInUseError(v4Error)) {
                const urls = [];
                if (this.#isAddressInUseError(v6Error)) urls.push(this.cliArgs.getIPv6ListenUrl());
                if (this.#isAddressInUseError(v4Error)) urls.push(this.cliArgs.getIPv4ListenUrl());
                await reportBeforeFatal(...urls);
                if (this.#isAddressInUseError(v6Error)) await emitDiagnostic(this.cliArgs.getIPv6ListenUrl(), 6);
                if (this.#isAddressInUseError(v4Error)) await emitDiagnostic(this.cliArgs.getIPv4ListenUrl(), 4);
            }
            if (this.#isAddressInUseError(v6Error) && this.#isAddressInUseError(v4Error)) {
                this.#fatal('Error: Failed to start server because the configured IPv6 and IPv4 listen ports are already in use.');
            }
            this.#fatal('Error: Failed to start server on both IPv6 and IPv4');
        }
    }

    /**
     * Performs the server startup.
     * @returns {Promise<ServerStartupResult>} A promise that resolves with an object containing the results of the server startup
     */
    async start() {
        let useIPv6 = (this.cliArgs.enableIPv6 === true);
        let useIPv4 = (this.cliArgs.enableIPv4 === true);

        if (this.cliArgs.enableIPv6 === 'auto' || this.cliArgs.enableIPv4 === 'auto') {
            const ipQuery = await getHasIP();
            let hasIPv6 = false, hasIPv4 = false;

            hasIPv6 = this.cliArgs.listen ? ipQuery.hasIPv6Any : ipQuery.hasIPv6Local;
            if (this.cliArgs.enableIPv6 === 'auto') {
                useIPv6 = hasIPv6;
            }
            if (hasIPv6) {
                if (useIPv6) {
                    console.log(color.green('IPv6 support detected'));
                } else {
                    console.log('IPv6 support detected (but disabled)');
                }
            }

            hasIPv4 = this.cliArgs.listen ? ipQuery.hasIPv4Any : ipQuery.hasIPv4Local;
            if (this.cliArgs.enableIPv4 === 'auto') {
                useIPv4 = hasIPv4;
            }
            if (hasIPv4) {
                if (useIPv4) {
                    console.log(color.green('IPv4 support detected'));
                } else {
                    console.log('IPv4 support detected (but disabled)');
                }
            }

            if (this.cliArgs.enableIPv6 === 'auto' && this.cliArgs.enableIPv4 === 'auto') {
                if (!hasIPv6 && !hasIPv4) {
                    console.error('Both IPv6 and IPv4 are not detected');
                    process.exit(1);
                }
            }
        }

        if (!useIPv6 && !useIPv4) {
            console.error('Both IPv6 and IPv4 are disabled or not detected');
            process.exit(1);
        }

        const [v6Failed, v4Failed, v6Error, v4Error] = await this.#startHTTPorHTTPS(useIPv6, useIPv4);
        const result = { v6Failed, v4Failed, v6Error, v4Error, useIPv6, useIPv4 };
        await this.#handleServerListenFail(result);
        return result;
    }
}
