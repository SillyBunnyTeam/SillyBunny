import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { imageSize as sizeOf } from 'image-size';

import { getConfigValue, invalidateFirefoxCache, recoverFileWriteSync } from '../util.js';
import {
    getThumbnailResolution,
    getThumbnailMobileResolution,
    isAnimatedWebP,
    isAnimatedApng,
    thumbnailDimensions as dimensions,
    thumbnailMobileDimensions as mobileDimensions,
} from './image-metadata.js';

// SillyBunny: Jimp and its WASM codecs load on the first thumbnail write, not at server start.
/** @type {Promise<{Jimp: typeof import('../jimp.js').Jimp, JimpMime: typeof import('../jimp.js').JimpMime, ResizeStrategy: typeof import('@jimp/plugin-resize').ResizeStrategy, safeCover: typeof import('../jimp-safe.js').safeCover}>|null} */
let jimpToolsPromise = null;
function loadJimpTools() {
    jimpToolsPromise ??= (async () => {
        // Sequential imports avoid a Node --experimental-vm-modules race when multiple modules link @jimp/plugin-resize.
        const jimp = await import('../jimp.js');
        const resize = await import('@jimp/plugin-resize');
        const safe = await import('../jimp-safe.js');
        return {
            Jimp: jimp.Jimp,
            JimpMime: jimp.JimpMime,
            ResizeStrategy: resize.ResizeStrategy,
            safeCover: safe.safeCover,
        };
    })().catch(error => {
        jimpToolsPromise = null;
        throw error;
    });
    return jimpToolsPromise;
}

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

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const THUMBNAIL_CONTENT_TYPE_CACHE_LIMIT = 1024;
export const THUMBNAIL_CACHE_CONTROL = 'public, max-age=86400';

// SillyBunny: a thumbnail's format only changes when the file is rewritten, so the sniffed type is
// remembered per (path, ctime, size) instead of opening the file on every request.
/** @type {Map<string, {ctimeMs: number, size: number, type: string|null}>} */
const thumbnailContentTypeCache = new Map();

/** @type {Map<string, Promise<{success: boolean, skipped?: boolean, filename?: string, error?: string, aspectRatio?: number, resolution?: number}>>} */
const thumbnailGenerationsInFlight = new Map();

async function sniffThumbnailContentType(filePath) {
    let fileHandle = null;
    try {
        fileHandle = await fs.promises.open(filePath, 'r');
        const header = Buffer.alloc(12);
        await fileHandle.read(header, 0, header.length, 0);

        if (header.subarray(0, 3).equals(JPEG_SIGNATURE)) {
            return 'jpg';
        }
        if (header.subarray(0, 8).equals(PNG_SIGNATURE)) {
            return 'png';
        }
        return null;
    } finally {
        if (fileHandle !== null) {
            await fileHandle.close();
        }
    }
}

/**
 * Gets the sniffed content type of a cached thumbnail, reading its header only when the file changed.
 * @param {string} filePath Path to the cached thumbnail
 * @param {fs.Stats} stat Current stats of the cached thumbnail
 * @returns {Promise<string|null>} 'jpg', 'png', or null to keep Express' extension-based type
 */
export async function getCachedThumbnailContentType(filePath, stat) {
    const cached = thumbnailContentTypeCache.get(filePath);
    if (cached && cached.ctimeMs === stat.ctimeMs && cached.size === stat.size) {
        thumbnailContentTypeCache.delete(filePath);
        thumbnailContentTypeCache.set(filePath, cached);
        return cached.type;
    }

    let type;
    try {
        type = await sniffThumbnailContentType(filePath);
    } catch {
        // Fall back to Express' extension-based content type.
        thumbnailContentTypeCache.delete(filePath);
        return null;
    }

    thumbnailContentTypeCache.delete(filePath);
    thumbnailContentTypeCache.set(filePath, { ctimeMs: stat.ctimeMs, size: stat.size, type });
    if (thumbnailContentTypeCache.size > THUMBNAIL_CONTENT_TYPE_CACHE_LIMIT) {
        thumbnailContentTypeCache.delete(thumbnailContentTypeCache.keys().next().value);
    }
    return type;
}

export function getThumbnailContentTypeCacheSize() {
    return thumbnailContentTypeCache.size;
}

/**
 * Sets the response type from the cached thumbnail's encoded bytes rather than the original's extension.
 * @param {express.Response} response Express response; `response.locals.thumbnailStat` holds the file's current stats
 * @param {string} filePath Path to the cached thumbnail
 */
async function setCachedThumbnailContentType(response, filePath) {
    const stat = response.locals.thumbnailStat ?? await statIfExists(filePath);
    if (!stat) {
        return;
    }

    const type = await getCachedThumbnailContentType(filePath, stat);
    if (type === 'jpg') {
        response.type('jpg');
    } else if (type === 'png') {
        response.type('png');
    }
}

