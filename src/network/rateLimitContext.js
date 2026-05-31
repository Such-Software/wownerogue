/**
 * Rate-limit context resolver.
 *
 * Produces a STABLE identity and the real client IP for rate limiting, so limits cannot
 * be bypassed by simply reconnecting (which mints a fresh socket.id).
 *
 *  - stableId: prefers the session's stable user id (anon_token -> users.id); only when no
 *    session is resolvable does it fall back to the ephemeral socket id. A client that
 *    drops its token to mint a new identity is still caught by the IP limit.
 *  - clientIp: the socket handshake address, or the first X-Forwarded-For hop when the
 *    deployment is behind a trusted reverse proxy (TRUST_PROXY=true). XFF is ONLY trusted
 *    when TRUST_PROXY is set, since otherwise a client could spoof it.
 */

function clientIp(socket) {
    try {
        if (process.env.TRUST_PROXY === 'true') {
            const xff = socket.handshake?.headers?.['x-forwarded-for'];
            if (xff) return String(xff).split(',')[0].trim();
        }
        return socket.handshake?.address || null;
    } catch (_) {
        return null;
    }
}

function stableId(socket, sessionManager) {
    try {
        const u = sessionManager?.sessions?.get(socket.id);
        if (u && u.id != null) return `u:${u.id}`;
    } catch (_) {}
    return `s:${socket.id}`;
}

module.exports = { clientIp, stableId };
