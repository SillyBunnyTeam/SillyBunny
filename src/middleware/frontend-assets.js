import path from 'node:path';
import express from 'express';

import {
    FRONTEND_DIST_ROOT,
    HASHED_FRONTEND_ASSET_RE,
    applyFrontendAssetHeaders,
    getFrontendAssetsEnabled,
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

export function getFrontendAssetMiddleware() {
    const distImmutable = express.static(FRONTEND_DIST_ROOT, {
        fallthrough: true,
        setHeaders: applyFrontendAssetHeaders,
    });
    const publicRelativeFallback = express.static(path.join(serverDirectory, 'public'), {
        fallthrough: true,
        setHeaders: setPublicAssetHeaders,
    });

    return {
        immutableAssets: (req, res, next) => distImmutable(req, res, (err) => {
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
        }),
        publicAssets: express.static(FRONTEND_DIST_ROOT, {
            fallthrough: true,
            setHeaders: setPublicAssetHeaders,
        }),
    };
}

export function shouldServeFrontendAssets() {
    return getFrontendAssetsEnabled() && Boolean(loadFrontendManifest());
}
