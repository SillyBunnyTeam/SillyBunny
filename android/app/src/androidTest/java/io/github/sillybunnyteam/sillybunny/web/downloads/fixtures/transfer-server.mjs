// Host fixture server for the transfer device tests (WebTransfersDeviceTest, SafFileChooserDeviceTest):
// the repository's own launch-token middleware (src/middleware/launchToken.js) in front of download and
// file-picker fixture pages, plus a second listener that stands in for another service on a different
// loopback port and records everything that reaches it.
//
// Usage: node transfer-server.mjs <stateFile>
// Binds 127.0.0.1 on two random free ports in 20000-60999, writes {"port","other","token","pid"} to
// <stateFile> and runs until killed. The device reaches both ports through `adb reverse tcp:<p> tcp:<p>`;
// the tests read them from the instrumentation arguments fixturePort, fixtureOther and fixtureToken.
//
// Test bodies are deterministic: byte i of a body with seed s is (i * 31 + s) & 0xff, the same formula
// the pages and the Kotlin tests use.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function findRepositoryRoot(start) {
    let current = start;
    while (!fs.existsSync(path.join(current, 'src', 'middleware', 'launchToken.js'))) {
        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error('src/middleware/launchToken.js not found above ' + start);
        }
        current = parent;
    }
    return current;
}

const middlewareUrl = pathToFileURL(path.join(findRepositoryRoot(here), 'src', 'middleware', 'launchToken.js')).href;
const { default: createLaunchTokenMiddleware, LAUNCH_COOKIE_NAME } = await import(middlewareUrl);

const stateFile = process.argv[2];
if (!stateFile) {
    throw new Error('usage: node transfer-server.mjs <stateFile>');
}

const token = crypto.randomBytes(32).toString('hex');
const gate = createLaunchTokenMiddleware({ token });
const log = [];
let otherPort = 0;
let appPort = 0;

function record(listener, req, status) {
    const cookie = req.headers.cookie ?? '';
    log.push({
        at: Date.now(),
        listener,
        method: req.method,
        url: req.url,
        status,
        launchCookie: cookie.includes(`${LAUNCH_COOKIE_NAME}=${token}`),
        anyCookie: cookie.length > 0,
        userAgent: req.headers['user-agent'] ?? '',
    });
}

function pattern(length, seed) {
    const body = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index++) {
        body[index] = (index * 31 + seed) & 0xff;
    }
    return body;
}

function send(res, status, type, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
    res.end(body);
}

function page(name, port) {
    const file = path.join(here, 'pages', name);
    if (!fs.existsSync(file)) {
        return null;
    }
    return fs.readFileSync(file, 'utf8')
        .replaceAll('{{OTHER}}', String(otherPort))
        .replaceAll('{{APP}}', String(appPort))
        .replaceAll('{{PORT}}', String(port));
}

// Streams `body` in 64 KiB pieces, `delay` ms apart, so a test can cancel a transfer while it runs. With
// `cut`, the connection breaks once that many bytes went out, short of the declared length.
function stream(res, body, delay, cut = Infinity) {
    let offset = 0;
    const next = () => {
        if (res.destroyed) {
            return;
        }
        if (offset >= cut) {
            res.destroy();
            return;
        }
        if (offset >= body.length) {
            res.end();
            return;
        }
        const piece = body.subarray(offset, offset + 65536);
        offset += piece.length;
        res.write(piece);
        setTimeout(next, delay);
    };
    next();
}

function drain(req) {
    return new Promise((resolve) => {
        req.on('data', () => {});
        req.on('end', resolve);
        req.on('error', resolve);
    });
}

