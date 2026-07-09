/**
 * Rate-limit context resolver.
 *
 * Produces a STABLE identity and the real client IP for rate limiting, so limits cannot
 * be bypassed by simply reconnecting (which mints a fresh socket.id).
 *
 *  - stableId: prefers the session's stable user id (anon_token -> users.id); only when no
 *    session is resolvable does it fall back to the ephemeral socket id. A client that
 *    drops its token to mint a new identity is still caught by the IP limit.
 *  - clientIp: the socket handshake address, or the RIGHTMOST X-Forwarded-For hop when the
 *    deployment is behind a trusted reverse proxy (TRUST_PROXY=true). XFF is ONLY trusted
 *    when TRUST_PROXY is set, since otherwise a client could spoof it.
 */

// S5: with a single trusted nginx proxy in front, nginx APPENDS the real client IP as the
// last hop of X-Forwarded-For. The leftmost entries are attacker-controlled (a client can
// pre-populate the header), so we must read the RIGHTMOST hop — the one the proxy added —
// not the leftmost. Still gated on TRUST_PROXY so a direct-exposure deploy can't be spoofed.
function clientIp(socket) {
    try {
        if (process.env.TRUST_PROXY === 'true') {
            const xff = socket.handshake?.headers?.['x-forwarded-for'];
            if (xff) {
                const hops = String(xff).split(',').map(h => h.trim()).filter(Boolean);
                if (hops.length) return hops[hops.length - 1];
            }
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
