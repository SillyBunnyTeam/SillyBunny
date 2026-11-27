// Host fixture server for WebShellDeviceTest: the repository's own launch-token middleware
// (src/middleware/launchToken.js) in front of the fixture pages next to this file, plus a second
// listener that stands in for another service on a different loopback port, and a third that stands in
// for the OpenRouter sign-in. The request log names the listener: "app" (behind the gate), "hop" (the
// redirector outside the gate), "other" and "other-ws" (anything there escaped the shell, or was sent by a
// browser that holds the cookie), and "provider".
//
// Usage: node fixture-server.mjs <stateFile>
// Binds 127.0.0.1 on three random free ports in 20000-60999 (never 4444), writes
// {"port","other","provider","token","pid"} to <stateFile> and runs until killed. The device reaches the ports
// through `adb reverse tcp:<p> tcp:<p>`; the test reads them from the instrumentation arguments fixturePort,
// fixtureOther, fixtureProvider and fixtureToken.
//
// Each log entry also says whether a WebView sent the request (its user agent has "; wv)"), so a test that
// drives the device's browser can tell the browser's requests apart, and which kind of host name the
// request, its Referer and its Origin used: "ip" (127.0.0.1), "localhost", "named" (other.localhost),
// "provider" (provider.localhost) or "label" (the app's per-install <label>.localhost). The label itself is
// never logged: request URLs are logged with it replaced by "<label>".
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
let providerPort = 0;
const LABEL = /sb-[a-z2-7]{26}/gi;

/** The kind of host name in a Host header or URL host: never the name itself. */
function hostKind(value) {
    const host = String(value ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    if (!host) return 'none';
    if (host === '127.0.0.1') return 'ip';
    if (host === 'localhost') return 'localhost';
    if (host === 'other.localhost') return 'named';
    if (host === 'provider.localhost') return 'provider';
    if (/^sb-[a-z2-7]{26}\.localhost$/.test(host)) return 'label';
    return 'unknown';
}

function urlKind(value) {
    if (!value) return 'none';
    if (value === 'null') return 'opaque';
    try {
        return hostKind(new URL(value).host);
    } catch {
        return 'unparsable';
    }
}

function record(listener, req, status) {
    const cookie = req.headers.cookie ?? '';
    log.push({
        at: Date.now(),
        listener,
        method: req.method,
        url: String(req.url).replace(LABEL, '<label>'),
        status,
        launchCookie: cookie.includes(`${LAUNCH_COOKIE_NAME}=${token}`),
        anyCookie: cookie.length > 0,
        webView: /; wv\)/.test(req.headers['user-agent'] ?? ''),
        host: hostKind(req.headers.host),
        referer: urlKind(req.headers.referer),
        origin: urlKind(req.headers.origin),
    });
}

function send(res, status, type, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
    res.end(body);
}

/** The request's host name without the port: the label, when the app's WebView or browser asked. */
function requestHost(req) {
    return String(req.headers.host ?? '127.0.0.1').replace(/:\d+$/, '');
}

function page(name, port, req) {
    const file = path.join(here, 'pages', name);
    if (!fs.existsSync(file)) {
        return null;
    }
    return fs.readFileSync(file, 'utf8')
        .replaceAll('{{OTHER}}', String(otherPort))
        .replaceAll('{{PROVIDER}}', String(providerPort))
        .replaceAll('{{PORT}}', String(port))
        .replaceAll('{{HOST}}', requestHost(req));
}

// The host names a redirect to the other listener can use. "label" is the app's own label host, taken from
// the request, so only a page that the app loaded (and that therefore knows the label) can ask for it.
function otherHost(kind, req) {
    switch (kind) {
        case 'localhost': return 'localhost';
        case 'named': return 'other.localhost';
        case 'label': return requestHost(req);
        default: return '127.0.0.1';
    }
}

