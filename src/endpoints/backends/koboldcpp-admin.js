import fetch from 'node-fetch';
import express from 'express';

import { TEXTGEN_TYPES } from '../../constants.js';
import { setAdditionalHeadersByType } from '../../additional-headers.js';
import { trimV1 } from '../../util.js';

export const router = express.Router();

const REQUEST_TIMEOUT_MS = 10_000;
const POLL_TIMEOUT_MS = 5_000;
const ADMIN_ACTIONS = ['initial_model', 'unload_model'];
const ENTRY_TYPE_ORDER = ['model', 'config', 'action'];

/**
 * @typedef {object} SwitcherEntry
 * @property {string} name Option string exactly as KoboldCpp listed it; reload_config only accepts that exact string.
 * @property {'model'|'config'|'action'} type Entry kind
 */

/**
 * Gets the KoboldCpp base URL from a request body.
 * @param {any} body Request body
 * @returns {string} Base URL without a trailing slash or /v1, or an empty string if the URL is not valid
 */
function getBaseUrl(body) {
    if (typeof body?.api_server !== 'string') {
        return '';
    }

    try {
        const url = new URL(body.api_server.trim());
        if (!['http:', 'https:'].includes(url.protocol)) {
            return '';
        }
        // Same substitution as the status endpoint: KoboldCpp listens on IPv4 by default, and Node can resolve localhost to ::1 first.
        if (url.hostname === 'localhost') {
            url.hostname = '127.0.0.1';
        }
        return trimV1(url.toString());
    } catch {
        return '';
    }
}

/**
 * KoboldCpp checks its admin password as a Bearer token and also accepts that password on its other endpoints,
 * so the KoboldCpp API key secret can hold the admin password.
 * @param {import('express').Request} request Express request
 * @param {string} baseUrl KoboldCpp base URL
 * @returns {Record<string, string>} Request headers
 */
function getHeaders(request, baseUrl) {
    const headers = { 'Content-Type': 'application/json' };
    setAdditionalHeadersByType(headers, TEXTGEN_TYPES.KOBOLDCPP, baseUrl, request.user.directories, request.body.secret_id ?? null);
    return headers;
}

/**
 * @param {string} url Request URL
 * @param {import('node-fetch').RequestInit} options Fetch options
 * @param {number} timeoutMs Timeout in milliseconds
 * @returns {Promise<any>} Parsed JSON body
 */
async function fetchJson(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
    const result = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    if (!result.ok) {
        throw new Error(`${result.status} ${result.statusText}`);
    }
    return result.json();
}

/**
 * @param {string} name Option string from KoboldCpp
 * @returns {string} File name without the folder
 */
function getFileName(name) {
    // KoboldCpp joins subfolder entries with the separator of the machine it runs on.
    return name.split(/[\\/]/).pop() ?? name;
}

/**
 * Sorts KoboldCpp admin options into switcher entries.
 * Projector files and the later parts of split models are dropped because KoboldCpp cannot load them as the main model.
 * @param {unknown} options Response of GET /api/admin/list_options
 * @returns {SwitcherEntry[]} Entries grouped by type, with models and configs in natural order
 */
export function getSwitcherEntries(options) {
    if (!Array.isArray(options)) {
        return [];
    }

    /** @type {SwitcherEntry[]} */
    const entries = [];
    for (const name of options) {
        if (typeof name !== 'string' || !name) {
            continue;
        }
        if (ADMIN_ACTIONS.includes(name)) {
            entries.push({ name, type: 'action' });
            continue;
        }
        if (/\.kcpp[st]$/i.test(name)) {
            entries.push({ name, type: 'config' });
            continue;
        }
        if (!/\.gguf$/i.test(name)) {
            continue;
        }

        const fileName = getFileName(name);
        const shard = /-(\d+)-of-\d+\.gguf$/i.exec(fileName);
        if (/mmproj/i.test(fileName) || (shard && Number(shard[1]) !== 1)) {
            continue;
        }
        entries.push({ name, type: 'model' });
    }

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return entries.sort((a, b) => ENTRY_TYPE_ORDER.indexOf(a.type) - ENTRY_TYPE_ORDER.indexOf(b.type)
        || (a.type === 'action' ? ADMIN_ACTIONS.indexOf(a.name) - ADMIN_ACTIONS.indexOf(b.name) : collator.compare(a.name, b.name)));
}

