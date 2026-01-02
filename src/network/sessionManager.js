/**
 * SessionManager
 * Issues and resumes anonymous session tokens to persist credits & payout address across reconnects.
 */
const crypto = require('crypto');
const { normalizeError } = require('../utils/errors');

class SessionManager {
  constructor({ db, debugManager, gameModeManager }) {
    this.db = db;
    this.debugManager = debugManager;
    this.gameModeManager = gameModeManager;
    this.sessions = new Map(); // Memory cache
    this.cleanupInterval = null;
  }

  async initialize() {
    // Start cleanup timer for expired sessions
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 3600000); // Every hour
  }

  async resumeOrCreate({ socketId, ipAddress, resumeToken }) {
    try {
      // SECURE: Using parameterized query
      if (resumeToken) {
        const result = await this.db.query(
          'SELECT * FROM users WHERE anon_token = $1',
          [resumeToken]  // Parameterized to prevent injection
        );

        if (result.rows.length > 0) {
          const user = result.rows[0];

          // Update last seen and socket_id
          await this.db.query(
            'UPDATE users SET socket_id = $1, last_seen = NOW() WHERE id = $2',
            [socketId, user.id]  // Parameterized
          );

          // Update cache
          this.sessions.set(socketId, user);

          // Check for unprocessed payments (payment recovery)
          const recovered = await this.recoverPendingPayments(user.id, socketId);
          if (recovered.creditsRecovered > 0) {
            // Refresh user data after recovery
            const refreshed = await this.db.query('SELECT * FROM users WHERE id = $1', [user.id]);
            if (refreshed.rows.length > 0) {
              this.sessions.set(socketId, refreshed.rows[0]);
              user.credits = refreshed.rows[0].credits;
            }
          }

          if (this.debugManager.CONSOLE_LOGGING) console.log(`[SessionManager] Resumed session for user ${user.id}`);
          return {
            resumed: true,
            token: resumeToken,
            user: {
              ...user,
              socket_id: socketId
            },
            recovered
          };
        }
      }

      // Create new user with secure token
      const newToken = this.generateSecureToken();
      
      // SECURE: Using parameterized query for INSERT
      const result = await this.db.query(
        'INSERT INTO users (socket_id, ip_address, anon_token, created_at, last_seen) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *',
        [socketId, ipAddress, newToken]  // All parameterized
      );

      const newUser = result.rows[0];
      this.sessions.set(socketId, newUser);
      
      if (this.debugManager.CONSOLE_LOGGING) console.log(`[SessionManager] Created new anonymous user ${newUser.id}`);
      return {
        resumed: false,
        token: newToken,
        user: newUser
      };
    } catch (error) {
      const normalized = normalizeError(error, 'Failed to resume or create session');
      console.error('[SessionManager] Error in resumeOrCreate:', normalized.message);
      throw normalized;
    }
  }

  async getBySocket(socketId) {
    // Check cache first
    if (this.sessions.has(socketId)) {
      return this.sessions.get(socketId);
    }

    // SECURE: Parameterized query
    const result = await this.db.query(
      'SELECT * FROM users WHERE socket_id = $1',
      [socketId]  // Parameterized
    );

    if (result.rows.length > 0) {
      const user = result.rows[0];
      this.sessions.set(socketId, user);
      return user;
    }

    return null;
  }

  async updateUser(userId, updates) {
    // Build safe UPDATE query with parameterized values
    const allowedFields = ['credits', 'payout_address', 'last_seen'];
    const updateFields = [];
    const values = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        updateFields.push(`${key} = $${paramIndex++}`);
        values.push(value);
      }
    }

    if (updateFields.length === 0) {
      throw new Error('No valid fields to update');
    }

    values.push(userId);
    
    // SECURE: Fully parameterized UPDATE
    const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`;
    await this.db.query(query, values);

    // Clear cache to force refresh
    for (const [socketId, user] of this.sessions.entries()) {
      if (user.id === userId) {
        this.sessions.delete(socketId);
        break;
      }
    }
  }

  /**
   * Recover unprocessed confirmed payments for a user who disconnected
   * This handles credits_package payments that were confirmed but credits weren't added
   */
  async recoverPendingPayments(userId, socketId) {
    const result = { creditsRecovered: 0, paymentsProcessed: 0 };

    try {
      // Find confirmed credits_package payments that have no credits_purchased or 0
      // These are payments where the user disconnected before confirmation was processed
      const unprocessedPayments = await this.db.query(`
        SELECT p.id, p.payment_type, p.description, p.expected_amount, p.confirmed_at
        FROM payments p
        WHERE p.user_id = $1
          AND p.status = 'confirmed'
          AND p.payment_type = 'credits_package'
          AND (p.credits_purchased IS NULL OR p.credits_purchased = 0)
          AND p.confirmed_at > NOW() - INTERVAL '24 hours'
        ORDER BY p.confirmed_at ASC
      `, [userId]);

      if (unprocessedPayments.rows.length === 0) {
        return result;
      }

      for (const payment of unprocessedPayments.rows) {
        try {
          // Parse credits from description (e.g., "Wowngeon 10 credits package (WOW)")
          let creditsToAdd = 10; // Default fallback
          const desc = payment.description || '';
          const match = desc.match(/(\d+)\s*credits?/i);
          if (match) {
            creditsToAdd = parseInt(match[1], 10) || 10;
          }

          // Add credits to user
          const updateResult = await this.db.query(`
            UPDATE users
            SET credits = credits + $1,
                total_credits_purchased = COALESCE(total_credits_purchased, 0) + $1
            WHERE id = $2
            RETURNING credits
          `, [creditsToAdd, userId]);

          const newBalance = updateResult.rows[0]?.credits ?? 0;

          // Mark payment as processed
          await this.db.query(`
            UPDATE payments
            SET credits_purchased = $1
            WHERE id = $2
          `, [creditsToAdd, payment.id]);

          // Record credit transaction
          await this.db.query(`
            INSERT INTO credit_transactions (user_id, amount, reason, balance_after, transaction_type)
            VALUES ($1, $2, 'package_purchase_recovered', $3, 'purchase')
          `, [userId, creditsToAdd, newBalance]);

          result.creditsRecovered += creditsToAdd;
          result.paymentsProcessed++;

          console.log(`💰 [PaymentRecovery] Recovered ${creditsToAdd} credits for user ${userId} from payment ${payment.id}`);
        } catch (paymentError) {
          console.error(`[PaymentRecovery] Failed to process payment ${payment.id}:`, paymentError.message);
        }
      }

      if (result.creditsRecovered > 0) {
        console.log(`💰 [PaymentRecovery] Total recovered for user ${userId}: ${result.creditsRecovered} credits from ${result.paymentsProcessed} payments`);
      }
    } catch (error) {
      console.error('[PaymentRecovery] Error recovering payments:', error.message);
    }

    return result;
  }

  async cleanupExpiredSessions() {
    try {
      // SECURE: Parameterized query for cleanup
      const result = await this.db.query(
        `DELETE FROM users 
         WHERE last_seen < NOW() - INTERVAL '90 days' 
         AND credits = 0 
         RETURNING id`,
        []  // No parameters needed
      );

      if (result.rowCount > 0) {
        console.log(`[SessionManager] Cleaned up ${result.rowCount} expired sessions`);
      }
    } catch (error) {
      const normalized = normalizeError(error, 'Failed to cleanup expired sessions');
      console.error('[SessionManager] Error cleaning up sessions:', normalized.message);
    }
  }

  generateSecureToken() {
    return crypto.randomBytes(32).toString('base64url');
  }

  async rotateToken(userId) {
    const newToken = this.generateSecureToken();
    
    // SECURE: Parameterized query
    await this.db.query(
      'UPDATE users SET anon_token = $1 WHERE id = $2',
      [newToken, userId]
    );

    return newToken;
  }

  dispose() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessions.clear();
  }
}

module.exports = SessionManager;
