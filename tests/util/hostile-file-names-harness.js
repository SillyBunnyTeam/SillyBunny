import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';

import { write as writeCard } from '../../src/character-card-parser.js';
import { setConfigFilePath } from '../../src/util.js';

export const USER_HANDLE = 'default-user';
export const OUTSIDE_FILE_TEXT = 'outside-file-contents';
export const OUTSIDE_LISTING_NAME = 'outside-listing-entry.png';
export const SEED_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=', 'base64');

const BOUNDARY = 'hostile-file-names-boundary';
const REQUEST_TIMEOUT_MS = 20_000;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const isWindows = process.platform === 'win32';

export const onWindows = labels => (isWindows ? labels : []);
export const onPosix = labels => (isWindows ? [] : labels);

const ABSOLUTE_FOLDER = 'absolute path of the outside folder';
const ABSOLUTE_FILE = 'absolute path of the sentinel';

export const EVERY_INPUT = Symbol('every input');
// An absolute path holds a slash on POSIX systems and a backslash on Windows, so it changes group by platform.
export const SLASHES = ['../x', '/etc/x', '../outside', '../../outside', '../../../outside', '../../../../outside', '../outside/sentinel', '../../outside/sentinel', '../../../outside/sentinel', '../../../../outside/sentinel', ...onPosix([ABSOLUTE_FOLDER, ABSOLUTE_FILE])];
export const BACKSLASHES = ['..\\x', 'C:\\x', '\\\\host\\share\\x', '..\\..\\outside', '..\\..\\outside\\sentinel', ...onWindows([ABSOLUTE_FOLDER, ABSOLUTE_FILE])];
export const NUL_BYTE = ['a<NUL>b'];
export const RESERVED = ['CON', 'nul', 'COM1', 'aux.txt'];
export const TRAILING = ['x.', 'x<space>'];
export const LONG = ['300 characters'];
export const DOTS = ['.', '..'];
export const EMPTY = ['empty'];
export const ENCODED = ['%2e%2e%2f'];
export const MULTIPART = ['../../x.png'];

const STANDARD_INPUTS = Object.freeze([
    ['../x', '../x'],
    ['..\\x', '..\\x'],
    ['/etc/x', '/etc/x'],
    ['C:\\x', 'C:\\x'],
    ['\\\\host\\share\\x', '\\\\host\\share\\x'],
    ['a<NUL>b', 'a\0b'],
    ['CON', 'CON'],
    ['nul', 'nul'],
    ['COM1', 'COM1'],
    ['aux.txt', 'aux.txt'],
    ['x.', 'x.'],
    ['x<space>', 'x '],
    ['300 characters', 'a'.repeat(300)],
    ['.', '.'],
    ['..', '..'],
    ['empty', ''],
].map(([label, value]) => Object.freeze({ label, value })));

const ENCODED_TRAVERSAL = Object.freeze({ label: '%2e%2e%2f', value: '%2e%2e%2f', raw: true });
const MULTIPART_TRAVERSAL = Object.freeze({ label: '../../x.png', value: '../../x.png' });

/**
 * Sets the process up the way the server does before any router loads.
 * Routers read configuration when they load and some folders are relative to the working directory,
 * so call this before the dynamic imports of the routers.
 * @returns {{ tempRoot: string, dataRoot: string, restore: () => void }}
 */
export function prepareEnvironment() {
    const originalWorkingDirectory = process.cwd();
    const originalDataRoot = global.DATA_ROOT;
    const tempRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-hostile-'));
    const dataRoot = path.join(tempRoot, 'data');
    fs.mkdirSync(dataRoot);

    process.chdir(repoRoot);
    setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));
    // The character disk cache writes under the data root on a timer, so it would change the hashed tree.
    process.env.SILLYTAVERN_PERFORMANCE_USEDISKCACHE = 'false';
    // A throttled chat backup fires on a timer after a burst of saves, so it would land during a later request.
    process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '1';
    global.DATA_ROOT = dataRoot;

    return {
        tempRoot,
        dataRoot,
        restore() {
            process.chdir(originalWorkingDirectory);
            global.DATA_ROOT = originalDataRoot;
            delete process.env.SILLYTAVERN_PERFORMANCE_USEDISKCACHE;
            delete process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL;
            fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
        },
    };
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Maps every entry under a folder to the hash of its contents.
 * @param {string} root Folder to walk
 * @param {Set<string>} [skipped] Absolute paths to leave out with everything under them
 * @returns {Map<string, string>} Relative path to content hash, or to 'folder'
 */
