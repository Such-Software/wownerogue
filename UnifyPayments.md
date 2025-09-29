I'll first check if we've completed #4 (database indexes), then provide a comprehensive plan for the unified payment mode.

## 📊 Checking Database Indexes Status

Let me check what indexes have been applied:

```bash
# Check the migration file we created
cat src/migrations/004_security_improvements.sql | grep -E "CREATE INDEX|ALTER TABLE.*CONSTRAINT"
```

Looking at the migration file, we have:
- ✅ Created indexes for: games(user_id), games(status), payments(status), payments(created_at), users(last_seen)
- ✅ Added foreign key constraints for referential integrity
- ✅ Added audit_log and credit_transactions tables
- ⚠️ The migration had issues with CONCURRENTLY keyword (fixed by removing it)

**Status: #4 is PARTIALLY complete** - The indexes exist in the migration but we need to verify they were actually applied to the database.

## 🎯 Unified Payment Mode - Comprehensive Design Plan

After deep review of the codebase, here's my detailed plan for merging PAID_SINGLE and PAID_CREDITS into a unified, flexible payment system:

### 📋 Current State Analysis

**PAID_SINGLE Mode:**
- User pays per game
- Payment required for each game
- Payouts: 2x for escape, 3x for escape with treasure
- No credit system
- Simple flow: Pay → Play → Win/Lose → Payout

**PAID_CREDITS Mode:**
- User buys credit packages (10 credits for X WOW)
- Each game costs 1 credit
- Currently: Optional payouts (CREDITS_PAYOUT_ENABLED flag)
- Complex flow: Buy Credits → Play Multiple Games → Optional Payouts

**Code Locations:**
- Mode logic: gameModeManager.js
- Payment handling: paymentHandlers.js
- Queue management: queueManager.js
- Configuration: `.env` file with GAME_MODE, CREDITS_PAYOUT_ENABLED

### 🏗️ Unified Payment Architecture

```javascript
// New Unified Payment Configuration Structure
const UNIFIED_PAYMENT_CONFIG = {
    // Global payment system toggle
    paymentsEnabled: true,
    
    // Currency configuration
    currency: {
        symbol: 'WOW',
        decimals: 11,
        minPayment: BigInt('1e10'),  // 0.01 WOW minimum
        maxPayment: BigInt('1e14')   // 1000 WOW maximum
    },
    
    // Payment modes (both can be enabled simultaneously)
    modes: {
        // Direct pay-per-game mode
        direct: {
            enabled: true,
            price: BigInt('1e11'),  // 0.1 WOW per game
            requiresAddress: true,
            allowGuestPlay: false
        },
        
        // Credit package mode
        credits: {
            enabled: true,
            creditsPerGame: 1,
            requiresAddress: true,
            packages: [
                { id: 'small', credits: 10, price: BigInt('5e11'), bonus: 0 },
                { id: 'medium', credits: 25, price: BigInt('10e11'), bonus: 2 },
                { id: 'large', credits: 100, price: BigInt('35e11'), bonus: 15 }
            ],
            // Allow mixing - can buy credits even in direct mode
            allowMixedMode: true
        }
    },
    
    // Payout configuration (applies to both modes)
    payouts: {
        enabled: true,
        requiresKYC: false,  // Future: regulatory compliance
        
        // Payout rules by mode
        rules: {
            direct: {
                enabled: true,
                multipliers: {
                    escape: 2.0,
                    escapeWithTreasure: 3.0,
                    perfectRun: 5.0  // Future: no damage, fast time
                },
                minPayout: BigInt('1e10'),  // 0.01 WOW minimum
                maxPayout: BigInt('1e13')   // 10 WOW maximum per game
            },
            credits: {
                enabled: true,
                // Different multipliers for credit mode (operator choice)
                multipliers: {
                    escape: 1.5,
                    escapeWithTreasure: 2.0,
                    perfectRun: 3.0
                },
                // Credits mode uses base price for calculations
                baseValue: BigInt('5e10'),  // 0.05 WOW per credit
                minPayout: BigInt('1e10'),
                maxPayout: BigInt('5e12')   // 5 WOW maximum per game
            }
        },
        
        // Payout processing
        processing: {
            automatic: true,
            batchingEnabled: true,
            batchInterval: 300,  // 5 minutes
            confirmations: 1,
            maxRetries: 3
        }
    },
    
    // Promotional features
    promotions: {
        enabled: true,
        freeCredits: {
            onSignup: 0,
            onFirstPurchase: 2,
            referralBonus: 5
        },
        discounts: {
            enabled: false,
            bulkDiscount: 0.1,  // 10% off large packages
            happyHour: null     // Future: time-based discounts
        }
    },
    
    // Anti-abuse measures
    limits: {
        maxGamesPerHour: 60,
        maxPayoutsPerDay: 100,
        maxCreditPurchasePerDay: BigInt('1e14'),  // 1000 WOW
        cooldownBetweenGames: 5  // seconds
    }
};
```

