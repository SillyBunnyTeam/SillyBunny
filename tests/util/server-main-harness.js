/* global globalThis */
import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../../src/util.js';

const src = relative => fileURLToPath(new URL(`../../src/${relative}`, import.meta.url));
const defaultConfigPath = fileURLToPath(new URL('../../default/config.yaml', import.meta.url));
setConfigFilePath(defaultConfigPath);
const realUsers = await import('../../src/users.js');

/**
 * Loads `src/server-main.js` with startup side effects stubbed so tests can exercise its
 * real Express routes and process signal handlers without binding a production port or
 * mutating the repository data directory.
 * @returns {Promise<{ app: import('express').Express, signalHandlers: Map<string, Function[]>, cleanup: () => void }>}
 */
export async function bootServerMainHarness() {
    jest.resetModules();

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-server-main-'));
    const previousDataRoot = globalThis.DATA_ROOT;
    const previousCliArgs = globalThis.COMMAND_LINE_ARGS;

    globalThis.DATA_ROOT = tempRoot;
    globalThis.COMMAND_LINE_ARGS = {
        configPath: defaultConfigPath,
        dataRoot: tempRoot,
        port: 0,
        listen: false,
        listenAddressIPv6: '[::]',
        listenAddressIPv4: '127.0.0.1',
        enableIPv4: true,
        enableIPv6: false,
        dnsPreferIPv6: false,
        heartbeatInterval: 0,
        browserLaunchEnabled: false,
        browserLaunchHostname: 'auto',
        browserLaunchPort: -1,
        browserLaunchAvoidLocalhost: false,
        enableCorsProxy: false,
        disableCsrf: true,
        ssl: false,
        certPath: '',
        keyPath: '',
        keyPassphrase: '',
        whitelistMode: false,
        basicAuthMode: false,
        enableKeepAlive: false,
        requestProxyEnabled: false,
        requestProxyUrl: '',
        requestProxyBypass: [],
        getIPv4ListenUrl: () => new URL('http://127.0.0.1:0/'),
        getIPv6ListenUrl: () => new URL('http://[::1]:0/'),
        getBrowserLaunchHostname: async () => '127.0.0.1',
        getBrowserLaunchUrl: () => new URL('http://127.0.0.1:0/'),
    };

    const { setConfigFilePath } = await import('../../src/util.js');
    setConfigFilePath(defaultConfigPath);

    let capturedApp = null;
    const startupDone = Promise.withResolvers();
    const noopMiddleware = (_req, _res, next) => next();

    await jest.unstable_mockModule(src('server-log-buffer.js'), () => ({
        getServerLogSnapshot: jest.fn(() => ({ entries: [] })),
    }));
    await jest.unstable_mockModule(src('middleware/webpack-serve.js'), () => ({
        default: () => {
            const middleware = (_req, _res, next) => next();
            middleware.runWebpackCompiler = jest.fn(async () => {});
            return middleware;
        },
    }));
    await jest.unstable_mockModule(src('server-startup.js'), () => ({
        setupPrivateEndpoints: jest.fn(),
        ServerStartup: class ServerStartup {
            constructor(app) {
                capturedApp = app;
            }
            async start() {
                return { v4Failed: false, v6Failed: true };
            }
        },
    }));
    await jest.unstable_mockModule(src('users.js'), () => ({
        ...realUsers,
        initUserStorage: jest.fn(async () => {}),
        getCookieSecret: jest.fn(() => 'test-secret'),
        getCookieSessionName: jest.fn(() => 'test-session'),
        ensurePublicDirectoriesExist: jest.fn(async () => {}),
        getUserDirectoriesList: jest.fn(async () => []),
        getAllUserHandles: jest.fn(async () => []),
        migrateSystemPrompts: jest.fn(async () => {}),
        migrateUserData: jest.fn(async () => {}),
        requireLoginMiddleware: noopMiddleware,
        requireAdminMiddleware: noopMiddleware,
        setUserDataMiddleware: noopMiddleware,
        shouldRedirectToLogin: jest.fn(() => false),
        cleanUploads: jest.fn(),
        getSessionCookieAge: jest.fn(() => 0),
        getSessionCookieExpires: jest.fn(() => null),
        verifySecuritySettings: jest.fn(),
        loginPageMiddleware: noopMiddleware,
        migratePublicOverrides: jest.fn(async () => {}),
    }));
    await jest.unstable_mockModule(src('endpoints/users-public.js'), () => ({
        router: (_req, _res, next) => next(),
    }));
    await jest.unstable_mockModule(src('endpoints/content-manager.js'), () => ({
        checkForNewContent: jest.fn(async () => {}),
        PRESET_CONTENT_TYPES: [],
    }));
    await jest.unstable_mockModule(src('endpoints/settings.js'), () => ({
        init: jest.fn(async () => {}),
    }));
    await jest.unstable_mockModule(src('endpoints/stats.js'), () => ({
        init: jest.fn(async () => {}),
        onExit: jest.fn(async () => {}),
    }));
    await jest.unstable_mockModule(src('endpoints/groups.js'), () => ({
        migrateGroupChatsMetadataFormat: jest.fn(async () => {}),
    }));
    await jest.unstable_mockModule(src('endpoints/secrets.js'), () => ({
        migrateFlatSecrets: jest.fn(),
    }));
    await jest.unstable_mockModule(src('endpoints/characters.js'), () => ({
        characterIndex: { close: jest.fn() },
    }));
    await jest.unstable_mockModule(src('conversation-index.js'), () => ({
        conversationIndex: { close: jest.fn() },
    }));
    await jest.unstable_mockModule(src('plugin-loader.js'), () => ({
        getLoadedServerPlugins: jest.fn(() => []),
        loadPlugins: jest.fn(async () => async () => {}),
    }));
    await jest.unstable_mockModule(src('middleware/accessLogWriter.js'), () => ({
        default: () => noopMiddleware,
        getAccessLogPath: jest.fn(() => path.join(tempRoot, 'access.log')),
        migrateAccessLog: jest.fn(),
    }));
    await jest.unstable_mockModule(src('server-listen.js'), () => ({
        closeListeningServers: jest.fn(async () => {}),
    }));
    const { serverEvents, EVENT_NAMES } = await import('../../src/server-events.js');
    serverEvents.once(EVENT_NAMES.SERVER_STARTED, () => startupDone.resolve());
    await jest.unstable_mockModule(src('request-proxy.js'), () => ({
        default: jest.fn(),
    }));
    await jest.unstable_mockModule(src('private-request-filter.js'), () => ({
        default: jest.fn(),
    }));

    const signalHandlers = new Map();
    const originalProcessOn = process.on.bind(process);
    const processOnSpy = jest.spyOn(process, 'on').mockImplementation((event, listener) => {
        if (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].includes(event)) {
            if (!signalHandlers.has(event)) signalHandlers.set(event, []);
            signalHandlers.get(event).push(listener);
            return process;
        }
        return originalProcessOn(event, listener);
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation((...args) => {
        startupDone.reject(new Error(`server-main startup error: ${args.map(String).join(' ')}`));
    });

    try {
        await import('../../src/server-main.js');
        await startupDone.promise;
    } finally {
        processOnSpy.mockRestore();
        logSpy.mockRestore();
        warnSpy.mockRestore();
        infoSpy.mockRestore();
        errorSpy.mockRestore();
    }

    return {
        app: capturedApp,
        signalHandlers,
        cleanup: () => {
            globalThis.DATA_ROOT = previousDataRoot;
            globalThis.COMMAND_LINE_ARGS = previousCliArgs;
            fs.rmSync(tempRoot, { recursive: true, force: true });
        },
    };
}