/**
 * Finds the model file behind the name KoboldCpp reports for the loaded model.
 * KoboldCpp reports "koboldcpp/" plus the file name without its extension, after deleting every character
 * outside Python's \w, "." and "-". The same filter runs on each model entry here.
 * @param {SwitcherEntry[]} entries Switcher entries
 * @param {unknown} loadedModel Model ID from /v1/models, for example "koboldcpp/Foo-7B.Q4_K_M"
 * @returns {string|null} Matching entry name, or null when no model file matches
 */
export function findLoadedFile(entries, loadedModel) {
    const prefix = 'koboldcpp/';
    if (typeof loadedModel !== 'string' || !loadedModel.startsWith(prefix)) {
        return null;
    }

    const loadedName = loadedModel.slice(prefix.length);
    const match = entries.find(entry => entry.type === 'model'
        && getFileName(entry.name).replace(/\.gguf$/i, '').replace(/[^\p{L}\p{N}_.-]/gu, '') === loadedName);
    return match?.name ?? null;
}

router.post('/models', async function (request, response) {
    const baseUrl = getBaseUrl(request.body);
    if (!baseUrl) {
        return response.sendStatus(400);
    }

    const headers = getHeaders(request, baseUrl);

    /** @type {any} */
    let version;
    try {
        version = await fetchJson(`${baseUrl}/api/extra/version`, { headers });
    } catch (error) {
        console.warn('KoboldCpp version request failed:', error.message);
        return response.status(502).send({ error: true });
    }

    // KoboldCpp reports 0 when admin mode is off, 1 when it is on, and 2 when it also needs the admin password.
    const admin = [1, 2].includes(Number(version?.admin)) ? Number(version.admin) : 0;

    /** @type {SwitcherEntry[]} */
    let entries = [];
    if (admin) {
        try {
            entries = getSwitcherEntries(await fetchJson(`${baseUrl}/api/admin/list_options`, { headers }));
        } catch (error) {
            console.warn('KoboldCpp admin options request failed:', error.message);
        }
    }

    /** @type {string|null} */
    let loadedModel = null;
    try {
        const models = await fetchJson(`${baseUrl}/v1/models`, { headers });
        const id = models?.data?.[0]?.id;
        loadedModel = typeof id === 'string' ? id : null;
    } catch (error) {
        console.warn('KoboldCpp model request failed:', error.message);
    }

    return response.send({
        admin,
        entries,
        loadedModel,
        loadedFile: findLoadedFile(entries, loadedModel),
    });
});

router.post('/load', async function (request, response) {
    const baseUrl = getBaseUrl(request.body);
    const filename = request.body?.filename;
    if (!baseUrl || typeof filename !== 'string' || !filename) {
        return response.sendStatus(400);
    }

    try {
        console.info('Asking KoboldCpp to load:', filename);
        const result = await fetchJson(`${baseUrl}/api/admin/reload_config`, {
            method: 'POST',
            headers: getHeaders(request, baseUrl),
            body: JSON.stringify({ filename }),
        });
        return response.send({ success: result?.success === true });
    } catch (error) {
        console.warn('KoboldCpp load request failed:', error.message);
        return response.status(502).send({ error: true });
    }
});

// KoboldCpp restarts its worker process to load a model. The old worker keeps answering for a short time
// after the load request, so the client waits for an uptime shorter than the time since its request.
router.post('/uptime', async function (request, response) {
    const baseUrl = getBaseUrl(request.body);
    if (!baseUrl) {
        return response.sendStatus(400);
    }

    try {
        const perf = await fetchJson(`${baseUrl}/api/extra/perf`, { headers: getHeaders(request, baseUrl) }, POLL_TIMEOUT_MS);
        const uptime = Number(perf?.uptime);
        return response.send({ online: true, uptime: Number.isFinite(uptime) ? uptime : null });
    } catch {
        return response.send({ online: false, uptime: null });
    }
});
