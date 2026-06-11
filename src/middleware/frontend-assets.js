import express from 'express';

import {
    FRONTEND_DIST_ROOT,
    applyFrontendAssetHeaders,
    getFrontendAssetsEnabled,
    loadFrontendManifest,
} from '../frontend-assets.js';

export function setPublicAssetHeaders(res, requestPath) {
    if (/\.(?:m?js)$/i.test(requestPath)) {
        // SillyBunny: public JS modules are mostly unversioned; iOS WebKit can keep stale module graphs over plain HTTP.
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return;
    }

    if (/\.(?:html?|json|map)$/i.test(requestPath)) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
    }

    res.setHeader('Cache-Control', 'public, max-age=3600');
}

export function getFrontendAssetMiddleware() {
    return {
        immutableAssets: express.static(FRONTEND_DIST_ROOT, {
            fallthrough: true,
            setHeaders: applyFrontendAssetHeaders,
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
