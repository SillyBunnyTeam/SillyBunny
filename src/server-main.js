import './server-log-buffer.js';

// native node modules
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import dns from 'node:dns';
import process from 'node:process';
import http from 'node:http';
import https from 'node:https';

import cors from 'cors';
import { csrfSync } from 'csrf-sync';
import express from 'express';
import cookieSession from 'cookie-session';
import multer from 'multer';
import responseTime from 'response-time';
import helmet from 'helmet';

// local library imports
import './fetch-patch.js';
import { APP_NAME, isBunRuntime } from './runtime.js';
import { serverDirectory } from './server-directory.js';
import { getServerBootId } from './server-boot-marker.js';

import { serverEvents, EVENT_NAMES } from './server-events.js';
import { loadPlugins } from './plugin-loader.js';
import { registerGracefulShutdown } from './shutdown.js';
import {
    initUserStorage,
    getCookieSecret,
    getCookieSessionName,
    ensurePublicDirectoriesExist,
    getUserDirectoriesList,
    migrateSystemPrompts,
    migrateUserData,
    requireLoginMiddleware,
    setUserDataMiddleware,
    shouldRedirectToLogin,
    cleanUploads,
    getSessionCookieAge,
    getSessionCookieExpires,
    verifySecuritySettings,
    loginPageMiddleware,
    migratePublicOverrides,
} from './users.js';

import getWebpackServeMiddleware from './middleware/webpack-serve.js';
import { FRONTEND_ASSET_PREFIX, rewriteFrontendHtml } from './frontend-assets.js';
import { getFrontendAssetMiddleware, setPublicAssetHeaders, shouldServeFrontendAssets } from './middleware/frontend-assets.js';
import getResponseCompressionMiddleware from './middleware/response-compression.js';
import basicAuthMiddleware from './middleware/basicAuth.js';
import requireHttpsMiddleware from './middleware/requireHttps.js';
import { createSession, destroySession, validateCredentials, isSessionAuthEnabled } from './middleware/sessionAuth.js';
import getWhitelistMiddleware from './middleware/whitelist.js';
import accessLoggerMiddleware, { getAccessLogPath, migrateAccessLog } from './middleware/accessLogWriter.js';
import multerMonkeyPatch from './middleware/multerMonkeyPatch.js';
import initRequestProxy from './request-proxy.js';
import initPrivateRequestFilter from './private-request-filter.js';
import cacheBuster from './middleware/cacheBuster.js';
import corsProxyMiddleware from './middleware/corsProxy.js';
import hostWhitelistMiddleware from './middleware/hostWhitelist.js';
import userCssMiddleware from './middleware/userCss.js';
import { createUploadStorage } from './middleware/uploadStorage.js';
import {
    getVersion,
    color,
    removeColorFormatting,
    getSeparator,
    safeReadFileSync,
    recoverFileWritesInDirectorySync,
    setupLogLevel,
    setWindowTitle,
    getConfigValue,
} from './util.js';
import { isBenignStreamAbort } from './stream-disconnect-guard.js';
import { UPLOADS_DIRECTORY } from './constants.js';

// Routers
import { router as usersPublicRouter } from './endpoints/users-public.js';
import { init as statsInit, onExit as statsOnExit } from './endpoints/stats.js';
import { checkForNewContent, PRESET_CONTENT_TYPES } from './endpoints/content-manager.js';
import { init as settingsInit } from './endpoints/settings.js';
import { ServerStartup, setupPrivateEndpoints } from './server-startup.js';
import { diskCache } from './endpoints/characters.js';
import { migrateFlatSecrets } from './endpoints/secrets.js';
import { migrateGroupChatsMetadataFormat } from './endpoints/groups.js';

// Unrestrict console logs display limit
util.inspect.defaultOptions.maxArrayLength = null;
util.inspect.defaultOptions.maxStringLength = null;
util.inspect.defaultOptions.depth = 4;

/** @type {import('./users.js').UserDirectoryList[]} */
let startupDirectories = [];

/** @type {import('./command-line.js').CommandLineArguments} */
const cliArgs = globalThis.COMMAND_LINE_ARGS;

