import express from 'express';

import {
    FRONTEND_DIST_ROOT,
    applyFrontendAssetHeaders,
    getFrontendAssetsEnabled,
    loadFrontendManifest,
} from '../frontend-assets.js';

export function isIosWebKitUserAgent(userAgent) {
    const normalizedUserAgent = String(userAgent || '');

    return /\bAppleWebKit\//i.test(normalizedUserAgent)
        && (
            /\b(?:iPad|iPhone|iPod)\b/i.test(normalizedUserAgent)
            || (/\bMacintosh\b/i.test(normalizedUserAgent) && /\bMobile\//i.test(normalizedUserAgent))
        );
}

function getRequestUserAgent(res) {
    return res?.req?.headers?.['user-agent']
        ?? res?.req?.headers?.['User-Agent']
        ?? (typeof res?.req?.get === 'function' ? res.req.get('user-agent') : '');
}

function appendVaryHeader(res, value) {
    const currentHeader = typeof res.getHeader === 'function' ? res.getHeader('Vary') : '';
    const values = String(currentHeader || '').split(',').map(header => header.trim()).filter(Boolean);
    const normalizedValue = value.toLowerCase();

    if (!values.some(header => header === '*' || header.toLowerCase() === normalizedValue)) {
        values.push(value);
    }

    res.setHeader('Vary', values.join(', '));
}

export function setPublicAssetHeaders(res, requestPath) {
    if (/\.(?:m?js)$/i.test(requestPath)) {
        // SillyBunny: iOS WebKit needs revalidation for unversioned modules; other browsers should avoid reload storms.
        appendVaryHeader(res, 'User-Agent');
        res.setHeader('Cache-Control', isIosWebKitUserAgent(getRequestUserAgent(res)) ? 'no-cache' : 'public, max-age=3600');
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