### 📁 File Structure Refactoring

```
src/
├── payments/
│   ├── UnifiedPaymentManager.js     # NEW: Main payment orchestrator
│   ├── PaymentModeManager.js        # NEW: Handles mode logic
│   ├── CreditManager.js             # NEW: Credit operations
│   ├── PayoutManager.js             # NEW: Payout processing
│   ├── PaymentValidator.js          # NEW: Input validation
│   ├── moneroPayService.js          # EXISTING: Keep
│   ├── qrService.js                 # EXISTING: Keep
│   └── walletRPCService.js          # EXISTING: Keep
├── game/
│   ├── gameModeManager.js           # REFACTOR: Simplify to game logic only
│   └── ...
└── config/
    ├── paymentConfig.js              # NEW: Centralized config
    └── environmentValidator.js       # NEW: Validate .env settings
```

### 🔄 Migration Strategy

#### Phase 1: Database Schema Updates (Day 1)
```sql
-- New migrations/005_unified_payment_system.sql

-- Add payment mode tracking
ALTER TABLE payments ADD COLUMN payment_mode VARCHAR(20) DEFAULT 'direct';
ALTER TABLE payments ADD COLUMN credit_package_id VARCHAR(20);
ALTER TABLE payments ADD COLUMN credits_purchased INTEGER DEFAULT 0;

-- Add user preferences
ALTER TABLE users ADD COLUMN preferred_payment_mode VARCHAR(20) DEFAULT 'direct';
ALTER TABLE users ADD COLUMN total_credits_purchased INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN total_games_played INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN total_payouts_received BIGINT DEFAULT 0;

-- Add payout tracking improvements
CREATE TABLE IF NOT EXISTS payouts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    game_id INTEGER REFERENCES games(id),
    amount BIGINT NOT NULL,
    multiplier DECIMAL(3,1) NOT NULL,
    reason VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    tx_hash VARCHAR(64),
    created_at TIMESTAMP DEFAULT NOW(),
    processed_at TIMESTAMP,
    error_message TEXT
);

-- Add credit transaction types
ALTER TABLE credit_transactions ADD COLUMN transaction_type VARCHAR(20);
-- Types: 'purchase', 'game_fee', 'payout', 'bonus', 'refund', 'adjustment'

-- Indexes for performance
CREATE INDEX idx_payouts_status ON payouts(status);
CREATE INDEX idx_payouts_user_id ON payouts(user_id);
CREATE INDEX idx_payments_payment_mode ON payments(payment_mode);
```

#### Phase 2: Configuration System (Day 1-2)

