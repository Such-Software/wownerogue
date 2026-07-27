'use strict';

const crypto = require('crypto');

function md5(value) {
    return crypto.createHash('md5').update(String(value)).digest('hex');
}

function parseDigestChallenge(header) {
    const value = Array.isArray(header) ? header.find(item => /^Digest\s/i.test(item)) : header;
    if (!value || !/^Digest\s/i.test(String(value))) return null;
    const params = {};
    const body = String(value).replace(/^Digest\s+/i, '');
    const pattern = /([a-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/gi;
    let match;
    while ((match = pattern.exec(body))) {
        params[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
    }
    if (!params.realm || !params.nonce) return null;
    return params;
}

function challengeFrom(error) {
    if (Number(error?.response?.status) !== 401) return null;
    const headers = error.response.headers || {};
    return parseDigestChallenge(headers['www-authenticate'] || headers['WWW-Authenticate']);
}

function quote(value) {
    return String(value).replace(/(["\\])/g, '\\$1');
}

/** Minimal RFC 7616/2617 MD5 Digest client for monero-wallet-rpc. */
class DigestAuthClient {
    constructor(http, { username, password, randomBytes = crypto.randomBytes } = {}) {
        this.http = http;
        this.username = String(username || '');
        this.password = String(password || '');
        this.randomBytes = randomBytes;
        this.challenge = null;
        this.nonceCount = 0;
    }

    /**
     * Prove that the server rejects an intentionally unauthenticated, read-only request with a
     * usable Digest challenge. A configured credential is not an authentication boundary when
     * wallet-rpc silently accepts the same request without it.
     */
    async verifyEnforced(url, body, config = {}) {
        try {
            await this.http.post(url, body, config);
        } catch (error) {
            const challenge = challengeFrom(error);
            if (!challenge) {
                const unavailable = new Error('Wallet RPC did not provide a valid Digest challenge.');
                unavailable.code = 'WALLET_RPC_AUTH_UNVERIFIED';
                unavailable.cause = error;
                throw unavailable;
            }
            this.challenge = challenge;
            this.nonceCount = 0;
            return true;
        }
        const notEnforced = new Error('Wallet RPC accepted an unauthenticated request.');
        notEnforced.code = 'WALLET_RPC_AUTH_NOT_ENFORCED';
        throw notEnforced;
    }

    _authorization(url, method = 'POST') {
        const challenge = this.challenge;
        if (!challenge) return null;
        const algorithm = String(challenge.algorithm || 'MD5').toUpperCase();
        if (!['MD5', 'MD5-SESS'].includes(algorithm)) {
            throw new Error(`Unsupported wallet RPC Digest algorithm: ${algorithm}`);
        }
        const qops = String(challenge.qop || 'auth').split(',').map(value => value.trim().toLowerCase());
        if (!qops.includes('auth')) throw new Error('Wallet RPC Digest challenge does not support qop=auth');

        const endpoint = new URL(url);
        const uri = `${endpoint.pathname || '/'}${endpoint.search || ''}`;
        const cnonce = this.randomBytes(16).toString('hex');
        const nc = (++this.nonceCount).toString(16).padStart(8, '0');
        const initialHa1 = md5(`${this.username}:${challenge.realm}:${this.password}`);
        const ha1 = algorithm === 'MD5-SESS'
            ? md5(`${initialHa1}:${challenge.nonce}:${cnonce}`)
            : initialHa1;
        const ha2 = md5(`${method.toUpperCase()}:${uri}`);
        const response = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
        const fields = [
            `username="${quote(this.username)}"`,
            `realm="${quote(challenge.realm)}"`,
            `nonce="${quote(challenge.nonce)}"`,
            `uri="${quote(uri)}"`,
            `algorithm=${algorithm}`,
            `response="${response}"`,
            'qop=auth',
            `nc=${nc}`,
            `cnonce="${cnonce}"`
        ];
        if (challenge.opaque) fields.push(`opaque="${quote(challenge.opaque)}"`);
        return `Digest ${fields.join(', ')}`;
    }

    async post(url, body, config = {}) {
        const sendAuthenticated = () => {
            const authorization = this._authorization(url, 'POST');
            return this.http.post(url, body, {
                ...config,
                headers: { ...(config.headers || {}), Authorization: authorization }
            });
        };

        if (this.challenge) {
            try {
                return await sendAuthenticated();
            } catch (error) {
                const refreshed = challengeFrom(error);
                if (!refreshed) throw error;
                this.challenge = refreshed;
                this.nonceCount = 0;
                return sendAuthenticated();
            }
        }

        try {
            return await this.http.post(url, body, config);
        } catch (error) {
            const challenge = challengeFrom(error);
            if (!challenge) throw error;
            this.challenge = challenge;
            this.nonceCount = 0;
            return sendAuthenticated();
        }
    }
}

module.exports = { DigestAuthClient, parseDigestChallenge };
