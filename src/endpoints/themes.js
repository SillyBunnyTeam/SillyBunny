import path from 'node:path';
import fs from 'node:fs';

import express from 'express';
import sanitize from 'sanitize-filename';

import { tryWriteFileSync } from '../util.js';
// SillyBunny: shared exclusive-create helper for /create and Bundled Extras.
import { publishNewFile } from '../sillybunny-publish-file.js';

export const router = express.Router();

router.post('/save', (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    const filename = path.join(request.user.directories.themes, sanitize(`${request.body.name}.json`));
    tryWriteFileSync(filename, JSON.stringify(request.body, null, 4));

    return response.sendStatus(200);
});

// SillyBunny: installers publish a complete theme without replacing native edits.
router.post('/create', (request, response) => {
    if (typeof request.body?.name !== 'string' || !request.body.name.trim()) {
        return response.sendStatus(400);
    }

    try {
        // SillyBunny: the shared helper links exclusively, and copies exclusively where the file system has no hard links.
        const created = publishNewFile(request.user.directories.themes, sanitize(`${request.body.name}.json`), JSON.stringify(request.body, null, 4));
        return response.sendStatus(created ? 201 : 409);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/delete', (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    try {
        const filename = path.join(request.user.directories.themes, sanitize(`${request.body.name}.json`));
        if (!fs.existsSync(filename)) {
            console.error('Theme file not found:', filename);
            return response.sendStatus(404);
        }
        fs.unlinkSync(filename);
        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