```javascript
// src/config/paymentConfig.js
class PaymentConfigManager {
    constructor() {
        this.config = this.loadConfig();
        this.validateConfig();
    }
    
    loadConfig() {
        // Priority: Environment > Database > Defaults
        const config = { ...DEFAULT_CONFIG };
        
        // Load from environment
        if (process.env.PAYMENT_MODES) {
            const modes = process.env.PAYMENT_MODES.split(',');
            config.modes.direct.enabled = modes.includes('direct');
            config.modes.credits.enabled = modes.includes('credits');
        }
        
        // Payouts configuration
        config.payouts.enabled = process.env.PAYOUTS_ENABLED === 'true';
        config.payouts.rules.direct.enabled = 
            process.env.DIRECT_PAYOUTS_ENABLED !== 'false';
        config.payouts.rules.credits.enabled = 
            process.env.CREDIT_PAYOUTS_ENABLED === 'true';
        
        // Price configuration
        if (process.env.GAME_PRICE) {
            config.modes.direct.price = BigInt(process.env.GAME_PRICE);
        }
        
        return config;
    }
    
    validateConfig() {
        // Ensure at least one payment mode is enabled
        if (!this.config.modes.direct.enabled && 
            !this.config.modes.credits.enabled) {
            throw new Error('At least one payment mode must be enabled');
        }
        
        // Validate payout configuration
        if (this.config.payouts.enabled) {
            if (!this.config.modes.direct.enabled && 
                !this.config.payouts.rules.credits.enabled) {
                console.warn('Payouts enabled but no payout rules active');
            }
        }
        
        // Validate prices
        this.validatePrices();
        
        return true;
    }
    
    validatePrices() {
        const { direct, credits } = this.config.modes;
        
        if (direct.enabled && direct.price <= 0n) {
            throw new Error('Direct game price must be positive');
        }
        
        if (credits.enabled) {
            for (const pkg of credits.packages) {
                if (pkg.price <= 0n) {
                    throw new Error(`Credit package ${pkg.id} has invalid price`);
                }
                if (pkg.credits <= 0) {
                    throw new Error(`Credit package ${pkg.id} has invalid credit count`);
                }
            }
        }
    }
    
    // Dynamic configuration updates
    async updateConfig(updates) {
        // Validate updates
        const newConfig = { ...this.config, ...updates };
        
        // Test configuration
        const testManager = new PaymentConfigManager();
        testManager.config = newConfig;
        testManager.validateConfig();
        
        // Apply updates
        this.config = newConfig;
        
        // Persist to database for next restart
        await this.persistConfig();
        
        // Notify all connected clients
        this.broadcastConfigUpdate();
    }
}
```

#### Phase 3: Unified Payment Manager (Day 2-3)

