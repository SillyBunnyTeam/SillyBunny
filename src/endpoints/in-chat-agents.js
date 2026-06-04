import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

import { ensureDirectory, tryWriteFileSync } from '../util.js';

export const router = express.Router();

/**
 * Resolves a storage filename for an agent or agent group.
 * @param {string} directory
 * @param {string} id
 * @returns {string}
 */
function getStorageFilename(directory, id) {
    return path.join(directory, sanitize(`${id}.json`));
}

/**
 * Reads and parses JSON files from a directory.
 * @param {string} directory
 * @returns {object[]}
 */
function readJsonDirectory(directory) {
    ensureDirectory(directory);

    return fs.readdirSync(directory)
        .filter(file => path.extname(file).toLowerCase() === '.json')
        .sort()
        .flatMap(file => {
            const filename = path.join(directory, file);

            try {
                return [JSON.parse(fs.readFileSync(filename, 'utf8'))];
            } catch (error) {
                console.warn(`[InChatAgents] Failed to parse "${filename}":`, error);
                return [];
            }
        });
}

/**
 * Validates and normalizes an in-chat agent group payload.
 * @param {unknown} payload
 * @returns {object|null}
 */
function normalizeGroupPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const group = /** @type {Record<string, unknown>} */ (payload);
    const id = String(group.id ?? '').trim();

    if (!id) {
        return null;
    }

    const customAgents = Array.isArray(group.customAgents)
        ? group.customAgents
            .filter(agent => agent && typeof agent === 'object')
            .map(agent => {
                const normalizedAgent = { ...agent };
                delete normalizedAgent.id;
                normalizedAgent.enabled = false;
                return normalizedAgent;
            })
        : [];

    return {
        id,
        name: String(group.name ?? '').trim(),
        description: String(group.description ?? '').trim(),
        agentTemplateIds: Array.isArray(group.agentTemplateIds)
            ? group.agentTemplateIds.map(id => String(id ?? '').trim()).filter(Boolean)
            : [],
        customAgents,
        builtin: false,
    };
}

router.post('/save', (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    ensureDirectory(request.user.directories.inChatAgents);
    const filename = getStorageFilename(request.user.directories.inChatAgents, String(request.body.id));
    tryWriteFileSync(filename, JSON.stringify(request.body, null, 4));

    return response.sendStatus(200);
});

router.post('/delete', (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    ensureDirectory(request.user.directories.inChatAgents);
    const filename = getStorageFilename(request.user.directories.inChatAgents, String(request.body.id));
    if (fs.existsSync(filename)) {
        fs.unlinkSync(filename);
    }

    return response.sendStatus(200);
});

router.post('/groups/list', (_request, response) => {
    const groups = readJsonDirectory(_request.user.directories.inChatAgentGroups)
        .map(normalizeGroupPayload)
        .filter(Boolean)
        .sort((a, b) => {
            const nameCompare = a.name.localeCompare(b.name);
            return nameCompare || a.id.localeCompare(b.id);
        });

    return response.json(groups);
});

router.post('/groups/save', (request, response) => {
    const group = normalizeGroupPayload(request.body);

    if (!group) {
        return response.sendStatus(400);
    }

    ensureDirectory(request.user.directories.inChatAgentGroups);
    const filename = getStorageFilename(request.user.directories.inChatAgentGroups, group.id);
    tryWriteFileSync(filename, JSON.stringify(group, null, 4));

    return response.sendStatus(200);
});

router.post('/groups/delete', (request, response) => {
    const id = String(request.body?.id ?? '').trim();

    if (!id) {
        return response.sendStatus(400);
    }

    ensureDirectory(request.user.directories.inChatAgentGroups);
    const filename = getStorageFilename(request.user.directories.inChatAgentGroups, id);
    if (fs.existsSync(filename)) {
        fs.unlinkSync(filename);
    }

    return response.sendStatus(200);
});
