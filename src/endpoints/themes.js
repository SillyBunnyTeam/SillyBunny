import path from 'node:path';
import fs from 'node:fs';

import express from 'express';
import sanitize from 'sanitize-filename';

import { ensureDirectory, tryWriteFileSync } from '../util.js';

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

    let tempDirectory;
    try {
        const directory = request.user.directories.themes;
        const filename = path.join(directory, sanitize(`${request.body.name}.json`));
        if (!ensureDirectory(directory)) return response.sendStatus(500);
        tempDirectory = fs.mkdtempSync(path.join(directory, '.theme-create-'));
        const tempPath = path.join(tempDirectory, 'theme.json');
        tryWriteFileSync(tempPath, JSON.stringify(request.body, null, 4), 'utf8', { expectedFileAbsent: true, durable: true });
        // Linking is exclusive across processes; partial writes stay outside the theme inventory.
        try {
            fs.linkSync(tempPath, filename);
        } catch (error) {
            if (error?.code === 'EEXIST') {
                return response.sendStatus(409);
            }
            throw error;
        }
        return response.sendStatus(201);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    } finally {
        if (tempDirectory) {
            try {
                fs.rmSync(tempDirectory, { recursive: true, force: true });
            } catch (error) {
                console.error(error);
            }
        }
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