export function hashTree(root, skipped = new Set()) {
    const entries = new Map();
    const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const fullPath = path.join(directory, entry.name);
            if (skipped.has(fullPath)) {
                continue;
            }
            const relativePath = path.relative(root, fullPath).replaceAll(path.sep, '/');
            if (entry.isDirectory()) {
                entries.set(relativePath, 'folder');
                walk(fullPath);
            } else {
                entries.set(relativePath, sha256(fs.readFileSync(fullPath)));
            }
        }
    };
    walk(root);
    return entries;
}

export function diffTrees(before, after) {
    const changes = [];
    for (const [key, value] of after) {
        if (before.get(key) !== value) {
            changes.push(key);
        }
    }
    for (const key of before.keys()) {
        if (!after.has(key)) {
            changes.push(key);
        }
    }
    return changes.sort();
}

function buildMultipart(fields, file) {
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
        parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    if (file) {
        // The multipart parser reads a backslash in a quoted file name as an escape.
        const quotedName = file.name.replaceAll('\\', '\\\\');
        parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="avatar"; filename="${quotedName}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`));
        parts.push(file.content);
        parts.push(Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
    return Buffer.concat(parts);
}

function encodeValue(input) {
    return input.raw ? input.value : encodeURIComponent(input.value);
}

function buildRequest(row, input) {
    let target = `${row.mount}${row.path}`;
    const fixed = row.fixed ?? {};

    switch (row.transport) {
        case 'query': {
            const query = Object.entries(fixed).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
            query.push(`${encodeURIComponent(row.field)}=${encodeValue(input)}`);
            return { method: row.method, target: `${target}?${query.join('&')}`, headers: {} };
        }
        case 'param':
            target = target.replace(`:${row.field}`, encodeValue(input));
            return { method: row.method, target, headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(fixed)) };
        case 'multipart': {
            const body = buildMultipart({ ...fixed, [row.field]: input.value }, row.file ?? { name: 'upload.png', type: 'image/png', content: SEED_PNG });
            return { method: row.method, target, headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` }, body };
        }
        case 'filename': {
            const body = buildMultipart(fixed, { name: input.value, type: 'image/png', content: row.fileContent ?? SEED_PNG });
            return { method: row.method, target, headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` }, body };
        }
        default: {
            const payload = row.wrap ? { ...fixed, ...row.wrap(input.value) } : { ...fixed, [row.field]: input.value };
            return { method: row.method, target, headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(payload)) };
        }
    }
}

function sendRequest(port, { method, target, headers, body }) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1',
            port,
            method,
            path: target,
            headers: body ? { ...headers, 'Content-Length': body.length } : headers,
            agent: false,
            timeout: REQUEST_TIMEOUT_MS,
        }, (response) => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
        });
        request.on('timeout', () => request.destroy(new Error('The route did not answer')));
        request.on('error', reject);
        request.end(body);
    });
}

/**
 * Starts an Express app with the upload stack of the real server and the given routers.
 * @param {{ tempRoot: string, dataRoot: string }} environment Result of prepareEnvironment()
 * @param {Record<string, import('express').Router>} routers Routers by mount path
 * @returns {Promise<object>} Harness
 */
