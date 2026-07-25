import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { Jimp, JimpMime } from '../jimp.js';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { imageSize as sizeOf } from 'image-size';

import { getConfigValue, invalidateFirefoxCache } from '../util.js';
import {
    getThumbnailResolution,
    getThumbnailMobileResolution,
    isAnimatedWebP,
    isAnimatedApng,
    thumbnailDimensions as dimensions,
    thumbnailMobileDimensions as mobileDimensions,
} from './image-metadata.js';
import { ResizeStrategy } from '@jimp/plugin-resize';
import { safeCover } from '../jimp-safe.js';

export const publicRouter = express.Router();
export const apiRouter = express.Router();

export const SKIPPED_EXTENSIONS = new Set(['.apng', '.mp4', '.webm', '.avi', '.mkv', '.flv', '.gif']);
export const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.apng']);

const thumbnailRuntimeSettings = {
    enabled: !!getConfigValue('thumbnails.enabled', true, 'boolean'),
    quality: Math.min(100, Math.max(1, parseInt(getConfigValue('thumbnails.quality', 100, 'number')))),
    format: String(getConfigValue('thumbnails.format', 'png')).toLowerCase().trim() === 'png' ? 'png' : 'jpg',
};

const thumbnailMobileRuntimeSettings = {
    enabled: !!getConfigValue('thumbnails.mobile.enabled', true, 'boolean'),
    quality: Math.min(100, Math.max(1, parseInt(getConfigValue('thumbnails.mobile.quality', 82, 'number')))),
    format: String(getConfigValue('thumbnails.mobile.format', 'jpg')).toLowerCase().trim() === 'png' ? 'png' : 'jpg',
};

function setCachedThumbnailContentType(response, filePath) {
    let fd = null;
    try {
        fd = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(12);
        fs.readSync(fd, header, 0, header.length, 0);

        if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
            response.type('jpg');
        } else if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
            response.type('png');
        }
    } catch {
        // Fall back to Express' extension-based content type.
    } finally {
        if (fd !== null) {
            fs.closeSync(fd);
        }
    }
}

/**
 * @typedef {'bg' | 'avatar' | 'persona'} ThumbnailType
 */


/**
 * @typedef {'desktop' | 'mobile'} ThumbnailPreset
 */

/**
 * Gets a path to thumbnail folder based on the type.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {ThumbnailType} type Thumbnail type
 * @param {ThumbnailPreset} [preset='desktop'] Thumbnail preset
 * @returns {string} Path to the thumbnails folder
 */
export function getThumbnailFolder(directories, type, preset = 'desktop') {
    let thumbnailFolder;
    const isMobile = preset === 'mobile';

    switch (type) {
        case 'bg':
            thumbnailFolder = directories.thumbnailsBg;
            break;
        case 'avatar':
            thumbnailFolder = isMobile ? directories.thumbnailsAvatarMobile : directories.thumbnailsAvatar;
            break;
        case 'persona':
            thumbnailFolder = isMobile ? directories.thumbnailsPersonaMobile : directories.thumbnailsPersona;
            break;
    }

    return thumbnailFolder;
}

/**
 * Gets a path to the original images folder based on the type.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {ThumbnailType} type Thumbnail type
 * @returns {string} Path to the original images folder
 */
function getOriginalFolder(directories, type) {
    let originalFolder;

    switch (type) {
        case 'bg':
            originalFolder = directories.backgrounds;
            break;
        case 'avatar':
            originalFolder = directories.characters;
            break;
        case 'persona':
            originalFolder = directories.avatars;
            break;
    }

    return originalFolder;
}

/**
 * Resolves a requested file name to the name that actually exists in the original images folder.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {ThumbnailType} type Thumbnail type
 * @param {string} file Requested file name
 * @returns {string} File name to use for thumbnail lookups
 */
// SillyBunny: diverges from upstream. Clients can send a `file` that was percent-encoded twice
// ("Mara%2520Rodriguez.png"); Express decodes it once, leaving a literal "%20" that never matches
// the file on disk. The name as sent always wins, so real '%' characters keep working.
function resolveOriginalFileName(directories, type, file) {
    if (!file.includes('%')) {
        return file;
    }

    const originalFolder = getOriginalFolder(directories, type);
    if (originalFolder === undefined || fs.existsSync(path.join(originalFolder, file))) {
        return file;
    }

    let decodedFile;
    try {
        decodedFile = decodeURIComponent(file);
    } catch {
        // A '%' that is not a valid escape sequence is a legal file name character.
        return file;
    }

    // Re-run the sanitizer so a decoded name can never escape the folder.
    if (!decodedFile || decodedFile === file || decodedFile !== sanitize(decodedFile)) {
        return file;
    }

    return fs.existsSync(path.join(originalFolder, decodedFile)) ? decodedFile : file;
}