if (!cliArgs.enableIPv6 && !cliArgs.enableIPv4) {
    console.error('error: You can\'t disable all internet protocols: at least IPv6 or IPv4 must be enabled.');
    process.exit(1);
}

// Set keep-alive preference for all HTTP/HTTPS requests.
http.globalAgent = new http.Agent({ keepAlive: cliArgs.enableKeepAlive });
https.globalAgent = new https.Agent({ keepAlive: cliArgs.enableKeepAlive });

const app = express();
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(getResponseCompressionMiddleware());
app.use(responseTime());

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// CORS Settings //
const corsEnabled = getConfigValue('cors.enabled', true, 'boolean');
if (corsEnabled) {
    const corsOrigin = getConfigValue('cors.origin', 'null');
    const corsMethods = getConfigValue('cors.methods', ['OPTIONS']);
    const corsAllowedHeaders = getConfigValue('cors.allowedHeaders', []);
    const corsExposedHeaders = getConfigValue('cors.exposedHeaders', []);
    const corsCredentials = getConfigValue('cors.credentials', false, 'boolean');
    const corsMaxAge = getConfigValue('cors.maxAge', null, 'number');

    /** @type {cors.CorsOptions} */
    const corsOptions = {
        origin: corsOrigin,
        methods: corsMethods,
        credentials: corsCredentials,
    };
    if (Array.isArray(corsAllowedHeaders) && corsAllowedHeaders.length > 0) {
        corsOptions.allowedHeaders = corsAllowedHeaders;
    }
    if (Array.isArray(corsExposedHeaders) && corsExposedHeaders.length > 0) {
        corsOptions.exposedHeaders = corsExposedHeaders;
    }
    if (corsMaxAge !== null && Number.isInteger(corsMaxAge)) {
        corsOptions.maxAge = corsMaxAge;
    }
    app.use(cors(corsOptions));
}

// HTTPS enforcement (applies to all connections when enabled)
app.use(requireHttpsMiddleware);

// Session auth login/logout endpoints (registered before basic auth to allow unauthenticated login)
if (isSessionAuthEnabled()) {
    app.post('/api/auth/login', express.json(), async (req, res) => {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required.' });
        }
        const valid = await validateCredentials(username, password);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }
        const token = createSession(username);
        return res.json({ token });
    });

    app.post('/api/auth/logout', express.json(), (req, res) => {
        const authHeader = req.headers.authorization;
        if (authHeader) {
            const [scheme, token] = authHeader.split(' ');
            if (scheme === 'Bearer' && token) {
                destroySession(token);
            }
        }
        return res.json({ success: true });
    });
}

app.use(cookieSession({
    name: getCookieSessionName(),
    sameSite: 'lax',
    httpOnly: true,
    maxAge: isBunRuntime() ? undefined : getSessionCookieAge(),
    secret: getCookieSecret(globalThis.DATA_ROOT),
}));

if (isBunRuntime()) {
    app.use((req, _res, next) => {
        // Bun 1.3.11 overflows large millisecond cookie ages via Date.now(),
        // so we provide a concrete expiry date on each request instead.
        req.sessionOptions.expires = getSessionCookieExpires();
        delete req.sessionOptions.maxAge;
        next();
    });
}

if (cliArgs.listen && cliArgs.basicAuthMode) {
    app.use(basicAuthMiddleware);
}

if (cliArgs.whitelistMode) {
    const whitelistMiddleware = await getWhitelistMiddleware();
    app.use(whitelistMiddleware);
}

app.use(hostWhitelistMiddleware);

if (cliArgs.listen) {
    app.use(accessLoggerMiddleware());
}

app.use(setUserDataMiddleware);

function parseCookieHeaderNames(cookieHeader) {
    return String(cookieHeader || '')
        .split(';')
        .map(cookie => cookie.trim().split('=')[0]?.trim())
        .filter(Boolean);
}

function getServerCookieClearDomains(hostname) {
    const cleanHostname = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');

    if (!cleanHostname || cleanHostname === 'localhost' || cleanHostname.includes(':') || /^[\d.]+$/.test(cleanHostname)) {
        return [''];
    }

    const parts = cleanHostname.split('.').filter(Boolean);
    if (parts.length < 2) {
        return [''];
    }

    const domains = new Set(['']);
    for (let index = 0; index < parts.length - 1; index++) {
        const domain = parts.slice(index).join('.');
        domains.add(domain);
        domains.add(`.${domain}`);
    }

    return [...domains];
}

