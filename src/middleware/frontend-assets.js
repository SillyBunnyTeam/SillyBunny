import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import {
    FRONTEND_DIST_ROOT,
    HASHED_FRONTEND_ASSET_RE,
    applyFrontendAssetHeaders,
    distrustFrontendManifest,
    getFrontendAssetsEnabled,
    isHashedAssetIntact,
    loadFrontendManifest,
} from '../frontend-assets.js';
import { serverDirectory } from '../server-directory.js';

export function setPublicAssetHeaders(res, requestPath) {
    if (/\.(?:m?js|css)$/i.test(requestPath)) {
        // SillyBunny: revalidate unversioned JS modules and stylesheets to avoid stale mixed
        // frontend graphs. Extension CSS pairs with always-revalidated JS, so an hour-stale
        // stylesheet leaves new UI unstyled or invisible.
        res.setHeader('Cache-Control', 'no-cache');
        return;
    }

    if (/\.(?:html?|json|map)$/i.test(requestPath)) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
    }

    res.setHeader('Cache-Control', 'public, max-age=3600');
}

/**
 * Maps a request path below /frontend-assets/ to a file inside distRoot.
 * @param {string} distRoot Absolute directory of the built files
 * @param {string} requestPath Path as Express reports it, still percent-encoded
 * @returns {string|null} Absolute file path, or null for a path that leaves distRoot or cannot be decoded
 */
function resolveDistFilePath(distRoot, requestPath) {
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(requestPath);
    } catch {
        return null;
    }

    if (decodedPath.includes('\0')) {
        return null;
    }

    const filePath = path.resolve(distRoot, `.${decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`}`);
    return filePath.startsWith(`${path.resolve(distRoot)}${path.sep}`) ? filePath : null;
}

export function getFrontendAssetMiddleware({ distRoot = FRONTEND_DIST_ROOT } = {}) {
    const distImmutable = express.static(distRoot, {
        fallthrough: true,
        setHeaders: applyFrontendAssetHeaders,
    });
    const publicRelativeFallback = express.static(path.join(serverDirectory, 'public'), {
        fallthrough: true,
        setHeaders: setPublicAssetHeaders,
    });

    return {
        immutableAssets: (req, res, next) => {
            // A hashed file is sent with a one-year immutable cache header, so its bytes must match the hash in its name.
            // A damaged one is not served, and the manifest is distrusted so that the next GET / serves raw public/.
            if (HASHED_FRONTEND_ASSET_RE.test(req.path)) {
                const filePath = resolveDistFilePath(distRoot, req.path);
                if (filePath && !isHashedAssetIntact(filePath)) {
                    if (fs.existsSync(filePath)) {
                        console.warn(`Frontend asset ${path.basename(filePath)} does not match the hash in its name; not serving it, and falling back to raw public/ assets.`);
                        distrustFrontendManifest({ distRoot });
                    }
                    return next();
                }
            }

            return distImmutable(req, res, (err) => {
                if (err) {
                    return next(err);
                }

                // Never fall back to public/ for missing fingerprinted asset URLs.
                if (HASHED_FRONTEND_ASSET_RE.test(req.path)) {
                    return next();
                }

                // Allow unhashed relative lookups resolved against import.meta.url (e.g. manifest.json,
                // worker scripts) to fall back to public/ without duplicating raw files into dist/frontend/.
                return publicRelativeFallback(req, res, next);
            });
        },
        publicAssets: express.static(distRoot, {
            fallthrough: true,
            setHeaders: setPublicAssetHeaders,
        }),
    };
}

export function shouldServeFrontendAssets(manifestPaths = {}) {
    return getFrontendAssetsEnabled() && Boolean(loadFrontendManifest(manifestPaths));
}