/**
 * Removes the generated thumbnail from the disk.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {ThumbnailType} type Type of the thumbnail
 * @param {string} file Name of the file
 */
export function invalidateThumbnail(directories, type, file) {
    if (type === 'bg') {
        const folder = getThumbnailFolder(directories, type);
        if (folder === undefined) throw new Error('Invalid thumbnail type');

        const pathToThumbnail = path.join(folder, sanitize(file));
        if (fs.existsSync(pathToThumbnail)) {
            fs.unlinkSync(pathToThumbnail);
        }
        return;
    }

    for (const preset of ['desktop', 'mobile']) {
        const folder = getThumbnailFolder(directories, type, preset);
        if (folder === undefined) throw new Error('Invalid thumbnail type');

        const pathToThumbnail = path.join(folder, sanitize(file));
        if (fs.existsSync(pathToThumbnail)) {
            fs.unlinkSync(pathToThumbnail);
        }
    }
}

export function setThumbnailRuntimeSettings(settings = {}) {
    thumbnailRuntimeSettings.enabled = Boolean(settings.enabled);
    thumbnailRuntimeSettings.quality = Math.min(100, Math.max(1, parseInt(settings.quality, 10) || 100));
    thumbnailRuntimeSettings.format = String(settings.format ?? 'png').toLowerCase().trim() === 'png' ? 'png' : 'jpg';
}

export function getThumbnailRuntimeSettings() {
    return { ...thumbnailRuntimeSettings };
}

export function setThumbnailMobileRuntimeSettings(settings = {}) {
    thumbnailMobileRuntimeSettings.enabled = Boolean(settings.enabled);
    thumbnailMobileRuntimeSettings.quality = Math.min(100, Math.max(1, parseInt(settings.quality, 10) || 82));
    thumbnailMobileRuntimeSettings.format = String(settings.format ?? 'jpg').toLowerCase().trim() === 'png' ? 'png' : 'jpg';
}

export function getThumbnailMobileRuntimeSettings() {
    return { ...thumbnailMobileRuntimeSettings };
}

/**
 * Generates or retrieves a thumbnail for a given file.
 * @param {import('../users.js').UserDirectoryList} directories - User's directory configuration.
 * @param {ThumbnailType} type - Type of thumbnail ('bg', 'avatar', 'persona').
 * @param {string} file - The filename of the image.
 * @param {boolean} [forceGenerate=false] - Whether to force generation even if a thumbnail exists.
 * @param {boolean|null} [isKnownAnimated=null] - If true, skips generation. If false, assumes static. If null, checks.
 * @param {ThumbnailPreset} [preset='desktop'] - Thumbnail preset to generate.
 * @returns {Promise<{path: string|null, aspectRatio: number|null, resolution: number|null}>} Path to thumbnail, its aspect ratio, and resolution.
 */
