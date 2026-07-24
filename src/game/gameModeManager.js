/**
 * Game Mode Manager
 * Handles different game modes (FREE, PAID_SINGLE, PAID_CREDITS)
 */

const {
    DEFAULT_DECIMALS,
    parseAtomicEnvValue,
    inferCurrencyDecimals: inferCurrencyDecimalsForSymbol,
    formatAtomic,
    formatAtomicHuman,
    getDecimalDivisor,
    gameNameFor,
    currencyLabelFor
} = require('./helpers/gameModeUtils');
const { ValidationError, normalizeError } = require('../utils/errors');
const paymentConfig = require('../config/paymentConfig');
const money = require('../money/atomic');
const Entitlements = require('../multiplayer/entitlements');
const ProductGrants = require('../payments/productGrants');
const { hashSeed, normalizeClientSeed } = require('./provablyFair');
const { buildProviderRegistry } = require('../payments/providers');
const { listMatchRulesets, resolveMatchRuleset } = require('./rulesets');
const { matchPayoutAdmissionPolicy } = require('../network/matchEconomyPolicy');
const { isSmirkEnabled } = require('../auth/smirkPolicy');
const { reservePayoutCapacity } = require('../services/payoutAdmissionService');
const { getOperatedProductProfile } = require('../config/operatedProductProfiles');

// A wallet "not enough (unlocked) money" error is raised BEFORE the tx is broadcast, so it
// is SAFE to retry (no double-pay risk) — unlike an ambiguous post-broadcast failure. Monero
// locks spent outputs (incl. change) for ~10 blocks, so this is the expected error when all
// outputs are temporarily locked.
function payoutErrorText(error, depth = 0) {
    if (depth > 4 || error == null) return '';
    if (typeof error === 'string') return error;
    const parts = [error.message, error.details && JSON.stringify(error.details)];
    if (error.cause && error.cause !== error) parts.push(payoutErrorText(error.cause, depth + 1));
    return parts.filter(Boolean).join(' ');
}

function isInsufficientFundsError(error) {
    return /not enough (unlocked )?(money|balance|outputs)|insufficient|no unlocked|unlocked balance/i
        .test(payoutErrorText(error));
}

const DEFAULT_SINGLE_GAME_PRICE = 5000000000;   // 0.005 XMR or 0.05 WOW depending on currency decimals
const DEFAULT_CREDITS_PACKAGE_PRICE = 50000000000;
const NO_PAYOUT_ADDRESS_SENTINEL = 'PENDING_NO_ADDRESS';
const TX_HASH_PATTERN = /^[0-9a-f]{64}$/i;

function validTxHash(value) {
    return typeof value === 'string' && TX_HASH_PATTERN.test(value.trim());
}

class GameModeManager {
    constructor(databaseManager, walletRPCService, debugManager, paymentConfigManager = null, paymentProviders = null) {
        this.db = databaseManager;
        this.walletService = walletRPCService;
        this.debugManager = debugManager;
        this.paymentConfigManager = paymentConfigManager || null;

        // Modular payment providers (Pillar 3). Defaults to a registry whose only member is the
        // native Monero/Wownero provider wrapping this walletService — so with no gateway env set
        // every chain routes to the existing wallet-RPC path and behavior is unchanged. Injectable
        // for tests. See src/payments/providers/index.js + the btcpay-infra-topology memo.
        this.paymentProviders = paymentProviders || buildProviderRegistry({ walletService: walletRPCService });

        this.cryptoType = process.env.CRYPTO_TYPE || 'XMR';
        this.currencyDecimals = this.inferCurrencyDecimals(this.cryptoType);
        
        // Network configuration (mainnet/stagenet/testnet) - only applies to Monero
        // Wownero only has mainnet, so this is ignored for WOW
        this.network = (process.env.MONERO_NETWORK || 'mainnet').toLowerCase();
        this.isTestNetwork = this.network === 'stagenet' || this.network === 'testnet';
        
        this.singleGamePrice = DEFAULT_SINGLE_GAME_PRICE;
        this.creditsPackagePrice = DEFAULT_CREDITS_PACKAGE_PRICE;
        // PAYOUTS_ENABLED is the operator's emergency/master kill switch. Per-mode flags are
        // subordinate to it; keeping the values separate makes hot config changes reversible
        // without losing the configured direct/credits policy.
        this.payoutsEnabled = true;
        this.creditsPayoutEnabled = false;
        this.directPayoutEnabled = true;
        this.directRequiresAddress = true;
        this.creditsRequiresAddress = true;
        this.creditsPayoutBaseValue = DEFAULT_SINGLE_GAME_PRICE;
        this.directPayoutMultipliers = { escape: 2, escapeWithTreasure: 3 };
        this.creditPayoutMultipliers = { escape: 2, escapeWithTreasure: 3 };
        this.creditsPerGameCost = 1;
        this.preferCreditsFirst = true;
        this.paymentsEnabled = false;
        this.directModeEnabled = false;
        this.creditsModeEnabled = false;
        this.configSnapshot = null;
        this._batchPayoutTimer = null;
        this._isBatchProcessing = false;
        this._isShuttingDown = false;
        this._gameAdmissionClosed = false;
        this._gameStartAdmissions = new Set();
        // The composition root replaces this with the dynamic startup/runtime financial
        // reconciliation gate. Default-open keeps isolated free/test instances compatible.
        this.financialAdmissionAllowed = () => true;

        this.applyLegacyEnvConfig();

        if (this.paymentConfigManager) {
            const config = this.paymentConfigManager.getConfig();
            this.applyConfigSnapshot(config, { emitLog: false });
            this.setLegacyGameMode(this.paymentConfigManager.getLegacyGameMode());

            if (this.paymentConfigManager.eventBus && typeof this.paymentConfigManager.eventBus.on === 'function') {
                this.paymentConfigManager.eventBus.on('paymentConfig:update', (updatedConfig) => {
                    this.applyConfigSnapshot(updatedConfig, { emitLog: true, context: 'updated' });
                    this.setLegacyGameMode(this.paymentConfigManager.getLegacyGameMode());
                });
            }
        }

        this.logConfiguration('initialized');
    }

    inferCurrencyDecimals(symbol) {
        return inferCurrencyDecimalsForSymbol(symbol);
    }

    // Product name (Monerogue/Wownerogue) and network-aware currency label (sXMR on
    // stagenet, XMR on mainnet, WOW for Wownero) — derived so they always track config.
    get gameName() { return gameNameFor(this.cryptoType); }
    get currencyLabel() { return currencyLabelFor(this.cryptoType, this.network); }

    applyLegacyEnvConfig() {
        this.setLegacyGameMode(process.env.GAME_MODE || 'FREE');
        this.cryptoType = process.env.CRYPTO_TYPE || this.cryptoType;
        this.currencyDecimals = this.inferCurrencyDecimals(this.cryptoType);
        // Support both DIRECT_GAME_PRICE and legacy SINGLE_GAME_PRICE
        this.singleGamePrice = parseAtomicEnvValue(process.env.DIRECT_GAME_PRICE || process.env.SINGLE_GAME_PRICE, this.singleGamePrice);
        this.creditsPackagePrice = parseAtomicEnvValue(process.env.CREDITS_PACKAGE_PRICE, this.creditsPackagePrice);
        this.creditsPerGameCost = parseAtomicEnvValue(process.env.CREDITS_PER_GAME, 1) || 1;
        this.payoutsEnabled = !/^false$/i.test(process.env.PAYOUTS_ENABLED || 'true');
        this.creditsPayoutEnabled = /^true$/i.test(process.env.CREDITS_PAYOUTS_ENABLED || process.env.CREDITS_PAYOUT_ENABLED || 'false');
        // Direct (per-game / entry-fee) payouts must be independently gateable, like credits.
        // Default true for backward compatibility; set DIRECT_PAYOUTS_ENABLED=false for a
        // no-payout instance (sell entry/credits for prestige only, e.g. mainnet legitimacy).
        this.directPayoutEnabled = !/^false$/i.test(process.env.DIRECT_PAYOUTS_ENABLED || 'true');
        this.directRequiresAddress = !/^false$/i.test(process.env.DIRECT_REQUIRES_ADDRESS || 'true');
        this.creditsRequiresAddress = !/^false$/i.test(process.env.CREDITS_REQUIRES_ADDRESS || 'true');
        this.creditsPayoutBaseValue = parseAtomicEnvValue(process.env.CREDITS_PAYOUT_BASE, this.singleGamePrice);
        process.env.CREDITS_PER_GAME = String(this.creditsPerGameCost);

        const directEscape = Number(process.env.DIRECT_PAYOUT_ESCAPE);
        if (Number.isFinite(directEscape) && directEscape > 0) {
            this.directPayoutMultipliers.escape = directEscape;
        }
        const directTreasure = Number(process.env.DIRECT_PAYOUT_TREASURE);
        if (Number.isFinite(directTreasure) && directTreasure > 0) {
            this.directPayoutMultipliers.escapeWithTreasure = directTreasure;
        }
        const creditsEscape = Number(process.env.CREDITS_PAYOUT_ESCAPE);
        if (Number.isFinite(creditsEscape) && creditsEscape > 0) {
            this.creditPayoutMultipliers.escape = creditsEscape;
        }
        const creditsTreasure = Number(process.env.CREDITS_PAYOUT_TREASURE);
        if (Number.isFinite(creditsTreasure) && creditsTreasure > 0) {
            this.creditPayoutMultipliers.escapeWithTreasure = creditsTreasure;
        }

        if (process.env.PREFER_CREDITS_FIRST) {
            this.preferCreditsFirst = /^true$/i.test(process.env.PREFER_CREDITS_FIRST);
        }

        this.paymentsEnabled = this.gameMode !== 'FREE';
        this.directModeEnabled = this.gameMode === 'PAID_SINGLE';
        this.creditsModeEnabled = this.gameMode === 'PAID_CREDITS';

        // FREE_PLAY_ENABLED lets players CHOOSE free play even on an instance that also
        // sells credits/entry (their score goes to the Pleb board; paid games go to the
        // Hall of Champions). Always true when payments are off (free is the only option).
        this.freePlayEnabled = !this.paymentsEnabled || /^true$/i.test(process.env.FREE_PLAY_ENABLED || 'false');
    }

    applyConfigSnapshot(config, options = {}) {
        if (!config || typeof config !== 'object') {
            return;
        }

        this.configSnapshot = config;
        this.paymentsEnabled = !!config.paymentsEnabled;

        if (config.currency) {
            if (config.currency.symbol) {
                this.cryptoType = config.currency.symbol;
            }
            if (config.currency.decimals !== undefined) {
                this.currencyDecimals = Number(config.currency.decimals);
            } else {
                this.currencyDecimals = this.inferCurrencyDecimals(this.cryptoType);
            }
        }

        if (config.modes && config.modes.direct) {
            const { price, enabled, requiresAddress } = config.modes.direct;
            if (price !== undefined && price !== null) {
                this.singleGamePrice = money.toSafe(money.toBig(price));
            }
            this.directModeEnabled = !!enabled;
            if (requiresAddress !== undefined) {
                this.directRequiresAddress = !!requiresAddress;
            }
        }

        if (config.modes && config.modes.credits) {
            const creditsMode = config.modes.credits;
            if (creditsMode.packages && creditsMode.packages.length > 0) {
                const primaryPackage = creditsMode.packages[0];
                if (primaryPackage.price !== undefined && primaryPackage.price !== null) {
                    this.creditsPackagePrice = money.toSafe(money.toBig(primaryPackage.price));
                }
                if (primaryPackage.credits) {
                    process.env.CREDITS_PER_PACKAGE = String(primaryPackage.credits);
                }
            }
            if (creditsMode.creditsPerGame !== undefined) {
                this.creditsPerGameCost = Number(creditsMode.creditsPerGame) || 1;
            }
            this.creditsModeEnabled = !!creditsMode.enabled;
            if (creditsMode.requiresAddress !== undefined) {
                this.creditsRequiresAddress = !!creditsMode.requiresAddress;
            }
        }

        if (config.payouts && config.payouts.enabled !== undefined) {
            this.payoutsEnabled = !!config.payouts.enabled;
        }

        if (config.payouts && config.payouts.rules) {
            const directRule = config.payouts.rules.direct || {};
            const creditsRule = config.payouts.rules.credits || {};

            if (directRule.enabled !== undefined) {
                this.directPayoutEnabled = !!directRule.enabled;
            }

            if (directRule.multipliers) {
                if (directRule.multipliers.escape !== undefined) {
                    this.directPayoutMultipliers.escape = Number(directRule.multipliers.escape);
                }
                if (directRule.multipliers.escapeWithTreasure !== undefined) {
                    this.directPayoutMultipliers.escapeWithTreasure = Number(directRule.multipliers.escapeWithTreasure);
                }
            }

            if (creditsRule.multipliers) {
                if (creditsRule.multipliers.escape !== undefined) {
                    this.creditPayoutMultipliers.escape = Number(creditsRule.multipliers.escape);
                }
                if (creditsRule.multipliers.escapeWithTreasure !== undefined) {
                    this.creditPayoutMultipliers.escapeWithTreasure = Number(creditsRule.multipliers.escapeWithTreasure);
                }
            }

            if (creditsRule.baseValue !== undefined) {
                this.creditsPayoutBaseValue = money.toSafe(money.toBig(creditsRule.baseValue));
            }

            if (creditsRule.enabled !== undefined) {
                this.creditsPayoutEnabled = !!creditsRule.enabled;
            }
        }

        if (config.preferences) {
            if (config.preferences.preferCreditsFirst !== undefined) {
                this.preferCreditsFirst = !!config.preferences.preferCreditsFirst;
            }
        }

        process.env.SINGLE_GAME_PRICE = String(this.singleGamePrice);
        process.env.CREDITS_PACKAGE_PRICE = String(this.creditsPackagePrice);
        process.env.CREDITS_PER_GAME = String(this.creditsPerGameCost);
        process.env.CREDITS_PAYOUT_ENABLED = this.creditsPayoutEnabled ? 'true' : 'false';
        process.env.CREDITS_PAYOUTS_ENABLED = process.env.CREDITS_PAYOUT_ENABLED;

        // applyLegacyEnvConfig() runs before the unified config snapshot. Without recomputing
        // here, an instance with no legacy GAME_MODE starts from FREE and accidentally keeps
        // free play enabled even when FREE_PLAY_ENABLED=false and paid modes are active.
        this.freePlayEnabled = !this.paymentsEnabled
            || /^true$/i.test(process.env.FREE_PLAY_ENABLED || 'false');

        if (options.emitLog) {
            this.logConfiguration(options.context || 'updated');
        }
    }

    setLegacyGameMode(mode) {
        this.gameMode = (mode || 'FREE').toUpperCase();
        process.env.GAME_MODE = this.gameMode;
    }

    formatAtomic(value) {
        return formatAtomic({
            value,
            decimals: Number.isFinite(this.currencyDecimals) ? this.currencyDecimals : DEFAULT_DECIMALS
        });
    }

    getDecimalDivisor() {
        return getDecimalDivisor(Number.isFinite(this.currencyDecimals) ? this.currencyDecimals : DEFAULT_DECIMALS);
    }

    formatAtomicHuman(value, digits = 3) {
        return formatAtomicHuman({
            value,
            decimals: Number.isFinite(this.currencyDecimals) ? this.currencyDecimals : DEFAULT_DECIMALS,
            digits
        });
    }

    getPrimaryCreditPackage() {
        const packages = this.configSnapshot?.modes?.credits?.packages;
        if (Array.isArray(packages) && packages.length > 0) {
            return packages[0];
        }
        return {
            id: 'default',
            credits: 10,
            price: this.creditsPackagePrice,
            bonus: 0
        };
    }

