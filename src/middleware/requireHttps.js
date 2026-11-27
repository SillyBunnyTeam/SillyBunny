import { getConfigValue } from '../util.js';
import { getTrustedProxies, isIpInPatterns } from '../express-common.js';
import { hasForwardingHeaders, isLoopbackAddress } from '../loopback-request.js';

const REQUIRE_HTTPS = getConfigValue('requireHttps', false, 'boolean');

/**
 * Middleware that rejects non-HTTPS connections when requireHttps is enabled.
 * Direct connections from this machine are always allowed (for local development).
 */
const requireHttpsMiddleware = function (request, response, callback) {
    if (!REQUIRE_HTTPS) {
        return callback();
    }

    // A proxy on this machine also connects from a loopback address, so a request with forwarding headers is not local.
    const isLocalhost = isLoopbackAddress(request.ip) && !hasForwardingHeaders(request);

    if (isLocalhost) {
        return callback();
    }

    // Check if request is HTTPS (direct or via a trusted reverse proxy)
    const forwardedProto = isIpInPatterns(request.ip, getTrustedProxies())
        ? String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
        : '';
    const isHttps = request.secure || forwardedProto === 'https';

    if (!isHttps) {
        return response.status(403).json({
            error: 'HTTPS is required for non-localhost connections. Configure SSL in config.yaml or use a reverse proxy with HTTPS.',
        });
    }

    return callback();
};

export default requireHttpsMiddleware;
