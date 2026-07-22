/**
 * One-time, socket-bound server-seed commitments for solo games.
 *
 * The server publishes hash(serverSeed) before a client chooses its clientSeed. A start request
 * consumes exactly one published offer; the secret serverSeed is then handed to Game internally
 * and revealed only after the run. Keeping issuance separate from consumption prevents the server
 * from choosing/grinding its seed after seeing the player's contribution.
 */

const crypto = require('crypto');
const { generateSeed, hashSeed, normalizeClientSeed } = require('./provablyFair');

const DEFAULT_TTL_MS = 15 * 60 * 1000;

class FairnessOfferManager {
    constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), seedFactory = generateSeed, idFactory = () => crypto.randomUUID() } = {}) {
        this.ttlMs = Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS);
        this.now = now;
        this.seedFactory = seedFactory;
        this.idFactory = idFactory;
        this.offers = new Map();       // offerId -> private offer
        this.currentBySocket = new Map(); // socketId -> offerId
        this.consumed = new Map();     // offerId -> expiry (explicit replay detection)
    }

    _prune() {
        const now = this.now();
        for (const [id, offer] of this.offers.entries()) {
            if (offer.expiresAt <= now) {
                this.offers.delete(id);
                if (this.currentBySocket.get(offer.socketId) === id) this.currentBySocket.delete(offer.socketId);
            }
        }
        for (const [id, expiresAt] of this.consumed.entries()) {
            if (expiresAt <= now) this.consumed.delete(id);
        }
    }

    _public(offer) {
        return {
            offerId: offer.offerId,
            commitment: offer.commitment,
            issuedAt: offer.issuedAt,
            expiresAt: offer.expiresAt,
            algorithm: 'HMAC-SHA256(serverSeed, clientSeed)',
            proofVersion: 2
        };
    }

    /** Return the existing unexpired offer for a socket, or publish a fresh one. */
    ensureOffer(socketId) {
        this._prune();
        const owner = String(socketId || '');
        if (!owner) throw new Error('socketId is required for a fairness offer');
        const currentId = this.currentBySocket.get(owner);
        const current = currentId ? this.offers.get(currentId) : null;
        if (current) return this._public(current);

        const issuedAt = this.now();
        const serverSeed = this.seedFactory();
        const offer = {
            offerId: this.idFactory(),
            socketId: owner,
            serverSeed,
            commitment: hashSeed(serverSeed),
            issuedAt,
            expiresAt: issuedAt + this.ttlMs
        };
        this.offers.set(offer.offerId, offer);
        this.currentBySocket.set(owner, offer.offerId);
        return this._public(offer);
    }

    /**
     * Consume a published offer once. Missing offerId is accepted only for legacy clients with
     * an empty client seed; modern clients must echo the offer they actually received.
     */
    consume(socketId, { offerId = null, clientSeed = '' } = {}) {
        this._prune();
        const owner = String(socketId || '');
        const normalizedSeed = normalizeClientSeed(clientSeed);
        if (clientSeed != null && String(clientSeed).trim() !== '' && normalizedSeed === null) {
            return { success: false, code: 'INVALID_CLIENT_SEED', reason: 'Client seed must be 1-64 hexadecimal characters.' };
        }

        if (!offerId && normalizedSeed) {
            return { success: false, code: 'OFFER_REQUIRED', reason: 'A published fairness offer is required for a client seed.' };
        }

        const resolvedId = offerId || this.currentBySocket.get(owner);
        if (!resolvedId) {
            return { success: false, code: 'OFFER_MISSING', reason: 'No active fairness offer. Request a new offer and retry.' };
        }
        if (this.consumed.has(resolvedId)) {
            return { success: false, code: 'OFFER_REPLAYED', reason: 'That fairness offer was already used.' };
        }

        const offer = this.offers.get(resolvedId);
        if (!offer) {
            return { success: false, code: 'OFFER_EXPIRED', reason: 'That fairness offer expired. Request a new offer and retry.' };
        }
        if (offer.socketId !== owner) {
            return { success: false, code: 'OFFER_OWNER_MISMATCH', reason: 'That fairness offer belongs to another connection.' };
        }

        // Synchronous delete/mark makes consumption atomic in Node's event loop. No await may
        // occur between checking and claiming this offer.
        this.offers.delete(resolvedId);
        if (this.currentBySocket.get(owner) === resolvedId) this.currentBySocket.delete(owner);
        this.consumed.set(resolvedId, Math.max(offer.expiresAt, this.now() + this.ttlMs));

        return {
            success: true,
            proofInput: {
                proofVersion: 2,
                offerId: offer.offerId,
                offerIssuedAt: offer.issuedAt,
                serverSeed: offer.serverSeed,
                commitment: offer.commitment,
                clientSeed: normalizedSeed || ''
            }
        };
    }

    discardSocket(socketId) {
        const owner = String(socketId || '');
        const id = this.currentBySocket.get(owner);
        if (id) this.offers.delete(id);
        this.currentBySocket.delete(owner);
    }
}

module.exports = FairnessOfferManager;
