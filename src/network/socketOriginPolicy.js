'use strict';

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

function normalizedConfiguredOrigin(hostedBy) {
    if (typeof hostedBy !== 'string' || hostedBy.trim() === '') return null;

    try {
        const parsed = new URL(hostedBy.trim());
        if (!HTTP_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) return null;
        return parsed.origin;
    } catch (_) {
        return null;
    }
}

function normalizedRequestOrigin(origin) {
    if (typeof origin !== 'string' || origin.trim() === '') return null;

    try {
        const raw = origin.trim();
        // URL normalizes dot-segments, so validate the Origin header's shape first. A browser
        // Origin is only scheme://authority (an optional trailing slash is tolerated).
        if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+\/?$/.test(raw)) return null;
        const parsed = new URL(raw);
        if (!HTTP_PROTOCOLS.has(parsed.protocol)
            || parsed.username
            || parsed.password
            || parsed.pathname !== '/'
            || parsed.search
            || parsed.hash) {
            return null;
        }
        return parsed.origin;
    } catch (_) {
        return null;
    }
}

/**
 * Build Socket.IO's allowRequest hook from an immutable environment snapshot.
 *
 * Development keeps the existing permissive behavior. Production requires a valid public
 * HOSTED_BY origin before any handshake is accepted. Once configured, requests without an
 * Origin header remain available to health probes and non-browser clients; browser handshakes
 * must present the exact normalized HTTP(S) scheme + host (including any non-default port).
 */
function createSocketOriginAllowRequest(env = process.env) {
    const production = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
    const expectedOrigin = production ? normalizedConfiguredOrigin(env.HOSTED_BY) : null;

    return (req, callback) => {
        if (!production) {
            callback(null, true);
            return;
        }

        // Missing or malformed production HOSTED_BY is configuration-invalid. Reject every
        // handshake rather than silently degrading to wildcard browser access.
        if (!expectedOrigin) {
            callback(null, false);
            return;
        }

        const headers = req && req.headers;
        const hasOrigin = !!headers && Object.prototype.hasOwnProperty.call(headers, 'origin');
        if (!hasOrigin) {
            callback(null, true);
            return;
        }

        const requestOrigin = normalizedRequestOrigin(headers.origin);
        callback(null, requestOrigin !== null && requestOrigin === expectedOrigin);
    };
}

module.exports = {
    createSocketOriginAllowRequest,
    normalizedConfiguredOrigin,
    normalizedRequestOrigin
};
