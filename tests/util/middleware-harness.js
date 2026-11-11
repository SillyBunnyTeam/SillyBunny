import { jest } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../../default/config.yaml', import.meta.url));

export const PASSED_BODY = 'reached the handler';

const openServers = [];

/**
 * Gives the next server module imports a fresh registry and this configuration.
 * Import a config-reading module with a dynamic import() after this call, because a static import
 * keeps the instance from before the reset.
 * @param {Record<string, string>} [env] SILLYTAVERN_* variables to set. This function removes all others.
 * @param {string|null} [configPath] Config file for keys without a variable. Pass null when the code under test sets the path.
 */
export async function resetServerModules(env = {}, configPath = DEFAULT_CONFIG_PATH) {
    jest.resetModules();
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('SILLYTAVERN_')) {
            delete process.env[key];
        }
    }
    Object.assign(process.env, env);
    if (configPath !== null) {
        const { setConfigFilePath } = await import('../../src/util.js');
        setConfigFilePath(configPath);
    }
}

export function createTempDirectory(prefix) {
    return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));
}

export function removeTempDirectory(directory) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
}

export function writeErrorPage(dataRoot, fileName, content) {
    const errorsDirectory = path.join(dataRoot, '_errors');
    fs.mkdirSync(errorsDirectory, { recursive: true });
    fs.writeFileSync(path.join(errorsDirectory, fileName), content);
}

/**
 * The server stays open until closeApps.
 */
export async function startApp(...middlewares) {
    const app = express();
    for (const middleware of middlewares) {
        app.use(middleware);
    }
    app.use((_request, response) => response.status(200).send(PASSED_BODY));
    const server = await new Promise((resolve, reject) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        listening.once('error', reject);
    });
    openServers.push(server);
    const { port } = server.address();
    return { port, url: `http://127.0.0.1:${port}/` };
}

export async function closeApps() {
    await Promise.all(openServers.splice(0).map(server => new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    })));
}

/**
 * fetch replaces a Host header with the address in the URL, so a test that sets Host needs this function.
 */
export function sendRequest(port, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, headers, agent: false }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                body += chunk;
            });
            response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
        });
        request.once('error', reject);
        request.end();
    });
}

/**
 * Node answers 400 to an HTTP/1.1 request without Host before Express runs, so this request uses HTTP/1.0.
 */
export function sendRequestWithoutHost(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write('GET / HTTP/1.0\r\n\r\n'));
        let raw = '';
        socket.setEncoding('utf8');
        socket.on('data', chunk => {
            raw += chunk;
        });
        socket.once('end', () => {
            const headerEnd = raw.indexOf('\r\n\r\n');
            resolve({ status: Number(raw.split(' ')[1]), body: raw.slice(headerEnd + 4) });
        });
        socket.once('error', reject);
    });
}

/**
 * Runs a middleware against a fake request, for cases that a socket on 127.0.0.1 cannot produce.
 * The result has passed set to true when the middleware called next.
 */
export function callMiddleware(middleware, request) {
    return new Promise((resolve, reject) => {
        const result = { passed: false, status: undefined, body: undefined };
        const finish = body => {
            result.body = body;
            resolve(result);
            return response;
        };
        const response = {
            headersSent: false,
            status(code) {
                result.status = code;
                return response;
            },
            set: () => response,
            vary: () => response,
            send: finish,
            json: finish,
            sendStatus(code) {
                result.status = code;
                return finish();
            },
        };
        const next = () => {
            result.passed = true;
            resolve(result);
        };
        Promise.resolve(middleware(request, response, next)).catch(reject);
    });
}

/**
 * Call it after resetServerModules, because the storage belongs to the current module registry.
 * alice signs in with alice-pass, bob is disabled, carol has no password and dave has no salt.
 */
export async function seedAccounts(dataRoot) {
    const { getPasswordHash, initUserStorage, toKey } = await import('../../src/users.js');
    const { default: storage } = await import('node-persist');
    const salt = 'c2FsdC1mb3ItdGVzdHM=';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await initUserStorage(dataRoot);
    logSpy.mockRestore();
    await storage.setItem(toKey('alice'), { handle: 'alice', enabled: true, password: getPasswordHash('alice-pass', salt), salt });
    await storage.setItem(toKey('bob'), { handle: 'bob', enabled: false, password: getPasswordHash('bob-pass', salt), salt });
    await storage.setItem(toKey('carol'), { handle: 'carol', enabled: true, password: '', salt });
    await storage.setItem(toKey('dave'), { handle: 'dave', enabled: true, password: 'stored-hash' });
}