```javascript
// src/payments/UnifiedPaymentManager.js
class UnifiedPaymentManager {
    constructor(config, walletService, db) {
        this.config = config;
        this.wallet = walletService;
        this.db = db;
        
        this.creditManager = new CreditManager(db, config);
        this.payoutManager = new PayoutManager(wallet, db, config);
        this.validator = new PaymentValidator(config);
        
        this.pendingPayments = new Map();
        this.activeGames = new Map();
    }
    
    // Unified game start flow
    async requestGameStart(userId, socketId) {
        const user = await this.db.getUser(userId);
        
        // Check if user has credits
        if (user.credits > 0 && this.config.modes.credits.enabled) {
            return this.startGameWithCredits(user, socketId);
        }
        
        // Check if direct payment is enabled
        if (this.config.modes.direct.enabled) {
            return this.startGameWithDirectPayment(user, socketId);
        }
        
        // Offer credit purchase if only credits mode
        if (this.config.modes.credits.enabled) {
            return {
                action: 'purchase_credits',
                packages: this.config.modes.credits.packages
            };
        }
        
        throw new Error('No payment method available');
    }
    
    async startGameWithCredits(user, socketId) {
        // Validate credit balance
        if (user.credits < this.config.modes.credits.creditsPerGame) {
            return {
                action: 'insufficient_credits',
                required: this.config.modes.credits.creditsPerGame,
                balance: user.credits,
                packages: this.config.modes.credits.packages
            };
        }
        
        // Deduct credits
        await this.creditManager.deductCredits(
            user.id, 
            this.config.modes.credits.creditsPerGame,
            'game_start'
        );
        
        // Start game
        return {
            action: 'game_start',
            mode: 'credits',
            creditsRemaining: user.credits - this.config.modes.credits.creditsPerGame
        };
    }
    
    async startGameWithDirectPayment(user, socketId) {
        // Check if user needs to set payout address
        if (this.config.payouts.enabled && !user.payout_address) {
            return {
                action: 'require_payout_address',
                message: 'Please set your payout address first'
            };
        }
        
        // Generate payment request
        const payment = await this.createPaymentRequest(
            user.id,
            this.config.modes.direct.price,
            'direct_game'
        );
        
        return {
            action: 'payment_required',
            payment: {
                address: payment.address,
                amount: payment.amount,
                qr: payment.qr,
                expires: payment.expires
            }
        };
    }
    
    // Handle game completion and payouts
    async processGameCompletion(gameId, outcome) {
        const game = await this.db.getGame(gameId);
        const user = await this.db.getUser(game.user_id);
        
        // Determine if payout is due
        const payoutConfig = this.getPayoutConfig(game.payment_mode);
        if (!payoutConfig.enabled) {
            return { payout: false };
        }
        
        // Calculate payout
        const payout = this.calculatePayout(game, outcome, payoutConfig);
        if (payout.amount <= 0n) {
            return { payout: false };
        }
        
        // Process payout
        const result = await this.payoutManager.processPayout(
            user,
            game,
            payout
        );
        
        return {
            payout: true,
            amount: payout.amount,
            multiplier: payout.multiplier,
            status: result.status,
            txHash: result.txHash
        };
    }
    
    calculatePayout(game, outcome, config) {
        let multiplier = 0;
        let baseAmount = 0n;
        
        // Determine base amount
        if (game.payment_mode === 'direct') {
            baseAmount = this.config.modes.direct.price;
        } else if (game.payment_mode === 'credits') {
            baseAmount = this.config.payouts.rules.credits.baseValue;
        }
        
        // Determine multiplier
        if (outcome.reason === 'escaped') {
            if (outcome.treasure) {
                multiplier = config.multipliers.escapeWithTreasure;
            } else {
                multiplier = config.multipliers.escape;
            }
            
            // Future: Perfect run bonus
            if (outcome.perfectRun) {
                multiplier = config.multipliers.perfectRun;
            }
        }
        
        // Calculate final amount
        const amount = BigInt(Math.floor(Number(baseAmount) * multiplier));
        
        // Apply limits
        const minPayout = config.minPayout;
        const maxPayout = config.maxPayout;
        
        if (amount < minPayout) return { amount: 0n, multiplier: 0 };
        if (amount > maxPayout) return { amount: maxPayout, multiplier };
        
        return { amount, multiplier };
    }
}
```

#### Phase 4: Credit Management System (Day 3)