    /**
     * PAYMENTS_ENABLED is the intake kill switch.  Product-specific switches narrow it further;
     * they can never create an invoice when the master switch is off.  Keep this predicate pure
     * so Socket.IO can refuse before consuming a fairness offer or touching wallet/DB state, and
     * enforce it again in createPaymentRequest for non-Socket.IO callers.
     */
    isPaymentIntakeEnabled(paymentType) {
        if (!this._isFinancialAdmissionAllowed()) return false;
        if (!this.paymentsEnabled) return false;
        if (paymentType === 'single_game') return Boolean(this.directModeEnabled);
        if (paymentType === 'credits_package') return Boolean(this.creditsModeEnabled);
        if (paymentType === 'cosmetic_pack') return true;
        // Unknown products are rejected by the canonical switch below; keeping them distinct
        // from a disabled product produces the correct operator/client diagnostic.
        return true;
    }

    _isFinancialAdmissionAllowed() {
        try {
            return typeof this.financialAdmissionAllowed !== 'function'
                || this.financialAdmissionAllowed() === true;
        } catch (_) {
            return false;
        }
    }

    _financialRecoveryPendingResult() {
        return {
            success: false,
            code: 'FINANCIAL_RECOVERY_PENDING',
            reason: 'Financial recovery is still pending; paid entry is temporarily unavailable.'
        };
    }

    _assertPaymentIntakeEnabled(paymentType) {
        if (this.isPaymentIntakeEnabled(paymentType)) return;
        const product = paymentType === 'single_game'
            ? 'Direct entry'
            : (paymentType === 'credits_package' ? 'Credit purchases' : 'Payment intake');
        throw new ValidationError(`${product} is disabled by runtime policy`, {
            code: 'PAYMENT_INTAKE_DISABLED',
            safeMessage: 'That paid product is not available on this server.'
        });
    }

    _requiresPaidFairnessV2() {
        // Production invoices are never allowed to opt out: the proof must be committed
        // before funds can arrive and survive a restart on the durable payment row.
        if (process.env.NODE_ENV === 'production') return true;
        if (/^false$/i.test(process.env.REQUIRE_PAID_FAIRNESS_V2 || '')) return false;
        return /^true$/i.test(process.env.REQUIRE_PAID_FAIRNESS_V2 || '');
    }

    /** Validate and reduce private offer material before binding it to a payment row. */
    _normalizePaymentFairnessProof(input, { required = this._requiresPaidFairnessV2() } = {}) {
        if (!input || typeof input !== 'object') {
            if (required) {
                throw new ValidationError('A v2 fairness offer is required before creating a paid entry', {
                    safeMessage: 'Request a new fairness offer before paying.'
                });
            }
            return null;
        }
        const proofVersion = Number(input.proofVersion);
        const offerId = typeof input.offerId === 'string' ? input.offerId.trim() : '';
        const serverSeed = typeof input.serverSeed === 'string' ? input.serverSeed.trim().toLowerCase() : '';
        const commitment = typeof input.commitment === 'string' ? input.commitment.trim().toLowerCase() : '';
        const clientSeed = normalizeClientSeed(input.clientSeed);
        const issuedMs = input.offerIssuedAt instanceof Date
            ? input.offerIssuedAt.getTime()
            : Number(input.offerIssuedAt);
        if (proofVersion !== 2
            || !offerId || offerId.length > 64
            || !/^[0-9a-f]{64}$/.test(serverSeed)
            || !/^[0-9a-f]{64}$/.test(commitment)
            || hashSeed(serverSeed) !== commitment
            || clientSeed === null
            || !Number.isFinite(issuedMs) || issuedMs <= 0) {
            throw new ValidationError('Invalid v2 fairness proof supplied for paid entry', {
                safeMessage: 'The fairness offer is invalid or expired. Request a new offer.'
            });
        }
        return {
            proofVersion: 2,
            offerId,
            offerIssuedAt: issuedMs,
            serverSeed,
            commitment,
            clientSeed
        };
    }

    _paymentFairnessProofFromRow(row) {
        if (!row || row.fairness_bound_at == null) return null;
        try {
            return this._normalizePaymentFairnessProof({
                proofVersion: row.fairness_proof_version,
                offerId: row.fairness_offer_id,
                offerIssuedAt: row.fairness_offer_issued_at instanceof Date
                    ? row.fairness_offer_issued_at.getTime()
                    : Date.parse(row.fairness_offer_issued_at),
                serverSeed: row.fairness_server_seed,
                commitment: row.fairness_commitment,
                clientSeed: row.fairness_client_seed || ''
            }, { required: true });
        } catch (_) {
            return null;
        }
    }

    _normalizeConfirmationReceipts(receipts, providerId) {
        if (!Array.isArray(receipts)) return [];
        const expectedProvider = String(providerId || 'native-monero');
        const normalized = new Map();
        for (const receipt of receipts) {
            const evidenceType = String(receipt?.evidenceType || '');
            const receiptProvider = String(receipt?.providerId || expectedProvider);
            const evidenceId = String(receipt?.evidenceId || '').trim();
            const txHash = typeof receipt?.txHash === 'string'
                ? receipt.txHash.trim().toLowerCase()
                : null;
            const rawOutputId = typeof receipt?.outputId === 'string'
                ? receipt.outputId.trim().toLowerCase()
                : null;
            const addressIndex = receipt?.addressIndex == null ? null : Number(receipt.addressIndex);
            const amount = money.toBig(receipt?.amount);
            if (receipt?.confirmed !== true || receiptProvider !== expectedProvider
                || amount <= 0n || !evidenceId || evidenceId.length > 160) {
                throw new ValidationError('Invalid confirmed payment receipt evidence');
            }
            let outputId = rawOutputId;
            if (evidenceType === 'chain_output') {
                if (outputId?.startsWith('global:')) {
                    const rawIndex = outputId.slice('global:'.length);
                    if (!/^\d+$/.test(rawIndex)) {
                        throw new ValidationError('Invalid native chain-output receipt evidence');
                    }
                    const index = BigInt(rawIndex);
                    if (index > 18446744073709551615n) {
                        throw new ValidationError('Invalid native chain-output receipt evidence');
                    }
                    outputId = `global:${index.toString()}`;
                }
                if (expectedProvider !== 'native-monero' || !validTxHash(txHash)
                    || (!/^[0-9a-f]{64}$/.test(outputId || '')
                        && !/^global:(0|[1-9]\d*)$/.test(outputId || ''))
                    || evidenceId.toLowerCase() !== `${txHash}:${outputId}`
                    || !Number.isInteger(addressIndex) || addressIndex < 0) {
                    throw new ValidationError('Invalid native chain-output receipt evidence');
                }
            } else if (evidenceType === 'provider_invoice') {
                if (expectedProvider === 'native-monero' || txHash !== null
                    || outputId !== null || addressIndex !== null) {
                    throw new ValidationError('Invalid provider-invoice receipt evidence');
                }
            } else {
                throw new ValidationError('Unknown payment receipt evidence type');
            }
            const value = {
                providerId: expectedProvider,
                evidenceType,
                evidenceId: evidenceType === 'chain_output' ? `${txHash}:${outputId}` : evidenceId,
                txHash,
                outputId,
                addressIndex,
                amount: amount.toString()
            };
            const prior = normalized.get(value.evidenceId);
            if (prior) {
                if (JSON.stringify(prior) !== JSON.stringify(value)) {
                    throw new ValidationError('Conflicting duplicate payment receipt evidence');
                }
                continue;
            }
            normalized.set(value.evidenceId, value);
        }
        return Array.from(normalized.values());
    }

    async _persistConfirmationReceipts(client, payment, receipts, { requireCoverage = true } = {}) {
        const providerId = String(payment.provider_id || 'native-monero');
        const normalized = this._normalizeConfirmationReceipts(receipts, providerId);
        if (normalized.length === 0) {
            if (process.env.NODE_ENV === 'production') {
                throw new ValidationError('Confirmed payment has no durable receipt evidence');
            }
            return null;
        }
        if (providerId === 'native-monero') {
            const paymentAddressIndex = Number(payment.address_index);
            if (!Number.isInteger(paymentAddressIndex) || paymentAddressIndex < 0
                || normalized.some(receipt => receipt.addressIndex !== paymentAddressIndex)) {
                throw new ValidationError('Chain-output receipt does not belong to this invoice address');
            }
        }
        for (const receipt of normalized) {
            await client.query(`
                INSERT INTO payment_receipts (
                    payment_id, provider_id, evidence_type, evidence_id,
                    tx_hash, output_id, address_index, amount, confirmed
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, TRUE)
                ON CONFLICT (provider_id, evidence_id) DO NOTHING
            `, [payment.id, receipt.providerId, receipt.evidenceType, receipt.evidenceId,
                receipt.txHash, receipt.outputId, receipt.addressIndex, receipt.amount]);
        }
        const evidence = await client.query(`
            SELECT COALESCE(SUM(amount), 0)::text AS total,
                   MIN(tx_hash) FILTER (WHERE tx_hash IS NOT NULL) AS primary_tx_hash,
                   COUNT(*)::text AS receipt_count
            FROM payment_receipts
            WHERE payment_id = $1 AND provider_id = $2 AND confirmed = TRUE
              AND (($2 = 'native-monero' AND evidence_type = 'chain_output')
                OR ($2 <> 'native-monero' AND evidence_type = 'provider_invoice'))
        `, [payment.id, providerId]);
        const total = money.toBig(evidence.rows[0]?.total || 0);
        const expected = money.toBig(payment.expected_amount);
        if (requireCoverage && total < expected) {
            throw new ValidationError('Confirmed receipts do not cover the invoice amount');
        }
        return {
            total,
            primaryTxHash: evidence.rows[0]?.primary_tx_hash || null,
            receiptCount: Number(evidence.rows[0]?.receipt_count || 0)
        };
    }

    async confirmSingleGamePayment(paymentId, receivedAmount, receipts = []) {
        return this.db.withTransaction(async (client) => {
            const locked = await client.query(`
                SELECT id, status, expected_amount, provider_id, address_index
                FROM payments WHERE id = $1 FOR UPDATE
            `, [paymentId]);
            const payment = locked.rows[0];
            if (!payment || payment.status !== 'pending') return { updated: false };
            const evidence = await this._persistConfirmationReceipts(client, payment, receipts);
            const received = evidence?.total ?? money.toBig(receivedAmount || 0);
            if (received < money.toBig(payment.expected_amount)) return { updated: false, underpaid: true };
            const update = await client.query(`
                UPDATE payments
                SET status = 'confirmed', confirmed_at = NOW(), received_amount = $2::bigint,
                    tx_hash = COALESCE($3, tx_hash), confirmation_evidence_at = NOW()
                WHERE id = $1 AND status = 'pending'
                RETURNING id
            `, [paymentId, received.toString(), evidence?.primaryTxHash || null]);
            return { updated: update.rows.length === 1 };
        });
    }

    /**
     * Persist receipts discovered after invoice expiry without granting a game or product.
     * The payment is left expired and a durable manual-review item is upserted. This makes late
     * mining/refund cases visible while keeping stale or unbound entries out of the game queue.
     */
    async reconcileLatePaymentForReview(paymentId, receipts = []) {
        return this.db.withTransaction(async (client) => {
            const locked = await client.query(`
                SELECT id, status, expected_amount, provider_id, address_index
                FROM payments
                WHERE id = $1
                FOR UPDATE
            `, [paymentId]);
            const payment = locked.rows[0];
            if (!payment || !['pending', 'expired'].includes(payment.status)) {
                return { checked: false, needsReview: false };
            }

            let evidence = null;
            if (Array.isArray(receipts) && receipts.length > 0) {
                evidence = await this._persistConfirmationReceipts(client, payment, receipts, {
                    requireCoverage: false
                });
            }
            const observed = evidence?.total || 0n;

            await client.query(`
                UPDATE payments
                SET status = CASE WHEN status = 'pending' THEN 'expired' ELSE status END,
                    late_receipt_checked_at = NOW(),
                    received_amount = GREATEST(COALESCE(received_amount, 0), $2::bigint)
                WHERE id = $1
            `, [paymentId, observed.toString()]);

            if (observed <= 0n || !evidence?.receiptCount) {
                return { checked: true, needsReview: false };
            }

            const coverageComplete = observed >= money.toBig(payment.expected_amount);
            await client.query(`
                INSERT INTO payment_late_reviews (
                    payment_id, provider_id, observed_amount, expected_amount,
                    receipt_count, metadata
                ) VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6::jsonb)
                ON CONFLICT (payment_id) DO UPDATE
                SET provider_id = EXCLUDED.provider_id,
                    status = 'needs_review',
                    observed_amount = GREATEST(payment_late_reviews.observed_amount,
                        EXCLUDED.observed_amount),
                    expected_amount = EXCLUDED.expected_amount,
                    receipt_count = GREATEST(payment_late_reviews.receipt_count,
                        EXCLUDED.receipt_count),
                    metadata = EXCLUDED.metadata,
                    last_observed_at = NOW(),
                    resolved_at = NULL
            `, [paymentId, payment.provider_id || 'native-monero', observed.toString(),
                String(payment.expected_amount), evidence.receiptCount,
                JSON.stringify({ coverageComplete, entitlementGranted: false })]);

            return {
                checked: true,
                needsReview: true,
                observedAmount: observed.toString(),
                coverageComplete
            };
        });
    }


    _getMatchEconomies() {
        const out = { free: true };
        if (this.creditsModeEnabled || this.freePlayEnabled) {
            out.credits_prestige = true;
        }
        // Crypto admission has its own explicit switch, payout cap, ruleset contract, and the
        // global payout safety gate. Existing accepted matches settle from their DB snapshot;
        // this policy controls only new queue admission.
        const cryptoPolicy = matchPayoutAdmissionPolicy({
            env: process.env,
            gameModeManager: this,
            ruleset: resolveMatchRuleset(process.env.MATCH_RULESET_ID || 'race'),
            requestedMaxPlayers: process.env.MATCH_MAX_PLAYERS
        });
        if (cryptoPolicy.enabled) {
            out.crypto_race = true;
        }
        return out;
    }

    _getMatchRulesetInfo() {
        const active = resolveMatchRuleset(process.env.MATCH_RULESET_ID || 'race');
        const catalog = listMatchRulesets();
        return {
            activeRuleset: catalog.find(r => r.id === active.id) || catalog.find(r => r.id === 'race'),
            rulesets: catalog
        };
    }

    /** Effective payout policy for a recorded game mode (master switch + per-mode rule). */
    isPayoutEnabledForMode(mode) {
        if (!this.payoutsEnabled) return false;
        const normalized = String(mode || '').toUpperCase();
        if (normalized === 'PAID_SINGLE') {
            return !!this.directPayoutEnabled
                && (Number(this.directPayoutMultipliers.escape) > 0
                    || Number(this.directPayoutMultipliers.escapeWithTreasure) > 0);
        }
        if (normalized === 'PAID_CREDITS') {
            return !!this.creditsPayoutEnabled
                && (Number(this.creditPayoutMultipliers.escape) > 0
                    || Number(this.creditPayoutMultipliers.escapeWithTreasure) > 0);
        }
        return false;
    }

    /** Whether this mode must have a payout address before entry/payment is accepted. */
    requiresPayoutAddressForMode(mode) {
        const normalized = String(mode || '').toUpperCase();
        if (!this.isPayoutEnabledForMode(normalized)) return false;
        if (normalized === 'PAID_SINGLE') return !!this.directRequiresAddress;
        if (normalized === 'PAID_CREDITS') return !!this.creditsRequiresAddress;
        return false;
    }

    getCosmeticProducts() {
        const products = this.configSnapshot?.products?.cosmetic;
        return Array.isArray(products) ? products : [];
    }

    getCosmeticProduct(productId) {
        const products = this.getCosmeticProducts();
        if (!productId) return products[0] || null;
        return products.find(p => p.id === productId) || null;
    }

    /**
     * Return the complete solo-payout outcome contract implemented by calculatePayout().
     * Explicitly selecting the two reachable outcomes prevents stale or experimental config
     * keys from being advertised as payout promises by public APIs.
     */
    getImplementedPayoutMultipliersForMode(mode) {
        const normalizedMode = (mode || this.gameMode || 'FREE').toUpperCase();
        const configured = normalizedMode === 'PAID_CREDITS'
            ? this.creditPayoutMultipliers
            : this.directPayoutMultipliers;
        const escape = configured?.escape ?? 0;

        return {
            escape,
            escapeWithTreasure: configured?.escapeWithTreasure ?? escape
        };
    }