export async function generateThumbnail(directories, type, file, forceGenerate = false, isKnownAnimated = null, preset = 'desktop') {
    // If the caller has already determined the file is animated, skip processing.
    if (isKnownAnimated) {
        return { path: null, aspectRatio: null, resolution: null };
    }

    const isMobile = preset === 'mobile';
    const thumbnailFolder = getThumbnailFolder(directories, type, preset);
    const originalFolder = getOriginalFolder(directories, type);
    if (thumbnailFolder === undefined || originalFolder === undefined) throw new Error('Invalid thumbnail type');
    // SillyBunny: tolerate a double percent-encoded name (see resolveOriginalFileName).
    file = resolveOriginalFileName(directories, type, file);
    const pathToCachedFile = path.join(thumbnailFolder, file);

    try {
        const pathToOriginalFile = path.join(originalFolder, file);

        // Check if thumbnail already exists and return it if not forcing regeneration
        if (!forceGenerate && fs.existsSync(pathToCachedFile)) {
            try {
                // Check if original image was updated after thumbnail creation
                const originalFileExists = fs.existsSync(pathToOriginalFile);
                if (originalFileExists) {
                    const originalStat = fs.statSync(pathToOriginalFile);
                    const cachedStat = fs.statSync(pathToCachedFile);

                    if (originalStat.mtimeMs > cachedStat.ctimeMs) {
                        // Original file changed, regenerate thumbnail
                        forceGenerate = true;
                    }
                }

                if (!forceGenerate) {
                    const buffer = fs.readFileSync(pathToCachedFile);
                    const fileDimensions = sizeOf(buffer);
                    const ratio = (fileDimensions.height > 0) ? (fileDimensions.width / fileDimensions.height) : 1.0;
                    // When a thumbnail exists, return the current resolution from config so the JSON can be updated.
                    const resolution = isMobile ? getThumbnailMobileResolution(type) : getThumbnailResolution(type);
                    return { path: pathToCachedFile, aspectRatio: ratio, resolution };
                }
            } catch (e) {
                forceGenerate = true;
            }
        }
        if (!fs.existsSync(pathToOriginalFile)) {
            console.error(`[generateThumbnail] Cannot generate thumbnail, original file not found: ${pathToOriginalFile}`);
            return { path: null, aspectRatio: null, resolution: null };
        }

        const fileExtension = path.extname(file).toLowerCase();

        // For WebP files, we must check if they are animated, as Jimp cannot process them.
        // If isKnownAnimated is false, we assume the caller knows it is static and skip this check.
        if (fileExtension === '.webp' && isKnownAnimated !== false) {
            const buffer = fs.readFileSync(pathToOriginalFile);
            const isAnimated = isAnimatedWebP(buffer);
            if (isAnimated) {
                // The client is expected to handle it.
                return { path: null, aspectRatio: null, resolution: null };
            }
        }

        // For PNG files, check if they are actually APNGs.
        if (fileExtension === '.png' && isKnownAnimated !== false) {
            const buffer = fs.readFileSync(pathToOriginalFile);
            const isAnimated = isAnimatedApng(buffer);
            if (isAnimated) {
                // The client is expected to handle it.
                return { path: null, aspectRatio: null, resolution: null };
            }
        }

        if (SKIPPED_EXTENSIONS.has(fileExtension)) {
            return { path: null, aspectRatio: null, resolution: null };
        }

        // Process the image to generate thumbnail
        const result = await processSingleImage(file, originalFolder, thumbnailFolder, type, preset);
        if (result.success) {
            return { path: pathToCachedFile, aspectRatio: result.aspectRatio ?? null, resolution: result.resolution ?? null };
        } else {
            console.error(`[generateThumbnail] Failed to process image ${file}:`, result.error);
            return { path: null, aspectRatio: null, resolution: null };
        }
    } catch (error) {
        console.error(`[generateThumbnail] Unexpected error processing ${file}:`, error);
        return { path: null, aspectRatio: null, resolution: null };
    }
}

/**
 * Processes a single image to generate its thumbnail.
 * @param {string} file - The filename of the image.
 * @param {string} originalFolder - Path to the original image folder.
 * @param {string} thumbnailFolder - Path to the thumbnail output folder.
 * @param {ThumbnailType} type - The type of thumbnail to generate.
 * @param {ThumbnailPreset} [preset='desktop'] - Thumbnail preset to generate.
 * @returns {Promise<{success: boolean, filename?: string, error?: string, aspectRatio?: number, resolution?: number}>} Result of the processing.
 */