function getServerCookieClearPaths(pathname) {
    const paths = new Set(['/']);
    const segments = String(pathname || '/').split('/').filter(Boolean);
    let currentPath = '';

    for (const segment of segments) {
        currentPath += `/${segment}`;
        paths.add(currentPath);
        paths.add(`${currentPath}/`);
    }

    return [...paths];
}

function isSecureCookieRequest(request) {
    const forwardedProto = request.get('x-forwarded-proto')?.split(',')[0]?.trim();
    return Boolean(request.secure || request.protocol === 'https' || forwardedProto === 'https');
}

// SillyBunny: Clear cookies & cache must also expire HttpOnly cookie-session data.
app.post('/api/cookies/clear', express.json(), (request, response) => {
    const sessionName = getCookieSessionName();
    const cookieNames = new Set([
        ...parseCookieHeaderNames(request.headers.cookie),
        sessionName,
        `${sessionName}.sig`,
        'session',
        'session.sig',
    ]);
    const domains = getServerCookieClearDomains(request.hostname);
    const paths = getServerCookieClearPaths(request.path);
    const secure = isSecureCookieRequest(request);
    let expirationAttempts = 0;

    if (request.session) {
        request.sessionOptions.overwrite = false;
        request.session.handle = null;
        request.session.csrfToken = null;
        request.session = null;
    }

    for (const name of cookieNames) {
        for (const path of paths) {
            for (const domain of domains) {
                const options = {
                    path,
                    sameSite: 'lax',
                    httpOnly: true,
                    expires: new Date(0),
                };

                if (secure) {
                    options.secure = true;
                }

                if (domain) {
                    options.domain = domain;
                }

                try {
                    response.cookie(name, '', options);
                    expirationAttempts++;
                } catch (error) {
                    console.warn(`Failed to queue cookie expiration for ${name}`, error);
                }
            }
        }
    }

    return response.json({
        success: true,
        clearedCookieNames: cookieNames.size,
        expirationAttempts,
    });
});

// CSRF Protection //
function applyCsrfTokenHeaders(res) {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Vary': 'Cookie',
    });
}

if (!cliArgs.disableCsrf) {
    const csrfSyncProtection = csrfSync({
        getTokenFromState: (req) => {
            if (!req.session) {
                console.error('(CSRF error) getTokenFromState: Session object not initialized');
                return;
            }
            return req.session.csrfToken;
        },
        getTokenFromRequest: (req) => {
            return req.headers['x-csrf-token']?.toString();
        },
        storeTokenInState: (req, token) => {
            if (!req.session) {
                console.error('(CSRF error) storeTokenInState: Session object not initialized');
                return;
            }
            req.session.csrfToken = token;
        },
        skipCsrfProtection: (req) => {
            return cliArgs.enableCorsProxy ? /^\/proxy\//.test(req.path) : false;
        },
        size: 32,
    });

    app.get('/csrf-token', (req, res) => {
        applyCsrfTokenHeaders(res);
        res.json({
            'token': csrfSyncProtection.generateToken(req),
        });
    });

    // Customize the error message
    csrfSyncProtection.invalidCsrfTokenError.message = color.red('Invalid CSRF token. Please refresh the page and try again.');
    csrfSyncProtection.invalidCsrfTokenError.stack = undefined;

    app.use(csrfSyncProtection.csrfSynchronisedProtection);
} else {
    console.warn('\nCSRF protection is disabled. This will make your server vulnerable to CSRF attacks.\n');
    app.get('/csrf-token', (req, res) => {
        applyCsrfTokenHeaders(res);
        res.json({
            'token': 'disabled',
        });
    });
}

