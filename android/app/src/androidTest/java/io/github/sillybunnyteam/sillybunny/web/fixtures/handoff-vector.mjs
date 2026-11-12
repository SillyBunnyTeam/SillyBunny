// The fixed handoff vector of BrowserHandoffTest, computed and checked with the server's own code
// (src/middleware/launchToken.js). Usage: node handoff-vector.mjs [code]
// Without [code] it prints the server's code for the fixed inputs; with [code] (for example the one the
// Kotlin test prints) it also reports whether the middleware accepts it once (the cookie and the page that
// moves to /), then rejects its replay and its use after expiry.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let root = path.dirname(fileURLToPath(import.meta.url));
while (!fs.existsSync(path.join(root, 'src', 'middleware', 'launchToken.js'))) {
    const parent = path.dirname(root);
    if (parent === root) {
        throw new Error('src/middleware/launchToken.js not found');
    }
    root = parent;
}
const middleware = await import(pathToFileURL(path.join(root, 'src', 'middleware', 'launchToken.js')).href);

const token = '0123456789abcdef'.repeat(4);
const nonce = Buffer.from([...Array(16).keys()]);
const expiry = 1_700_000_030_000;
const now = expiry - 30_000;

const serverCode = middleware.createHandoffCode(token, { nonce, expiry });
const candidate = process.argv[2] ?? serverCode;

function call(handler, url) {
    return new Promise((resolve) => {
        const headers = {};
        const res = {
            statusCode: 200,
            setHeader: (name, value) => {
                headers[name.toLowerCase()] = value;
            },
            end: (body = '') => resolve({ status: res.statusCode, headers, body: String(body) }),
        };
        handler({ method: 'GET', url, headers: {} }, res, () => resolve({ status: 'next', headers, body: '' }));
    });
}

const gate = middleware.default({ token, now: () => now });
const first = await call(gate, `/__sillybunny/handoff?c=${candidate}`);
const replay = await call(gate, `/__sillybunny/handoff?c=${candidate}`);
const late = await call(middleware.default({ token, now: () => expiry }), `/__sillybunny/handoff?c=${candidate}`);
console.log(JSON.stringify({
    serverCode,
    candidateMatchesServer: candidate === serverCode,
    first: {
        status: first.status,
        location: first.headers.location,
        contentType: first.headers['content-type'],
        cacheControl: first.headers['cache-control'],
        setCookie: first.headers['set-cookie'],
        bodyIsHandoffPage: first.body === middleware.HANDOFF_PAGE,
    },
    replayStatus: replay.status,
    expiredStatus: late.status,
}, null, 1));