function app(port) {
    return async (req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        // Fixture control endpoints sit in front of the gate, so the tests can read them without the cookie.
        if (url.pathname === '/__fixture/log') {
            return send(res, 200, 'application/json', JSON.stringify(log));
        }
        if (url.pathname === '/__fixture/reset') {
            log.length = 0;
            return send(res, 200, 'text/plain', 'ok');
        }
        const end = res.end.bind(res);
        let recorded = false;
        res.end = (...args) => {
            if (!recorded) {
                recorded = true;
                record('app', req, res.statusCode);
            }
            return end(...args);
        };
        res.on('close', () => {
            if (!recorded) {
                recorded = true;
                record('app', req, res.statusCode);
            }
        });
        gate(req, res, async () => {
            await drain(req);
            const n = Math.min(Number(url.searchParams.get('n') ?? 1024), 512 * 1024 * 1024);
            const seed = Number(url.searchParams.get('seed') ?? 1) & 0xff;
            if (url.pathname === '/bytes') {
                const headers = { 'Content-Length': String(n) };
                const disposition = url.searchParams.get('disposition');
                if (disposition) {
                    headers['Content-Disposition'] = disposition;
                }
                const delay = Number(url.searchParams.get('delay') ?? 0);
                const cut = Number(url.searchParams.get('cut') ?? Infinity);
                res.writeHead(200, {
                    'Content-Type': url.searchParams.get('type') ?? 'application/octet-stream',
                    'Cache-Control': 'no-store',
                    ...headers,
                });
                return delay > 0 ? stream(res, pattern(n, seed), delay, cut) : res.end(pattern(n, seed));
            }
            if (url.pathname === '/attachment') {
                // Like the server's five attachment responses: the header names a file, whatever the method.
                const name = url.searchParams.get('name') ?? 'report.json';
                return send(res, 200, url.searchParams.get('type') ?? 'application/json', pattern(n, seed), {
                    'Content-Disposition': `attachment; filename="${name}"`,
                    'Content-Length': String(n),
                });
            }
            if (url.pathname === '/redirect') {
                res.writeHead(Number(url.searchParams.get('code') ?? 302), {
                    Location: url.searchParams.get('to') ?? '/',
                    'Cache-Control': 'no-store',
                });
                return res.end();
            }
            if (url.pathname === '/status') {
                return send(res, Number(url.searchParams.get('code') ?? 500), 'text/plain', 'status');
            }
            const name = url.pathname === '/' ? 'transfers.html' : url.pathname.slice(1);
            const body = /^[a-z0-9-]+\.html$/.test(name) ? page(name, port) : null;
            if (body === null) {
                return send(res, 404, 'text/plain', 'missing');
            }
            return send(res, 200, 'text/html; charset=utf-8', body);
        });
    };
}

// Anything that reaches this listener left the app origin. It serves the pages for the cross-origin
// frame checks and answers everything else with bytes, so a leaked download would produce a save.
function other() {
    return (req, res) => {
        record('other', req, 200);
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/frame.html' || url.pathname === '/post.html') {
            return send(res, 200, 'text/html; charset=utf-8', page(url.pathname.slice(1), otherPort));
        }
        return send(res, 200, 'application/octet-stream', pattern(4096, 7), {
            'Content-Disposition': 'attachment; filename="other.bin"',
        });
    };
}

function listen(handler) {
    return new Promise((resolve, reject) => {
        const attempt = (count) => {
            const port = 20000 + crypto.randomInt(41000);
            if (port === 4444) {
                attempt(count + 1);
                return;
            }
            const server = http.createServer(handler(port));
            server.once('error', (error) => (count < 20 ? attempt(count + 1) : reject(error)));
            server.listen(port, '127.0.0.1', () => resolve({ server, port }));
        };
        attempt(0);
    });
}

const otherServer = await listen(other);
otherPort = otherServer.port;
const appServer = await listen(app);
appPort = appServer.port;
fs.writeFileSync(stateFile, JSON.stringify({ port: appServer.port, other: otherPort, token, pid: process.pid }));
console.log(`fixture app=${appServer.port} other=${otherPort} pid=${process.pid}`);
