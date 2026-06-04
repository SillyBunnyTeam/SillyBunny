import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

import { tryWriteFileSync } from '../util.js';
import {
    clearDefaultPresetDeletion,
    findDefaultPreset,
    getDefaultPresetFile,
    getDefaultPresets,
    isDefaultPresetDeleted,
    recordDefaultPresetDeletion,
    restoreDefaultPresetFiles,
} from './content-manager.js';

/**
 * Gets the folder and extension for the preset settings based on the API source ID.
 * @param {string} apiId API source ID
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {{folder: string?, extension: string?}} Object containing the folder and extension for the preset settings
 */
function getPresetSettingsByAPI(apiId, directories) {
    switch (apiId) {
        case 'kobold':
        case 'koboldhorde':
            return { folder: directories.koboldAI_Settings, extension: '.json' };
        case 'novel':
            return { folder: directories.novelAI_Settings, extension: '.json' };
        case 'textgenerationwebui':
            return { folder: directories.textGen_Settings, extension: '.json' };
        case 'openai':
            return { folder: directories.openAI_Settings, extension: '.json' };
        case 'instruct':
            return { folder: directories.instruct, extension: '.json' };
        case 'context':
            return { folder: directories.context, extension: '.json' };
        case 'sysprompt':
            return { folder: directories.sysprompt, extension: '.json' };
        case 'reasoning':
            return { folder: directories.reasoning, extension: '.json' };
        default:
            return { folder: null, extension: null };
    }
}

function getPresetContentTypeByAPI(apiId) {
    switch (apiId) {
        case 'kobold':
        case 'koboldhorde':
            return 'kobold_preset';
        case 'novel':
            return 'novel_preset';
        case 'textgenerationwebui':
            return 'textgen_preset';
        case 'openai':
            return 'openai_preset';
        case 'instruct':
        case 'context':
        case 'sysprompt':
        case 'reasoning':
            return apiId;
        default:
            return null;
    }
}

export const router = express.Router();

router.post('/save', function (request, response) {
    const name = sanitize(request.body.name);
    if (!request.body.preset || !name) {
        return response.sendStatus(400);
    }

    const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
    const filename = name + settings.extension;

    if (!settings.folder) {
        return response.sendStatus(400);
    }

    const fullpath = path.join(settings.folder, filename);
    const defaultPreset = findDefaultPreset(request.user.directories, { folder: settings.folder, name });
    const explicitDefaultRestore = Boolean(request.body.restoreDefault);

    if (defaultPreset && isDefaultPresetDeleted(request.user.directories, defaultPreset) && !explicitDefaultRestore) {
        return response.status(409).send({
            error: 'This bundled default preset was deleted by the user and will not be recreated unless defaults are explicitly restored.',
            isDeletedDefault: true,
            name,
        });
    }

    if (defaultPreset && explicitDefaultRestore) {
        clearDefaultPresetDeletion(request.user.directories, defaultPreset);
    }

    tryWriteFileSync(fullpath, JSON.stringify(request.body.preset, null, 4));
    return response.send({ name });
});

router.post('/delete', function (request, response) {
    const name = sanitize(request.body.name);
    if (!name) {
        return response.sendStatus(400);
    }

    const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
    const filename = name + settings.extension;

    if (!settings.folder) {
        return response.sendStatus(400);
    }

    const fullpath = path.join(settings.folder, filename);

    const defaultPreset = findDefaultPreset(request.user.directories, { folder: settings.folder, name });

    if (fs.existsSync(fullpath)) {
        if (defaultPreset) {
            recordDefaultPresetDeletion(request.user.directories, defaultPreset);
        }

        fs.unlinkSync(fullpath);
        return response.sendStatus(200);
    }

    if (defaultPreset) {
        recordDefaultPresetDeletion(request.user.directories, defaultPreset);
        return response.sendStatus(200);
    }

    return response.sendStatus(404);
});

router.post('/restore', function (request, response) {
    try {
        const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
        const name = sanitize(request.body.name);
        const defaultPresets = getDefaultPresets(request.user.directories);

        const defaultPreset = defaultPresets.find(p => p.name === name && p.folder === settings.folder);

        const result = { isDefault: false, preset: {}, tombstoneCleared: false };

        if (defaultPreset) {
            result.isDefault = true;
            result.preset = getDefaultPresetFile(defaultPreset.filename) || {};
            if (request.body.clearTombstone === true) {
                result.tombstoneCleared = clearDefaultPresetDeletion(request.user.directories, defaultPreset);
            }
        }

        return response.send(result);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/restore-defaults', function (request, response) {
    try {
        const apiId = request.body.apiId ? String(request.body.apiId) : '';
        const contentType = apiId ? getPresetContentTypeByAPI(apiId) : null;

        if (apiId && !contentType) {
            return response.sendStatus(400);
        }

        const result = restoreDefaultPresetFiles(request.user.directories, contentType ? [contentType] : null);

        return response.send({
            ok: result.failed.length === 0,
            ...result,
        });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