export async function startHarness(environment, routers) {
    // The server installs this patch at startup, and Jimp needs it to load its WASM codecs from file URLs.
    await import('../../src/fetch-patch.js');
    const { getUserDirectories } = await import('../../src/users.js');
    const { createUploadStorage } = await import('../../src/middleware/uploadStorage.js');
    const { default: multerMonkeyPatch } = await import('../../src/middleware/multerMonkeyPatch.js');

    const { tempRoot, dataRoot } = environment;
    const directories = getUserDirectories(USER_HANDLE);
    const userRoot = directories.root;
    const uploadsRoot = path.join(dataRoot, '_uploads');
    const outsideRoot = path.join(dataRoot, 'outside');
    for (const directory of [...Object.values(directories), uploadsRoot, outsideRoot]) {
        fs.mkdirSync(directory, { recursive: true });
    }

    for (const name of ['sentinel', 'sentinel.json', 'sentinel.jsonl', 'sentinel.txt']) {
        fs.writeFileSync(path.join(outsideRoot, name), OUTSIDE_FILE_TEXT);
    }
    fs.writeFileSync(path.join(outsideRoot, 'sentinel.png'), SEED_PNG);
    fs.writeFileSync(path.join(outsideRoot, OUTSIDE_LISTING_NAME), SEED_PNG);

    const seedCard = JSON.stringify({
        name: 'seed',
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: { name: 'seed', first_mes: 'hello', extensions: {} },
    });
    const chatFile = `${JSON.stringify({ user_name: 'user', character_name: 'seed', create_date: '2026-01-01', chat_metadata: {} })}\n${JSON.stringify({ name: 'seed', mes: 'hello', is_user: false, send_date: '2026-01-01' })}\n`;
    const seedFiles = {
        'characters/seed.png': writeCard(SEED_PNG, seedCard),
        'characters/other.png': writeCard(SEED_PNG, seedCard),
        'characters/seed/joy.png': SEED_PNG,
        'chats/seed/seed.jsonl': chatFile,
        'backgrounds/seed.png': SEED_PNG,
        'User Avatars/seed.png': SEED_PNG,
        'themes/seed.json': '{}',
        'QuickReplies/seed.json': '{}',
        'movingUI/seed.json': '{}',
        'OpenAI Settings/seed.json': '{}',
        'user/images/seed/seed.png': SEED_PNG,
        'user/files/seed.txt': 'seed',
        'user/workflows/seed.json': '{}',
        'user/workflows/Default_Comfy_Workflow.json': '{}',
        'worlds/seed.json': '{"entries":{}}',
        'groups/seed.json': JSON.stringify({ id: 'seed', name: 'seed', members: [], chat_id: 'seedchat', chats: ['seedchat'] }),
        'group chats/seedchat.jsonl': chatFile,
        'assets/bgm/seed.mp3': 'seed',
        'InChatAgents/seed.json': '{}',
        'InChatAgentGroups/seed.json': '{}',
        'backups/chat_seed.jsonl': chatFile,
        [`backups/settings_${USER_HANDLE}_seed.json`]: '{}',
        'extensions/seed/manifest.json': '{}',
        'vectors/webllm/seed/seed.json': '{}',
        'settings.json': '{}',
    };
    for (const [relativePath, content] of Object.entries(seedFiles)) {
        const target = path.join(userRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }

    const outsideTreeSkip = new Set([userRoot, uploadsRoot]);
    const baseline = hashTree(userRoot);
    let outsideTree = hashTree(tempRoot, outsideTreeSkip);

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    app.use(multer({ storage: createUploadStorage(uploadsRoot) }).single('avatar'));
    app.use(multerMonkeyPatch);
    app.use((request, _response, next) => {
        request.user = {
            profile: { handle: USER_HANDLE, name: 'hostile', admin: true },
            directories,
        };
        next();
    });
    for (const [mount, router] of Object.entries(routers)) {
        app.use(mount, router);
    }

    const server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const { port } = server.address();

    const restoreUserTree = () => {
        for (const key of diffTrees(baseline, hashTree(userRoot)).reverse()) {
            const target = path.join(userRoot, key);
            if (!baseline.has(key)) {
                fs.rmSync(target, { recursive: true, force: true, maxRetries: 5 });
            } else if (baseline.get(key) === 'folder') {
                fs.mkdirSync(target, { recursive: true });
            } else {
                fs.rmSync(target, { recursive: true, force: true, maxRetries: 5 });
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, seedFiles[key]);
            }
        }
    };

    return {
        directories,
        userRoot,
        outsideRoot,
        /**
         * Restores the seeded user folder, sends one input through a row and reports what changed on disk.
         * @param {object} row Route table row
         * @param {{ value: string, raw?: boolean }} input Input value
         * @returns {Promise<{ status: number, text: string, outsideChanges: string[], userChanges: string[] }>}
         */
        async run(row, input) {
            restoreUserTree();
            const response = await sendRequest(port, buildRequest(row, input));
            const outsideAfter = hashTree(tempRoot, outsideTreeSkip);
            const outsideChanges = diffTrees(outsideTree, outsideAfter);
            outsideTree = outsideAfter;
            return {
                status: response.status,
                text: response.body.toString('latin1'),
                outsideChanges,
                userChanges: diffTrees(baseline, hashTree(userRoot)),
            };
        },
        restoreUserTree,
        async close() {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        },
    };
}

