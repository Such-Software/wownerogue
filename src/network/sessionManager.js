/**
 * SessionManager
 * Issues and resumes anonymous session tokens to persist credits & payout address across reconnects.
 */
const { randomUUID } = require('crypto');

class SessionManager {
  constructor({ db, debugManager, gameModeManager }) {
    this.db = db;
    this.debugManager = debugManager;
    this.gameModeManager = gameModeManager;
  }

  async resumeOrCreate({ socketId, ipAddress, resumeToken }) {
    try {
      if (resumeToken) {
        const existing = await this.db.query(`SELECT * FROM users WHERE anon_token = $1 LIMIT 1`, [resumeToken]);
        if (existing.rows.length) {
          const row = existing.rows[0];
          await this.db.query(`UPDATE users SET socket_id = $1, last_seen = NOW() WHERE id = $2`, [socketId, row.id]);
          if (this.debugManager.CONSOLE_LOGGING) console.log(`[SessionManager] Resumed session ${row.id} via token.`);
          return { resumed: true, token: resumeToken, user: { ...row, socket_id: socketId } };
        }
      }
      // Create
      const token = randomUUID();
      const inserted = await this.db.query(`INSERT INTO users (socket_id, ip_address, anon_token) VALUES ($1,$2,$3) RETURNING *`, [socketId, ipAddress, token]);
      const row = inserted.rows[0];
      if (this.debugManager.CONSOLE_LOGGING) console.log(`[SessionManager] Created new anonymous user ${row.id}`);
      return { resumed: false, token, user: row };
    } catch (e) {
      console.error('SessionManager resumeOrCreate error:', e.message);
      throw e;
    }
  }

  async getBySocket(socketId) {
    const res = await this.db.query(`SELECT * FROM users WHERE socket_id = $1 LIMIT 1`, [socketId]);
    return res.rows[0] || null;
  }

  async rotateToken(socketId) {
    const token = randomUUID();
    const res = await this.db.query(`UPDATE users SET anon_token = $1, last_seen = NOW() WHERE socket_id = $2 RETURNING anon_token`, [token, socketId]);
    if (res.rows.length) return res.rows[0].anon_token;
    return null;
  }
}

module.exports = SessionManager;
