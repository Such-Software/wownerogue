/**
 * Payment Handlers
 * Encapsulates payment request creation, monitoring, mempool detection,
 * confirmation handling, and queue integration.
 */

const { normalizeError } = require('../utils/errors');
const money = require('../money/atomic');
const {
    buildCommerceDisclosure,
    validatePaidAcknowledgement
} = require('../config/commerceDisclosurePolicy');

const PENDING_COMMERCE_ACK_TTL_MS = 5 * 60 * 1000;
const PENDING_COMMERCE_ACK_MAX = 256;

class PaymentHandlers {
    constructor({ io, gameModeManager, walletService, debugManager, queueManager, broadcastManager, sessionManager }) {
        this.io = io;
        this.gameModeManager = gameModeManager;
        this.walletService = walletService;
        this.debugManager = debugManager;
        this.queueManager = queueManager;
        this.broadcastManager = broadcastManager;
        this.sessionManager = sessionManager;
        // Address -> timestamp of the first mempool notification, so we notify/queue once
        // per payment address. A Map with TTL eviction (below) instead of an unbounded Set.
        this.mempoolNotified = new Map();
        this._mempoolNotifiedTtlMs = 60 * 60 * 1000; // 1 hour
        // Track underpaid payments we've already warned about (notify once, keep monitoring for top-up)
        this.underpaidNotified = new Set();
        this.paymentMonitors = new Map();
        // Track pending payment metadata per socket (may reuse existing)
        this.socketPaymentMap = new Map(); // socketId -> { address, paymentId, amount, cryptoType, createdAt }
        // A single-game fairness offer may arrive before payout-address confirmation. Preserve
        // the already-consumed proof across that prompt; never fall back to generating a layout
        // from an unpublished server seed when payment later confirms.
        this.pendingEntryFairness = new Map();
        // Retain a canonical acknowledgement across the payout-address prompt. Entries are tiny,
        // bounded, expire quickly, and are cleared on disconnect; raw client objects never enter
        // this map.
        this.pendingCommerceAcknowledgement = new Map();
        // Track paymentIds already confirmed (avoid duplicate emits / queue actions)
        this.confirmedPayments = new Set();
        // Periodic cleanup (confirmed payment IDs older than retention window)
        this._confirmedTimestamps = new Map();
        this._confirmedRetentionMs = 6 * 60 * 60 * 1000; // 6 hours
        // Track expiry timeouts so they can be cleared / unref'd to avoid keeping process open
        this._expiryTimeouts = new Map(); // socketId -> timeout
        // Keep reference so tests can dispose / and unref so it doesn't keep event loop alive
        this._cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [pid, ts] of this._confirmedTimestamps.entries()) {
                if (now - ts > this._confirmedRetentionMs) {
                    this._confirmedTimestamps.delete(pid);
                    this.confirmedPayments.delete(pid);
                }
            }
            // TTL-evict stale mempool-notified addresses (replaces the old random eviction).
            for (const [addr, ts] of this.mempoolNotified.entries()) {
                if (now - ts > this._mempoolNotifiedTtlMs) {
                    this.mempoolNotified.delete(addr);
                }
            }
            this._sweepPendingCommerceAcknowledgements(now);
        }, 30 * 60 * 1000); // sweep every 30 min
        if (this._cleanupInterval && this._cleanupInterval.unref) {
            // Allow process (including Jest) to exit naturally without waiting for this interval
            this._cleanupInterval.unref();
        }
    }

    _entryModeForPaymentType(paymentType) {
        if (paymentType === 'single_game') return 'PAID_SINGLE';
        if (paymentType === 'credits_package') return 'PAID_CREDITS';
        return null;
    }

    _requiresBoundPaidFairness() {
        return typeof this.gameModeManager?._requiresPaidFairnessV2 === 'function'
            && this.gameModeManager._requiresPaidFairnessV2();
    }

    _invoiceCanLeadDirectlyToPayout(paymentType, { preselection = false } = {}) {
        const type = String(paymentType || '').toLowerCase();
        if (type === 'single_game' || type === 'pay_direct') {
            return !!this.gameModeManager?.isPayoutEnabledForMode?.('PAID_SINGLE');
        }
        if (type === 'use_credit' || type === 'paid_credits') {
            return !!this.gameModeManager?.isPayoutEnabledForMode?.('PAID_CREDITS');
        }
        if (preselection && !type) {
            return !!(this.gameModeManager?.isPayoutEnabledForMode?.('PAID_SINGLE')
                || this.gameModeManager?.isPayoutEnabledForMode?.('PAID_CREDITS'));
        }
        // Buying credits/products creates no immediate payout promise. The authoritative reserve
        // gate runs later when a credit is actually consumed for a payout-bearing game.
        return false;
    }

    _sweepPendingCommerceAcknowledgements(now = Date.now()) {
        for (const [socketId, entry] of this.pendingCommerceAcknowledgement.entries()) {
            if (!entry || entry.expiresAt <= now) this.pendingCommerceAcknowledgement.delete(socketId);
        }
    }

    _rememberPendingCommerceAcknowledgement(socketId, acknowledgement) {
        if (!socketId || !acknowledgement) return;
        this._sweepPendingCommerceAcknowledgements();
        this.pendingCommerceAcknowledgement.delete(socketId);
        while (this.pendingCommerceAcknowledgement.size >= PENDING_COMMERCE_ACK_MAX) {
            const oldest = this.pendingCommerceAcknowledgement.keys().next().value;
            if (oldest === undefined) break;
            this.pendingCommerceAcknowledgement.delete(oldest);
        }
        // Clone only the bounded canonical contract. Never retain a caller-owned object or any
        // incidental socket payload fields in this short-lived continuation cache.
        const canonicalAcknowledgement = Object.freeze({
            policyVersion: String(acknowledgement.policyVersion),
            ageEligible: acknowledgement.ageEligible === true,
            termsRead: acknowledgement.termsRead === true,
            riskAccepted: acknowledgement.riskAccepted === true,
            testnetUnderstood: acknowledgement.testnetUnderstood === true
        });
        this.pendingCommerceAcknowledgement.set(socketId, {
            acknowledgement: canonicalAcknowledgement,
            expiresAt: Date.now() + PENDING_COMMERCE_ACK_TTL_MS
        });
    }

    _getPendingCommerceAcknowledgement(socketId) {
        const entry = this.pendingCommerceAcknowledgement.get(socketId);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now()) {
            this.pendingCommerceAcknowledgement.delete(socketId);
            return null;
        }
        return entry.acknowledgement;
    }

    clearPendingCommerceAcknowledgement(socketId) {
        this.pendingCommerceAcknowledgement.delete(socketId);
    }

    _requirePaidAcknowledgement(socket, acknowledgement) {
        const disclosure = buildCommerceDisclosure(this.gameModeManager, process.env);
        // This method is reached only for value-bearing actions. Force the action-level gate even
        // when payment intake is paused and a user is spending an existing credit/ticket.
        const result = validatePaidAcknowledgement(acknowledgement, disclosure, { required: true });
        if (result.ok) return result.acknowledgement;
        this.clearPendingCommerceAcknowledgement(socket.id);
        this.pendingEntryFairness.delete(socket.id);
        const payload = {
            error: result.message,
            message: result.message,
            code: result.code,
            policyVersion: disclosure.policyVersion
        };
        this.io.to(socket.id).emit('commerce_ack_required', payload);
        this.io.to(socket.id).emit('payment_error', payload);
        return null;
    }

    async _allowInvoiceFlowForReserve(socket, paymentType, options = {}) {
        if (!this._invoiceCanLeadDirectlyToPayout(paymentType, options)) return true;
        const alertService = this.gameModeManager?.alertService;
        if (!alertService || typeof alertService.checkBalanceForGameStart !== 'function') {
            return true; // authoritative transactional start gate remains fail-closed
        }
        const balanceCheck = await alertService.checkBalanceForGameStart();
        if (!balanceCheck.halted) return true;
        this.io.to(socket.id).emit('balance_critical', {
            reason: 'low_balance',
            message: balanceCheck.reason || 'Sorry, the house balance is too low to initiate new games. Please try again later.'
        });
        return false;
    }

    /**
     * Fail closed before creating an invoice when the resulting entry mode can pay out and the
     * operator requires an address. The primary browser flow calls handlePaymentRequest directly,
     * so this cannot live only in the legacy createAndShowPaymentRequest path.
     */
    async _ensureRequiredPayoutAddress(socket, paymentType) {
        const mode = this._entryModeForPaymentType(paymentType);
            if (!mode || !this.gameModeManager) return { ok: true, reason: 'not_required' };
        const needsAddress = typeof this.gameModeManager.requiresPayoutAddressForMode === 'function'
            ? this.gameModeManager.requiresPayoutAddressForMode(mode)
            : ((mode === 'PAID_SINGLE')
                || (mode === 'PAID_CREDITS' && this.gameModeManager.creditsPayoutEnabled));
        if (!needsAddress) return { ok: true, reason: 'not_required' };

        try {
            const userRow = await this.gameModeManager.getOrCreateUser(socket.id);
            if (userRow?.payout_address) return { ok: true, reason: 'present' };
            const message = 'Before paying, add a payout address so winnings can be delivered.';
            this.broadcastManager.sendStatusUpdate(socket.id, 'payment', `💳 ${message}`);
            this.io.to(socket.id).emit('payment_error', { error: message, code: 'PAYOUT_ADDRESS_REQUIRED' });
            return { ok: false, reason: 'address_required' };
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to verify payout address');
            console.error('Address pre-check failed:', normalized.message);
            this.io.to(socket.id).emit('payment_error', {
                error: 'Could not verify your payout address. Please try again.',
                code: 'PAYOUT_ADDRESS_CHECK_FAILED'
            });
            return { ok: false, reason: 'address_check_failed' };
        }
    }

    async handlePaymentRequest(socket, data) {
        if (!this.gameModeManager) {
            this.clearPendingCommerceAcknowledgement(socket.id);
            this.io.to(socket.id).emit('payment_error', { error: 'Payment system not available' });
            return;
        }

        const paymentType = data?.type || data?.gameMode || 'single_game';
        if (typeof this.gameModeManager.isPaymentIntakeEnabled === 'function'
            && !this.gameModeManager.isPaymentIntakeEnabled(paymentType)) {
            this.clearPendingCommerceAcknowledgement(socket.id);
            this.pendingEntryFairness.delete(socket.id);
            this.io.to(socket.id).emit('payment_error', {
                error: 'That paid product is not available on this server.',
                code: 'PAYMENT_INTAKE_DISABLED'
            });
            return;
        }

        const acknowledgement = this._requirePaidAcknowledgement(socket, data?.legalAcknowledgement);
        if (!acknowledgement) return;

        try {
            const { type, packageId, productId } = data || {};
            const paymentType = type || data?.gameMode || 'single_game';
            if (!await this._allowInvoiceFlowForReserve(socket, paymentType)) {
                this.clearPendingCommerceAcknowledgement(socket.id);
                this.pendingEntryFairness.delete(socket.id);
                return;
            }
            if (paymentType === 'single_game' && data?.fairnessProof) {
                this.pendingEntryFairness.set(socket.id, data.fairnessProof);
            }
            const addressCheck = await this._ensureRequiredPayoutAddress(socket, paymentType);
            if (!addressCheck.ok) {
                if (addressCheck.reason === 'address_required') {
                    this._rememberPendingCommerceAcknowledgement(socket.id, acknowledgement);
                } else {
                    this.clearPendingCommerceAcknowledgement(socket.id);
                    this.pendingEntryFairness.delete(socket.id);
                }
                return;
            }
            const options = {
                packageId,
                productId,
                reuseExisting: true,
                fairnessProof: data.fairnessProof || this.pendingEntryFairness.get(socket.id) || null
            };
            const paymentRequest = await this.gameModeManager.createPaymentRequest(socket.id, paymentType, options);
            const cryptoType = this.gameModeManager.cryptoType;
            
            // Generate QR code
            let qrDataUrl = null;
            try {
                const { generatePaymentQR } = require('../payments/qrService');
                qrDataUrl = await generatePaymentQR(
                    paymentRequest.address,
                    paymentRequest.amount,
                    cryptoType,
                    paymentType === 'single_game'
                        ? 'Single game'
                        : (paymentRequest.package?.label || (paymentType === 'credits_package' ? 'Credits package' : 'Product purchase')),
                    this.gameModeManager.currencyDecimals
                );
            } catch (qrErr) {
                console.warn('QR generation failed:', qrErr.message);
            }
            
            this.io.to(socket.id).emit('payment_created', {
                paymentId: paymentRequest.id,
                address: paymentRequest.address,
                amount: paymentRequest.amount,
                amountFormatted: paymentRequest.amountFormatted,
                humanAmount: paymentRequest.amountFormatted,
                currency: cryptoType,
                cryptoType: cryptoType,
                package: paymentRequest.package,
                productId: paymentRequest.productId,
                grants: paymentRequest.grants,
                paymentType: paymentType,
                qr: qrDataUrl,
                reused: !!paymentRequest.reused,
                fairness: paymentRequest.fairnessProof ? {
                    proofVersion: paymentRequest.fairnessProof.proofVersion,
                    offerId: paymentRequest.fairnessProof.offerId,
                    offerIssuedAt: paymentRequest.fairnessProof.offerIssuedAt,
                    commitment: paymentRequest.fairnessProof.commitment,
                    clientSeed: paymentRequest.fairnessProof.clientSeed
                } : null
            });
            this.clearPendingCommerceAcknowledgement(socket.id);
            
            // CRITICAL: Start payment monitoring!
            // Stop any existing monitoring for this socket first
            this.stopMonitoringForSocket(socket.id);
            
            // Get current user for queue management
            const currentUser = this.queueManager?.getUserBySocket ? 
                this.queueManager.getUserBySocket(socket.id) : { serverId: socket.id };
            
            // Start monitoring for payment
            this._monitorAddress(socket, paymentRequest, paymentRequest.amount, cryptoType, currentUser,
                paymentType, paymentRequest.fairnessProof || options.fairnessProof || null);
            if (paymentType === 'single_game') this.pendingEntryFairness.delete(socket.id);
            
            if (this.debugManager.CONSOLE_LOGGING) console.log(`💳 Payment request created for ${socket.id}: ${paymentRequest.amount}`);
        } catch (e) {
            this.clearPendingCommerceAcknowledgement(socket.id);
            this.pendingEntryFairness.delete(socket.id);
            const err = normalizeError(e, 'Failed to create payment request');
            console.error('Error creating payment request:', err.message);
            this.io.to(socket.id).emit('payment_error', { error: err.safeMessage });
        }
    }

    async createAndShowPaymentRequest(socket, options = {}) {
        if (!this.gameModeManager) {
            this.clearPendingCommerceAcknowledgement(socket.id);
            this.pendingEntryFairness.delete(socket.id);
            return;
        }

        const suppliedAcknowledgement = options.legalAcknowledgement
            || this._getPendingCommerceAcknowledgement(socket.id);
        const acknowledgement = this._requirePaidAcknowledgement(socket, suppliedAcknowledgement);
        if (!acknowledgement) return;

        if (!await this._allowInvoiceFlowForReserve(socket, options.paymentType, {
            preselection: !options.paymentType
        })) {
            this.clearPendingCommerceAcknowledgement(socket.id);
            this.pendingEntryFairness.delete(socket.id);
            return;
        }

        // If both direct and credits modes are enabled, let the user choose
        const bothModesEnabled = this.gameModeManager.directModeEnabled && this.gameModeManager.creditsModeEnabled;
        const forceShowOptions = options.showOptions === true;
        
        if (bothModesEnabled && !options.paymentType) {
            // Send event to show payment options modal on client
            this.io.to(socket.id).emit('show_payment_options', {
                reason: 'choose_payment_method',
                message: 'Choose how you want to play'
            });
            this.clearPendingCommerceAcknowledgement(socket.id);
            return;
        }
        
        try {
            const currentUser = socket.id && this.queueManager.getUserBySocket ? this.queueManager.getUserBySocket(socket.id) : null;
            // caller (SocketHandlers) will handle user existence; keep method generic
            const gameMode = this.gameModeManager.gameMode;
            const cryptoType = this.gameModeManager.cryptoType;
            let paymentType = options.paymentType;
            let amount;
            let description;

            // Determine payment type if not specified
            if (!paymentType) {
                if (gameMode === 'PAID_SINGLE' || this.gameModeManager.directModeEnabled) {
                    paymentType = 'single_game';
                } else if (gameMode === 'PAID_CREDITS') {
                    paymentType = 'credits_package';
                }
            }

            if (paymentType === 'single_game' && options.fairnessProof) {
                this.pendingEntryFairness.set(socket.id, options.fairnessProof);
            }

            const fairnessProof = paymentType === 'single_game'
                ? (options.fairnessProof || this.pendingEntryFairness.get(socket.id) || null)
                : null;

            const addressCheck = await this._ensureRequiredPayoutAddress(socket, paymentType);
            if (!addressCheck.ok) {
                if (addressCheck.reason === 'address_required') {
                    this._rememberPendingCommerceAcknowledgement(socket.id, acknowledgement);
                } else {
                    this.clearPendingCommerceAcknowledgement(socket.id);
                    this.pendingEntryFairness.delete(socket.id);
                }
                return;
            }

            if (paymentType === 'single_game') {
                amount = this.gameModeManager.singleGamePrice;
                description = 'Single game entry';
            } else if (paymentType === 'credits_package') {
                const primaryPackage = this.gameModeManager.getPrimaryCreditPackage();
                amount = money.toSafe(money.toBig(primaryPackage?.price ?? this.gameModeManager.creditsPackagePrice));
                const credits = primaryPackage?.credits ?? this.gameModeManager.creditsPerGameCost * 10;
                description = `${credits} credit package`;
            } else if (paymentType === 'cosmetic_pack') {
                const product = this.gameModeManager.getCosmeticProduct(options.productId || options.packageId);
                if (!product) {
                    this.clearPendingCommerceAcknowledgement(socket.id);
                    this.pendingEntryFairness.delete(socket.id);
                    this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Invalid product selection.');
                    return;
                }
                amount = money.toSafe(money.toBig(product.price));
                description = product.label || product.id;
            } else {
                this.clearPendingCommerceAcknowledgement(socket.id);
                this.pendingEntryFairness.delete(socket.id);
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Invalid game mode configuration.');
                return;
            }

            // Resolve authoritative userId from session manager (stable across socket reconnects)
            let sessionUserId = null;
            if (this.sessionManager?.sessions?.has(socket.id)) {
                sessionUserId = this.sessionManager.sessions.get(socket.id).id;
            }

            const paymentRequest = await this.gameModeManager.createPaymentRequest(socket.id, paymentType, {
                reuseExisting: true,
                packageId: options.packageId,
                productId: options.productId,
                userId: sessionUserId,
                fairnessProof
            });
            const reused = !!paymentRequest.reused;

            // Stop monitoring any expired addresses from previous payment requests
            if (paymentRequest.expiredAddresses?.length > 0) {
                for (const addr of paymentRequest.expiredAddresses) {
                    this.walletService.stopPaymentMonitoring(addr);
                    this.walletService.addressToUser.delete(addr);
                    this.walletService.addressToSocket.delete(addr);
                }
            }

            const formattedAmount = paymentRequest.amountFormatted ?? this.gameModeManager.formatAtomicHuman(amount, 3);
            let qrDataUrl = null;
            try {
                const { generatePaymentQR } = require('../payments/qrService');
                qrDataUrl = await generatePaymentQR(
                    paymentRequest.address,
                    paymentRequest.amount,
                    cryptoType,
                    description,
                    this.gameModeManager.currencyDecimals
                );
            } catch (e) {}

            this.io.to(socket.id).emit('payment_created', {
                paymentId: paymentRequest.id,
                address: paymentRequest.address,
                amount: paymentRequest.amount,
                amountFormatted: formattedAmount,
                humanAmount: formattedAmount,
                paymentType,
                productId: paymentRequest.productId,
                grants: paymentRequest.grants,
                gameMode,
                cryptoType,
                description,
                expiresAt: paymentRequest.expiresAt,
                qr: qrDataUrl,
                package: paymentRequest.package,
                reused,
                fairness: paymentRequest.fairnessProof ? {
                    proofVersion: paymentRequest.fairnessProof.proofVersion,
                    offerId: paymentRequest.fairnessProof.offerId,
                    offerIssuedAt: paymentRequest.fairnessProof.offerIssuedAt,
                    commitment: paymentRequest.fairnessProof.commitment,
                    clientSeed: paymentRequest.fairnessProof.clientSeed
                } : null
            });
            this.clearPendingCommerceAcknowledgement(socket.id);

            const statusHeader = reused
                ? '🔁 Existing payment request still pending. Use the details below to pay.'
                : `💳 PAYMENT REQUIRED (${description})`;

            const nextStep = paymentType === 'single_game'
                ? '🔄 Added to queue once mempool seen.'
                : '🔄 Purchase applies after block confirmation.';
            const statusBody = `\n\nAmount: ${formattedAmount} ${cryptoType}\nAddress: ${paymentRequest.address}\n\n⚠️  Send EXACTLY ${formattedAmount} ${cryptoType}.\n${nextStep}\n⏰ Expires in 30 minutes.`;

            this.broadcastManager.sendStatusUpdate(
                socket.id,
                'payment',
                `${statusHeader}${statusBody}`
            );

            // If we reused an existing request, ensure we refresh monitoring to avoid duplicate watchers
            this.stopMonitoringForSocket(socket.id);
            this._monitorAddress(socket, paymentRequest, paymentRequest.amount, cryptoType, currentUser,
                paymentType, paymentRequest.fairnessProof || fairnessProof);
            if (paymentType === 'single_game') this.pendingEntryFairness.delete(socket.id);
        } catch (e) {
            this.clearPendingCommerceAcknowledgement(socket.id);
            this.pendingEntryFairness.delete(socket.id);
            const err = normalizeError(e, 'Failed to create payment request');
            console.error('Error creating payment request:', err.message);
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', err.safeMessage);
        }
    }

    _monitorAddress(socket, paymentRequest, amount, cryptoType, currentUser, paymentType = 'single_game', fairnessProof = null) {
        // Select the provider that owns this chain: native wallet-RPC by default, or a BTCPay/
        // checkout gateway when this.cryptoType is routed to one. Native watches by subaddress;
        // a gateway watches by invoice id. The confirmation handler is identical either way.
        const registry = this.gameModeManager && this.gameModeManager.paymentProviders;
        const provider = registry ? registry.getProvider(cryptoType) : null;
        const isGateway = !!(provider && provider.id !== 'native-monero');
        const watchRef = isGateway ? (paymentRequest.invoiceId || paymentRequest.address) : paymentRequest.address;

        // Record mapping so we can stop later (replace existing entry)
        this.socketPaymentMap.set(socket.id, {
            address: paymentRequest.address,
            paymentId: paymentRequest.id,
            amount: paymentRequest.amount,
            cryptoType,
            paymentType,
            fairnessProof: paymentType === 'single_game' ? fairnessProof : null,
            package: paymentRequest.package,
            provider: provider || null,
            watchRef,
            createdAt: Date.now()
        });

        // Expire request after 30 minutes if not confirmed
        const expiryTimeout = setTimeout(() => {
            const mapping = this.socketPaymentMap.get(socket.id);
            if (mapping && mapping.address === paymentRequest.address) { // still active and not replaced
                this.stopMonitoringForSocket(socket.id);
                this.broadcastManager.sendStatusUpdate(socket.id, 'warning', 'Payment request expired. Type \'enter\' again to create a new payment request.');
            }
        }, 30 * 60 * 1000);
        // Store & unref so tests / process can exit (the 30-min timer must never keep the
        // event loop alive on its own — in production the server keeps the process running).
        if (expiryTimeout && expiryTimeout.unref) expiryTimeout.unref();
        this._expiryTimeouts.set(socket.id, expiryTimeout);

        // Start watching. onUpdate delivers a raw wallet-style status; for native that IS the
        // walletService status (unchanged legacy path), for a gateway it's mapped from the
        // Greenfield invoice. Fall back to direct wallet monitoring when no provider is registered.
        const onStatus = (status) => this._handlePaymentStatus(socket, paymentRequest, currentUser, status);
        if (provider && typeof provider.startWatch === 'function') {
            provider.startWatch(watchRef, onStatus, 2000);
        } else {
            this.walletService.startPaymentMonitoring(paymentRequest.address, onStatus, 2000);
        }
    }

    // Handle one payment status update (raw wallet-style shape: in_mempool/confirmed/complete/
    // amount/required/confirmations). Extracted verbatim from the monitor callback so native and
    // gateway providers share the exact same confirmation logic.
    async _handlePaymentStatus(socket, paymentRequest, currentUser, status) {
            if (status.in_mempool && !status.confirmed) {
                if (this.mempoolNotified.has(paymentRequest.address)) return;
                this.mempoolNotified.set(paymentRequest.address, Date.now());

                const mapping = this.socketPaymentMap.get(socket.id);
                const isGameEntry = !mapping || mapping.paymentType === 'single_game';

                // A production paid entry is only usable with the proof durably bound to its
                // invoice. Never put a legacy/corrupt unbound payment into the queue merely
                // because its transaction appeared in the mempool.
                if (isGameEntry && this._requiresBoundPaidFairness() && !mapping?.fairnessProof) {
                    console.error(`[PaymentHandlers] Refusing to queue unbound paid entry ${paymentRequest.id}`);
                    socket.emit('payment_review_required', {
                        paymentId: paymentRequest.id,
                        code: 'PAYMENT_FAIRNESS_UNBOUND',
                        message: 'This payment requires support review before a game can start.'
                    });
                    return;
                }

                const detectMessage = !isGameEntry
                    ? 'Payment detected in mempool! Awaiting block confirmation to apply your purchase...'
                    : 'Payment detected in mempool! Adding you to the game queue...';
                socket.emit('payment_detected', {
                    paymentId: paymentRequest.id,
                    message: detectMessage,
                    amount: status.observedAmount ?? status.amount,
                    confirmations: 0
                });

                // Only queue for single_game payments. Product purchases just apply grants.
                if (isGameEntry) {
                    const existingIdx = this.queueManager.getPlayerIndex(socket.id);
                    if (existingIdx === -1) {
                        // Try to get DB userId from session
                        let userId = null;
                        if (this.sessionManager?.sessions?.has(socket.id)) {
                            userId = this.sessionManager.sessions.get(socket.id).id;
                        }

                        this.queueManager.addPlayer({
                            serverId: socket.id,
                            clientId: currentUser ? currentUser.clientId : null,
                            userId: userId,
                            paymentId: paymentRequest.id,
                            requiresConfirmation: true,
                            confirmed: false,
                            fairnessProof: mapping?.fairnessProof || null
                        });
                    }
                    socket.emit('queue_joined', { position: (existingIdx === -1 ? this.queueManager.getQueueLength() : existingIdx + 1), message: 'Payment received! Waiting for next block to start game...', currentBlock: this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() : null, nextBlock: this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() + 1 : null });
                }
            } else if (status.confirmed) {
                // SECURITY (Phase 0.1): A confirmed transaction is NOT sufficient to grant a
                // game/credits — we must verify the RECEIVED amount covers what was expected.
                // checkPaymentStatus() sets `confirmed` for ANY incoming tx on the subaddress,
                // while `complete` means totalReceived >= required. Without this gate a player
                // could send a single atomic unit and play (or buy credits) for free.
                let exactCoverage = false;
                try {
                    exactCoverage = money.toBig(status.amount || 0)
                        >= money.toBig(paymentRequest.amount);
                } catch (_) { exactCoverage = false; }
                if (!status.complete || !exactCoverage) {
                    // Underpaid. Keep monitoring so a later top-up to the same address can
                    // complete it; warn the user once to avoid spamming on every 2s poll.
                    if (!this.underpaidNotified.has(paymentRequest.id)) {
                        this.underpaidNotified.add(paymentRequest.id);
                        const required = status.required || 0;
                        const received = status.amount || 0;
                        let shortfall = 0;
                        try {
                            const exact = money.toBig(required) - money.toBig(received);
                            shortfall = money.toSafe(exact > 0n ? exact : 0n);
                        } catch (_) { shortfall = 0; }
                        console.warn(`[PaymentHandlers] Underpaid payment ${paymentRequest.id}: received ${received}, required ${required} (shortfall ${shortfall})`);
                        try {
                            socket.emit('payment_underpaid', {
                                paymentId: paymentRequest.id,
                                received,
                                required,
                                shortfall
                            });
                        } catch (_) {}
                        this.broadcastManager.sendStatusUpdate(socket.id, 'warning',
                            `⚠️  UNDERPAYMENT DETECTED\n\nReceived less than the required amount. Send the remaining balance to the SAME address to complete your payment, or wait for it to expire and try again.`);
                    }
                    return;
                }

                // SECURITY: Use in-memory Set as fast-path, but DB is source of truth
                // This prevents double-processing on server restart
                if (this.confirmedPayments.has(paymentRequest.id)) {
                    // Already processed in this session, skip
                    this.stopMonitoringForSocket(socket.id);
                    return;
                }

                const confirmedMapping = this.socketPaymentMap.get(socket.id);
                const confirmedIsGameEntry = !confirmedMapping
                    || confirmedMapping.paymentType === 'single_game';
                if (confirmedIsGameEntry && this._requiresBoundPaidFairness()
                    && !confirmedMapping?.fairnessProof) {
                    console.error(`[PaymentHandlers] Refusing to confirm unbound paid entry ${paymentRequest.id}`);
                    socket.emit('payment_review_required', {
                        paymentId: paymentRequest.id,
                        code: 'PAYMENT_FAIRNESS_UNBOUND',
                        message: 'Funds were detected, but this entry requires support review.'
                    });
                    this.broadcastManager.sendStatusUpdate(socket.id, 'error',
                        'Payment received, but its fairness commitment is missing. No game was started; contact support.');
                    this.stopMonitoringForSocket(socket.id);
                    return;
                }

                // Mark in memory to prevent duplicate processing within this session
                this.confirmedPayments.add(paymentRequest.id);
                this._confirmedTimestamps.set(paymentRequest.id, Date.now());

                // Handle non-game products: add credits / cosmetic grants / premium tier.
                const mapping = this.socketPaymentMap.get(socket.id);
                if (mapping && mapping.paymentType !== 'single_game' && this.gameModeManager) {
                    try {
                        // Product confirmation atomically checks status='pending' and applies grants.
                        const creditsResult = await this.gameModeManager.processProductPaymentConfirmation(
                            socket.id,
                            paymentRequest.id,
                            mapping.package,
                            money.toBig(status.amount || 0).toString(),
                            status.receipts || []
                        );
                        if (creditsResult.success) {
                            socket.emit('credits_update', {
                                balance: creditsResult.newBalance,
                                totalCreditsPurchased: creditsResult.totalCreditsPurchased || 0,
                                ...(creditsResult.entitlements || {})
                            });
                            if (creditsResult.entitlements) {
                                socket.emit('identity_update', { entitlements: creditsResult.entitlements });
                            }
                            const packs = creditsResult.grantsApplied?.packs || [];
                            const packText = packs.length ? `\nUnlocked: ${packs.map(p => p.id).join(', ')}` : '';
                            socket.emit('payment_confirmed', {
                                paymentId: paymentRequest.id,
                                message: `Payment confirmed! Added ${creditsResult.creditsAdded} credits. New balance: ${creditsResult.newBalance}${packText}`,
                                creditsAdded: creditsResult.creditsAdded,
                                newBalance: creditsResult.newBalance,
                                grantsApplied: creditsResult.grantsApplied,
                                confirmations: status.confirmations
                            });
                            this.broadcastManager.sendStatusUpdate(socket.id, 'success',
                                `✅ PURCHASE CONFIRMED!\n\n+${creditsResult.creditsAdded} credits added.\nNew balance: ${creditsResult.newBalance} credits.${packText}\n\nType 'enter' to start a game!`);
                        } else if (creditsResult.alreadyProcessed) {
                            // Payment was already confirmed (e.g., after server restart) - just notify user
                            console.log(`[PaymentHandlers] Payment ${paymentRequest.id} already processed, skipping duplicate`);
                            socket.emit('payment_confirmed', { paymentId: paymentRequest.id, message: 'Payment already processed.', confirmations: status.confirmations });
                        } else {
                            console.error('Failed to process credits package:', creditsResult.reason);
                            socket.emit('payment_review_required', {
                                paymentId: paymentRequest.id,
                                code: 'PAYMENT_GRANT_REJECTED',
                                message: 'Funds were detected, but the purchase was not applied and requires support review.'
                            });
                            this.broadcastManager.sendStatusUpdate(socket.id, 'error',
                                'Payment received, but no entitlement was applied. Contact support for review.');
                        }
                    } catch (e) {
                        console.error('Error processing credits package confirmation:', e.message);
                        socket.emit('payment_review_required', {
                            paymentId: paymentRequest.id,
                            code: 'PAYMENT_RECEIPT_REJECTED',
                            message: 'Funds were detected, but the purchase transaction failed and requires support review.'
                        });
                        this.broadcastManager.sendStatusUpdate(socket.id, 'error',
                            'Payment received, but no entitlement was applied. Contact support for review.');
                    }
                    // Defensively remove from queue — credits purchases should never be queued
                    this.queueManager.removePlayer(socket.id);
                } else {
                    // single_game payment - standard flow
                    // CRITICAL: Atomically update payment status and check if we actually updated it
                    // This prevents double-processing on server restart
                    let wasUpdated = false;
                    let confirmationError = null;
                    try {
                        if (typeof this.gameModeManager?.confirmSingleGamePayment === 'function') {
                            const confirmation = await this.gameModeManager.confirmSingleGamePayment(
                                paymentRequest.id,
                                money.toBig(status.amount || 0).toString(),
                                status.receipts || []
                            );
                            wasUpdated = confirmation?.updated === true;
                        } else if (this.gameModeManager && this.gameModeManager.db) {
                            const updateResult = await this.gameModeManager.db.query(`
                                UPDATE payments
                                SET status = 'confirmed',
                                    confirmed_at = NOW(),
                                    received_amount = $2
                                WHERE id = $1 AND status = 'pending'
                                RETURNING id
                            `, [paymentRequest.id, money.toBig(status.amount || 0).toString()]);
                            wasUpdated = updateResult.rows.length > 0;
                            if (this.debugManager.CONSOLE_LOGGING) {
                                console.log(`[PaymentHandlers] Payment ${paymentRequest.id} status update: ${wasUpdated ? 'success' : 'already confirmed'}`);
                            }
                        }
                    } catch (dbErr) {
                        confirmationError = dbErr;
                        console.error('[PaymentHandlers] Failed to update payment status in DB:', dbErr.message);
                    }

                    // Only proceed with game logic if we actually confirmed this payment
                    if (!wasUpdated) {
                        if (confirmationError) {
                            socket.emit('payment_review_required', {
                                paymentId: paymentRequest.id,
                                code: 'PAYMENT_RECEIPT_REJECTED',
                                message: 'Funds were detected, but their receipt evidence requires support review.'
                            });
                            this.stopMonitoringForSocket(socket.id);
                            return;
                        }
                        console.log(`[PaymentHandlers] Payment ${paymentRequest.id} already confirmed, skipping duplicate processing`);
                        socket.emit('payment_confirmed', { paymentId: paymentRequest.id, message: 'Payment already processed.', confirmations: status.confirmations });
                        this.stopMonitoringForSocket(socket.id);
                        return;
                    }

                    socket.emit('payment_confirmed', { paymentId: paymentRequest.id, message: 'Payment confirmed in block!', confirmations: status.confirmations });

                    // Unify to credits: a direct/single_game entry counts as buying + spending 1
                    // credit, so it advances total_credits_purchased and unlocks the same tier/
                    // threshold cosmetics as a credit purchase. (Runs once — guarded by wasUpdated.)
                    if (this.gameModeManager && typeof this.gameModeManager.recordDirectEntryPurchase === 'function') {
                        try {
                            const rec = await this.gameModeManager.recordDirectEntryPurchase(socket.id);
                            if (rec) {
                                socket.emit('credits_update', {
                                    balance: rec.balance,
                                    totalCreditsPurchased: rec.totalCreditsPurchased,
                                    ...(rec.entitlements || {})
                                });
                                if (rec.entitlements) socket.emit('identity_update', { entitlements: rec.entitlements });
                            }
                        } catch (e) {
                            console.error('[PaymentHandlers] direct-entry credit record failed:', e.message);
                        }
                    }

                    // IMPORTANT: If payment confirmed before mempool detection (fast blocks),
                    // the player may not be in the queue yet. Add them now with confirmed=true.
                    const existingIdx = this.queueManager.getPlayerIndex(socket.id);
                    if (existingIdx === -1) {
                        console.log(`[PaymentHandlers] Payment confirmed but player not in queue - adding now (socket: ${socket.id})`);
                        // Try to get DB userId from session
                        let userId = null;
                        if (this.sessionManager?.sessions?.has(socket.id)) {
                            userId = this.sessionManager.sessions.get(socket.id).id;
                        }
                        this.queueManager.addPlayer({
                            serverId: socket.id,
                            clientId: currentUser ? currentUser.clientId : null,
                            userId: userId,
                            paymentId: paymentRequest.id,
                            requiresConfirmation: false, // Already confirmed
                            confirmed: true,
                            fairnessProof: mapping?.fairnessProof || null
                        });
                    } else {
                        // Player was in queue from mempool detection, just mark confirmed
                        this.queueManager.markConfirmed(socket.id);
                    }

                    // Attempt immediate game start so user doesn't wait another full block
                    const currentBlock = this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() : null;
                    if (currentBlock !== null) {
                        const started = await this.queueManager.startGameImmediately(socket.id, currentBlock);
                        if (!started) {
                            console.log(`[PaymentHandlers] Immediate start failed for ${socket.id} - player will start on next block`);
                            if (this.debugManager.CONSOLE_LOGGING) {
                                this.queueManager.debugDumpQueue();
                            }
                        } else {
                            console.log(`[PaymentHandlers] ✅ Immediate game start successful for ${socket.id}`);
                        }
                    } else {
                        console.log(`[PaymentHandlers] No block height available - player will start on next block`);
                    }
                }
                // Clean up monitoring for this socket (even if duplicate)
                this.stopMonitoringForSocket(socket.id);
            }
    }

    /**
     * Check if a socket has active payment monitoring
     * @param {string} socketId - The socket ID to check
     * @returns {boolean} True if monitoring is active
     */
    hasActiveMonitoring(socketId) {
        return this.socketPaymentMap.has(socketId);
    }

    /**
     * Stop monitoring (if any) for a given socket (disconnect/expiry)
     */
    stopMonitoringForSocket(socketId) {
        const mapping = this.socketPaymentMap.get(socketId);
        if (mapping) {
            if (mapping.provider && typeof mapping.provider.stopWatch === 'function') {
                mapping.provider.stopWatch(mapping.watchRef || mapping.address); // native delegates to stopPaymentMonitoring
            } else {
                this.walletService.stopPaymentMonitoring(mapping.address);
            }
            this.socketPaymentMap.delete(socketId);
            this.mempoolNotified.delete(mapping.address);
            if (mapping.paymentId != null) {
                this.underpaidNotified.delete(mapping.paymentId);
            }
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`🛑 Stopped monitoring for socket ${socketId}`);
            }
        }
        const expiry = this._expiryTimeouts.get(socketId);
        if (expiry) {
            clearTimeout(expiry);
            this._expiryTimeouts.delete(socketId);
        }
    }

    /**
     * Dispose resources (intervals, monitors) - useful for tests / graceful shutdown.
     */
    dispose() {
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }
        for (const socketId of Array.from(this.socketPaymentMap.keys())) {
            this.stopMonitoringForSocket(socketId);
        }
        for (const [socketId, to] of this._expiryTimeouts.entries()) {
            clearTimeout(to);
            this._expiryTimeouts.delete(socketId);
        }
        this.pendingCommerceAcknowledgement.clear();
        this.pendingEntryFairness.clear();
    }
}

module.exports = PaymentHandlers;
