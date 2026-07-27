/**
 * SessionManager
 * Issues and resumes anonymous session tokens to persist credits & payout address across reconnects.
 */
const crypto = require('crypto');
const { normalizeError } = require('../utils/errors');
const { createFinancialRecoveryError } = require('../utils/financialRecoveryError');

class SessionManager {
  constructor({ db, debugManager, gameModeManager, io = null }) {
    this.db = db;
    this.debugManager = debugManager;
    this.gameModeManager = gameModeManager;
    this.io = io;
    this.sessions = new Map(); // Keyed by socket id
    this.cleanupInterval = null;
  }

  async initialize() {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 3600000); // Hourly
  }

  async resumeOrCreate({ socketId, ipAddress, resumeToken }) {
    try {
      if (resumeToken) {
        const result = await this.db.query(
          'SELECT * FROM users WHERE anon_token = $1',
          [resumeToken]
        );

        if (result.rows.length > 0) {
          const selectedUser = result.rows[0];

          const recovered = await this.recoverPendingPayments(selectedUser.id, socketId);

          // Compare-and-swap the bearer credential and socket ownership in one UPDATE. Two
          // concurrent resumes may both read the old token, but exactly one can consume it;
          // the losing connection is rejected instead of receiving an already-stale token.
          const issuedToken = this.generateSecureToken();
          const rotated = await this.db.query(`
            UPDATE users
            SET socket_id = $1, last_seen = NOW(), anon_token = $2
            WHERE id = $3 AND anon_token = $4
            RETURNING *
          `, [socketId, issuedToken, selectedUser.id, resumeToken]);
          if (rotated.rows.length !== 1) {
            const replayError = new Error('Session token was already consumed by another resume');
            replayError.code = 'SESSION_TOKEN_REPLAY';
            throw replayError;
          }
          const user = rotated.rows[0];

          // A bearer rotation revokes every older live socket for this stable user. Evict and
          // disconnect them before caching the newly authenticated socket.
          this.disconnectUserSessions([user.id], [], { exceptSocketId: socketId });
          this.sessions.set(socketId, user);

          if (this.debugManager.CONSOLE_LOGGING) console.log(`[SessionManager] Resumed session for user ${user.id}`);
          return {
            resumed: true,
            token: issuedToken,
            user: {
              ...user,
              socket_id: socketId
            },
            recovered
          };
        }
      }

      const newToken = this.generateSecureToken();

      const result = await this.db.query(
        'INSERT INTO users (socket_id, ip_address, anon_token, created_at, last_seen) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *',
        [socketId, ipAddress, newToken]
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
      if (error?.code === 'SESSION_TOKEN_REPLAY') throw error;
      const normalized = normalizeError(error, 'Failed to resume or create session');
      console.error('[SessionManager] Error in resumeOrCreate:', normalized.message);
      throw normalized;
    }
  }

  async getBySocket(socketId) {
    if (this.sessions.has(socketId)) {
      return this.sessions.get(socketId);
    }

    const result = await this.db.query(
      'SELECT * FROM users WHERE socket_id = $1',
      [socketId]
    );

    if (result.rows.length > 0) {
      const user = result.rows[0];
      this.sessions.set(socketId, user);
      return user;
    }

    return null;
  }

  async updateUser(userId, updates) {
    // Column names come from this allowlist only; values are always parameterized.
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

    const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`;
    await this.db.query(query, values);

    // Evict the cached row so the next getBySocket re-reads the updated columns.
    for (const [socketId, user] of this.sessions.entries()) {
      if (user.id === userId) {
        this.sessions.delete(socketId);
        break;
      }
    }
  }

  /**
   * Recover confirmed payments whose entitlement was never delivered: credits_package
   * invoices confirmed without credits added, and unconsumed single_game invoices.
   */
  async recoverPendingPayments(userId, socketId) {
    const result = { creditsRecovered: 0, paymentsProcessed: 0 };

    try {
      // Confirmed credits_package payments with credits_purchased null or 0: confirmation
      // was never processed through to a credit grant.
      const unprocessedPayments = await this.db.query(`
        SELECT p.id, p.payment_type, p.description, p.expected_amount, p.confirmed_at
        FROM payments p
        WHERE p.user_id = $1
          AND p.status = 'confirmed'
          AND p.payment_type = 'credits_package'
          AND (p.credits_purchased IS NULL OR p.credits_purchased = 0)
          AND p.confirmed_at > NOW() - INTERVAL '7 days'
        ORDER BY p.confirmed_at ASC
      `, [userId]);

      // Payments where credits_purchased is set but no matching ledger row exists, so the
      // balance was never actually moved.
      const orphanedPayments = await this.db.query(`
        SELECT p.id, p.credits_purchased, p.confirmed_at
        FROM payments p
        WHERE p.user_id = $1
          AND p.status = 'confirmed'
          AND p.payment_type = 'credits_package'
          AND p.credits_purchased > 0
          AND p.confirmed_at > NOW() - INTERVAL '7 days'
          AND NOT EXISTS (
            SELECT 1 FROM credit_transactions ct
            WHERE ct.user_id = p.user_id
              AND ct.amount = p.credits_purchased
              AND ct.reason IN ('package_purchase', 'package_purchase_recovered')
              AND ct.created_at >= p.confirmed_at - INTERVAL '1 minute'
          )
        ORDER BY p.confirmed_at ASC
      `, [userId]);

      // Both sets take the same recovery path.
      for (const orphan of orphanedPayments.rows) {
        unprocessedPayments.rows.push({
          id: orphan.id,
          payment_type: 'credits_package',
          description: null,
          expected_amount: null,
          confirmed_at: orphan.confirmed_at,
          _creditsFromRecord: orphan.credits_purchased
        });
      }

      // An empty credits_package set must not short-circuit the method: the single_game
      // recovery below still has to run.
      for (const payment of (unprocessedPayments.rows.length === 0 ? [] : unprocessedPayments.rows)) {
        try {
          // Prefer the stored credit count; otherwise parse it out of the description.
          let creditsToAdd = payment._creditsFromRecord || 0;
          if (!creditsToAdd) {
            creditsToAdd = 10; // Fallback when the description carries no count
            const desc = payment.description || '';
            const match = desc.match(/(\d+)\s*credits?/i);
            if (match) {
              creditsToAdd = parseInt(match[1], 10) || 10;
            }
          }
          const isOrphaned = !!payment._creditsFromRecord;

          // The row lock serializes recovery of a payment across instances, so a payment
          // cannot be credited twice.
          const recovered = await this.db.withTransaction(async (client) => {
            const lockResult = await client.query(`
              SELECT id, credits_purchased
              FROM payments
              WHERE id = $1
              FOR UPDATE
            `, [payment.id]);

            if (!lockResult.rows[0]) return null;

            // Idempotency marker differs per case: credits_purchased for a plain
            // unprocessed payment, an existing ledger row for an orphaned one.
            if (!isOrphaned) {
              if (lockResult.rows[0].credits_purchased && lockResult.rows[0].credits_purchased > 0) {
                return null; // Already processed
              }
            } else {
              const txCheck = await client.query(`
                SELECT 1 FROM credit_transactions
                WHERE user_id = $1
                  AND amount = $2
                  AND reason IN ('package_purchase', 'package_purchase_recovered')
                  AND created_at >= $3::timestamp - INTERVAL '1 minute'
                LIMIT 1
              `, [userId, creditsToAdd, payment.confirmed_at]);
              if (txCheck.rows.length > 0) {
                return null; // Already recovered
              }
            }

            const updateResult = await client.query(`
              UPDATE users
              SET credits = credits + $1,
                  total_credits_purchased = COALESCE(total_credits_purchased, 0) + $1
              WHERE id = $2
              RETURNING credits
            `, [creditsToAdd, userId]);

            const newBalance = updateResult.rows[0]?.credits ?? 0;

            // Marking the payment and writing the ledger row share the transaction with
            // the balance update, so all three commit together or not at all.
            await client.query(`
              UPDATE payments
              SET credits_purchased = $1
              WHERE id = $2
            `, [creditsToAdd, payment.id]);

            await client.query(`
              INSERT INTO credit_transactions (user_id, amount, reason, balance_after, transaction_type)
              VALUES ($1, $2, 'package_purchase_recovered', $3, 'purchase')
            `, [userId, creditsToAdd, newBalance]);

            return { creditsToAdd, newBalance };
          });

          if (recovered) {
            result.creditsRecovered += recovered.creditsToAdd;
            result.paymentsProcessed++;
            console.log(`💰 [PaymentRecovery] Recovered ${recovered.creditsToAdd} credits for user ${userId} from payment ${payment.id}`);
          } else {
            console.log(`ℹ️ [PaymentRecovery] Payment ${payment.id} already processed by another instance`);
          }
        } catch (paymentError) {
          console.error(`[PaymentRecovery] Failed to process payment ${payment.id}:`, paymentError.message);
        }
      }

      // Confirmed single_game payments no games row references were paid for but never
      // played. Grant the equivalent of one paid game in credits instead. Idempotent via
      // the per-payment entitlement grant and reason key.
      try {
        const creditsPerGame = (this.gameModeManager && this.gameModeManager.creditsPerGameCost) || 1;
        const unconsumed = await this.db.query(`
          SELECT p.id, p.confirmed_at
          FROM payments p
          WHERE p.user_id = $1
            AND p.status = 'confirmed'
            AND p.payment_type = 'single_game'
            AND p.confirmed_at > NOW() - INTERVAL '7 days'
            AND NOT EXISTS (SELECT 1 FROM games g WHERE g.payment_id = p.id)
            AND NOT EXISTS (
              SELECT 1 FROM payment_entitlement_grants peg WHERE peg.payment_id = p.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM credit_transactions ct
              WHERE ct.user_id = p.user_id AND ct.reason = 'single_game_recovered:' || p.id
            )
          ORDER BY p.confirmed_at ASC
        `, [userId]);

        for (const payment of unconsumed.rows) {
          try {
            const recovered = await this.db.withTransaction(async (client) => {
              // Re-check ownership, status and consumption under the lock so concurrent
              // instances cannot both credit the same invoice.
              const lock = await client.query(`
                SELECT id, user_id, status, payment_type
                FROM payments
                WHERE id = $1
                FOR UPDATE
              `, [payment.id]);
              if (!lock.rows[0]) return null;
              if (String(lock.rows[0].user_id) !== String(userId)
                  || lock.rows[0].status !== 'confirmed'
                  || lock.rows[0].payment_type !== 'single_game') return null;

              const gameCheck = await client.query(`SELECT 1 FROM games WHERE payment_id = $1 LIMIT 1`, [payment.id]);
              if (gameCheck.rows.length > 0) return null; // A game consumed it in the meantime

              const existingGrant = await client.query(
                `SELECT payment_id FROM payment_entitlement_grants WHERE payment_id = $1 FOR UPDATE`,
                [payment.id]
              );
              if (existingGrant.rows.length > 0) return null;

              const reason = `single_game_recovered:${payment.id}`;
              const dup = await client.query(
                `SELECT 1 FROM credit_transactions WHERE user_id = $1 AND reason = $2 LIMIT 1`,
                [userId, reason]
              );
              if (dup.rows.length > 0) {
                // Ledger rows written before migration 035 carry only the reason key. Treat
                // that key as authoritative: materialize the canonical grant marker for it
                // without granting credits again.
                await client.query(`
                  INSERT INTO payment_entitlement_grants (
                    payment_id, user_id, source, credits_granted, metadata
                  ) VALUES ($1, $2, 'single_game_recovery', $3, $4::jsonb)
                  ON CONFLICT (payment_id) DO NOTHING
                `, [payment.id, userId, creditsPerGame, JSON.stringify({ legacyReason: reason })]);
                return null;
              }

              // This unique payment-scoped marker is the grant claim. It is inserted before
              // the balance mutation in the same transaction, so concurrent recovery and a
              // later direct-game start cannot both consume the invoice.
              const grant = await client.query(`
                INSERT INTO payment_entitlement_grants (
                  payment_id, user_id, source, credits_granted, metadata
                ) VALUES ($1, $2, 'single_game_recovery', $3, $4::jsonb)
                ON CONFLICT (payment_id) DO NOTHING
                RETURNING payment_id
              `, [payment.id, userId, creditsPerGame, JSON.stringify({ reason })]);
              if (grant.rowCount !== 1) return null;

              const upd = await client.query(
                `UPDATE users SET credits = credits + $1 WHERE id = $2 RETURNING credits`,
                [creditsPerGame, userId]
              );
              const newBalance = upd.rows[0]?.credits ?? 0;
              await client.query(`
                INSERT INTO credit_transactions (
                  user_id, amount, reason, balance_after, transaction_type, payment_id
                ) VALUES ($1, $2, $3, $4, 'recovery', $5)
              `, [userId, creditsPerGame, reason, newBalance, payment.id]);
              return { creditsToAdd: creditsPerGame };
            });

            if (recovered) {
              result.creditsRecovered += recovered.creditsToAdd;
              result.paymentsProcessed++;
              console.log(`💰 [PaymentRecovery] Recovered unconsumed single_game payment ${payment.id} as ${recovered.creditsToAdd} credit(s) for user ${userId}`);
            }
          } catch (e) {
            console.error(`[PaymentRecovery] Failed to recover single_game payment ${payment.id}:`, e.message);
          }
        }
      } catch (e) {
        console.error('[PaymentRecovery] single_game recovery error:', e.message);
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
      // Only disposable anonymous users are deleted: long-idle, zero credits, no payout
      // address, and no history in any table referencing users through a RESTRICT/NO ACTION
      // foreign key. The NOT EXISTS guards keep the DELETE from aborting on an FK violation
      // and keep users with payments, payouts, or games on record.
      const result = await this.db.query(
        `DELETE FROM users u
         WHERE u.last_seen < NOW() - INTERVAL '90 days' AND u.credits = 0 AND u.payout_address IS NULL
           AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM payouts po WHERE po.user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM games g WHERE g.user_id = u.id)
         RETURNING u.id`,
        []
      );

      if (result.rowCount > 0) {
        console.log(`[SessionManager] Cleaned up ${result.rowCount} expired sessions`);
      }
    } catch (error) {
      const normalized = normalizeError(error, 'Failed to cleanup expired sessions');
      console.error('[SessionManager] Error cleaning up sessions:', normalized.message);
    }
  }

  /**
   * Finalize games left at status='active' by a server kill. On a fresh boot no game can
   * legitimately still be running, so every such row is an orphan: restore an exact,
   * durably recorded PAID_CREDITS debit and then settle the game's status. A mode label,
   * payment link, or current entry price is not debit evidence; direct-payment refunds go
   * through the explicit refund workflow. Repeat runs are safe: each game is locked FOR
   * UPDATE and skipped unless still 'active', and each restoration has a per-game ledger
   * key. index.js calls this at startup right after recoverPendingPayments.
   */
  async recoverOrphanedGames() {
    const summary = {
      ok: true,
      scanned: 0,
      finalized: 0,
      refunded: 0,
      creditsRefunded: 0,
      unresolved: []
    };
    let orphans;
    try {
      orphans = await this.db.query(
        `SELECT g.id
         FROM games g
         WHERE g.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM solo_restart_snapshots s WHERE s.game_id = g.id
           )
         ORDER BY g.id ASC`,
        []
      );
    } catch (error) {
      summary.ok = false;
      throw createFinancialRecoveryError('orphaned_solo_games', {
        ...summary,
        scanFailed: true,
        resolved: 0
      }, error);
    }

    const rows = orphans.rows || [];
    summary.scanned = rows.length;
    for (const orphan of rows) {
        try {
          const outcome = await this.db.withTransaction(async (client) => {
            // Re-check under the lock: another instance or a prior run may already have
            // finalized this game.
            const lock = await client.query(
              `SELECT g.id, g.user_id, g.game_mode, g.payment_id, g.status,
                      g.entry_consumed_at, g.entry_credits_spent
               FROM games g
               WHERE g.id = $1
                 AND NOT EXISTS (
                   SELECT 1 FROM solo_restart_snapshots s WHERE s.game_id = g.id
                 )
               FOR UPDATE`,
              [orphan.id]
            );
            const game = lock.rows[0];
            if (!game || game.status !== 'active') return null;

            const reason = `orphan_game_refunded:${game.id}`;
            let refunded = false;
            let creditsRefunded = 0;

            if (game.user_id) {
              // The per-game reason key makes the refund idempotent.
              const dup = await client.query(
                `SELECT 1 FROM credit_transactions WHERE user_id = $1 AND reason = $2 LIMIT 1`,
                [game.user_id, reason]
              );

              if (dup.rows.length === 0) {
                // Refund only against durable debit evidence. An active row labelled
                // PAID_CREDITS is not proof a credit was taken: a start can persist the game
                // and then fail before its transaction commits. The current configured cost
                // is not used either, since it may have changed since entry was accepted.
                const spent = Number(game.entry_credits_spent || 0);
                const doRefund = game.game_mode === 'PAID_CREDITS'
                  && game.entry_consumed_at != null
                  && Number.isSafeInteger(spent)
                  && spent > 0;

                if (doRefund) {
                  const upd = await client.query(
                    `UPDATE users SET credits = credits + $1 WHERE id = $2 RETURNING credits`,
                    [spent, game.user_id]
                  );
                  const newBalance = upd.rows[0]?.credits ?? 0;
                  await client.query(
                    `INSERT INTO credit_transactions (user_id, amount, reason, balance_after, transaction_type)
                     VALUES ($1, $2, $3, $4, 'refund')`,
                    [game.user_id, spent, reason, newBalance]
                  );
                  refunded = true;
                  creditsRefunded = spent;
                }
              }
            }

            const newStatus = refunded ? 'refunded' : 'expired';
            await client.query(
              `UPDATE games SET status = $1, completed_at = COALESCE(completed_at, NOW()) WHERE id = $2`,
              [newStatus, game.id]
            );

            return { refunded, creditsRefunded };
          });

          if (outcome) {
            summary.finalized++;
            if (outcome.refunded) {
              summary.refunded++;
              summary.creditsRefunded += outcome.creditsRefunded;
            }
          }
        } catch (e) {
          console.error(`[OrphanRecovery] Failed to recover game ${orphan.id}:`, e.message);
          summary.unresolved.push({ type: 'game', id: orphan.id });
        }
    }

    if (summary.unresolved.length > 0) {
      summary.ok = false;
      throw createFinancialRecoveryError('orphaned_solo_games', {
        ...summary,
        resolved: summary.finalized
      });
    }

    if (summary.finalized > 0) {
      console.log(`[OrphanRecovery] Finalized ${summary.finalized} orphaned game(s); refunded ${summary.refunded} (${summary.creditsRefunded} credits).`);
    }
    return summary;
  }

  generateSecureToken() {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Evict and disconnect cached sockets belonging to one or more stable users. Extra socket ids
   * cover sockets not present in the cache. Token rotation and wallet-account adoption call this
   * so an old live socket cannot keep exercising paid actions from a stale in-memory session.
   */
  disconnectUserSessions(userIds, extraSocketIds = [], { exceptSocketId = null } = {}) {
    const targetUsers = new Set((Array.isArray(userIds) ? userIds : [userIds])
      .filter(id => id != null)
      .map(String));
    const socketIds = new Set((Array.isArray(extraSocketIds) ? extraSocketIds : [extraSocketIds])
      .filter(Boolean));

    for (const [cachedSocketId, cachedUser] of this.sessions) {
      if (targetUsers.has(String(cachedUser?.id))) socketIds.add(cachedSocketId);
    }

    for (const staleSocketId of socketIds) {
      if (!staleSocketId || staleSocketId === exceptSocketId) continue;
      this.sessions.delete(staleSocketId);
      try {
        const socket = this.io?.sockets?.sockets?.get?.(staleSocketId);
        if (socket) socket.disconnect(true);
      } catch (_) {
        // DB token revocation is authoritative; socket teardown is best-effort defense in depth.
      }
    }
    return Array.from(socketIds).filter(id => id !== exceptSocketId);
  }

  async rotateToken(userId, presentedToken) {
    if (!presentedToken) {
      const missingToken = new Error('A presented token is required for rotation');
      missingToken.code = 'SESSION_TOKEN_REPLAY';
      throw missingToken;
    }
    const newToken = this.generateSecureToken();

    const rotated = await this.db.query(
      `UPDATE users SET anon_token = $1
       WHERE id = $2 AND anon_token = $3
       RETURNING id`,
      [newToken, userId, presentedToken]
    );
    if (rotated.rows.length !== 1) {
      const replayError = new Error('Session token was already consumed by another rotation');
      replayError.code = 'SESSION_TOKEN_REPLAY';
      throw replayError;
    }

    return newToken;
  }

  /**
   * Evict a socket's cached session row. Called on disconnect to bound the `sessions` map
   * and to keep stale rows from being served on reconnect. A later getBySocket re-reads
   * from the database.
   */
  removeSocket(socketId) {
    this.sessions.delete(socketId);
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