```javascript
// src/payments/CreditManager.js
class CreditManager {
    constructor(db, config) {
        this.db = db;
        this.config = config;
    }
    
    async purchaseCredits(userId, packageId, paymentId) {
        const pkg = this.config.modes.credits.packages.find(p => p.id === packageId);
        if (!pkg) {
            throw new Error('Invalid credit package');
        }
        
        const client = await this.db.pool.connect();
        try {
            await client.query('BEGIN');
            
            // Add credits to user account
            const totalCredits = pkg.credits + pkg.bonus;
            await client.query(
                `UPDATE users 
                 SET credits = credits + $1,
                     total_credits_purchased = total_credits_purchased + $2
                 WHERE id = $3`,
                [totalCredits, pkg.credits, userId]
            );
            
            // Log transaction
            await client.query(
                `INSERT INTO credit_transactions
                 (user_id, amount, transaction_type, reason, payment_id)
                 VALUES ($1, $2, $3, $4, $5)`,
                [userId, totalCredits, 'purchase', `Package: ${packageId}`, paymentId]
            );
            
            // Add bonus credits if applicable
            if (pkg.bonus > 0) {
                await client.query(
                    `INSERT INTO credit_transactions
                     (user_id, amount, transaction_type, reason)
                     VALUES ($1, $2, $3, $4)`,
                    [userId, pkg.bonus, 'bonus', `Package ${packageId} bonus`]
                );
            }
            
            await client.query('COMMIT');
            
            return {
                success: true,
                creditsAdded: totalCredits,
                newBalance: await this.getBalance(userId)
            };
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
    
    async deductCredits(userId, amount, reason) {
        const client = await this.db.pool.connect();
        try {
            await client.query('BEGIN');
            
            // Check balance
            const balance = await this.getBalance(userId);
            if (balance < amount) {
                throw new Error('Insufficient credits');
            }
            
            // Deduct credits
            await client.query(
                `UPDATE users 
                 SET credits = credits - $1,
                     total_games_played = total_games_played + 1
                 WHERE id = $2`,
                [amount, userId]
            );
            
            // Log transaction
            await client.query(
                `INSERT INTO credit_transactions
                 (user_id, amount, transaction_type, reason)
                 VALUES ($1, $2, $3, $4)`,
                [userId, -amount, 'game_fee', reason]
            );
            
            await client.query('COMMIT');
            
            return {
                success: true,
                newBalance: balance - amount
            };
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
    
    async refundCredits(userId, amount, reason) {
        // Similar to purchaseCredits but for refunds
    }
    
    async getBalance(userId) {
        const result = await this.db.query(
            'SELECT credits FROM users WHERE id = $1',
            [userId]
        );
        return result.rows[0]?.credits || 0;
    }
    
    async getCreditHistory(userId, limit = 50) {
        const result = await this.db.query(
            `SELECT * FROM credit_transactions
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [userId, limit]
        );
        return result.rows;
    }
}
```

#### Phase 5: UI/UX Updates (Day 4)

```javascript
// Frontend changes needed
// html/js/network/socketHandlers.js additions

SocketHandlers.onPaymentModeSelection = function(data) {
    // Show available payment options
    if (data.modes.length === 1) {
        // Single mode - proceed directly
        this.proceedWithPaymentMode(data.modes[0]);
    } else {
        // Multiple modes - show selection UI
        UI.showPaymentModeSelection(data.modes);
    }
};

SocketHandlers.onCreditPackageSelection = function(data) {
    // Show credit packages
    const packages = data.packages.map(pkg => ({
        id: pkg.id,
        credits: pkg.credits + (pkg.bonus || 0),
        price: UI.formatCurrency(pkg.price),
        bonus: pkg.bonus > 0 ? `+${pkg.bonus} bonus!` : '',
        savings: this.calculateSavings(pkg)
    }));
    
    UI.showCreditPackages(packages);
};

SocketHandlers.onPayoutProcessed = function(data) {
    // Show payout notification
    const message = `Payout processed: ${UI.formatCurrency(data.amount)} (${data.multiplier}x)`;
    
    UI.showNotification(message, 'success');
    
    // Play appropriate sound
    if (data.multiplier >= 3) {
        AudioAlerts.playFile('big_win');
    } else {
        AudioAlerts.playFile('payout_received');
    }
};

// UI additions
UI.showPaymentModeSelection = function(modes) {
    const html = `
        <div class="payment-mode-selection">
            <h3>Select Payment Method</h3>
            ${modes.map(mode => `
                <div class="payment-option" data-mode="${mode.id}">
                    <h4>${mode.name}</h4>
                    <p>${mode.description}</p>
                    ${mode.price ? `<p class="price">${UI.formatCurrency(mode.price)}</p>` : ''}
                    ${mode.creditsAvailable ? `<p class="credits">Credits: ${mode.creditsAvailable}</p>` : ''}
                    <button onclick="UI.selectPaymentMode('${mode.id}')">
                        ${mode.buttonText}
                    </button>
                </div>
            `).join('')}
        </div>
    `;
    
    this.showModal(html);
};
```

### 🔧 Environment Configuration

```bash
# New .env configuration
# Payment System Configuration
PAYMENTS_ENABLED=true

# Payment Modes (comma-separated: direct,credits)
PAYMENT_MODES=direct,credits

# Direct Payment Configuration
DIRECT_PAYMENT_ENABLED=true
DIRECT_GAME_PRICE=100000000000  # 0.1 WOW
DIRECT_PAYOUTS_ENABLED=true
DIRECT_PAYOUT_ESCAPE=2.0
DIRECT_PAYOUT_TREASURE=3.0