// A 302 to the other listener. `?to=/<path>` picks the target path, so the test can tell which probe a
// request that arrived there came from (the default is /redirected); `&host=<kind>` picks the host name.
function redirectToOther(res, url, req) {
    const to = url.searchParams.get('to');
    const target = to && /^\/[a-z0-9-]+$/.test(to) ? to : '/redirected';
    const host = otherHost(url.searchParams.get('host'), req);
    res.writeHead(302, { Location: `http://${host}:${otherPort}${target}`, 'Cache-Control': 'no-store' });
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
        // The shell refuses that first hop, as it refuses every local name but the app origin.
        if (url.pathname === '/__fixture/redirect-other') {
            record('hop', req, 302);
            return redirectToOther(res, url, req);
        }
        const end = res.end.bind(res);
        res.end = (...args) => {
            record('app', req, res.statusCode);
            return end(...args);
        };
        // Like helmet's default on the real server: no Referer leaves the app's pages.
        res.setHeader('Referrer-Policy', 'no-referrer');
        gate(req, res, () => {
            if (url.pathname === '/png') {
                return send(res, 200, 'image/png', png);
            }
            if (url.pathname === '/sw.js') {
                return send(res, 200, 'application/javascript', page('sw.js', port, req), { 'Service-Worker-Allowed': '/' });
            }
            if (url.pathname === '/sw-probe') {
                return send(res, 200, 'text/plain', `probe ${url.search}`);
            }
            if (url.pathname === '/redirect-other') {
                return redirectToOther(res, url, req);
            }
            // The real server's OAuth callback route (src/server-main.js, `/callback/:source?`): 307 to
            // /?source=<source>&query=<the raw query>.
            const callback = /^\/callback(?:\/([^/]+))?\/?$/.exec(url.pathname);
            if (callback) {
                const query = req.url.split('?')[1];
                const params = new URLSearchParams();
                if (callback[1]) params.set('source', decodeURIComponent(callback[1]));
                if (query) params.set('query', query);
                res.writeHead(307, { Location: `/?${params.toString()}`, 'Cache-Control': 'no-store' });
                return res.end();
            }
            const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
            const body = /^[a-z0-9-]+\.html$/.test(name) ? page(name, port, req) : null;
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

const STYLE = '<style>body{margin:0;font:16px sans-serif}.b{display:block;box-sizing:border-box;width:calc(100% - 16px);' +
    'height:52px;margin:6px 8px;background:#ccd;border:0;font:16px sans-serif;line-height:52px;text-align:center;' +
    'color:#000;text-decoration:none}</style>';

// A page of the stand-in provider. `back` is where it sends the browser once the user signed in.
function providerPage(title, back) {
    const script = JSON.stringify(back).replaceAll('<', '\\u003c');
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        `${STYLE}<title>${title}</title></head><body>` +
        `<a class="b" id="sign-in" href="/sign-in?back=${encodeURIComponent(back)}">sign in</a>` +
        '<a class="b" id="elsewhere" href="https://example.com/provider-elsewhere">elsewhere</a>' +
        '<script>window.results = { bridge: typeof globalThis.sillybunnyTransfers, ' +
        "api: typeof globalThis[Symbol.for('sillybunny.transfers')] };" +
        `window.fx = { back() { location.href = ${script}; return 'ok'; } };` +
        // `&auto=1`: the page sends the browser back by itself, for a browser that the test cannot script.
        "if (new URLSearchParams(location.search).get('auto')) setTimeout(() => window.fx.back(), 500);</script>" +
        '</body></html>';
}

// The stand-in for https://openrouter.ai: /auth sends the browser back to callback_url with a code, by a page
// (the default; at once with `&auto=1`) or by a 302 (`&mode=302`). /sign-in is another page of the provider.
function provider(req, res) {
    const url = new URL(req.url, 'http://provider.localhost');
    if (url.pathname === '/auth') {
        const back = `${url.searchParams.get('callback_url') ?? ''}?code=fixture-code`;
        if (url.searchParams.get('mode') === '302') {
            record('provider', req, 302);
            res.writeHead(302, { Location: back, 'Cache-Control': 'no-store' });
            return res.end();
        }
        record('provider', req, 200);
        return send(res, 200, 'text/html; charset=utf-8', providerPage('fixture-provider', back));
    }
    if (url.pathname === '/sign-in') {
        record('provider', req, 200);
        return send(res, 200, 'text/html; charset=utf-8', providerPage('fixture-provider-sign-in', url.searchParams.get('back') ?? ''));
    }
    record('provider', req, 404);
    send(res, 404, 'text/plain', 'missing');
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

const otherServer = await listen(() => other);
otherPort = otherServer.port;
// WebSocket handshakes cannot be intercepted by the shell; record them to measure the residual exposure.
otherServer.server.on('upgrade', (req, socket) => {
    record('other-ws', req, 101);
    socket.destroy();
});
const providerServer = await listen(() => provider);
providerPort = providerServer.port;
const appServer = await listen(app);
// A TLS ClientHello on the cleartext port (an HTTPS upgrade) is logged, not answered.
appServer.server.on('clientError', (error, socket) => {
    if (error.rawPacket && error.rawPacket[0] === 0x16) {
        log.push({ at: Date.now(), listener: 'app', method: 'TLS', url: '-', status: 0, launchCookie: false, anyCookie: false,
            webView: false, host: 'none', referer: 'none', origin: 'none' });
    }
    socket.destroy();
});
fs.writeFileSync(stateFile, JSON.stringify({ port: appServer.port, other: otherPort, provider: providerPort, token, pid: process.pid }));
console.log(`fixture app=${appServer.port} other=${otherPort} provider=${providerPort} pid=${process.pid}`);