// Static files
// Host index page
app.get('/', cacheBuster.middleware, (request, response) => {
    if (shouldRedirectToLogin(request)) {
        const query = request.url.split('?')[1];
        const redirectUrl = query ? `/login?${query}` : '/login';
        return response.redirect(redirectUrl);
    }

    if (shouldServeFrontendAssets()) {
        const indexPath = path.join(serverDirectory, 'public', 'index.html');
        const indexHtml = safeReadFileSync(indexPath);
        response.type('html');
        response.set('Cache-Control', 'no-cache');
        return response.send(rewriteFrontendHtml(indexHtml));
    }

    response.set('Cache-Control', 'no-cache');
    return response.sendFile('index.html', { root: path.join(serverDirectory, 'public') });
});

// Callback endpoint for OAuth PKCE flows (e.g. OpenRouter)
app.get('/callback/:source?', (request, response) => {
    const source = request.params.source;
    const query = request.url.split('?')[1];
    const searchParams = new URLSearchParams();
    source && searchParams.set('source', source);
    query && searchParams.set('query', query);
    const path = `/?${searchParams.toString()}`;
    return response.redirect(307, path);
});

// Host login page
app.get('/login', loginPageMiddleware);

// Host frontend assets
const webpackMiddleware = getWebpackServeMiddleware();
const frontendAssetMiddleware = getFrontendAssetMiddleware();
app.use(FRONTEND_ASSET_PREFIX, frontendAssetMiddleware.immutableAssets);
app.use(webpackMiddleware);
app.use(userCssMiddleware);
app.use((request, response, next) => {
    if (!shouldServeFrontendAssets()) {
        return next();
    }

    return frontendAssetMiddleware.publicAssets(request, response, next);
});
app.use(express.static(path.join(serverDirectory, 'public'), { setHeaders: setPublicAssetHeaders }));

// Public API
app.use('/api/users', usersPublicRouter);

// Everything below this line requires authentication
app.use(requireLoginMiddleware);
app.post('/api/ping', (request, response) => {
    if (request.query.extend && request.session) {
        request.session.touch = Date.now();
    }

    response.sendStatus(204);
});

if (cliArgs.enableCorsProxy) {
    app.use('/proxy/:url(*)', corsProxyMiddleware);
} else {
    app.use('/proxy/:url(*)', async (_, res) => {
        const message = 'CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.';
        console.log(message);
        res.status(404).send(message);
    });
}

// File uploads
const uploadsPath = path.join(cliArgs.dataRoot, UPLOADS_DIRECTORY);
// SillyBunny: avoid Bun's recursive mkdir bug on ReadOnly Windows directories.
const uploadStorage = createUploadStorage(uploadsPath);
app.use(multer({ storage: uploadStorage, limits: { fieldSize: 500 * 1024 * 1024 } }).single('avatar'));
app.use(multerMonkeyPatch);

app.get('/version', async function (_, response) {
    const data = await getVersion();
    response.send({
        ...data,
        serverBootId: getServerBootId(),
    });
});

setupPrivateEndpoints(app);

/**
 * Tasks that need to be run before the server starts listening.
 * @returns {Promise<void>}
 */