async function processSingleImage(file, originalFolder, thumbnailFolder, type, preset = 'desktop') {
    const pathToOriginalFile = path.join(originalFolder, file);
    const pathToCachedFile = path.join(thumbnailFolder, file);

    try {
        const isMobile = preset === 'mobile';
        const fileBuffer = fs.readFileSync(pathToOriginalFile);
        const image = await Jimp.read(fileBuffer);

        // Calculate aspect ratio from original image dimensions
        const originalWidth = image.bitmap.width;
        const originalHeight = image.bitmap.height;
        const aspectRatio = (originalHeight > 0) ? (originalWidth / originalHeight) : 1.0;

        const thumbImage = image.clone();
        const thumbnailResolution = isMobile ? getThumbnailMobileResolution(type) : getThumbnailResolution(type);
        const dimensionSource = isMobile ? mobileDimensions : dimensions;
        const settings = isMobile ? thumbnailMobileRuntimeSettings : thumbnailRuntimeSettings;

        if (type === 'bg') {
            const [configWidth, configHeight] = dimensionSource[type];
            const targetPixelArea = configWidth * configHeight;

            // Calculate thumbnail dimensions to maintain target pixel area while preserving aspect ratio
            // For aspect ratio w:h, if area = w*h and ratio = w/h, then:
            // w = sqrt(area * ratio) and h = sqrt(area / ratio)
            const thumbWidth = Math.round(Math.sqrt(targetPixelArea * aspectRatio));
            const thumbHeight = Math.round(Math.sqrt(targetPixelArea / aspectRatio));

            thumbImage.resize({ w: thumbWidth, h: thumbHeight, mode: ResizeStrategy.BILINEAR });
        } else if (type === 'avatar' || type === 'persona') {
            // Crop and resize to fixed dimensions
            const [configWidth, configHeight] = dimensionSource[type];
            safeCover(thumbImage, { w: configWidth, h: configHeight, mode: ResizeStrategy.BILINEAR });
        }

        const buffer = settings.format === 'png'
            ? await thumbImage.getBuffer(JimpMime.png)
            : await thumbImage.getBuffer(JimpMime.jpeg, { quality: settings.quality, jpegColorSpace: 'ycbcr' });

        writeFileAtomicSync(pathToCachedFile, buffer);

        return { success: true, aspectRatio, resolution: thumbnailResolution };
    } catch (error) {
        console.warn(`[Thumbnails] Failed to process image ${file}:`, error);
        return { success: false, filename: file, error: error.message };
    }
}

/**
 * Public endpoint for serving thumbnails.
 * @param {express.Request} request - The Express request object.
 * @param {express.Response} response - The Express response object.
 */
publicRouter.get('/', async function (request, response) {
    try {
        const { file: rawFile, type, animated, preset: rawPreset } = request.query;
        if (typeof rawFile !== 'string' || typeof type !== 'string') return response.sendStatus(400);
        if (!(type === 'bg' || type === 'avatar' || type === 'persona')) {
            return response.sendStatus(400);
        }

        const sanitizedFile = sanitize(rawFile);
        if (sanitizedFile !== rawFile) return response.sendStatus(403);

        // SillyBunny: tolerate a double percent-encoded `file` param (see resolveOriginalFileName).
        const file = resolveOriginalFileName(request.user.directories, type, sanitizedFile);

        const requestedPreset = rawPreset === 'mobile' ? 'mobile' : 'desktop';

        const serveOriginal = () => {
            const folder = getOriginalFolder(request.user.directories, type);
            const pathToOriginalFile = path.resolve(path.join(folder, file));
            if (!fs.existsSync(pathToOriginalFile)) return response.sendStatus(404);
            invalidateFirefoxCache(pathToOriginalFile, request, response);
            return response.sendFile(pathToOriginalFile);
        };

        if (!thumbnailRuntimeSettings.enabled) {
            return serveOriginal();
        }

        const animatedEnabled = animated === 'true';
        const fileExtension = path.extname(file).toLowerCase();
        const isAnimatedFormat = SKIPPED_EXTENSIONS.has(fileExtension);

        // Serve original for animated formats or GIFs
        if (animatedEnabled && isAnimatedFormat) {
            return serveOriginal();
        }

        if (fileExtension === '.gif') {
            return serveOriginal();
        }

        // If the mobile preset is disabled, fall back to the desktop thumbnail.
        const effectivePreset = (requestedPreset === 'mobile' && thumbnailMobileRuntimeSettings.enabled) ? 'mobile' : 'desktop';
        const thumbnailFolder = getThumbnailFolder(request.user.directories, type, effectivePreset);
        const pathToCachedFile = path.join(thumbnailFolder, file);

        // Try to generate thumbnail if it doesn't exist
        if (!fs.existsSync(pathToCachedFile)) {
            const thumbResult = await generateThumbnail(request.user.directories, type, file, false, null, effectivePreset);
            // If generation failed (path is null), serve the original file
            if (!thumbResult.path) {
                return serveOriginal();
            }
        }

        if (fs.existsSync(pathToCachedFile)) {
            invalidateFirefoxCache(pathToCachedFile, request, response);
            setCachedThumbnailContentType(response, pathToCachedFile);
            return response.sendFile(file, { root: thumbnailFolder, dotfiles: 'allow' });
        }

        // Send a 404 so the frontend can display a placeholder
        return response.sendStatus(404);
    } catch (error) {
        console.error('Failed getting thumbnail', error);
        return response.sendStatus(500);
    }
});

export const router = express.Router();
router.use(publicRouter);
router.use(apiRouter);