async function statIfExists(filePath) {
    try {
        const stat = await fs.promises.stat(filePath);
        return stat.isFile() ? stat : null;
    } catch {
        return null;
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
            thumbnailFolder = isMobile ? directories.thumbnailsBgMobile : directories.thumbnailsBg;
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

// SillyBunny: path containment permits POSIX-valid names that sanitize-filename rejects.
function resolveDirectChildPath(folder, file) {
    if (typeof file !== 'string' || !file || file.includes('\0') || path.basename(file) !== file) {
        return null;
    }

    const root = path.resolve(folder);
    const filePath = path.resolve(root, file);
    return path.dirname(filePath) === root ? filePath : null;
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
    for (const preset of ['desktop', 'mobile']) {
        const folder = getThumbnailFolder(directories, type, preset);
        if (folder === undefined) throw new Error('Invalid thumbnail type');

        const pathToThumbnail = resolveDirectChildPath(folder, file);
        if (!pathToThumbnail) continue;
        thumbnailContentTypeCache.delete(pathToThumbnail);
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
    if (!resolveDirectChildPath(originalFolder, file) || !resolveDirectChildPath(thumbnailFolder, file)) {
        return { path: null, aspectRatio: null, resolution: null };
    }
    // SillyBunny: tolerate a double percent-encoded name (see resolveOriginalFileName).
    file = resolveOriginalFileName(directories, type, file);
    const pathToCachedFile = resolveDirectChildPath(thumbnailFolder, file);
    const pathToOriginalFile = resolveDirectChildPath(originalFolder, file);
    if (!pathToCachedFile || !pathToOriginalFile) {
        return { path: null, aspectRatio: null, resolution: null };
    }

    try {
        if (type === 'avatar' && path.extname(pathToOriginalFile).toLowerCase() === '.png') {
            recoverFileWriteSync(pathToOriginalFile);
        }

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
        if (SKIPPED_EXTENSIONS.has(fileExtension)) {
            return { path: null, aspectRatio: null, resolution: null };
        }

        // SillyBunny: deduplicate concurrent generation before the first await so parallel requests
        // for the same uncached thumbnail share one file read, animation check, decode, and write.
        let generation = thumbnailGenerationsInFlight.get(pathToCachedFile);
        if (!generation) {
            generation = (async () => {
                /** @type {Buffer|null} */
                let originalBuffer = null;

                // For WebP files, we must check if they are animated, as Jimp cannot process them.
                // If isKnownAnimated is false, we assume the caller knows it is static and skip this check.
                if (fileExtension === '.webp' && isKnownAnimated !== false) {
                    originalBuffer = await fs.promises.readFile(pathToOriginalFile);
                    if (isAnimatedWebP(originalBuffer)) {
                        return { skipped: true, success: false };
                    }
                }

                // For PNG files, check if they are actually APNGs.
                if (fileExtension === '.png' && isKnownAnimated !== false) {
                    originalBuffer = await fs.promises.readFile(pathToOriginalFile);
                    if (isAnimatedApng(originalBuffer)) {
                        return { skipped: true, success: false };
                    }
                }

                return processSingleImage(file, originalFolder, thumbnailFolder, type, preset, originalBuffer);
            })().finally(() => thumbnailGenerationsInFlight.delete(pathToCachedFile));
            thumbnailGenerationsInFlight.set(pathToCachedFile, generation);
        }

        const result = await generation;
        if (result.skipped) {
            // The client is expected to handle animated formats.
            return { path: null, aspectRatio: null, resolution: null };
        }
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
 * @param {Buffer|null} [originalBuffer=null] - Contents of the original file, when the caller already read it.
 * @returns {Promise<{success: boolean, filename?: string, error?: string, aspectRatio?: number, resolution?: number}>} Result of the processing.
 */
async function processSingleImage(file, originalFolder, thumbnailFolder, type, preset = 'desktop', originalBuffer = null) {
    const pathToOriginalFile = path.join(originalFolder, file);
    const pathToCachedFile = path.join(thumbnailFolder, file);

    try {
        const isMobile = preset === 'mobile';
        const fileBuffer = originalBuffer ?? await fs.promises.readFile(pathToOriginalFile);
        const { Jimp, JimpMime, ResizeStrategy, safeCover } = await loadJimpTools();
        const image = await Jimp.read(fileBuffer);

        // Calculate aspect ratio from original image dimensions
        const originalWidth = image.bitmap.width;
        const originalHeight = image.bitmap.height;
        const aspectRatio = (originalHeight > 0) ? (originalWidth / originalHeight) : 1.0;

        // SillyBunny: the decoded image is not reused, so it is resized in place instead of cloned.
        const thumbImage = image;
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

        const originalFolder = getOriginalFolder(request.user.directories, type);
        if (!resolveDirectChildPath(originalFolder, rawFile)) return response.sendStatus(403);

        // SillyBunny: tolerate a double percent-encoded `file` param (see resolveOriginalFileName).
        const file = resolveOriginalFileName(request.user.directories, type, rawFile);
        const pathToOriginalFile = resolveDirectChildPath(originalFolder, file);
        if (!pathToOriginalFile) return response.sendStatus(403);

        const requestedPreset = rawPreset === 'mobile' ? 'mobile' : 'desktop';

        const serveOriginal = () => {
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
        const pathToCachedFile = resolveDirectChildPath(thumbnailFolder, file);
        if (!pathToCachedFile) return response.sendStatus(403);

        // SillyBunny: one stat per request replaces the double existsSync, and feeds the content-type cache.
        let cachedStat = await statIfExists(pathToCachedFile);

        // Try to generate thumbnail if it doesn't exist
        if (!cachedStat) {
            const thumbResult = await generateThumbnail(request.user.directories, type, file, false, null, effectivePreset);
            // If generation failed (path is null), serve the original file
            if (!thumbResult.path) {
                return serveOriginal();
            }
            cachedStat = await statIfExists(pathToCachedFile);
        }

        if (cachedStat) {
            invalidateFirefoxCache(pathToCachedFile, request, response);
            // SillyBunny: cache thumbnails for 24h when cache-busted (?t=) or on non-Firefox clients;
            // unversioned Firefox requests keep invalidateFirefoxCache's no-store header.
            if (request.query.t !== undefined || !response.getHeader('Cache-Control')) {
                response.setHeader('Cache-Control', THUMBNAIL_CACHE_CONTROL);
            }
            response.locals.thumbnailStat = cachedStat;
            await setCachedThumbnailContentType(response, pathToCachedFile);
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
