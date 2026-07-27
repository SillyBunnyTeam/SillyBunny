import compression from 'compression';

function getHeaderValue(response, headerName) {
    const value = response?.getHeader?.(headerName);
    if (Array.isArray(value)) {
        return value.join(',');
    }

    return value === undefined || value === null ? '' : String(value);
}

function hasCacheDirective(response, directive) {
    const cacheControl = getHeaderValue(response, 'Cache-Control').toLowerCase();
    return cacheControl.split(',').map(part => part.trim()).includes(directive);
}

/**
 * Keeps generic response compression away from live streams.
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @returns {boolean}
 */
export function shouldCompressResponse(request, response) {
    const contentType = getHeaderValue(response, 'Content-Type').toLowerCase();
    if (contentType.split(';', 1)[0].trim() === 'text/event-stream') {
        return false;
    }

    if (hasCacheDirective(response, 'no-transform')) {
        return false;
    }

    return compression.filter(request, response);
}

export default function getResponseCompressionMiddleware() {
    return compression({ filter: shouldCompressResponse });
}