export function inputsForRow(row, harness) {
    const inputs = [...STANDARD_INPUTS];
    if (row.transport === 'param') {
        inputs.push(ENCODED_TRAVERSAL);
    }
    if (row.transport === 'filename') {
        inputs.push(MULTIPART_TRAVERSAL);
    }
    // A one-level traversal from the standard list stays inside the user root, so these reach for the outside folder itself.
    for (const climb of ['../', '../../', '../../../', '../../../../']) {
        inputs.push({ label: `${climb}outside`, value: `${climb}outside` });
        inputs.push({ label: `${climb}outside/sentinel`, value: `${climb}outside/sentinel` });
    }
    inputs.push({ label: '..\\..\\outside', value: '..\\..\\outside' });
    inputs.push({ label: '..\\..\\outside\\sentinel', value: '..\\..\\outside\\sentinel' });
    inputs.push({ label: ABSOLUTE_FOLDER, value: harness.outsideRoot });
    inputs.push({ label: ABSOLUTE_FILE, value: path.join(harness.outsideRoot, 'sentinel') });
    return inputs.filter(input => !row.leftOut?.includes(input.label));
}

/**
 * Sends the plain value and every input of a table row, and lists what went wrong.
 * An input passes when the route refuses it with a status from the row's reject set, or when the row lists it
 * under sanitized and the route answers with a success. A 500 passes only for an input that the row lists under
 * serverError. Every input must leave the tree outside the user folder unchanged, change nothing in the user
 * folder except the paths under the row's writes, and keep outside contents out of the answer.
 * @param {object} harness Harness
 * @param {object} row Route table row
 * @returns {Promise<string[]>} One message for each failed check, so an empty list means that the row passes
 */
export async function checkRow(harness, row) {
    const sanitized = row.sanitized === EVERY_INPUT ? null : new Set([row.sanitized ?? []].flat(Infinity));
    const serverError = new Set([row.serverError ?? []].flat(Infinity));
    const writes = row.writes ?? [];
    const failures = [];

    if (row.plain !== undefined) {
        const { status } = await harness.run(row, { value: row.plain });
        if (status < 200 || status >= 300) {
            failures.push(`plain value ${row.plain}: answered ${status}, so this row does not reach the name handling`);
        }
    }

    for (const input of inputsForRow(row, harness)) {
        const { label } = input;
        let result;
        try {
            result = await harness.run(row, input);
        } catch (error) {
            failures.push(`${label}: ${error.message}`);
            continue;
        }
        const { status, text, outsideChanges, userChanges } = result;
        const isSuccess = status >= 200 && status < 300;

        if (isSuccess && sanitized && !sanitized.has(label)) {
            failures.push(`${label}: accepted with ${status}, but this row must refuse it`);
        }
        if (status >= 500 && !serverError.has(label)) {
            failures.push(`${label}: answered ${status}, which this row does not list for this input`);
        }
        if (!isSuccess && status < 500 && !row.reject.includes(status)) {
            failures.push(`${label}: answered ${status}, which is not in the reject set ${row.reject.join(', ')}`);
        }
        if (outsideChanges.length > 0) {
            failures.push(`${label}: changed the tree outside the user folder: ${outsideChanges.join(', ')}`);
        }
        const strayChanges = userChanges.filter(change => !writes.some(allowed => change === allowed || change.startsWith(`${allowed}/`)));
        if (strayChanges.length > 0) {
            failures.push(`${label}: changed paths the row does not allow: ${strayChanges.join(', ')}`);
        }
        if (text.includes(OUTSIDE_FILE_TEXT) || text.includes(OUTSIDE_LISTING_NAME)) {
            failures.push(`${label}: answered with contents from outside the user folder`);
        }
        if (isSuccess && row.body !== undefined && text !== row.body) {
            failures.push(`${label}: answered ${JSON.stringify(text.slice(0, 80))}, expected ${JSON.stringify(row.body)}`);
        }
    }
    return failures;
}
