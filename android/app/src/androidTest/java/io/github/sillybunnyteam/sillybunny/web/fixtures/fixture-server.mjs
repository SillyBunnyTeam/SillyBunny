// Host fixture server for WebShellDeviceTest: the repository's own launch-token middleware
// (src/middleware/launchToken.js) in front of the fixture pages next to this file, plus a second
// listener that stands in for another service on a different loopback port. The request log names
// the listener: "app" (behind the gate), "hop" (the redirector outside the gate), "other" and
// "other-ws" (anything there escaped the shell, or was sent by a browser that holds the cookie).
//
// Usage: node fixture-server.mjs <stateFile>
// Binds 127.0.0.1 on two random free ports in 20000-60999, writes {"port","other","token","pid"} to
// <stateFile> and runs until killed. The device reaches both ports through `adb reverse tcp:<p> tcp:<p>`;
// the test reads them from the instrumentation arguments fixturePort, fixtureOther and fixtureToken.
//
// Each log entry also says whether a WebView sent the request (its user agent has "; wv)"), so a test that
// drives the device's browser can tell the browser's requests apart.
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
    throw new Error('usage: node fixture-server.mjs <stateFile>');
}

const token = crypto.randomBytes(32).toString('hex');
const gate = createLaunchTokenMiddleware({ token });
const log = [];
// A 1x1 PNG for the clipboard image case.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let otherPort = 0;

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
        webView: /; wv\)/.test(req.headers['user-agent'] ?? ''),
    });
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
    return fs.readFileSync(file, 'utf8').replaceAll('{{OTHER}}', String(otherPort)).replaceAll('{{PORT}}', String(port));
}

// A 302 to the other listener. `?to=/<path>` picks the target path, so the test can tell which probe a
// request that arrived there came from; the default is /redirected.
function redirectToOther(res, url) {
    const to = url.searchParams.get('to');
    const target = to && /^\/[a-z0-9-]+$/.test(to) ? to : '/redirected';
    res.writeHead(302, { Location: `http://127.0.0.1:${otherPort}${target}`, 'Cache-Control': 'no-store' });
    return res.end();
}

function app(port) {
    return (req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        // Fixture control endpoints sit in front of the gate, so the test can read them without the cookie.
        if (url.pathname === '/__fixture/log') {
            return send(res, 200, 'application/json', JSON.stringify(log));
        }
        if (url.pathname === '/__fixture/reset') {
            log.length = 0;
            return send(res, 200, 'text/plain', 'ok');
        }
        // A redirector outside the gate, reached as http://localhost:<port>: another site than the app origin.
        // The app allows cleartext only to 127.0.0.1, so on devices WebView refuses that first hop; the external
        // https redirector (fixtureExternalRedirector) measures the cross-site hop instead.
        if (url.pathname === '/__fixture/redirect-other') {
            record('hop', req, 302);
            return redirectToOther(res, url);
        }
        const end = res.end.bind(res);
        res.end = (...args) => {
            record('app', req, res.statusCode);
            return end(...args);
        };
        gate(req, res, () => {
            if (url.pathname === '/png') {
                return send(res, 200, 'image/png', png);
            }
            if (url.pathname === '/sw.js') {
                return send(res, 200, 'application/javascript', page('sw.js', port), { 'Service-Worker-Allowed': '/' });
            }
            if (url.pathname === '/sw-probe') {
                return send(res, 200, 'text/plain', `probe ${url.search}`);
            }
            if (url.pathname === '/redirect-other') {
                return redirectToOther(res, url);
            }
            const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
            const body = /^[a-z0-9-]+\.html$/.test(name) ? page(name, port) : null;
            if (body === null) {
                return send(res, 404, 'text/plain', 'missing');
            }
            return send(res, 200, 'text/html; charset=utf-8', body);
        });
    };
}

// Anything that reaches this listener escaped the shell's containment. GET /b-<name> stands in for a page that
// another app opens in the browser: its own image (/b-sub?from=<name>) and WebSocket (/b-ws?from=<name>) show
// what the browser sends to this port by itself.
function other(req, res) {
    record('other', req, 200);
    const name = /^\/b-([a-z0-9-]+)$/.exec(req.url)?.[1];
    if (req.method === 'GET' && name) {
        return send(res, 200, 'text/html; charset=utf-8', '<!doctype html><html><head><meta charset="utf-8">' +
            `<title>fixture-other</title></head><body><img src="/b-sub?from=${name}" width="1" height="1">` +
            `<script>try { new WebSocket('ws://' + location.host + '/b-ws?from=${name}'); } catch (e) {}</script>` +
            '</body></html>');
    }
    send(res, 200, 'text/plain', 'other');
}

function listen(handler) {
    return new Promise((resolve, reject) => {
        const attempt = (count) => {
            const port = 20000 + crypto.randomInt(41000);
            const server = http.createServer(handler(port));
            server.once('error', (error) => (count < 20 ? attempt(count + 1) : reject(error)));
            server.listen(port, '127.0.0.1', () => resolve({ server, port }));
        };
        attempt(0);
    });
}

const otherServer = await listen(() => other);
otherPort = otherServer.port;
// WebSocket handshakes cannot be intercepted by the shell; record them to measure the residual exposure.
otherServer.server.on('upgrade', (req, socket) => {
    record('other-ws', req, 101);
    socket.destroy();
});
const appServer = await listen(app);
fs.writeFileSync(stateFile, JSON.stringify({ port: appServer.port, other: otherPort, token, pid: process.pid }));
console.log(`fixture app=${appServer.port} other=${otherPort} pid=${process.pid}`);