# Credit System Configuration
CREDITS_ENABLED=true
CREDITS_PER_GAME=1
CREDITS_PAYOUTS_ENABLED=false  # Operator choice
CREDITS_PAYOUT_BASE=50000000000  # 0.05 WOW per credit
CREDITS_PAYOUT_ESCAPE=1.5
CREDITS_PAYOUT_TREASURE=2.0

# Credit Packages (JSON format)
CREDITS_PACKAGES='[
    {"id":"small","credits":10,"price":"500000000000","bonus":0},
    {"id":"medium","credits":25,"price":"1000000000000","bonus":2},
    {"id":"large","credits":100,"price":"3500000000000","bonus":15}
]'

# Mixed Mode Settings
ALLOW_MIXED_MODE=true  # Can use credits even in direct mode
PREFER_CREDITS_FIRST=true  # Use credits before requesting payment

# Payout Processing
PAYOUT_BATCH_ENABLED=true
PAYOUT_BATCH_INTERVAL=300  # 5 minutes
PAYOUT_MIN_AMOUNT=10000000000  # 0.01 WOW minimum
PAYOUT_MAX_PER_GAME=10000000000000  # 10 WOW maximum

# Anti-Abuse Limits
MAX_GAMES_PER_HOUR=60
MAX_PAYOUTS_PER_DAY=100
GAME_COOLDOWN_SECONDS=5
```

### 📈 Migration Timeline

**Week 1:**
- Day 1: Database schema updates, configuration system
- Day 2: UnifiedPaymentManager core implementation
- Day 3: CreditManager and PayoutManager
- Day 4: Frontend UI updates
- Day 5: Integration testing

**Week 2:**
- Day 1-2: Migrate existing data
- Day 3: Staging deployment and testing
- Day 4: Performance optimization
- Day 5: Production deployment

### ✅ Testing Strategy

```javascript
// Test scenarios to cover
describe('Unified Payment System', () => {
    test('Direct payment only mode', async () => {
        const config = { modes: { direct: { enabled: true }, credits: { enabled: false }}};
        // Test direct payment flow
    });
    
    test('Credits only mode', async () => {
        const config = { modes: { direct: { enabled: false }, credits: { enabled: true }}};
        // Test credit purchase and usage
    });
    
    test('Mixed mode - prefer credits', async () => {
        const config = { 
            modes: { direct: { enabled: true }, credits: { enabled: true }},
            preferCreditsFirst: true
        };
        // Test credits used before direct payment
    });
    
    test('Payout calculations - direct mode', async () => {
        // Test 2x and 3x multipliers
    });
    
    test('Payout calculations - credits mode', async () => {
        // Test different multipliers for credits
    });
    
    test('Anti-abuse limits', async () => {
        // Test rate limiting and max limits
    });
});
```

### 🎯 Benefits of This Approach

1. **Maximum Flexibility**: Operators can enable/disable any combination
2. **Backward Compatible**: Existing configurations continue to work
3. **Future Proof**: Easy to add new payment methods or payout rules
4. **Granular Control**: Different payout rates for different modes
5. **Player Choice**: Users can choose their preferred payment method
6. **Revenue Optimization**: Credit packages encourage bulk purchases
7. **Risk Management**: Configurable limits and anti-abuse measures

### 🚀 Implementation Priority

1. **High Priority (Days 1-3)**:
   - UnifiedPaymentManager
   - Configuration system
   - Database migrations
   - Basic mode switching

2. **Medium Priority (Days 4-5)**:
   - Credit management
   - Payout processing
   - UI updates
   - Testing

3. **Low Priority (Future)**:
   - Advanced analytics
   - A/B testing framework
   - Dynamic pricing
   - Loyalty rewards

This plan provides a robust, flexible payment system that can adapt to different business models while maintaining code simplicity and maintainability. The operator gains complete control over payment modes, pricing, and payout rules through simple configuration changes.