    calculatePayout(mode, { treasureFound = false } = {}) {
        const normalizedMode = (mode || this.gameMode || 'FREE').toUpperCase();
        const usingCredits = normalizedMode === 'PAID_CREDITS';
        const base = usingCredits ? (this.creditsPayoutBaseValue || this.singleGamePrice) : this.singleGamePrice;
        const multipliers = this.getImplementedPayoutMultipliersForMode(normalizedMode);
        const multiplier = treasureFound
            ? (multipliers.escapeWithTreasure ?? multipliers.escape ?? 0)
            : (multipliers.escape ?? 0);

        // Exact integer math: base (atomic units) * decimal multiplier via BigInt, then
        // narrow back to a number only when exactly representable. Avoids float precision
        // loss on large atomic amounts (the old `Math.round(base * multiplier)`).
        const amount = money.toSafe(money.mulByDecimal(base, multiplier));

        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`🧮 calculatePayout: mode=${normalizedMode}, usingCredits=${usingCredits}, treasureFound=${treasureFound}`);
            console.log(`   base=${base}, multipliers=${JSON.stringify(multipliers)}, chosen multiplier=${multiplier}`);
            console.log(`   final amount=${amount} (base * multiplier = ${base} * ${multiplier})`);
        }
        
        return { amount, multiplier, base };
    }

    /**
     * Process a confirmed credits package payment - add credits to user
     * SECURITY: Uses atomic check-and-update to prevent double-crediting on server restart
     * @param {string} socketId - Socket ID of the user
     * @param {number} paymentId - Payment record ID
     * @param {object} packageInfo - Package info (credits, bonus, etc.)
     * @returns {object} Result with success, creditsAdded, newBalance, alreadyProcessed
     */
    async processProductPaymentConfirmation(socketId, paymentId, productInfo = null, receivedAmount = null, receipts = []) {
        try {
            // Look up user from payment record's user_id (stable across socket reconnects)
            // This avoids the bug where socket ID changes if user refreshes during confirmation
            const paymentLookup = await this.db.query(`
                SELECT user_id, description, status, payment_type, product_id, product_grants,
                       received_amount, expected_amount, provider_id, provider_invoice_id,
                       address_index
                FROM payments
                WHERE id = $1
            `, [paymentId]);

            if (paymentLookup.rows.length === 0) {
                console.error(`Payment ${paymentId} not found`);
                return { success: false, reason: 'Payment not found' };
            }

            // Fast-fail if already confirmed (avoids unnecessary transaction)
            if (paymentLookup.rows[0].status === 'confirmed') {
                console.log(`Payment ${paymentId} already confirmed, skipping duplicate processing`);
                return { success: false, alreadyProcessed: true, reason: 'Payment already processed' };
            }

            const userId = paymentLookup.rows[0].user_id;
            const paymentRow = paymentLookup.rows[0];
            paymentRow.id = paymentId;

            // Determine credits to add from package info or payment description
            const paymentType = paymentRow.payment_type || 'credits_package';
            let fallbackCredits = paymentType === 'credits_package' ? 10 : 0;
            if (productInfo && productInfo.credits) {
                fallbackCredits = Number(productInfo.credits) + (Number(productInfo.bonus) || 0);
            } else {
                const desc = paymentLookup.rows[0].description || '';
                const match = desc.match(/(\d+)\s*credits?/i);
                if (match) {
                    fallbackCredits = parseInt(match[1], 10) || fallbackCredits;
                }
            }
            const durableProduct = {
                id: paymentRow.product_id,
                grants: paymentRow.product_grants || undefined
            };
            // New payments snapshot normalized grants at invoice creation. Prefer that durable
            // promise over the live catalog so a product edit cannot change ticket backing while
            // an invoice is awaiting confirmations. Legacy rows with an empty grant object retain
            // the historical catalog/description fallback.
            const hasDurableGrants = paymentRow.product_grants
                && Object.keys(paymentRow.product_grants).length > 0;
            const product = hasDurableGrants ? durableProduct : (productInfo || durableProduct);
            const productGrants = ProductGrants.normalizeProductGrants(product, { credits: fallbackCredits });
            const creditsToAdd = productGrants.credits;
            const productId = product?.id || paymentRow.product_id || paymentType;
            const grantJson = ProductGrants.serializeProductGrants(productGrants);
            const raceEntriesToAdd = productGrants.raceEntries || 0;
            const raceEntryValueAtomic = productGrants.raceEntryValueAtomic
                ? BigInt(productGrants.raceEntryValueAtomic)
                : null;
            const backingRequired = raceEntryValueAtomic === null
                ? null
                : raceEntryValueAtomic * BigInt(raceEntriesToAdd);
            let paidAtomic = null;
            for (const candidate of [paymentRow.received_amount, receivedAmount]) {
                if (candidate == null || candidate === '') continue;
                try {
                    const parsed = BigInt(String(candidate).split('.')[0]);
                    if (parsed >= 0n && (paidAtomic === null || parsed > paidAtomic)) {
                        paidAtomic = parsed;
                    }
                } catch (_) { /* try the next trusted source */ }
            }
            const cryptoTicketFundingRequired = process.env.MATCH_CRYPTO_RACE_ENABLED === 'true'
                && process.env.MATCH_PAYOUTS_ENABLED === 'true';
            let configuredMatchEntryFee = null;
            try {
                const rawEntryFee = String(process.env.MATCH_ENTRY_FEE_ATOMIC ?? '').trim().replace(/_/g, '');
                if (/^\d+$/.test(rawEntryFee)) {
                    const parsed = BigInt(rawEntryFee);
                    if (parsed > 0n) configuredMatchEntryFee = parsed;
                }
            } catch (_) { /* handled by the fail-closed condition below */ }
            if (cryptoTicketFundingRequired && raceEntriesToAdd > 0
                && (backingRequired === null
                    || configuredMatchEntryFee === null
                    || raceEntryValueAtomic !== configuredMatchEntryFee
                    || paidAtomic === null
                    || paidAtomic < backingRequired)) {
                throw new Error(`Race-entry product ${productId} lacks confirmed per-ticket payout backing`);
            }

            // CRITICAL: Wrap all three operations in a transaction.
            // If any step fails, the payment stays 'pending' and can be recovered.
            const result = await this.db.withTransaction(async (client) => {
                // Lock and finalize the durable product promise before inserting append-only
                // receipt evidence. New invoices already contain this snapshot; this also gives
                // legacy pending invoices one safe, pre-receipt upgrade path.
                const snapshotResult = await client.query(`
                    UPDATE payments
                    SET product_id = COALESCE(product_id, $2),
                        product_grants = CASE
                            WHEN product_grants = '{}'::jsonb THEN $3::jsonb
                            ELSE product_grants
                        END
                    WHERE id = $1 AND status = 'pending'
                    RETURNING id, status, expected_amount, provider_id, provider_invoice_id,
                              address_index, product_id, product_grants
                `, [paymentId, productId, JSON.stringify(grantJson)]);
                if (snapshotResult.rows.length === 0) {
                    return { alreadyProcessed: true };
                }
                const confirmationPayment = { ...paymentRow, ...snapshotResult.rows[0], id: paymentId };
                const receiptEvidence = await this._persistConfirmationReceipts(client, confirmationPayment, receipts);
                const durableReceived = receiptEvidence?.total?.toString() || receivedAmount;
                // Step 1: Atomically mark payment as confirmed (prevents double-crediting)
                const paymentUpdateResult = await client.query(`
                    UPDATE payments
                    SET status = 'confirmed',
                        credits_purchased = $1,
                        confirmed_at = NOW(),
                        received_amount = COALESCE($3, received_amount),
                        tx_hash = COALESCE($4, tx_hash),
                        confirmation_evidence_at = CASE WHEN $4::text IS NULL
                            THEN confirmation_evidence_at ELSE NOW() END
                    WHERE id = $2 AND status = 'pending'
                    RETURNING id
                `, [creditsToAdd, paymentId, durableReceived,
                    receiptEvidence?.primaryTxHash || null]);

                if (paymentUpdateResult.rows.length === 0) {
                    // Already processed by another instance - not an error
                    return { alreadyProcessed: true };
                }

                // Preserve the value needed to reverse a payment-specific premium upgrade.
                // Lock order matches refund processing: payment first, then user.
                const priorUser = await client.query(`
                    SELECT id, premium_level
                    FROM users
                    WHERE id = $1
                    FOR UPDATE
                `, [userId]);
                if (!priorUser.rows[0]) {
                    throw new Error(`Payment ${paymentId} user no longer exists`);
                }
                const previousPremiumLevel = priorUser.rows[0].premium_level || 'free';
                const premiumChanged = !!productGrants.premiumLevel
                    && previousPremiumLevel !== productGrants.premiumLevel;

                // Step 2: Add credits / premium tier to user (using payment's user_id, not socket lookup)
                const updateResult = await client.query(`
                    UPDATE users
                    SET credits = credits + $1,
                        total_credits_purchased = COALESCE(total_credits_purchased, 0) + $1,
                        premium_level = CASE
                            WHEN $3::text IS NULL THEN premium_level
                            ELSE $3::text
                        END,
                        updated_at = NOW()
                    WHERE id = $2
                    RETURNING id, credits, total_credits_purchased, premium_level
                `, [creditsToAdd, userId, productGrants.premiumLevel]);

                const newBalance = updateResult.rows[0]?.credits ?? creditsToAdd;
                const totalCreditsPurchased = updateResult.rows[0]?.total_credits_purchased ?? creditsToAdd;
                const premiumLevel = updateResult.rows[0]?.premium_level || 'free';

                // Step 3: Record credit transaction for audit trail when credits were granted.
                if (creditsToAdd > 0) {
                    await client.query(`
                        INSERT INTO credit_transactions (
                            user_id, amount, reason, balance_after, transaction_type, payment_id
                        ) VALUES ($1, $2, 'package_purchase', $3, 'purchase', $4)
                    `, [userId, creditsToAdd, newBalance, paymentId]);
                }

                // Step 4: Grant race entry tickets if the product includes them.
                if (raceEntriesToAdd > 0) {
                    const raceEntryUpdate = await client.query(`
                        UPDATE users
                        SET race_entries = race_entries + $1
                        WHERE id = $2
                        RETURNING race_entries
                    `, [raceEntriesToAdd, userId]);
                    if (backingRequired !== null && paidAtomic !== null && paidAtomic >= backingRequired) {
                        const lotInsert = await client.query(`
                            INSERT INTO race_entry_lots (
                                user_id, payment_id, unit_value_atomic, original_entries,
                                remaining_entries, product_id
                            ) VALUES ($1, $2, $3, $4, $4, $5)
                            ON CONFLICT (payment_id) DO NOTHING
                            RETURNING id
                        `, [userId, paymentId, raceEntryValueAtomic.toString(), raceEntriesToAdd, productId]);
                        if (lotInsert.rowCount !== 1) {
                            throw new Error(`Race-entry backing lot already exists for payment ${paymentId}`);
                        }
                    }
                    await client.query(`
                        INSERT INTO race_entry_transactions (user_id, delta, balance_after, reason, payment_id, metadata)
                        VALUES ($1, $2, $3, 'purchase', $4, $5::jsonb)
                    `, [
                        userId,
                        raceEntriesToAdd,
                        raceEntryUpdate.rows[0].race_entries,
                        paymentId,
                        JSON.stringify({
                            productId,
                            raceEntryValueAtomic: raceEntryValueAtomic?.toString() || null,
                            backingRequiredAtomic: backingRequired?.toString() || null
                        })
                    ]);
                }

                // Step 5: Grant cosmetic/render packs. Only newly inserted rows belong to
                // this payment; a refund must never delete ownership from an earlier source.
                const newlyGrantedPacks = [];
                for (const pack of productGrants.packs) {
                    const packInsert = await client.query(`
                        INSERT INTO user_pack_entitlements (user_id, pack_id, source, expires_at, metadata)
                        VALUES ($1, $2, $3, $4, $5::jsonb)
                        ON CONFLICT (user_id, pack_id) DO NOTHING
                        RETURNING pack_id
                    `, [
                        userId,
                        pack.id,
                        pack.source || 'product_purchase',
                        pack.expiresAt || null,
                        JSON.stringify({ productId, paymentId })
                    ]);
                    if (packInsert.rows?.[0]?.pack_id) {
                        newlyGrantedPacks.push({
                            id: packInsert.rows[0].pack_id,
                            source: pack.source || 'product_purchase',
                            expiresAt: pack.expiresAt || null
                        });
                    }
                }

                // Unique payment-scoped grant claim. All balance/entitlement mutations above
                // roll back if this marker already exists, so confirmation is exactly once.
                const entitlementGrant = await client.query(`
                    INSERT INTO payment_entitlement_grants (
                        payment_id, user_id, source, credits_granted,
                        purchase_progress_granted, race_entries_granted, packs_granted,
                        premium_level_granted, premium_level_previous, metadata
                    ) VALUES (
                        $1, $2, 'product_confirmation', $3, $3, $4, $5::jsonb,
                        $6, $7, $8::jsonb
                    )
                    ON CONFLICT (payment_id) DO NOTHING
                    RETURNING payment_id
                `, [
                    paymentId,
                    userId,
                    creditsToAdd,
                    raceEntriesToAdd,
                    JSON.stringify(newlyGrantedPacks),
                    premiumChanged ? productGrants.premiumLevel : null,
                    premiumChanged ? previousPremiumLevel : null,
                    JSON.stringify({ productId, requestedPacks: productGrants.packs.map(pack => pack.id) })
                ]);
                if (entitlementGrant.rowCount === 0) {
                    throw new Error(`Payment ${paymentId} entitlement grant already exists`);
                }

                const grantRows = await client.query(`
                    SELECT pack_id
                    FROM user_pack_entitlements
                    WHERE user_id = $1
                      AND (expires_at IS NULL OR expires_at > NOW())
                `, [userId]);

                return { newBalance, totalCreditsPurchased, premiumLevel, packGrants: grantRows.rows || [] };
            });

            if (result.alreadyProcessed) {
                console.log(`Payment ${paymentId} already confirmed (atomic check), skipping duplicate`);
                return { success: false, alreadyProcessed: true, reason: 'Payment already processed' };
            }

            const entitlements = Entitlements.snapshotForUser({
                id: userId,
                credits: result.newBalance,
                total_credits_purchased: result.totalCreditsPurchased,
                premium_level: result.premiumLevel
            }, result.packGrants);

            console.log(`Product payment confirmed: ${productId} (+${creditsToAdd} credits) for user ${userId}, new balance: ${result.newBalance}`);

            return {
                success: true,
                creditsAdded: creditsToAdd,
                newBalance: result.newBalance,
                totalCreditsPurchased: result.totalCreditsPurchased,
                grantsApplied: grantJson,
                entitlements
            };
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to process product payment confirmation');
            console.error('Error processing product payment:', normalized.message);
            return {
                success: false,
                reason: normalized.safeMessage
            };
        }
    }

    async processCreditsPackageConfirmation(socketId, paymentId, packageInfo = null, receivedAmount = null, receipts = []) {
        return this.processProductPaymentConfirmation(socketId, paymentId, packageInfo, receivedAmount, receipts);
    }

    /**
     * Record a direct/single_game entry as "buy 1 credit and immediately spend it on this game":
     * the balance nets to zero but total_credits_purchased advances, so a direct payment unlocks the
     * SAME tier/threshold cosmetics as buying credits (the first step of unifying everything to
     * credits). Idempotent by the caller — the single_game confirmation runs once per payment via
     * its status='pending' -> 'confirmed' guard. Returns { totalCreditsPurchased, balance,
     * entitlements } or null.
     */
    async recordDirectEntryPurchase(socketId) {
        try {
            const user = await this.getOrCreateUser(socketId, { create: false });
            if (!user || user.id == null) return null;
            let totalCreditsPurchased = 0;
            let balance = 0;
            let premiumLevel = null;
            await this.db.withTransaction(async (client) => {
                const upd = await client.query(
                    `UPDATE users
                     SET total_credits_purchased = COALESCE(total_credits_purchased, 0) + 1
                     WHERE id = $1
                     RETURNING total_credits_purchased, credits, premium_level`,
                    [user.id]
                );
                if (!upd.rows.length) return;
                totalCreditsPurchased = Number(upd.rows[0].total_credits_purchased || 0);
                balance = Number(upd.rows[0].credits || 0);
                premiumLevel = upd.rows[0].premium_level || null;
                // Audit trail: bought 1 credit + spent it on this game (net 0 balance).
                await client.query(
                    `INSERT INTO credit_transactions (user_id, amount, reason, balance_after, transaction_type)
                     VALUES ($1, 1, 'direct_entry', $2, 'purchase'),
                            ($1, -1, 'game_entry', $2, 'spend')`,
                    [user.id, balance]
                );
            });

            let packGrants = [];
            try {
                const g = await this.db.query(
                    `SELECT pack_id, source, granted_at, expires_at FROM user_pack_entitlements
                     WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
                    [user.id]
                );
                packGrants = g.rows || [];
            } catch (_) { packGrants = []; }

            const entitlements = Entitlements.snapshotForUser({
                id: user.id,
                credits: balance,
                total_credits_purchased: totalCreditsPurchased,
                premium_level: premiumLevel
            }, packGrants);

            return { totalCreditsPurchased, balance, entitlements };
        } catch (err) {
            const normalized = normalizeError(err, 'Failed to record direct entry purchase');
            console.error('❌ recordDirectEntryPurchase error:', normalized.message);
            return null;
        }
    }

    async _findReusablePayment(userId, paymentType, productId = null) {
        if (!userId) return null;
        const result = await this.db.query(`
            SELECT id, subaddress, expected_amount, payment_type, status, created_at, expires_at,
                   description, product_id, product_grants,
                   fairness_proof_version, fairness_offer_id, fairness_offer_issued_at,
                   fairness_commitment, fairness_server_seed, fairness_client_seed,
                   fairness_bound_at, fairness_consumed_at
            FROM payments
            WHERE user_id = $1
              AND payment_type = $2
              AND ($3::text IS NULL OR product_id = $3)
              AND status = 'pending'
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY created_at DESC
            LIMIT 1
        `, [userId, paymentType, productId || null]);
        const row = result.rows[0] || null;
        if (row && paymentType === 'single_game' && this._requiresPaidFairnessV2()
            && (!this._paymentFairnessProofFromRow(row) || row.fairness_consumed_at != null)) {
            return null;
        }
        return row;
    }

    /**
     * Convert package info to JSON-safe format (BigInt price -> Number)
     */
    _serializePackageInfo(packageInfo) {
        if (!packageInfo) return null;
        return {
            ...packageInfo,
            price: packageInfo.price == null ? packageInfo.price : money.toSafe(money.toBig(packageInfo.price)),
            grants: ProductGrants.publicGrantSummary(ProductGrants.normalizeProductGrants(packageInfo, {
                credits: Number(packageInfo.credits || 0) + Number(packageInfo.bonus || 0)
            }))
        };
    }

    _mapPaymentRowToRequest(row, paymentType, packageInfo) {
        if (!row) return null;
        const amount = money.toSafe(money.toBig(row.expected_amount));
        return {
            id: row.id,
            address: row.subaddress,
            amount,
            amountFormatted: this.formatAtomicHuman(amount, 4),
            currency: this.cryptoType,
            expiresAt: row.expires_at,
            paymentType,
            description: row.description,
            productId: row.product_id || null,
            grants: row.product_grants || null,
            package: this._serializePackageInfo(packageInfo),
            fairnessProof: paymentType === 'single_game'
                ? this._paymentFairnessProofFromRow(row)
                : null,
            reused: true
        };
    }

    logConfiguration(context = 'initialized') {
        console.log(`🎮 Game Mode Manager ${context}: ${this.gameMode} mode`);
        console.log(`💰 Currency: ${this.cryptoType} (decimals: ${this.currencyDecimals})`);
        console.log(`💵 Single game price: ${this.singleGamePrice} atomic units (~${this.formatAtomic(this.singleGamePrice)} ${this.cryptoType})`);
        console.log(`💵 Credits payout base: ${this.creditsPayoutBaseValue} atomic units (~${this.formatAtomic(this.creditsPayoutBaseValue)} ${this.cryptoType})`);
        console.log(`🎫 Credits package price: ${this.creditsPackagePrice} atomic units (~${this.formatAtomic(this.creditsPackagePrice)} ${this.cryptoType})`);
        console.log(`🎯 Credits per game cost: ${this.creditsPerGameCost}`);
        console.log(`🧮 Payout multipliers - direct: ${JSON.stringify(this.directPayoutMultipliers)}, credits: ${JSON.stringify(this.creditPayoutMultipliers)}`);
        console.log(`🔁 Mode availability - direct: ${this.directModeEnabled}, credits: ${this.creditsModeEnabled}, preferCreditsFirst: ${this.preferCreditsFirst}`);
        console.log(`🛡️ Payout master switch: ${this.payoutsEnabled ? 'ENABLED' : 'DISABLED'}`);
        if (this.isPayoutEnabledForMode('PAID_CREDITS')) {
            console.log(`🎁 Credits payout mode ENABLED - base value: ${this.creditsPayoutBaseValue} atomic (~${this.formatAtomic(this.creditsPayoutBaseValue)} ${this.cryptoType})`);
        }
        console.log(`⚙️ Payments enabled: ${this.paymentsEnabled}`);
    }

    /**
     * Get effective game mode for a specific user, considering:
     * - Whether both modes are enabled (mixed mode)
     * - User's credit balance
     * - preferCreditsFirst setting
     * @param {object} user - User object with credits field
     * @returns {object} { mode, canUseCredits, canUseDirect, hasCredits, creditsBalance }
     */
    getEffectiveModeForUser(user) {
        const hasCredits = (user?.credits || 0) >= this.creditsPerGameCost;
        const bothModesEnabled = this.directModeEnabled && this.creditsModeEnabled;
        
        // Determine available options
        const canUseCredits = this.creditsModeEnabled && hasCredits;
        const canUseDirect = this.directModeEnabled;
        
        // Determine effective mode
        let effectiveMode;
        if (!this.paymentsEnabled) {
            effectiveMode = 'FREE';
        } else if (bothModesEnabled) {
            // Mixed mode: prefer based on config and availability
            if (this.preferCreditsFirst && hasCredits) {
                effectiveMode = 'PAID_CREDITS';
            } else if (hasCredits) {
                effectiveMode = 'PAID_CREDITS'; // Has credits, can use them
            } else {
                effectiveMode = 'PAID_SINGLE'; // No credits, must pay
            }
        } else if (this.creditsModeEnabled) {
            effectiveMode = 'PAID_CREDITS';
        } else if (this.directModeEnabled) {
            effectiveMode = 'PAID_SINGLE';
        } else {
            effectiveMode = 'FREE';
        }
        
        return {
            mode: effectiveMode,
            canUseCredits,
            canUseDirect,
            hasCredits,
            creditsBalance: user?.credits || 0,
            creditsRequired: this.creditsPerGameCost,
            bothModesEnabled,
            preferCreditsFirst: this.preferCreditsFirst,
            creditsPayoutsEnabled: this.isPayoutEnabledForMode('PAID_CREDITS'),
            directPayoutsEnabled: this.isPayoutEnabledForMode('PAID_SINGLE')
        };
    }

    getPublicPreferredPaymentMode(user) {
        if (!this.paymentsEnabled) {
            return 'free';
        }

        const preferred = String(user?.preferred_payment_mode || '').trim().toLowerCase();
        if (preferred === 'direct' && this.directModeEnabled) {
            return 'direct';
        }
        if (preferred === 'credits' && this.creditsModeEnabled) {
            return 'credits';
        }
        if (this.creditsModeEnabled) {
            return 'credits';
        }
        if (this.directModeEnabled) {
            return 'direct';
        }
        return 'free';
    }

    /**
     * Get available payment options for a user
     * @param {string} socketId - Socket ID
     * @returns {object} Available options for the user
     */
    async getPaymentOptionsForUser(socketId) {
        try {
            const user = await this.getOrCreateUser(socketId);
            const effective = this.getEffectiveModeForUser(user);

            const options = [];

            // Free play (Pleb board, no payout) — offered alongside paid options when enabled.
            if (this.freePlayEnabled && this.paymentsEnabled) {
                options.push({
                    type: 'play_free',
                    label: 'Play Free (Pleb leaderboard)',
                    mode: 'FREE',
                    cost: 0,
                    costDisplay: 'Free',
                    payoutEligible: false,
                    recommended: false
                });
            }

            if (effective.canUseCredits) {
                options.push({
                    type: 'use_credit',
                    label: `Use 1 Credit (${effective.creditsBalance} available)`,
                    mode: 'PAID_CREDITS',
                    cost: 0,
                    costDisplay: '1 credit',
                    payoutEligible: effective.creditsPayoutsEnabled,
                    recommended: effective.preferCreditsFirst
                });
            }
            
            if (effective.canUseDirect) {
                options.push({
                    type: 'pay_direct',
                    label: `Pay ${this.formatAtomicHuman(this.singleGamePrice, 2)} ${this.cryptoType}`,
                    mode: 'PAID_SINGLE',
                    cost: this.singleGamePrice,
                    costDisplay: `${this.formatAtomicHuman(this.singleGamePrice, 2)} ${this.cryptoType}`,
                    payoutEligible: effective.directPayoutsEnabled,
                    recommended: !effective.preferCreditsFirst || !effective.hasCredits
                });
            }
            
            if (this.creditsModeEnabled) {
                const pkg = this.getPrimaryCreditPackage();
                options.push({
                    type: 'buy_credits',
                    label: `Buy ${pkg.credits} Credits`,
                    mode: 'PURCHASE',
                    cost: money.toSafe(money.toBig(pkg.price)),
                    costDisplay: `${this.formatAtomicHuman(pkg.price, 2)} ${this.cryptoType}`,
                    credits: pkg.credits + (pkg.bonus || 0),
                    payoutEligible: false,
                    recommended: false
                });
            }
            
            return {
                user: {
                    credits: effective.creditsBalance,
                    hasPayoutAddress: !!user.payout_address
                },
                effective,
                options
            };
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to get payment options');
            console.error('❌ Error getting payment options:', normalized.message);
            return {
                user: { credits: 0, hasPayoutAddress: false },
                effective: { mode: 'FREE' },
                options: []
            };
        }
    }

    /**
     * Check if user can start a game
     */
    async canUserStartGame(socketId) {
        try {
            const user = await this.getOrCreateUser(socketId);
            const effective = this.getEffectiveModeForUser(user);
            
            // FREE mode or payments disabled
            if (effective.mode === 'FREE') {
                return { allowed: true, reason: 'Free mode' };
            }
            
            // Mixed mode: mirror _dispatchGameStart's exact precedence so eligibility/address
            // checks approve the same mode that will actually be consumed.
            if (effective.bothModesEnabled) {
                // Credits win immediately only when the operator prefers them.
                if (effective.hasCredits && this.preferCreditsFirst) {
                    return {
                        allowed: true,
                        reason: `${effective.creditsBalance} credits available`,
                        useCredits: true,
                        creditsRequired: this.creditsPerGameCost,
                        balance: effective.creditsBalance,
                        effectiveMode: 'PAID_CREDITS'
                    };
                }
                
                // Option 2: User has confirmed single_game payment
                const pendingPayment = await this.db.query(`
                    SELECT * FROM payments 
                    WHERE user_id = $1 AND status = 'confirmed'
                    AND payment_type = 'single_game'
                    AND NOT EXISTS (
                        SELECT 1 FROM games 
                        WHERE games.payment_id = payments.id
                    )
                    AND NOT EXISTS (
                        SELECT 1 FROM payment_entitlement_grants peg
                        WHERE peg.payment_id = payments.id
                    )
                    AND NOT EXISTS (
                        SELECT 1 FROM credit_transactions ct
                        WHERE ct.user_id = payments.user_id
                          AND ct.reason = 'single_game_recovered:' || payments.id
                    )
                    AND ($2::boolean = FALSE OR (
                        fairness_bound_at IS NOT NULL
                        AND fairness_consumed_at IS NULL
                        AND fairness_proof_version = 2
                    ))
                    ORDER BY confirmed_at DESC 
                    LIMIT 1
                `, [user.id, this._requiresPaidFairnessV2()]);
                
                if (pendingPayment.rows.length > 0) {
                    return { 
                        allowed: true, 
                        reason: 'Payment confirmed',
                        paymentId: pendingPayment.rows[0].id,
                        fairnessProof: this._paymentFairnessProofFromRow(pendingPayment.rows[0]),
                        effectiveMode: 'PAID_SINGLE'
                    };
                }

                // With no direct entry to claim, credits remain the fallback even when direct
                // is preferred.
                if (effective.hasCredits) {
                    return {
                        allowed: true,
                        reason: `${effective.creditsBalance} credits available`,
                        useCredits: true,
                        creditsRequired: this.creditsPerGameCost,
                        balance: effective.creditsBalance,
                        effectiveMode: 'PAID_CREDITS'
                    };
                }
                
                // Neither credits nor payment available
                return { 
                    allowed: false, 
                    reason: 'Payment or credits required',
                    action: 'choose_payment',
                    options: await this.getPaymentOptionsForUser(socketId)
                };
            }
            
            // Single mode logic (backwards compatible)
            switch (effective.mode) {
                case 'PAID_CREDITS':
                    if (effective.hasCredits) {
                        return {
                            allowed: true,
                            reason: `${effective.creditsBalance} credits remaining`,
                            creditsRequired: this.creditsPerGameCost,
                            effectiveMode: 'PAID_CREDITS'
                        };
                    }
                    return { 
                        allowed: false, 
                        reason: 'Insufficient credits',
                        action: 'purchase_credits',
                        creditsRequired: this.creditsPerGameCost,
                        balance: effective.creditsBalance
                    };
                    
                case 'PAID_SINGLE':
                    const payment = await this.db.query(`
                        SELECT * FROM payments 
                        WHERE user_id = $1 AND status = 'confirmed'
                        AND payment_type = 'single_game'
                        AND NOT EXISTS (
                            SELECT 1 FROM games 
                            WHERE games.payment_id = payments.id
                        )
                        AND NOT EXISTS (
                            SELECT 1 FROM payment_entitlement_grants peg
                            WHERE peg.payment_id = payments.id
                        )
                        AND NOT EXISTS (
                            SELECT 1 FROM credit_transactions ct
                            WHERE ct.user_id = payments.user_id
                              AND ct.reason = 'single_game_recovered:' || payments.id
                        )
                        AND ($2::boolean = FALSE OR (
                            fairness_bound_at IS NOT NULL
                            AND fairness_consumed_at IS NULL
                            AND fairness_proof_version = 2
                        ))
                        ORDER BY confirmed_at DESC 
                        LIMIT 1
                    `, [user.id, this._requiresPaidFairnessV2()]);
                    
                    if (payment.rows.length > 0) {
                        return { 
                            allowed: true, 
                            reason: 'Payment confirmed',
                            paymentId: payment.rows[0].id,
                            fairnessProof: this._paymentFairnessProofFromRow(payment.rows[0]),
                            effectiveMode: 'PAID_SINGLE'
                        };
                    }
                    
                    return { 
                        allowed: false, 
                        reason: 'Payment required',
                        action: 'make_payment'
                    };
                    
                default:
                    return { allowed: false, reason: 'Invalid game mode' };
            }
        } catch (error) {
            const normalized = normalizeError(error, 'Unable to verify game eligibility');
            console.error('❌ Error checking user game eligibility:', normalized.message);
            return { allowed: false, reason: normalized.safeMessage };
        }
    }

    /**
     * Process game start (deduct credits or link payment). Fairness input is deliberately not
     * accepted here: the one-time offer/client seed must already have been consumed by
     * SocketHandlers and passed into Game before its dungeon is generated.
     */
    async processGameStart(socketId, gameId, options = {}) {
        if (this._gameAdmissionClosed) {
            return {
                success: false,
                code: 'SERVER_SHUTTING_DOWN',
                reason: 'Game admission is temporarily closed while the server restarts.'
            };
        }
        const admission = this._dispatchGameStart(socketId, gameId, options);
        this._gameStartAdmissions.add(admission);
        try {
            return await admission;
        } finally {
            this._gameStartAdmissions.delete(admission);
        }
    }

    /** Close new solo entry consumption synchronously at the restart boundary. */
    beginGameAdmissionShutdown() {
        this._gameAdmissionClosed = true;
    }

    async drainGameStartAdmissions() {
        while (this._gameStartAdmissions.size > 0) {
            await Promise.allSettled(Array.from(this._gameStartAdmissions));
        }
        return { pending: 0 };
    }

    async _dispatchGameStart(socketId, gameId, options = {}) {
        try {
            const user = await this.getOrCreateUser(socketId);

            // The player explicitly chose FREE play (even on an instance that also sells
            // credits/entry). Record this game as FREE so it lands on the Pleb leaderboard,
            // with no payment and no payout.
            if (options.forceFree) {
                return await this._processGameStartFree(user, gameId);
            }

            const effective = this.getEffectiveModeForUser(user);

            // FREE mode (instance is free-only)
            if (effective.mode === 'FREE') {
                return { success: true, effectiveMode: 'FREE' };
            }
            if (!this._isFinancialAdmissionAllowed()) {
                return this._financialRecoveryPendingResult();
            }
            
            // Mixed mode: determine which method to use
            if (effective.bothModesEnabled) {
                // Prefer credits if available and preferCreditsFirst is true
                if (effective.hasCredits && this.preferCreditsFirst) {
                    return await this._processGameStartWithCredits(user, socketId, gameId);
                }
                
                // Check for confirmed direct payment
                const payment = await this.db.query(`
                    SELECT * FROM payments 
                    WHERE user_id = $1 AND status = 'confirmed'
                    AND payment_type = 'single_game'
                    AND NOT EXISTS (
                        SELECT 1 FROM games 
                        WHERE games.payment_id = payments.id
                    )
                    AND NOT EXISTS (
                        SELECT 1 FROM payment_entitlement_grants peg
                        WHERE peg.payment_id = payments.id
                    )
                    AND NOT EXISTS (
                        SELECT 1 FROM credit_transactions ct
                        WHERE ct.user_id = payments.user_id
                          AND ct.reason = 'single_game_recovered:' || payments.id
                    )
                    AND ($2::boolean = FALSE OR (
                        fairness_bound_at IS NOT NULL
                        AND fairness_consumed_at IS NULL
                        AND fairness_proof_version = 2
                    ))
                    ORDER BY confirmed_at DESC 
                    LIMIT 1
                `, [user.id, this._requiresPaidFairnessV2()]);
                
                if (payment.rows.length > 0) {
                    return await this._processGameStartWithPayment(user, payment.rows[0], gameId);
                }
                
                // Fall back to credits if available
                if (effective.hasCredits) {
                    return await this._processGameStartWithCredits(user, socketId, gameId);
                }
                
                return { success: false, reason: 'No valid payment or credits found' };
            }
            
            // Single mode logic
            switch (effective.mode) {
                case 'PAID_CREDITS':
                    return await this._processGameStartWithCredits(user, socketId, gameId);
                    
                case 'PAID_SINGLE':
                    const payment = await this.db.query(`
                        SELECT * FROM payments 
                        WHERE user_id = $1 AND status = 'confirmed'
                        AND payment_type = 'single_game'
                        AND NOT EXISTS (
                            SELECT 1 FROM games 
                            WHERE games.payment_id = payments.id
                        )
                        AND NOT EXISTS (
                            SELECT 1 FROM payment_entitlement_grants peg
                            WHERE peg.payment_id = payments.id
                        )
                        AND NOT EXISTS (
                            SELECT 1 FROM credit_transactions ct
                            WHERE ct.user_id = payments.user_id
                              AND ct.reason = 'single_game_recovered:' || payments.id
                        )
                        AND ($2::boolean = FALSE OR (
                            fairness_bound_at IS NOT NULL
                            AND fairness_consumed_at IS NULL
                            AND fairness_proof_version = 2
                        ))
                        ORDER BY confirmed_at DESC 
                        LIMIT 1
                    `, [user.id, this._requiresPaidFairnessV2()]);
                    
                    if (payment.rows.length === 0) {
                        return { success: false, reason: 'No valid payment found' };
                    }
                    
                    return await this._processGameStartWithPayment(user, payment.rows[0], gameId);
                    
                default:
                    return { success: false, reason: 'Invalid game mode' };
            }
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to process game start');
            console.error('❌ Error processing game start:', normalized.message);
            return { success: false, reason: normalized.safeMessage };
        }
    }

    /**
     * Compute the payout terms to snapshot on a game at start, so an admin changing
     * config mid-game can't alter an in-flight game's payout. Returns atomic amounts as
     * strings (for the BIGINT columns) plus the multipliers for the audit trail.
     */
    _computePayoutSnapshot(mode) {
        const escape = this._effectivePayoutOutcome(mode, false);
        const treasure = this._effectivePayoutOutcome(mode, true);
        const bounds = this._payoutBoundsForMode(mode);
        const eligible = this.isPayoutEnabledForMode(mode);
        const snapshot = {
            // These are exact payable amounts after applying the configured bounds. Settlement,
            // admission accounting, and the browser all consume the same contract.
            escapeAmount: escape.amountAtomic,
            treasureAmount: treasure.amountAtomic,
            escapeMult: escape.multiplier,
            treasureMult: treasure.multiplier,
            eligible
        };
        snapshot.terms = {
            version: 2,
            mode: String(mode || '').toUpperCase(),
            eligible,
            currency: this.cryptoType,
            currencyDecimals: this.currencyDecimals,
            escapeAmount: snapshot.escapeAmount,
            treasureAmount: snapshot.treasureAmount,
            escapeMultiplier: snapshot.escapeMult,
            treasureMultiplier: snapshot.treasureMult,
            minAmount: bounds?.min == null ? null : String(bounds.min),
            maxAmount: bounds?.max == null ? null : String(bounds.max),
            outcomes: {
                escape,
                escapeWithTreasure: treasure
            }
        };
        return snapshot;
    }

    /**
     * One exact, user-visible payout outcome. Raw multiplier math is retained for audit, while
     * amountAtomic is what can actually be committed and paid after min/max policy.
     */
    _effectivePayoutOutcome(mode, treasureFound) {
        const normalizedMode = String(mode || '').toUpperCase();
        const calculated = this.calculatePayout(normalizedMode, { treasureFound });
        const rawAmount = money.toBig(calculated.amount);
        const bounds = this._payoutBoundsForMode(normalizedMode);
        const eligible = this.isPayoutEnabledForMode(normalizedMode);
        let effective = eligible ? rawAmount : 0n;
        let capApplied = false;
        let suppressedReason = eligible ? null : 'payouts_disabled';

        if (eligible && bounds?.max !== null && bounds?.max !== undefined && effective > bounds.max) {
            effective = bounds.max;
            capApplied = true;
        }
        if (eligible && (effective <= 0n
            || (bounds?.min !== null && bounds?.min !== undefined && effective < bounds.min))) {
            effective = 0n;
            suppressedReason = 'below_minimum';
        }

        const decimals = Number.isInteger(this.currencyDecimals) && this.currencyDecimals >= 0
            ? this.currencyDecimals
            : inferCurrencyDecimalsForSymbol(this.cryptoType);
        return {
            payable: eligible && effective > 0n,
            amountAtomic: effective.toString(),
            amountFormatted: money.format(effective, decimals),
            rawAmountAtomic: rawAmount.toString(),
            multiplier: calculated.multiplier,
            capApplied,
            suppressedReason
        };
    }

    _publicPayoutOutcomes(mode) {
        return {
            escape: this._effectivePayoutOutcome(mode, false),
            escapeWithTreasure: this._effectivePayoutOutcome(mode, true)
        };
    }

    _snapshotMaxLiability(snapshot) {
        if (!snapshot?.eligible) return 0n;
        const escape = money.toBig(snapshot.escapeAmount || 0);
        const treasure = money.toBig(snapshot.treasureAmount || 0);
        return escape > treasure ? escape : treasure;
    }

    /**
     * Start a game the player explicitly chose to play for FREE. Records game_mode='FREE'
     * on the game (overriding the instance default, so it goes to the Pleb leaderboard) and
     * counts the game. No payment, no payout.
     */
    async _processGameStartFree(user, gameId) {
        await this.db.withTransaction(async (client) => {
            const gameUpdate = await client.query(`
                UPDATE games SET game_mode = 'FREE', payout_eligible = FALSE,
                    payout_terms = $2::jsonb, payout_committed_at = NOW(),
                    entry_consumed_at = NOW(), entry_credits_spent = NULL
                WHERE dungeon_seed = $1
                RETURNING id
            `, [gameId, JSON.stringify({ version: 1, mode: 'FREE', eligible: false })]);
            if (gameUpdate.rowCount === 0) {
                throw Object.assign(new Error('Durable game row not found'), { code: 'GAME_ROW_REQUIRED' });
            }
            await client.query(`
                UPDATE users SET total_games_played = total_games_played + 1, updated_at = NOW() WHERE id = $1
            `, [user.id]);
        });
        return { success: true, effectiveMode: 'FREE' };
    }

    async _processGameStartWithCredits(user, socketId, gameId) {
        if (!this._isFinancialAdmissionAllowed()) {
            return this._financialRecoveryPendingResult();
        }
        const creditsToSpend = this.creditsPerGameCost;
        const snap = this._computePayoutSnapshot('PAID_CREDITS');
        const requiresAddress = this.requiresPayoutAddressForMode('PAID_CREDITS');
        if (requiresAddress && (typeof user.payout_address !== 'string' || !user.payout_address.trim())) {
            return { success: false, reason: 'A payout address is required before starting this game.' };
        }

        const result = await this.db.withTransaction(async (client) => {
            if (snap.eligible) {
                await reservePayoutCapacity({
                    client,
                    walletService: this.walletService,
                    newLiability: this._snapshotMaxLiability(snap),
                    gameModeManager: this
                });
            }
            // Conditional update prevents credits going negative
            const updateRes = await client.query(`
                UPDATE users
                SET credits = credits - $1,
                    total_games_played = total_games_played + 1,
                    updated_at = NOW()
                WHERE id = $2 AND credits >= $1
                  AND ($3::boolean = FALSE OR NULLIF(BTRIM(payout_address), '') IS NOT NULL)
                RETURNING credits, total_credits_purchased, payout_address
            `, [creditsToSpend, user.id, requiresAddress]);

            if (updateRes.rows.length === 0) {
                return { admissionDenied: true };
            }

            const remainingCredits = updateRes.rows[0].credits;
            const totalCreditsPurchased = updateRes.rows[0].total_credits_purchased || user.total_credits_purchased || 0;

            const gameUpdate = await client.query(`
                UPDATE games SET game_mode = 'PAID_CREDITS', payout_address = $2,
                    payout_escape_amount = $3, payout_treasure_amount = $4,
                    payout_escape_mult = $5, payout_treasure_mult = $6,
                    payout_eligible = $7, payout_terms = $8::jsonb,
                    payout_committed_at = NOW(), entry_consumed_at = NOW(),
                    entry_credits_spent = $9
                WHERE dungeon_seed = $1
                RETURNING id
            `, [gameId, updateRes.rows[0].payout_address || null, snap.escapeAmount, snap.treasureAmount, snap.escapeMult, snap.treasureMult, snap.eligible, JSON.stringify(snap.terms), creditsToSpend]);
            if (gameUpdate.rowCount === 0) {
                throw Object.assign(new Error('Durable game row not found'), { code: 'GAME_ROW_REQUIRED' });
            }

            await client.query(`
                INSERT INTO credit_transactions (user_id, amount, reason, balance_after, transaction_type)
                VALUES ($1, $2, 'game_entry', $3, 'spend')
            `, [user.id, -creditsToSpend, remainingCredits]);

            return { remainingCredits, totalCreditsPurchased };
        });

        if (result.admissionDenied) {
            return {
                success: false,
                reason: requiresAddress
                    ? 'Insufficient credits or payout address is missing'
                    : 'Insufficient credits',
                creditsRequired: creditsToSpend,
                creditsAvailable: user.credits
            };
        }

        console.log(`Deducted ${creditsToSpend} credit(s) from user ${user.id}, ${result.remainingCredits} remaining`);

        return {
            success: true,
            creditsRemaining: result.remainingCredits,
            totalCreditsPurchased: result.totalCreditsPurchased,
            creditsSpent: creditsToSpend,
            effectiveMode: 'PAID_CREDITS'
        };
    }

    async _processGameStartWithPayment(user, payment, gameId) {
        if (!this._isFinancialAdmissionAllowed()) {
            return this._financialRecoveryPendingResult();
        }
        const snap = this._computePayoutSnapshot('PAID_SINGLE');
        // M3: claiming a confirmed single_game payment must be atomic. Re-verify the payment
        // is still unclaimed and lock it FOR UPDATE inside the transaction, so two concurrent
        // starts can't both consume the same payment. The unique index on games.payment_id
        // (migration 023) is the final backstop; a 23505 there is treated as "already consumed".
        try {
            const result = await this.db.withTransaction(async (client) => {
                if (snap.eligible) {
                    await reservePayoutCapacity({
                        client,
                        walletService: this.walletService,
                        newLiability: this._snapshotMaxLiability(snap),
                        gameModeManager: this
                    });
                }
                const claim = await client.query(`
                    SELECT * FROM payments
                    WHERE id = $1 AND user_id = $2
                      AND status = 'confirmed' AND payment_type = 'single_game'
                      AND NOT EXISTS (SELECT 1 FROM games WHERE games.payment_id = payments.id)
                      AND NOT EXISTS (
                          SELECT 1 FROM payment_entitlement_grants peg
                          WHERE peg.payment_id = payments.id
                      )
                      AND NOT EXISTS (
                          SELECT 1 FROM credit_transactions ct
                          WHERE ct.user_id = payments.user_id
                            AND ct.reason = 'single_game_recovered:' || payments.id
                      )
                      AND ($3::boolean = FALSE OR (
                          fairness_bound_at IS NOT NULL
                          AND fairness_consumed_at IS NULL
                          AND fairness_proof_version = 2
                      ))
                    FOR UPDATE
                `, [payment.id, user.id, this._requiresPaidFairnessV2()]);

                if (claim.rows.length === 0) {
                    // Locked+re-checked: a concurrent start already linked this payment (or it is
                    // no longer claimable). Abort WITHOUT linking or creating a duplicate game.
                    return { alreadyConsumed: true };
                }

                const claimedPayment = claim.rows[0];
                const payoutUser = await client.query(`
                    SELECT id, payout_address
                    FROM users
                    WHERE id = $1
                    FOR UPDATE
                `, [user.id]);
                const lockedPayoutAddress = typeof payoutUser.rows[0]?.payout_address === 'string'
                    ? payoutUser.rows[0].payout_address.trim()
                    : '';
                if (this.requiresPayoutAddressForMode('PAID_SINGLE') && !lockedPayoutAddress) {
                    return { addressRequired: true };
                }
                const boundProof = this._paymentFairnessProofFromRow(claimedPayment);
                if (this._requiresPaidFairnessV2() && !boundProof) {
                    return { alreadyConsumed: true };
                }

                if (boundProof) {
                    const gameProof = await client.query(`
                        SELECT proof_version, fairness_offer_id, fairness_offer_issued_at,
                               proof_commitment, server_seed, client_seed
                        FROM games
                        WHERE dungeon_seed = $1
                        FOR UPDATE
                    `, [gameId]);
                    const persisted = gameProof.rows[0];
                    const issuedAt = persisted?.fairness_offer_issued_at instanceof Date
                        ? persisted.fairness_offer_issued_at.getTime()
                        : Date.parse(persisted?.fairness_offer_issued_at);
                    if (!persisted
                        || Number(persisted.proof_version) !== 2
                        || persisted.fairness_offer_id !== boundProof.offerId
                        || String(persisted.proof_commitment || '').toLowerCase() !== boundProof.commitment
                        || String(persisted.server_seed || '').toLowerCase() !== boundProof.serverSeed
                        || String(persisted.client_seed || '').toLowerCase() !== boundProof.clientSeed
                        || issuedAt !== boundProof.offerIssuedAt) {
                        throw Object.assign(new Error('Game fairness proof does not match the paid invoice binding'), {
                            code: 'PAYMENT_FAIRNESS_MISMATCH'
                        });
                    }
                }

                const gameUpdate = await client.query(`
                    UPDATE games
                    SET payment_id = $1, game_mode = 'PAID_SINGLE', payout_address = $3,
                        payout_escape_amount = $4, payout_treasure_amount = $5,
                        payout_escape_mult = $6, payout_treasure_mult = $7,
                        payout_eligible = $8, payout_terms = $9::jsonb,
                        payout_committed_at = NOW(), entry_consumed_at = NOW()
                    WHERE dungeon_seed = $2
                    RETURNING id
                `, [payment.id, gameId, lockedPayoutAddress || null, snap.escapeAmount, snap.treasureAmount, snap.escapeMult, snap.treasureMult, snap.eligible, JSON.stringify(snap.terms)]);
                if (gameUpdate.rowCount === 0) {
                    throw Object.assign(new Error('Durable game row not found'), { code: 'GAME_ROW_REQUIRED' });
                }

                if (boundProof) {
                    const consumed = await client.query(`
                        UPDATE payments
                        SET fairness_consumed_at = NOW()
                        WHERE id = $1 AND fairness_consumed_at IS NULL
                        RETURNING id
                    `, [payment.id]);
                    if (consumed.rowCount !== 1) {
                        throw Object.assign(new Error('Payment fairness offer was already consumed'), {
                            code: 'PAYMENT_FAIRNESS_CONSUMED'
                        });
                    }
                }

                await client.query(`
                    UPDATE users
                    SET total_games_played = total_games_played + 1,
                        updated_at = NOW()
                    WHERE id = $1
                `, [user.id]);

                return { linked: true };
            });

            if (result.alreadyConsumed) {
                console.warn(`⚠️ Payment ${payment.id} already consumed by a concurrent start; aborting duplicate for game ${gameId}.`);
                return { success: false, reason: 'Payment already consumed', alreadyConsumed: true };
            }
            if (result.addressRequired) {
                return { success: false, reason: 'A payout address is required before starting this game.' };
            }

            console.log(`Linked game ${gameId} to payment ${payment.id}`);
            return {
                success: true,
                paymentId: payment.id,
                effectiveMode: 'PAID_SINGLE'
            };
        } catch (error) {
            // 23505 = unique_violation on games.payment_id: a concurrent start linked this
            // payment first. Treat as already-consumed, never an uncaught throw / duplicate.
            if (error && error.code === '23505') {
                console.warn(`⚠️ payment_id unique violation linking game ${gameId} to payment ${payment.id}; treating as already consumed.`);
                return { success: false, reason: 'Payment already consumed', alreadyConsumed: true };
            }
            throw error;
        }
    }

    // processGameCompletion() removed — dead code, never called.
    // Only completeGame() (below) is used for game completion/payouts.

    /**
     * Create payment request
     */
    async createPaymentRequest(socketId, paymentType, options = {}) {
        try {
            this._assertPaymentIntakeEnabled(paymentType);
            // Prefer session-resolved userId (stable across reconnects) over socket_id lookup
            let user;
            if (options.userId) {
                const result = await this.db.query('SELECT * FROM users WHERE id = $1', [options.userId]);
                user = result.rows[0] || await this.getOrCreateUser(socketId);
            } else {
                user = await this.getOrCreateUser(socketId);
            }
            const reuseExisting = options.reuseExisting !== false;
            const requestedPackageId = options.packageId;

            let amount;
            let description;
            let packageInfo = null;
            let productId = null;
            let productGrants = ProductGrants.normalizeProductGrants({}, { credits: 0 });
            let paymentFairnessProof = null;

            switch (paymentType) {
                case 'single_game': {
                    amount = this.singleGamePrice;
                    description = `${this.gameName} single game entry (${this.currencyLabel})`;
                    productId = 'single_game';
                    paymentFairnessProof = this._normalizePaymentFairnessProof(options.fairnessProof, {
                        required: this._requiresPaidFairnessV2()
                    });
                    break;
                }
                case 'credits_package': {
                    // Find the requested package, or fall back to primary
                    const packages = this.configSnapshot?.modes?.credits?.packages || [];
                    let selectedPackage = null;
                    
                    if (requestedPackageId && packages.length > 0) {
                        selectedPackage = packages.find(p => p.id === requestedPackageId);
                    }
                    
                    // Fall back to first package if not found
                    if (!selectedPackage) {
                        selectedPackage = this.getPrimaryCreditPackage();
                    }
                    
                    const packagePrice = selectedPackage?.price ?? this.creditsPackagePrice;
                    amount = money.toSafe(money.toBig(packagePrice));
                    packageInfo = selectedPackage;
                    productId = selectedPackage?.id || 'credits_package';
                    const creditCount = selectedPackage?.credits ?? 10;
                    const bonusCredits = selectedPackage?.bonus ?? 0;
                    productGrants = ProductGrants.normalizeProductGrants(selectedPackage, {
                        credits: Number(creditCount) + Number(bonusCredits || 0)
                    });
                    const bonusText = bonusCredits > 0 ? ` (+${bonusCredits} bonus)` : '';
                    description = `${this.gameName} ${creditCount}${bonusText} credits package (${this.currencyLabel})`;
                    break;
                }
                case 'cosmetic_pack': {
                    const product = this.getCosmeticProduct(options.productId || options.packageId);
                    if (!product) {
                        throw new ValidationError('Unknown cosmetic product requested', {
                            safeMessage: 'Unsupported product requested.'
                        });
                    }
                    const price = product.price ?? 0;
                    amount = money.toSafe(money.toBig(price));
                    packageInfo = product;
                    productId = product.id;
                    productGrants = ProductGrants.normalizeProductGrants(product, { credits: 0 });
                    description = `${this.gameName} ${product.label || product.id} (${this.currencyLabel})`;
                    break;
                }
                default:
                    throw new ValidationError(`Invalid payment type requested: ${paymentType}`, {
                        safeMessage: 'Unsupported payment type requested.'
                    });
            }

            if (reuseExisting) {
                const existingRow = await this._findReusablePayment(user.id, paymentType, productId);
                if (existingRow) {
                    const existing = this._mapPaymentRowToRequest(existingRow, paymentType, packageInfo);
                    if (existing && !existing.description) {
                        existing.description = description;
                    }
                    return existing;
                }
            }
            
            // Expire any stale pending payments for this user before creating a new one.
            // A user should only have one active pending payment at a time.
            const expiredResult = await this.db.query(`
                UPDATE payments SET status = 'expired'
                WHERE user_id = $1 AND status = 'pending'
                RETURNING subaddress
            `, [user.id]);
            const expiredAddresses = expiredResult.rows.map(r => r.subaddress);

            // Create the payment request through the routed provider. The native provider (default
            // for every chain when no gateway env is set) delegates to walletService.createPaymentRequest,
            // so this is byte-for-byte the legacy path for the shipped single-chain config — same
            // subaddress, same walletService monitoring maps. A BTCPay/xmrcheckout/wowcheckout gateway
            // takes over only when the operator routes this.cryptoType to it.
            const provider = this.paymentProviders && this.paymentProviders.getProvider(this.cryptoType);
            let paymentResult;
            if (provider) {
                const invoice = await provider.createInvoice({
                    chain: this.cryptoType,
                    amountAtomic: amount,
                    description,
                    userId: user.id,
                    orderId: socketId
                });
                paymentResult = {
                    address: invoice.address,
                    addressIndex: invoice.addressIndex ?? (invoice.raw && invoice.raw.addressIndex) ?? null,
                    expiresAt: invoice.expiresAt,
                    invoiceId: invoice.invoiceId || invoice.address
                };
            } else {
                // Defensive fallback: registry somehow empty -> exact legacy call.
                paymentResult = await this.walletService.createPaymentRequest(amount, description, user.id, socketId);
            }

            const expiresAt = paymentResult.expiresAt || new Date(Date.now() + 30 * 60 * 1000);

            // Store payment info in database (address_index enables monitoring restoration after restart)
            const insertResult = await this.db.query(`
                INSERT INTO payments (
                    user_id, socket_id, subaddress, expected_amount, payment_type, status,
                    description, created_at, expires_at, address_index, product_id, product_grants,
                    fairness_proof_version, fairness_offer_id, fairness_offer_issued_at,
                    fairness_commitment, fairness_server_seed, fairness_client_seed, fairness_bound_at,
                    provider_id, provider_invoice_id
                )
                VALUES (
                    $1, $2, $3, $4, $5, 'pending', $6, NOW(), $7, $8, $9, $10::jsonb,
                    $11, $12::varchar(64), $13, $14, $15, $16,
                    CASE WHEN $12::varchar(64) IS NULL THEN NULL ELSE NOW() END,
                    $17, $18
                )
                RETURNING id, expires_at
            `, [
                user.id,
                socketId,
                paymentResult.address,
                amount,
                paymentType,
                description,
                expiresAt,
                paymentResult.addressIndex ?? null,
                productId,
                JSON.stringify(ProductGrants.serializeProductGrants(productGrants)),
                paymentFairnessProof?.proofVersion || null,
                paymentFairnessProof?.offerId || null,
                paymentFairnessProof ? new Date(paymentFairnessProof.offerIssuedAt) : null,
                paymentFairnessProof?.commitment || null,
                paymentFairnessProof?.serverSeed || null,
                paymentFairnessProof?.clientSeed ?? null,
                provider?.id || 'native-monero',
                paymentResult.invoiceId || paymentResult.address
            ]);

            const insertedRow = insertResult.rows[0];
            
            return {
                id: insertedRow?.id,
                address: paymentResult.address,
                invoiceId: paymentResult.invoiceId || paymentResult.address,
                amount: money.toSafe(money.toBig(amount)),
                amountFormatted: this.formatAtomicHuman(amount, 4),
                currency: this.cryptoType,
                expiresAt: insertedRow?.expires_at || expiresAt,
                package: this._serializePackageInfo(packageInfo),
                paymentType,
                productId,
                grants: ProductGrants.publicGrantSummary(productGrants),
                fairnessProof: paymentFairnessProof,
                description,
                reused: false,
                expiredAddresses
            };
            
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to create payment request');
            console.error('❌ Error creating payment request:', normalized.message);
            throw normalized;
        }
    }

    /**
     * Get or create user record
     */
    /**
     * Resolve the database user for a socket.
     *
     * IDENTITY (Phase 2.1): The stable identity is `users.id`, established from the
     * client's `anon_token` by SessionManager at connection time. This method resolves
     * through that session identity FIRST, so every money/credit/payout path operates on
     * the same stable row. It only falls back to the legacy `socket_id` lookup-or-create
     * when no session exists (e.g. SessionManager not wired, or a REST call for a socket
     * with no live session) — `socket_id` is mutable and non-unique and must never be the
     * primary money key.
     */
    async getOrCreateUser(socketId, { create = true } = {}) {
        try {
            // 1. Prefer the stable identity established by SessionManager (anon_token -> id).
            if (this.sessionManager && typeof this.sessionManager.getBySocket === 'function') {
                try {
                    const sessionUser = await this.sessionManager.getBySocket(socketId);
                    if (sessionUser && sessionUser.id != null) {
                        // Return a FRESH row by stable id (the cached session row may be stale).
                        const fresh = await this.db.query(`SELECT * FROM users WHERE id = $1`, [sessionUser.id]);
                        if (fresh.rows.length > 0) {
                            await this.db.query(`UPDATE users SET last_active = NOW() WHERE id = $1`, [fresh.rows[0].id]);
                            return fresh.rows[0];
                        }
                    }
                } catch (sessErr) {
                    // Fall through to legacy resolution on any session-lookup error.
                }
            }

            // 2. Legacy fallback: look up by socket_id.
            let userResult = await this.db.query(`
                SELECT * FROM users WHERE socket_id = $1
            `, [socketId]);

            if (userResult.rows.length > 0) {
                await this.db.query(`
                    UPDATE users
                    SET last_active = NOW()
                    WHERE id = $1
                `, [userResult.rows[0].id]);

                return userResult.rows[0];
            }

            // Read-only callers (REST reads) pass { create: false }: never mint an orphan
            // row for a socket that has no user yet — return null and let them 404/handle it.
            if (!create) {
                return null;
            }

            // 3. Last resort: create a new user. This only fires when no session was
            // established for the socket (abnormal in normal flow, since every connection
            // creates a session) — log it so orphan-row creation is visible.
            userResult = await this.db.query(`
                INSERT INTO users (socket_id, ip_address)
                VALUES ($1, $2)
                RETURNING *
            `, [socketId, null]);

            console.warn(`👤 Created new user without a session (socket ${socketId}) — no anon_token identity resolved.`);
            return userResult.rows[0];

        } catch (error) {
            const normalized = normalizeError(error, 'Failed to load user');
            console.error('❌ Error getting/creating user:', normalized.message);
            throw normalized;
        }
    }

    /**
     * Set user payout address
     */
    async validatePayoutAddress(payoutAddress) {
        const address = typeof payoutAddress === 'string' ? payoutAddress.trim() : '';
        if (!address) return { valid: false, error: 'Address is empty' };

        // Payouts are sent by the native wallet service even when invoice creation is routed
        // through a checkout gateway, so its network-aware validator is authoritative.
        if (this.walletService && typeof this.walletService.validateAddress === 'function') {
            return this.walletService.validateAddress(address);
        }

        const provider = this.paymentProviders?.getProvider?.(this.cryptoType);
        if (provider && typeof provider.validateAddress === 'function') {
            return provider.validateAddress(this.cryptoType, address);
        }
        return { valid: false, error: 'No payout-address validator is available' };
    }

    async setUserPayoutAddress(socketId, payoutAddress) {
        try {
            const user = await this.getOrCreateUser(socketId);

            await this.db.query(`
                UPDATE users
                SET payout_address = $1,
                    updated_at = NOW()
                WHERE id = $2
            `, [payoutAddress, user.id]);

            const addressText = typeof payoutAddress === 'string' ? payoutAddress.trim() : '';
            const redactedAddress = addressText.length > 18
                ? `${addressText.slice(0, 10)}…${addressText.slice(-6)}`
                : (addressText ? '[redacted]' : '[cleared]');
            console.log(`💰 Set payout address for user ${user.id}: ${redactedAddress}`);

            // Reconcile any claimable match winnings this user earned with no address on file.
            // A match winner without a payout address is recorded as a durable 'needs_review'
            // liability (reason 'match_winner_no_address', sentinel address 'PENDING_NO_ADDRESS');
            // now that a real address exists, convert those to sendable 'pending' payouts and kick
            // the batcher. The reason filter is deliberately narrow so this NEVER touches the
            // ambiguous-broadcast 'needs_review' rows from the single-payout path (which have a real
            // address and a different reason) — converting those could double-pay.
            if (typeof payoutAddress === 'string' && payoutAddress.trim().length > 0) {
                try {
                    const reconciled = await this.db.query(`
                        UPDATE payouts
                        SET payout_address = $1, status = 'pending', last_error = NULL
                        WHERE user_id = $2
                          AND status = 'needs_review'
                          AND reason IN ('match_winner_no_address', 'solo_winner_no_address')
                          AND payout_address = 'PENDING_NO_ADDRESS'
                        RETURNING id
                    `, [payoutAddress.trim(), user.id]);
                    if (reconciled.rowCount > 0) {
                        console.log(`💰 Reconciled ${reconciled.rowCount} claimable payout(s) for user ${user.id} now that an address is set`);
                        if (typeof this._scheduleBatchPayout === 'function') this._scheduleBatchPayout();
                    }
                } catch (reconErr) {
                    // Never let reconciliation failure break address-setting.
                    const n = normalizeError(reconErr, 'Failed to reconcile claimable match payouts');
                    console.error('⚠️ Payout reconciliation error (address still saved):', n.message);
                }
            }
            return true;

        } catch (error) {
            const normalized = normalizeError(error, 'Failed to update payout address');
            console.error('❌ Error setting payout address:', normalized.message);
            return false;
        }
    }

    /**
     * Get user statistics
     */
    async getUserStats(socketId) {
        try {
            const result = await this.db.query(`
                SELECT * FROM get_user_stats($1)
            `, [socketId]);
            
            if (result.rows.length > 0) {
                return result.rows[0];
            }
            
            return {
                total_games: 0,
                games_won: 0,
                win_rate: 0,
                total_paid: 0,
                total_won: 0,
                net_profit: 0,
                credits_remaining: 0
            };
            
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to load user stats');
            console.error('❌ Error getting user stats:', normalized.message);
            return null;
        }
    }

    /**
     * Get game mode info for frontend
     */
    getGameModeInfo() {
        // Debug: Log credits payout base value being sent
        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`📤 getGameModeInfo: creditsPayoutBaseValue = ${this.creditsPayoutBaseValue} (${this.formatAtomic(this.creditsPayoutBaseValue)} ${this.cryptoType})`);
        }
        
        // Determine if we should show a testnet warning
        // Only for XMR on stagenet/testnet - WOW only has mainnet
        const showTestnetWarning = this.cryptoType === 'XMR' && this.isTestNetwork;
        const testnetWarning = showTestnetWarning 
            ? `⚠️ STAGENET MODE: This server is using ${this.network} XMR. Do NOT send real mainnet XMR! Only ${this.network} XMR will be accepted.`
            : null;
        
        // Serialize atomic prices as exact numbers when safe, decimal strings otherwise.
        const packages = this.configSnapshot?.modes?.credits?.packages || [];
        const creditPackages = packages.map(pkg => ({
            id: pkg.id,
            label: pkg.label || pkg.id,
            credits: pkg.credits,
            price: money.toSafe(money.toBig(pkg.price)),
            bonus: pkg.bonus || 0,
            grants: ProductGrants.publicGrantSummary(ProductGrants.normalizeProductGrants(pkg, {
                credits: Number(pkg.credits || 0) + Number(pkg.bonus || 0)
            })),
            priceFormatted: this.formatAtomicHuman(
                money.toSafe(money.toBig(pkg.price)),
                2
            )
        }));
        const cosmeticProducts = this.getCosmeticProducts().map(product => ({
            id: product.id,
            label: product.label || product.id,
            price: money.toSafe(money.toBig(product.price)),
            grants: ProductGrants.publicGrantSummary(ProductGrants.normalizeProductGrants(product, { credits: 0 })),
            priceFormatted: this.formatAtomicHuman(
                money.toSafe(money.toBig(product.price)),
                2
            )
        }));
        
        return {
            release: this.releaseIdentity || {
                verified: false,
                id: null,
                commit: null
            },
            operatedProductProfileId: getOperatedProductProfile(process.env)?.id || null,
            mode: this.gameMode,
            freePlayEnabled: !!this.freePlayEnabled, // players may choose free play even on a paid instance
            cryptoType: this.cryptoType,
            currencyLabel: this.currencyLabel, // sXMR on stagenet, XMR on mainnet, WOW for Wownero
            gameName: this.gameName,           // Monerogue / Wownerogue
            network: this.network,
            isTestNetwork: this.isTestNetwork,
            testnetWarning: testnetWarning,
            singleGamePrice: this.singleGamePrice,
            singleGamePriceFormatted: this.formatAtomicHuman(this.singleGamePrice, 2),
            creditsPackagePrice: this.creditsPackagePrice,
            creditsPerGame: this.creditsPerGameCost,
            creditPackages: creditPackages,
            cosmeticProducts: cosmeticProducts,
            creditsPayoutBaseValue: this.creditsPayoutBaseValue,
            paymentsEnabled: this.paymentsEnabled,
            freePlayEnabled: this.freePlayEnabled,
            directModeEnabled: this.directModeEnabled,
            creditsModeEnabled: this.creditsModeEnabled,
            payoutsEnabled: this.payoutsEnabled,
            directPayoutsEnabled: this.isPayoutEnabledForMode('PAID_SINGLE'),
            creditsPayoutsEnabled: this.isPayoutEnabledForMode('PAID_CREDITS'),
            payoutMultipliers: {
                direct: this.getImplementedPayoutMultipliersForMode('PAID_SINGLE'),
                credits: this.getImplementedPayoutMultipliersForMode('PAID_CREDITS')
            },
            // Exact server-calculated amounts. The browser must never recreate money promises
            // with floating point multiplier arithmetic.
            payoutOutcomes: {
                direct: this._publicPayoutOutcomes('PAID_SINGLE'),
                credits: this._publicPayoutOutcomes('PAID_CREDITS')
            },
            features: {
                paymentRequired: this.paymentsEnabled,
                creditsSystem: this.creditsModeEnabled,
                payouts: this.isPayoutEnabledForMode('PAID_SINGLE')
                    || this.isPayoutEnabledForMode('PAID_CREDITS')
            },
            earlyEntry: {
                enabled: this.configSnapshot?.earlyEntry?.enabled ?? false,
                allowInFreeMode: this.configSnapshot?.earlyEntry?.allowInFreeMode ?? false,
                allowInCreditsMode: this.configSnapshot?.earlyEntry?.allowInCreditsMode ?? false
            },
            // Smirk wallet integration. Smirk only works on mainnet, so it is forced off on
            // any test network (stagenet/testnet) regardless of SMIRK_ENABLED.
            smirkEnabled: isSmirkEnabled(process.env),
            explorerTxUrl: process.env.EXPLORER_TX_URL || null,
            // Which top-level modes this instance offers. Solo (the single-player dungeon) is
            // on unless explicitly disabled; Tavern and Multiplayer are opt-in. The client uses
            // this to show/hide entry points, so any single mode can run on its own.
            modes: {
                solo: process.env.SOLO_ENABLED !== 'false',
                tavern: process.env.TAVERN_ENABLED === 'true',
                multiplayer: process.env.MULTIPLAYER_ENABLED === 'true',
                match: {
                    enabled: process.env.MATCH_ENABLED === 'true',
                    economies: this._getMatchEconomies(),
                    maxPlayers: parseInt(process.env.MATCH_MAX_PLAYERS, 10) || 4,
                    ...this._getMatchRulesetInfo()
                }
            }
        };
    }

    /** Fire-and-forget operator alert (no-op when no alertService is wired). */
    _alert(type, subject, html) {
        if (this.alertService && typeof this.alertService.sendAlert === 'function') {
            this.alertService.sendAlert(type, { subject, html }).catch(() => {});
        }
    }

    /**
     * Resolve the configured payout min/max (atomic BigInt) for a recorded game mode from
     * the runtime config snapshot, or null when unavailable (older config / no snapshot).
     */
    _payoutBoundsForMode(recordedPaymentMode) {
        const rules = this.configSnapshot?.payouts?.rules;
        if (!rules) return null;
        const rule = recordedPaymentMode === 'PAID_CREDITS' ? rules.credits : rules.direct;
        if (!rule) return null;
        const toBigOrNull = (v) => {
            if (v === undefined || v === null) return null;
            try { return money.toBig(v); } catch { return null; }
        };
        return { min: toBigOrNull(rule.minPayout), max: toBigOrNull(rule.maxPayout) };
    }

    _soloPayoutCommitment(gameRow, recordedPaymentMode, treasureFound) {
        let terms = gameRow.payout_terms || null;
        if (typeof terms === 'string') {
            try { terms = JSON.parse(terms); } catch (_) { terms = null; }
        }
        const hasCommittedTerms = !!(terms && Number(terms.version) >= 1);
        // New rows carry an immutable boolean. NULL is reserved for games that predate the
        // commitment migration and therefore retain the legacy live-policy fallback.
        const eligible = typeof gameRow.payout_eligible === 'boolean'
            ? gameRow.payout_eligible
            : this.isPayoutEnabledForMode(recordedPaymentMode);
        if (!eligible) return { eligible: false, terms };

        let amount;
        let multiplier;
        if (hasCommittedTerms) {
            amount = treasureFound ? terms.treasureAmount : terms.escapeAmount;
            multiplier = treasureFound ? terms.treasureMultiplier : terms.escapeMultiplier;
        } else if (gameRow.payout_escape_amount != null || gameRow.payout_treasure_amount != null) {
            amount = treasureFound ? gameRow.payout_treasure_amount : gameRow.payout_escape_amount;
            multiplier = treasureFound ? gameRow.payout_treasure_mult : gameRow.payout_escape_mult;
        } else {
            const live = this.calculatePayout(recordedPaymentMode, { treasureFound });
            amount = live.amount;
            multiplier = live.multiplier;
        }

        let amountBig;
        try { amountBig = money.toBig(amount); } catch (_) {
            throw new Error(`Invalid committed payout amount for game ${gameRow.id}`);
        }
        const toBigOrNull = (value) => {
            if (value === undefined || value === null || value === '') return null;
            try { return money.toBig(value); } catch (_) { return null; }
        };
        const liveBounds = hasCommittedTerms ? null : this._payoutBoundsForMode(recordedPaymentMode);
        const min = hasCommittedTerms ? toBigOrNull(terms.minAmount) : liveBounds?.min ?? null;
        const max = hasCommittedTerms ? toBigOrNull(terms.maxAmount) : liveBounds?.max ?? null;
        let capped = false;
        if (max !== null && amountBig > max) {
            amountBig = max;
            amount = max.toString();
            capped = true;
        }
        if (amountBig <= 0n || (min !== null && amountBig < min)) {
            return { eligible: true, belowMinimum: true, amount, multiplier, min, max, terms };
        }
        return { eligible: true, amount, amountBig, multiplier, min, max, capped, terms };
    }

    /**
     * Complete a game (called from socket handlers when game ends)
     * @param {string} socketId - Player's socket ID
     * @param {string} gameId - Game UUID
     * @param {boolean} won - Whether the player won (escaped)
     * @param {boolean} treasureFound - Whether treasure was found
     * @returns {object} payout / completion info
     */
    async completeGame(socketId, gameId, won, treasureFound, metrics = {}) {
        try {
            const outcome = await this.db.withTransaction(async (client) => {
                // Lock by immutable dungeon seed. Completion and any payout obligation are
                // committed in this one transaction; neither half can survive alone.
                const gameResult = await client.query(`
                    SELECT id, user_id, game_mode, status, treasure_found, payout_address,
                           payout_eligible, payout_terms,
                           payout_escape_amount, payout_treasure_amount,
                           payout_escape_mult, payout_treasure_mult
                    FROM games
                    WHERE dungeon_seed = $1
                    LIMIT 1
                    FOR UPDATE
                `, [gameId]);
                const game = gameResult.rows[0];
                if (!game) {
                    throw Object.assign(new Error('Durable game row not found'), { code: 'GAME_ROW_REQUIRED' });
                }

                const recordedPaymentMode = (game.game_mode || this.gameMode || 'FREE').toUpperCase();
                const finalStatuses = new Set(['won', 'lost', 'expired']);
                const recordedStatus = String(game.status || '').toLowerCase();
                const alreadyFinal = finalStatuses.has(recordedStatus);
                if (alreadyFinal) {
                    const existing = await client.query(`SELECT id, status FROM payouts WHERE game_id = $1 LIMIT 1`, [game.id]);
                    if (existing.rows.length || recordedStatus !== 'won' || game.payout_eligible !== true) {
                        return {
                            success: true,
                            mode: recordedPaymentMode,
                            payout: null,
                            reason: existing.rows.length ? 'Payout already processed' : 'Game already completed',
                            score: metrics.score ?? null
                        };
                    }
                }

                if (!alreadyFinal) {
                    await client.query(`
                        UPDATE games
                        SET status = $1,
                            outcome = COALESCE($2, outcome),
                            treasure_found = $3,
                            moves_made = COALESCE($4, moves_made),
                            duration_seconds = COALESCE($5, duration_seconds),
                            score = COALESCE($6, score),
                            completed_at = NOW(),
                            proof_revealed_at = NOW()
                        WHERE id = $7
                    `, [
                        won ? 'won' : 'lost',
                        metrics.outcome || metrics.reason || (won ? 'escaped' : null),
                        treasureFound,
                        metrics.moves ?? null,
                        metrics.durationSeconds ?? null,
                        metrics.score ?? null,
                        game.id
                    ]);

                    if (Number(metrics.score) > 0 && game.user_id != null) {
                        await client.query(`
                            UPDATE users SET high_score = GREATEST(COALESCE(high_score, 0), $1)
                            WHERE id = $2
                        `, [metrics.score, game.user_id]);
                    }
                }

                const completedAsWin = alreadyFinal ? recordedStatus === 'won' : won;
                const completedWithTreasure = alreadyFinal ? !!game.treasure_found : treasureFound;
                if (!completedAsWin) {
                    return { success: true, mode: recordedPaymentMode, payout: null, score: metrics.score ?? null };
                }

                const commitment = this._soloPayoutCommitment(game, recordedPaymentMode, completedWithTreasure);
                if (!commitment.eligible) {
                    return { success: true, mode: recordedPaymentMode, payout: null, score: metrics.score ?? null };
                }
                if (commitment.belowMinimum) {
                    return {
                        success: true,
                        mode: recordedPaymentMode,
                        payout: null,
                        reason: 'Below minimum payout',
                        score: metrics.score ?? null
                    };
                }

                const existing = await client.query(`SELECT id, status FROM payouts WHERE game_id = $1 LIMIT 1`, [game.id]);
                if (existing.rows.length > 0) {
                    return {
                        success: true,
                        mode: recordedPaymentMode,
                        payout: null,
                        reason: 'Payout already processed',
                        score: metrics.score ?? null
                    };
                }

                let user = null;
                if (game.user_id != null) {
                    const userResult = await client.query(`SELECT id, payout_address FROM users WHERE id = $1 LIMIT 1`, [game.user_id]);
                    user = userResult.rows[0] || null;
                }
                const lockedAddress = typeof game.payout_address === 'string' ? game.payout_address.trim() : '';
                const fallbackAddress = typeof user?.payout_address === 'string' ? user.payout_address.trim() : '';
                const payoutAddress = lockedAddress || fallbackAddress;
                const identityResolved = game.user_id != null && !!user;
                const sendable = identityResolved && !!payoutAddress;
                const status = sendable ? 'pending' : 'needs_review';
                const reason = !identityResolved
                    ? 'solo_winner_identity_review'
                    : (sendable
                        ? (completedWithTreasure ? 'escape_with_treasure' : 'escape')
                        : 'solo_winner_no_address');
                const inserted = await client.query(`
                    INSERT INTO payouts (user_id, game_id, payout_address, amount, multiplier, reason, status, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                    ON CONFLICT (game_id) WHERE game_id IS NOT NULL DO NOTHING
                    RETURNING id
                `, [
                    game.user_id,
                    game.id,
                    payoutAddress || NO_PAYOUT_ADDRESS_SENTINEL,
                    String(commitment.amount),
                    commitment.multiplier,
                    reason,
                    status
                ]);
                if (inserted.rows.length === 0) {
                    return {
                        success: true,
                        mode: recordedPaymentMode,
                        payout: null,
                        reason: 'Payout already processed',
                        score: metrics.score ?? null
                    };
                }

                return {
                    success: true,
                    mode: recordedPaymentMode,
                    payout: {
                        status: sendable ? 'queued' : 'needs_review',
                        payoutId: inserted.rows[0].id,
                        amount: commitment.amount,
                        multiplier: commitment.multiplier,
                        treasure: completedWithTreasure
                    },
                    capped: commitment.capped,
                    needsReview: !sendable,
                    identityResolved,
                    score: metrics.score ?? null
                };
            });

            if (outcome.capped) {
                console.warn(`⚠️ Committed payout for game ${gameId} exceeded its start-time cap and was capped.`);
                this._alert('payout_over_max', '⚠️ Payout capped at committed maximum', `<p>The committed payout for game <b>${gameId}</b> was capped at its start-time maximum.</p>`);
            }
            if (outcome.needsReview) {
                this._alert('payout_liability_needs_review', '⚠️ Solo payout liability needs review', `<p>Game <b>${gameId}</b> completed with a payout liability that cannot be dispatched automatically.</p>`);
            }
            if (outcome.payout?.status === 'queued') this._scheduleBatchPayout();
            return outcome;
        } catch (err) {
            const normalized = normalizeError(err, 'Failed to complete game');
            console.error('❌ completeGame error:', normalized.message);
            if (err?.code === 'GAME_ROW_REQUIRED') {
                this._alert('payout_unresolved_game', '⚠️ Game completion not committed', `<p>No durable games row exists for dungeon seed <b>${gameId}</b> (socket ${socketId}). Completion and payout were not committed.</p>`);
            }
            return { success: false, error: normalized.safeMessage, reason: err?.code === 'GAME_ROW_REQUIRED' ? 'Game row not resolved' : undefined };
        }
    }

    // ---- Batch Payout Processing ----

    /**
     * Repair historical/legacy half-completions that already carry an explicit committed
     * liability. New completions create the row atomically; this scan is the crash/migration
     * reconciliation path and deliberately ignores NULL/false eligibility.
     */
    async reconcileCompletedSoloLiabilities({ limit = 100 } = {}) {
        if (!this.db || this._isReconcilingSoloLiabilities) return { scanned: 0, created: 0, failed: 0 };
        this._isReconcilingSoloLiabilities = true;
        try {
            const candidates = await this.db.query(`
                SELECT g.dungeon_seed, g.treasure_found
                FROM games g
                WHERE g.status = 'won'
                  AND g.payout_eligible = TRUE
                  AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.game_id = g.id)
                ORDER BY g.completed_at ASC NULLS LAST, g.id ASC
                LIMIT $1
            `, [Math.max(1, Math.min(1000, parseInt(limit, 10) || 100))]);
            let created = 0;
            let failed = 0;
            for (const game of candidates.rows || []) {
                const result = await this.completeGame(
                    'solo-liability-reconciler',
                    game.dungeon_seed,
                    true,
                    !!game.treasure_found,
                    { reconcile: true }
                );
                if (result?.payout?.payoutId) created += 1;
                else if (!result?.success) failed += 1;
            }
            return { scanned: candidates.rows?.length || 0, created, failed };
        } finally {
            this._isReconcilingSoloLiabilities = false;
        }
    }

    /**
     * Schedule batch payout processing with a short debounce.
     * Multiple wins within the debounce window (5s) are batched into one transfer.
     * Also called on new block events as a safety net.
     */
    _scheduleBatchPayout() {
        if (!this.payoutsEnabled || this._isShuttingDown) return;
        if (typeof this.payoutDispatchAllowed === 'function' && !this.payoutDispatchAllowed()) return;
        if (this._batchPayoutTimer) clearTimeout(this._batchPayoutTimer);
        this._batchPayoutTimer = setTimeout(() => {
            this._batchPayoutTimer = null;
            if (this._isShuttingDown) return;
            if (typeof this.payoutDispatchAllowed === 'function' && !this.payoutDispatchAllowed()) return;
            this._processPendingPayouts().catch(err => {
                console.error('❌ Batch payout processing error:', err.message);
            });
        }, 5000);
    }

    /** Stop accepting scheduled payout work and cancel any debounce that has not fired yet. */
    shutdown() {
        this._isShuttingDown = true;
        this.beginGameAdmissionShutdown();
        if (this._batchPayoutTimer) {
            clearTimeout(this._batchPayoutTimer);
            this._batchPayoutTimer = null;
        }
    }

    /**
     * Process all pending payouts that haven't been sent yet.
     * Batches them into a single transfer_split call for efficiency.
     * Called by debounce timer and on new block events.
     */
    async _processPendingPayouts() {
        // Emergency/operator kill switch. Return before locking or changing any rows so pending
        // liabilities remain intact and can be resumed deliberately when payouts are re-enabled.
        if (!this.payoutsEnabled || this._isShuttingDown) return;
        if (typeof this.payoutDispatchAllowed === 'function' && !this.payoutDispatchAllowed()) return;
        // Prevent concurrent batch processing
        if (this._isBatchProcessing) return;
        this._isBatchProcessing = true;

        try {
            // Reconcile any explicit committed wins left by an older deployment before
            // dispatching pending rows. The kill switch above still prevents any wallet send.
            await this.reconcileCompletedSoloLiabilities({ limit: 100 });

            // Gather pending payouts inside a transaction with row-level locks.
            // FOR UPDATE SKIP LOCKED prevents the retry service from grabbing the same rows.
            const pending = await this.db.withTransaction(async (client) => {
                const result = await client.query(`
                    SELECT id, user_id, game_id, payout_address, amount, multiplier, reason
                    FROM payouts
                    WHERE status = 'pending' AND tx_hash IS NULL
                    ORDER BY created_at ASC
                    FOR UPDATE SKIP LOCKED
                `);
                // Mark as 'processing' so retry service won't touch them even after this tx commits
                if (result.rows.length > 0) {
                    const ids = result.rows.map(r => r.id);
                    await client.query(
                        `UPDATE payouts SET status = 'processing', last_retry_at = NOW() WHERE id = ANY($1)`,
                        [ids]
                    );
                }
                return result;
            });

            if (pending.rows.length === 0) return;

            // MONERO OUTPUT LOCKING: a spent output (incl. the change output) is locked for
            // ~10 blocks. If we don't have enough UNLOCKED balance to cover this batch right
            // now, DEFER it (revert to pending) instead of attempting a transfer that would
            // fail — the next batch interval and every new-block tick re-check, so it sends as
            // soon as outputs unlock. Batching already minimises how many change outputs we
            // create; this handles the "all outputs currently locked" window.
            try {
                const totalNeeded = money.sum(pending.rows.map(p => p.amount)); // BigInt atomic
                const bal = await this.walletService.getBalance();
                // Keep wallet atomic units exact even above Number.MAX_SAFE_INTEGER.
                const unlocked = (bal && !bal.error) ? money.toBig(bal.unlocked_balance) : null;
                if (unlocked === null) {
                    throw new Error('Wallet returned no authoritative unlocked balance');
                }
                if (unlocked !== null && unlocked < totalNeeded) {
                    const ids = pending.rows.map(p => p.id);
                    await this.db.query(
                        `UPDATE payouts SET status = 'pending', last_error = $2, last_retry_at = NOW() WHERE id = ANY($1)`,
                        [ids, 'Deferred: insufficient unlocked balance (Monero outputs locked ~10 blocks)']
                    ).catch(() => {});
                    console.warn(`⏳ Deferring ${pending.rows.length} payout(s): unlocked ${unlocked} < needed ${totalNeeded}. Outputs likely locked; will retry next block/interval.`);
                    return;
                }
            } catch (balErr) {
                // A failed reserve/liveness probe is not permission to attempt a transfer. Keep
                // the liabilities pending; a later healthy worker can re-evaluate them without an
                // ambiguous broadcast outcome.
                const ids = pending.rows.map(p => p.id);
                await this.db.query(
                    `UPDATE payouts SET status = 'pending', last_error = $2, last_retry_at = NOW()
                     WHERE id = ANY($1) AND status = 'processing'`,
                    [ids, 'Deferred: wallet unlocked balance could not be verified']
                ).catch(() => {});
                console.error('Payout balance pre-check failed; batch deferred:', balErr.message);
                return;
            }

            // The operator/health gate may flip while rows are being claimed or the wallet is
            // probed. Recheck immediately before the first possible broadcast and release the
            // claims without incrementing retries if dispatch is no longer authorized.
            if (typeof this.payoutDispatchAllowed === 'function' && !this.payoutDispatchAllowed()) {
                const ids = pending.rows.map(p => p.id);
                await this.db.query(
                    `UPDATE payouts SET status = 'pending', last_error = $2, last_retry_at = NOW()
                     WHERE id = ANY($1) AND status = 'processing'`,
                    [ids, 'Payout dispatch paused before wallet transfer']
                ).catch(() => {});
                return;
            }

            console.log(`📦 Processing batch of ${pending.rows.length} pending payout(s)`);

            // Build destinations for transfer_split
            const destinations = pending.rows.map(p => ({
                amount: p.amount,
                address: p.payout_address
            }));

            // Generate batch_id to link payouts processed together
            const batchId = require('uuid').v4();

            if (pending.rows.length === 1) {
                // Single payout — use processPayout for simpler flow
                const p = pending.rows[0];
                let observedTxHash = null;
                try {
                    const result = await this.walletService.processPayout({
                        userId: p.user_id,
                        gameId: p.game_id,
                        address: p.payout_address,
                        amount: p.amount,
                        multiplier: p.multiplier
                    });
                    const txHash = typeof result?.txHash === 'string' ? result.txHash.trim() : '';
                    if (result?.success !== true || !validTxHash(txHash)) {
                        throw new Error('Wallet did not return explicit success with one valid transaction hash');
                    }
                    observedTxHash = txHash;

                    // Store tx_hash + status + user stats atomically in one transaction
                    await this.db.withTransaction(async (client) => {
                        await client.query(
                            `UPDATE payouts SET tx_hash = $1, fee = $2, batch_id = $3, status = 'completed', processed_at = NOW() WHERE id = $4`,
                            [txHash, result.fee || null, batchId, p.id]
                        );
                        await client.query(
                            `UPDATE users SET total_amount_won = total_amount_won + $1, total_payouts_received = COALESCE(total_payouts_received, 0) + 1 WHERE id = $2`,
                            [p.amount, p.user_id]
                        );
                    });
                    console.log(`💸 Single payout ${p.id} completed: ${txHash}`);
                } catch (err) {
                    // Insufficient-unlocked-funds is a pre-broadcast error -> retry on the next
                    // batch run (revert to pending). ANY OTHER error is ambiguous: processPayout
                    // (transfer_split) may have broadcast on-chain even though the RPC response
                    // errored, and this row has a null tx_hash so the retry service's blockchain
                    // guard can't protect it — an auto-retry could DOUBLE-PAY. Mark 'needs_review'
                    // (retry service skips it) + alert, mirroring the batch path below.
                    // Once a valid hash was observed, broadcast is proven even if the following
                    // DB transaction failed. Preserve that evidence and never return the row to
                    // the automatic retry pool.
                    const fundsIssue = !observedTxHash && isInsufficientFundsError(err);
                    const status = fundsIssue ? 'pending' : 'needs_review';
                    console.error(`❌ Single payout ${p.id} failed -> ${status}:`, err.message);
                    await this.db.query(
                        `UPDATE payouts
                         SET status = $1, last_error = $2,
                             tx_hash = COALESCE($3, tx_hash), last_retry_at = NOW()
                         WHERE id = $4`,
                        [status, String(err.message).slice(0, 500), observedTxHash, p.id]
                    ).catch(() => {});
                    if (!fundsIssue && this.alertService && typeof this.alertService.sendAlert === 'function') {
                        this.alertService.sendAlert('single_payout_failed', {
                            subject: '⚠️ Payout failed — manual review required',
                            html: `<p>Single payout <b>${p.id}</b> failed and was marked <b>needs_review</b> to avoid a possible double-payout.</p>`
                                + `<p>Amount: ${p.amount} → ${p.payout_address}</p><p>Error: ${err.message}</p>`
                        }).catch(() => {});
                    }
                }
            } else {
                // Multiple payouts — batch via transfer_split with multiple destinations
                const ids = pending.rows.map(p => p.id);
                let observedTxHash = null;
                try {
                    const result = await this.walletService.processBatchPayout(destinations);

                    // A shared hash is safe only when the RPC explicitly reports one transaction
                    // for the complete destination set. Multiple split hashes cannot be mapped to
                    // individual liabilities from wallet-rpc's response and require review.
                    const hashes = Array.isArray(result?.tx_hash_list)
                        ? result.tx_hash_list.map(hash => String(hash || '').trim())
                        : [];
                    if (result?.success !== true || hashes.length !== 1 || !validTxHash(hashes[0])) {
                        throw new Error('Wallet returned ambiguous batch transaction-hash evidence');
                    }
                    const txHash = hashes[0];
                    observedTxHash = txHash;
                    const feePerPayout = result.totalFee != null
                        ? money.toSafe((money.toBig(result.totalFee) + BigInt(pending.rows.length) - 1n)
                            / BigInt(pending.rows.length))
                        : null;

                    // Mark the ENTIRE batch completed in a SINGLE transaction so we never
                    // leave some rows completed and others stranded mid-batch (which the old
                    // per-row loop did when the shared tx_hash hit the unique index).
                    await this.db.withTransaction(async (client) => {
                        await client.query(
                            `UPDATE payouts SET tx_hash = $1, fee = $2, batch_id = $3, status = 'completed', processed_at = NOW() WHERE id = ANY($4)`,
                            [txHash, feePerPayout, batchId, ids]
                        );
                        // Per-row stat increments inside the same transaction. Amounts are passed
                        // as DB values so Postgres does the BIGINT arithmetic (no JS float).
                        for (const p of pending.rows) {
                            await client.query(
                                `UPDATE users SET total_amount_won = total_amount_won + $1::bigint, total_payouts_received = COALESCE(total_payouts_received, 0) + 1 WHERE id = $2`,
                                [p.amount, p.user_id]
                            );
                        }
                    });
                    console.log(`💸 Batch payout completed: ${pending.rows.length} payouts in tx ${txHash}`);
                } catch (err) {
                    // An insufficient-unlocked-funds error is raised BEFORE broadcast (no tx
                    // went out), so it's safe to retry: revert to 'pending' and let the next
                    // run send it once outputs unlock — no operator alert needed (transient).
                    //
                    // ANY OTHER error is ambiguous: transfer_split may have broadcast on-chain
                    // even though the RPC response errored. Those rows have no tx_hash, so the
                    // retry service's blockchain guard can't protect them and an auto-retry
                    // could DOUBLE-PAY. Mark 'needs_review' (retry service skips it) + alert.
                    const fundsIssue = !observedTxHash && isInsufficientFundsError(err);
                    const status = fundsIssue ? 'pending' : 'needs_review';
                    console.error(`❌ Batch payout failed (${pending.rows.length} payouts) -> ${status}:`, err.message);
                    await this.db.query(
                        `UPDATE payouts
                         SET status = $1, last_error = $2,
                             tx_hash = COALESCE($4, tx_hash), last_retry_at = NOW()
                         WHERE id = ANY($3)`,
                        [status, String(err.message).slice(0, 500), ids, observedTxHash]
                    ).catch(() => {});
                    if (!fundsIssue && this.alertService && typeof this.alertService.sendAlert === 'function') {
                        this.alertService.sendAlert('batch_payout_failed', {
                            subject: '⚠️ Batch payout failed — manual review required',
                            html: `<p>A batch of ${pending.rows.length} payout(s) failed and was marked <b>needs_review</b> to avoid a possible double-payout.</p>`
                                + `<p>Payout IDs: ${ids.join(', ')}</p><p>Error: ${err.message}</p>`
                        }).catch(() => {});
                    }
                }
            }
        } catch (err) {
            console.error('❌ _processPendingPayouts error:', err.message);
        } finally {
            this._isBatchProcessing = false;
        }
    }
}

module.exports = GameModeManager;
