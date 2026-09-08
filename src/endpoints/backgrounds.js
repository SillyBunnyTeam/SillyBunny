import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import mime from 'mime-types';
import sanitize from 'sanitize-filename';

import { invalidateThumbnail } from './thumbnails.js';
import { thumbnailDimensions, readMetadataIndex, renameMetadata, removeMetadata, getOrGenerateMetadataBatch } from './image-metadata.js';
import { getImages } from '../util.js';
import { MEDIA_REQUEST_TYPE } from '../constants.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';

export const router = express.Router();

router.post('/all', async function (request, response) {
    try {
        const files = getImages(request.user.directories.backgrounds, 'name', MEDIA_REQUEST_TYPE.IMAGE | MEDIA_REQUEST_TYPE.VIDEO);
        const config = { width: thumbnailDimensions.bg[0], height: thumbnailDimensions.bg[1] };

        // Only generate metadata for actual image files; video files are handled client-side.
        const imageFiles = files.filter(file => String(mime.lookup(file) || '').startsWith('image/'));
        const relativePaths = imageFiles.map(file => path.join('backgrounds', file));
        const { results: metadataMap } = await getOrGenerateMetadataBatch(request.user.directories.root, relativePaths, 'bg');

        // Build response with metadata for each background file.
        const filesWithMetadata = files.map(file => {
            const relativePath = path.join('backgrounds', file);
            const metadata = metadataMap[relativePath];
            const mimeType = String(mime.lookup(file) || '');
            const mediaType = mimeType.startsWith('video/') ? 'video' : 'image';
            return {
                filename: file,
                isAnimated: metadata?.isAnimated ?? mediaType === 'video',
                mediaType,
            };
        });

        response.json({ images: filesWithMetadata, config });
    } catch (error) {
        console.error('[Backgrounds] Error fetching backgrounds:', error);
        response.status(500).json({ error: 'Failed to fetch backgrounds' });
    }
});

/**
 * POST /api/backgrounds/folders
 * Returns folders and per-image folderIds from the metadata index.
 * Loaded separately from /all to avoid blocking image rendering.
 */
router.post('/folders', async function (request, response) {
    try {
        const index = await readMetadataIndex(request.user.directories.root);
        const folders = index.folders || [];

        // Build a slim map of image → folderIds for the frontend
        /** @type {Object.<string, string[]>} */
        const imageFolderMap = {};
        for (const [relativePath, meta] of Object.entries(index.images)) {
            if (Array.isArray(meta.folderIds) && meta.folderIds.length > 0) {
                // Strip the directory prefix to get just the filename
                const filename = relativePath.split('/').pop() || relativePath;
                imageFolderMap[filename] = meta.folderIds;
            }
        }

        response.json({ folders, imageFolderMap });
    } catch (error) {
        console.error('[Backgrounds] Folders endpoint error:', error);
        response.status(500).json({ error: 'Internal server error.' });
    }
});

router.post('/delete', getFileNameValidationFunction('bg'), async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        if (request.body.bg !== sanitize(request.body.bg)) {
            console.error('Malicious bg name prevented');
            return response.sendStatus(403);
        }

        const fileName = path.join(request.user.directories.backgrounds, sanitize(request.body.bg));

        if (!fs.existsSync(fileName)) {
            console.error('BG file not found');
            return response.sendStatus(400);
        }

        fs.unlinkSync(fileName);
        invalidateThumbnail(request.user.directories, 'bg', request.body.bg);

        // Remove metadata for deleted image
        const relativePath = path.join('backgrounds', request.body.bg);
        await removeMetadata(request.user.directories.root, relativePath).catch(err => {
            console.warn('[Backgrounds] Failed to remove metadata:', err.message);
        });

        return response.send('ok');
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});

router.post('/rename', async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        const oldFileName = path.join(request.user.directories.backgrounds, sanitize(request.body.old_bg));
        const newFileName = path.join(request.user.directories.backgrounds, sanitize(request.body.new_bg));

        if (!fs.existsSync(oldFileName)) {
            console.error('BG file not found');
            return response.sendStatus(400);
        }

        if (fs.existsSync(newFileName)) {
            console.error('New BG file already exists');
            return response.sendStatus(400);
        }

        fs.copyFileSync(oldFileName, newFileName);
        fs.unlinkSync(oldFileName);
        invalidateThumbnail(request.user.directories, 'bg', request.body.old_bg);

        // Update metadata for renamed image
        const oldRelativePath = path.join('backgrounds', request.body.old_bg);
        const newRelativePath = path.join('backgrounds', request.body.new_bg);
        await renameMetadata(request.user.directories.root, oldRelativePath, newRelativePath).catch(err => {
            console.warn('[Backgrounds] Failed to rename metadata:', err.message);
        });

        return response.send('ok');
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});

// SillyBunny: distinct routes keep native overwrites separate from create-only installs.
router.post('/upload', (request, response) => uploadBackground(request, response));
router.post('/upload-new', (request, response) => uploadBackground(request, response, true));

async function uploadBackground(request, response, createOnly = false) {
    let img_path;
    try {
        img_path = request.file && path.join(request.file.destination, request.file.filename);
        if (!request.body || !request.file) return response.sendStatus(400);

        const filename = sanitize(request.file.originalname);
        fs.copyFileSync(img_path, path.join(request.user.directories.backgrounds, filename), createOnly ? fs.constants.COPYFILE_EXCL : 0);
        fs.unlinkSync(img_path);
        img_path = undefined;
        invalidateThumbnail(request.user.directories, 'bg', filename);

        // Generate metadata for the new image
        const relativePath = path.join('backgrounds', filename);
        await getOrGenerateMetadataBatch(request.user.directories.root, [relativePath], 'bg').catch(err => {
            console.warn('[Backgrounds] Failed to generate metadata for upload:', err.message);
        });

        response.status(createOnly ? 201 : 200).send(filename);
    } catch (err) {
        if (createOnly && err?.code === 'EEXIST') {
            return response.sendStatus(409);
        }
        console.error(err);
        response.sendStatus(500);
    } finally {
        if (img_path) {
            try {
                fs.rmSync(img_path, { force: true });
            } catch (error) {
                console.error(error);
            }
        }
    }
}