async function preSetupTasks() {
    const version = await getVersion();

    // Print formatted header
    console.log();
    console.log(`${APP_NAME} v${version.pkgVersion}`);
    if (version.gitBranch && version.commitDate) {
        const date = new Date(version.commitDate);
        const localDate = date.toLocaleString('en-US', { timeZoneName: 'short' });
        console.log(`Running '${version.gitBranch}' (${version.gitRevision}) - ${localDate}`);
        if (!version.isLatest && ['staging', 'release'].includes(version.gitBranch)) {
            console.log('INFO: Currently not on the latest commit.');
            console.log(`      Run 'git pull --ff-only' to update from the tracked upstream for '${version.gitBranch}'. If you have merge conflicts, resolve them before updating.`);
        }
    }
    console.log();

    startupDirectories = await getUserDirectoriesList();
    for (const directories of startupDirectories) {
        recoverFileWritesInDirectorySync(directories.characters);
    }
    await migrateGroupChatsMetadataFormat(startupDirectories);
    await migratePublicOverrides();
    await checkForNewContent(startupDirectories, PRESET_CONTENT_TYPES);
    migrateFlatSecrets(startupDirectories);
    cleanUploads();
    migrateAccessLog();

    await settingsInit();
    await statsInit();

    const pluginsDirectory = path.join(serverDirectory, 'plugins');
    const cleanupPlugins = await loadPlugins(app, pluginsDirectory);
    const consoleTitle = process.title;

    let isExiting = false;
    const exitProcess = async (exitCode = 0) => {
        if (isExiting) return;
        isExiting = true;
        await statsOnExit();
        if (typeof cleanupPlugins === 'function') {
            await cleanupPlugins();
        }
        diskCache.dispose();
        setWindowTitle(consoleTitle);
        process.exit(exitCode);
    };

    registerGracefulShutdown(exitProcess);

    // Set up event listeners for a graceful shutdown
    // SillyBunny: signal handlers pass signal names, but process.exit needs numeric codes in Bun.
    process.on('SIGINT', () => exitProcess(0));
    process.on('SIGTERM', () => exitProcess(0));
    process.on('uncaughtException', (err) => {
        // SillyBunny: ignore expected stream disconnects from cancelled generations.
        if (isBenignStreamAbort(err)) {
            console.warn('Ignored streaming disconnect error:', err?.message ?? err);
            return;
        }

        console.error('Uncaught exception:', err);
        exitProcess();
    });
    process.on('unhandledRejection', (reason) => {
        // SillyBunny: ignore expected stream disconnects from cancelled generations.
        if (isBenignStreamAbort(reason)) {
            console.warn('Ignored streaming disconnect rejection:', reason?.message ?? reason);
            return;
        }

        console.error('Unhandled rejection:', reason);
        exitProcess();
    });

    // Add private request filter.
    const requestFilterOptions = {
        listen: cliArgs.listen,
        enabled: !!getConfigValue('privateAddressWhitelist.enabled', false, 'boolean'),
        privateAddressWhitelist: getConfigValue('privateAddressWhitelist.allowedRanges', ['127.0.0.0/8', '::1/128']),
        logBlocked: !!getConfigValue('privateAddressWhitelist.log.blockedRequests', true, 'boolean'),
        logAllowed: !!getConfigValue('privateAddressWhitelist.log.allowedRequests', false, 'boolean'),
        allowUnresolvedHosts: !!getConfigValue('privateAddressWhitelist.allowUnresolvedHosts', false, 'boolean'),
        enableKeepAlive: cliArgs.enableKeepAlive,
    };
    initPrivateRequestFilter(requestFilterOptions);

    // Add request proxy.
    initRequestProxy({
        enabled: cliArgs.requestProxyEnabled,
        url: cliArgs.requestProxyUrl,
        bypass: cliArgs.requestProxyBypass,
        enableKeepAlive: cliArgs.enableKeepAlive,
        privateRequestFilterEnabled: requestFilterOptions.enabled,
    });

    // Wait for frontend libs to compile
    await webpackMiddleware.runWebpackCompiler();
}

async function runDeferredStartupTasks() {
    if (startupDirectories.length === 0) {
        return;
    }

    try {
        await diskCache.verify(startupDirectories);
    } catch (error) {
        console.error('Deferred startup maintenance failed.', error);
    }
}

/**
 * Tasks that need to be run after the server starts listening.
 * @param {import('./server-startup.js').ServerStartupResult} result The result of the server startup
 * @returns {Promise<void>}
 */
