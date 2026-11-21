import path from 'node:path';

// The `mime` copy that Express uses to serve files names no type for these extensions, so the browser would get
// `application/octet-stream` and, without `nosniff`, could guess a type from the bytes. Extensions that already get a
// type from that copy are not listed here, so their type does not change.
const CONTENT_TYPES_THE_FILE_SERVER_LACKS = new Map([
    ['.avif', 'image/avif'],
    ['.jfif', 'image/jpeg'],
]);

/**
 * Express middleware for the route that serves files from a user's image folder. The route sets its own content type
 * and `X-Content-Type-Options` so that these files do not depend on a global middleware for either.
 * `Content-Security-Policy: sandbox` is left off on purpose: Chromium does not load audio or video that the user opens
 * directly or in a frame when the response has it.
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @param {import('express').NextFunction} next Next function
 */
export function setStoredMediaHeaders(request, response, next) {
    response.setHeader('X-Content-Type-Options', 'nosniff');

    let relativePath = String(request.params[0] ?? '');
    try {
        // The file route decodes the path once more than Express did, so the extension is read from the same text.
        relativePath = decodeURIComponent(relativePath);
    } catch {
        // The file route answers this path with an error.
    }
    const contentType = CONTENT_TYPES_THE_FILE_SERVER_LACKS.get(path.extname(relativePath).toLowerCase());
    if (contentType) {
        response.type(contentType);
    }

    next();
}
