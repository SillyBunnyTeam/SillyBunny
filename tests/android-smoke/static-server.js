import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { closeHttpServer, guardRequestHandler, listenOnFixturePort, parseRequestTarget } from './ports.js';

// Long enough for every asset name the app accepts (up to 196 characters, UpdateManifestParser).
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/** Content types for the files the updater fixture serves. */
export const CONTENT_TYPES = Object.freeze({
    '.apk': 'application/vnd.android.package-archive',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
});

/**
 * Returns the content type for a file name.
 * @param {string} name File name.
 * @returns {string} Content type.
 */
export function contentTypeFor(name) {
    return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Maps a URL path to a file inside the root, refusing traversal, dot files and odd names.
 * @param {string} root Root directory.
 * @param {string} pathname URL path.
 * @returns {string|null} File path.
 */
function resolveFile(root, pathname) {
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }
    const segments = decoded.split('/').slice(1);
    if (segments.length === 0 || segments.some(segment => !SEGMENT.test(segment) || segment.includes('..'))) {
        return null;
    }
    return path.join(root, ...segments);
}

/**
 * Starts a static file server for the app-updater step. Every response carries an exact
 * Content-Length, no Content-Encoding and the file's content type; directories are never listed.
 * @param {object} options Options.
 * @param {string} options.root Directory to serve.
 * @param {string} [options.host] Bind host (default loopback).
 * @param {number} [options.port] Explicit fixture port (default random).
 * @param {number} [options.maxPort] Highest random port (default the top of the fixture range).
 * @param {string} [options.logFile] JSON Lines file that receives one entry per request.
 * @returns {Promise<{host: string, port: number, url: string, root: string, requests: object[], close: () => Promise<void>}>}
 */
export async function startStaticServer({ root, host = '127.0.0.1', port, maxPort, logFile }) {
    const servedRoot = path.resolve(root);
    fs.mkdirSync(servedRoot, { recursive: true });
    if (logFile) {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
    }
    /** @type {object[]} */
    const requests = [];
    const record = (entry) => {
        requests.push(entry);
        if (logFile) {
            fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
        }
    };

    const server = http.createServer(guardRequestHandler(async (request, response) => {
        const url = parseRequestTarget(request);
        const entry = {
            time: new Date().toISOString(),
            method: request.method,
            // A target that URL rejects is logged as it was sent.
            path: url ? url.pathname : String(request.url ?? ''),
            accept: request.headers.accept ?? null,
            acceptEncoding: request.headers['accept-encoding'] ?? null,
            userAgent: request.headers['user-agent'] ?? null,
            status: 0,
            bytes: 0,
        };
        const reply = (status, extraHeaders = {}) => {
            const text = 'TODO(copy)\n';
            response.writeHead(status, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Length': Buffer.byteLength(text),
                'Cache-Control': 'no-store',
                ...extraHeaders,
            });
            response.end(request.method === 'HEAD' ? undefined : text);
            record({ ...entry, status });
        };

        if (!url) {
            reply(400);
            return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            reply(405, { 'Allow': 'GET, HEAD' });
            return;
        }
        const file = resolveFile(servedRoot, url.pathname);
        if (!file) {
            reply(404);
            return;
        }

        let handle;
        try {
            const linkStat = await fs.promises.lstat(file);
            if (!linkStat.isFile()) {
                reply(404);
                return;
            }
            handle = await fs.promises.open(file, 'r');
        } catch {
            reply(404);
            return;
        }

        try {
            // Size and bytes come from the same open file, so Content-Length always matches the body.
            const { size } = await handle.stat();
            response.writeHead(200, {
                'Content-Type': contentTypeFor(file),
                'Content-Length': size,
                'Cache-Control': 'no-store',
                'Accept-Ranges': 'none',
                'X-Content-Type-Options': 'nosniff',
            });
            if (request.method === 'HEAD' || size === 0) {
                response.end();
                record({ ...entry, status: 200, bytes: 0 });
                await handle.close();
                return;
            }
            const stream = handle.createReadStream({ start: 0, end: size - 1, autoClose: true });
            let bytes = 0;
            stream.on('data', chunk => {
                bytes += chunk.length;
            });
            stream.on('error', () => response.destroy());
            response.on('close', () => {
                stream.destroy();
                record({ ...entry, status: 200, bytes, complete: bytes === size });
            });
            stream.pipe(response);
        } catch {
            await handle.close().catch(() => {});
            response.destroy();
        }
    }, record));

    const boundPort = await listenOnFixturePort(server, { host, port, maxPort });
    return {
        host,
        port: boundPort,
        url: `http://${host}:${boundPort}`,
        root: servedRoot,
        requests,
        close: () => closeHttpServer(server),
    };
}