async function postSetupTasks(result) {
    const browserLaunchHostname = await cliArgs.getBrowserLaunchHostname(result);
    const browserLaunchUrl = cliArgs.getBrowserLaunchUrl(browserLaunchHostname);
    const browserLaunchApp = String(getConfigValue('browserLaunch.browser', 'default') ?? '');
    const skipBrowserAutoLaunch = process.env.SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH === '1';

    if (cliArgs.browserLaunchEnabled) {
        if (skipBrowserAutoLaunch) {
            console.log('Skipping browser auto-launch after restart to keep the existing session attached.');
        } else {
            try {
                // Load the browser launcher only when auto-open is enabled.
                const openModule = await import('open');
                const { default: open, apps } = openModule;

                const getBrowsers = () => {
                    const isAndroid = process.platform === 'android';
                    if (isAndroid) {
                        return {};
                    }
                    return {
                        'firefox': apps.firefox,
                        'chrome': apps.chrome,
                        'edge': apps.edge,
                        'brave': apps.brave,
                    };
                };

                const validBrowsers = getBrowsers();
                const appName = validBrowsers[browserLaunchApp.trim().toLowerCase()];
                const openOptions = appName ? { app: { name: appName } } : {};

                console.log(`Launching in a browser: ${browserLaunchApp}...`);
                await open(browserLaunchUrl.toString(), openOptions);
            } catch (error) {
                console.error('Failed to launch the browser. Open the URL manually.', error);
            }
        }
    }

    if (cliArgs.heartbeatInterval > 0) {
        // Convert seconds to milliseconds for the timer
        const intervalMs = cliArgs.heartbeatInterval * 1000;
        const heartbeatPath = path.join(globalThis.DATA_ROOT, 'heartbeat.json');

        console.log(`Heartbeat enabled. Updating ${color.green(heartbeatPath)} every ${cliArgs.heartbeatInterval} seconds`);

        const writeHeartbeat = () => {
            try {
                fs.writeFileSync(heartbeatPath, JSON.stringify({ timestamp: Date.now() }));
            } catch (err) {
                console.error(`Failed to write heartbeat file at ${color.green(heartbeatPath)}:`, err.message);
            }
        };

        // Write immediately
        writeHeartbeat();

        // Loop using the converted milliseconds
        setInterval(writeHeartbeat, intervalMs).unref();
    }

    setWindowTitle(`${APP_NAME} WebServer`);

    let logListen = `${APP_NAME} is listening on`;

    if (result.useIPv6 && !result.v6Failed) {
        logListen += color.green(
            ' IPv6: ' + cliArgs.getIPv6ListenUrl().host,
        );
    }

    if (result.useIPv4 && !result.v4Failed) {
        logListen += color.green(
            ' IPv4: ' + cliArgs.getIPv4ListenUrl().host,
        );
    }

    const goToLog = `Go to: ${color.blue(browserLaunchUrl)} to open ${APP_NAME}`;
    const plainGoToLog = removeColorFormatting(goToLog);

    console.log(logListen);
    if (cliArgs.listen) {
        console.log();
        console.log('To limit connections to internal localhost only ([::1] or 127.0.0.1), change the setting in config.yaml to "listen: false".');
        console.log('Check the "access.log" file in the data directory to inspect incoming connections:', color.green(getAccessLogPath()));
    }
    console.log('\n' + getSeparator(plainGoToLog.length) + '\n');
    console.log(goToLog);
    console.log('\n' + getSeparator(plainGoToLog.length) + '\n');

    setupLogLevel();
    serverEvents.emit(EVENT_NAMES.SERVER_STARTED, { url: browserLaunchUrl });
    void runDeferredStartupTasks();
}

/**
 * Registers a not-found error response if a not-found error page exists. Should only be called after all other middlewares have been registered.
 */
function apply404Middleware() {
    const notFoundWebpage = safeReadFileSync(path.join(serverDirectory, 'public/error/url-not-found.html')) ?? '';
    app.use((req, res) => {
        res.status(404).send(notFoundWebpage);
    });
}

/**
 * Sets the DNS resolution order based on the command line arguments.
 */
function setDnsResolutionOrder() {
    try {
        if (cliArgs.dnsPreferIPv6) {
            dns.setDefaultResultOrder('ipv6first');
            console.log('Preferring IPv6 for DNS resolution');
        } else {
            dns.setDefaultResultOrder('ipv4first');
            console.log('Preferring IPv4 for DNS resolution');
        }
    } catch (error) {
        console.warn('Failed to set DNS resolution order. Possibly unsupported in this runtime.');
    }
}

// User storage module needs to be initialized before starting the server
initUserStorage(globalThis.DATA_ROOT)
    .then(setDnsResolutionOrder)
    .then(ensurePublicDirectoriesExist)
    .then(migrateUserData)
    .then(migrateSystemPrompts)
    .then(verifySecuritySettings)
    .then(preSetupTasks)
    .then(apply404Middleware)
    .then(() => new ServerStartup(app, cliArgs).start())
    .then(postSetupTasks)
    .catch((error) => {
        console.error('A critical error has occurred while starting the server:', error);
        process.exit(1);
    });
