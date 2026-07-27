const appRequire = require('./helpers/appRequire');
const express = appRequire('express');
const http = require('http');
const nacl = appRequire('tweetnacl');
const createAuthRoutes = require('../src/routes/auth');

function normalized(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function createStateDb(initialUsers) {
  const users = new Map(initialUsers.map(user => [user.id, { ...user }]));
  const challenges = new Map();
  let challengeId = 1;

  async function query(sql, params = []) {
    const text = normalized(sql);

    if (text.includes('SELECT id, socket_id, anon_token FROM users')) {
      const row = Array.from(users.values()).find(user =>
        user.socket_id === params[0] && user.anon_token === params[1]);
      return { rows: row ? [{ id: row.id, socket_id: row.socket_id, anon_token: row.anon_token }] : [] };
    }

    if (text.startsWith('INSERT INTO smirk_challenges')) {
      const [challenge, socketId, userId, token] = params;
      const user = users.get(userId);
      if (!user || user.socket_id !== socketId || user.anon_token !== token) return { rows: [] };
      const row = {
        id: challengeId++, challenge, socket_id: socketId, user_id: userId,
        used: false, expires_at: Date.now() + 300000
      };
      challenges.set(challenge, row);
      return { rows: [{ id: row.id }] };
    }

    if (text.startsWith('DELETE FROM smirk_challenges')) return { rows: [], rowCount: 0 };

    if (text.startsWith('UPDATE smirk_challenges SET used = TRUE')) {
      const [challenge, userId, socketId] = params;
      const row = challenges.get(challenge);
      if (!row || row.used || row.user_id !== userId || row.socket_id !== socketId
        || row.expires_at <= Date.now()) return { rows: [] };
      row.used = true;
      return { rows: [{ id: row.id }] };
    }

    if (text.includes('SELECT id FROM users WHERE id = $1 AND socket_id = $2 AND anon_token = $3 FOR UPDATE')) {
      const user = users.get(params[0]);
      return {
        rows: user && user.socket_id === params[1] && user.anon_token === params[2]
          ? [{ id: user.id }]
          : []
      };
    }

    if (text.includes('SELECT id, socket_id, payout_address FROM users WHERE smirk_public_key')) {
      const owner = Array.from(users.values()).find(user =>
        user.smirk_public_key === params[0] && user.id !== params[1]);
      return { rows: owner ? [{
        id: owner.id,
        socket_id: owner.socket_id,
        payout_address: owner.payout_address
      }] : [] };
    }

    if (text.startsWith('UPDATE users SET socket_id = NULL, anon_token = $1')) {
      const [newToken, userId, socketId, oldToken] = params;
      const user = users.get(userId);
      if (!user || user.socket_id !== socketId || user.anon_token !== oldToken) return { rows: [] };
      user.socket_id = null;
      user.anon_token = newToken;
      return { rows: [{ id: user.id }] };
    }

    if (text.startsWith('UPDATE users SET socket_id = $1, anon_token = $2')) {
      const [socketId, newToken, userId, provenKey] = params;
      const user = users.get(userId);
      if (!user || user.smirk_public_key !== provenKey) return { rows: [] };
      user.socket_id = socketId;
      user.anon_token = newToken;
      return { rows: [{ id: user.id, payout_address: user.payout_address }] };
    }

    if (text.includes('SELECT id FROM users WHERE socket_id = $1 FOR UPDATE')) {
      return {
        rows: Array.from(users.values())
          .filter(user => user.socket_id === params[0])
          .map(user => ({ id: user.id }))
      };
    }

    if (text.startsWith('UPDATE users SET smirk_public_key = $1')) {
      const [key, userId, socketId, token] = params;
      const user = users.get(userId);
      if (!user || user.socket_id !== socketId || user.anon_token !== token) return { rows: [] };
      user.smirk_public_key = key;
      return { rows: [{ id: user.id }] };
    }

    if (text.includes('SELECT smirk_public_key, payout_address FROM users WHERE anon_token = $1')) {
      const user = Array.from(users.values()).find(row => row.anon_token === params[0]);
      return { rows: user ? [{
        smirk_public_key: user.smirk_public_key,
        payout_address: user.payout_address
      }] : [] };
    }

    return { rows: [] };
  }

  return {
    users,
    challenges,
    query: jest.fn(query),
    withTransaction: jest.fn(async callback => callback({ query }))
  };
}

function makeSessionManager(tokens = []) {
  let index = 0;
  return {
    generateSecureToken: jest.fn(() => tokens[index++] || `generated-token-${index}`),
    disconnectUserSessions: jest.fn()
  };
}

async function startServer(db, sessionManager) {
  const app = express();
  app.use(express.json());
  app.use(createAuthRoutes({ db, sessionManager }));
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({
      error: err.safeMessage || err.message,
      code: err.code || 'ERROR'
    });
  });
  return new Promise(resolve => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function request(server, path, { body, token } = {}) {
  const { port } = server.address();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Session-Token'] = token;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body || {})
  });
  return {
    status: response.status,
    headers: response.headers,
    json: await response.json().catch(() => ({}))
  };
}

function signedLegacyProof(challenge, keyPair = nacl.sign.keyPair()) {
  const signature = nacl.sign.detached(Buffer.from(challenge, 'utf8'), keyPair.secretKey);
  return {
    keyPair,
    publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
    signature: Buffer.from(signature).toString('hex')
  };
}

describe('Smirk stable-session ownership', () => {
  test('public victim socket id is insufficient: challenge requires its matching bearer and stores user_id', async () => {
    const db = createStateDb([
      { id: 1, socket_id: 'victim-public-socket', anon_token: 'victim-secret' },
      { id: 2, socket_id: 'attacker-socket', anon_token: 'attacker-secret' }
    ]);
    const server = await startServer(db, makeSessionManager());
    try {
      const missing = await request(server, '/api/auth/smirk/challenge', {
        body: { socketId: 'victim-public-socket' }
      });
      expect(missing.status).toBe(401);

      const stolenId = await request(server, '/api/auth/smirk/challenge', {
        body: { socketId: 'victim-public-socket' }, token: 'attacker-secret'
      });
      expect(stolenId.status).toBe(403);
      expect(db.challenges.size).toBe(0);

      const legitimate = await request(server, '/api/auth/smirk/challenge', {
        body: { socketId: 'victim-public-socket' }, token: 'victim-secret'
      });
      expect(legitimate.status).toBe(200);
      expect(db.challenges.get(legitimate.json.challenge)).toMatchObject({
        user_id: 1,
        socket_id: 'victim-public-socket',
        used: false
      });
    } finally {
      server.close();
    }
  });

  test('a challenge issued to one stable user cannot be verified through another session', async () => {
    const db = createStateDb([
      { id: 1, socket_id: 'victim-socket', anon_token: 'victim-token', smirk_public_key: null },
      { id: 2, socket_id: 'attacker-socket', anon_token: 'attacker-token', smirk_public_key: null }
    ]);
    const server = await startServer(db, makeSessionManager());
    try {
      const issued = await request(server, '/api/auth/smirk/challenge', {
        body: { socketId: 'victim-socket' }, token: 'victim-token'
      });
      const proof = signedLegacyProof(issued.json.challenge);
      const crossed = await request(server, '/api/auth/smirk/verify', {
        body: {
          socketId: 'attacker-socket', challenge: issued.json.challenge,
          publicKey: proof.publicKey, signature: proof.signature
        },
        token: 'attacker-token'
      });

      expect(crossed.status).toBe(400);
      expect(db.users.get(1).smirk_public_key).toBeNull();
      expect(db.users.get(2).smirk_public_key).toBeNull();
    } finally {
      server.close();
    }
  });

  test('legitimate wallet linking still succeeds for the authenticated session', async () => {
    const db = createStateDb([
      { id: 1, socket_id: 'owner-socket', anon_token: 'owner-token', smirk_public_key: null }
    ]);
    const server = await startServer(db, makeSessionManager());
    try {
      const issued = await request(server, '/api/auth/smirk/challenge', {
        body: { socketId: 'owner-socket' }, token: 'owner-token'
      });
      const proof = signedLegacyProof(issued.json.challenge);
      const linked = await request(server, '/api/auth/smirk/verify', {
        body: {
          socketId: 'owner-socket', challenge: issued.json.challenge,
          publicKey: proof.publicKey, signature: proof.signature
        },
        token: 'owner-token'
      });

      expect(linked.status).toBe(200);
      expect(linked.json).toMatchObject({ success: true, linked: true });
      expect(db.users.get(1).smirk_public_key).toBe(proof.publicKey);
    } finally {
      server.close();
    }
  });

  test('wallet adoption atomically displaces the fresh row, rotates tokens, leaves one socket owner, and revokes live sessions', async () => {
    const ownerKeyPair = nacl.sign.keyPair();
    const ownerKey = Buffer.from(ownerKeyPair.publicKey).toString('hex');
    const db = createStateDb([
      {
        id: 1, socket_id: 'old-owner-socket', anon_token: 'old-owner-token',
        smirk_public_key: ownerKey, payout_address: 'owner-address'
      },
      {
        id: 2, socket_id: 'fresh-public-socket', anon_token: 'fresh-token',
        smirk_public_key: null, payout_address: null
      }
    ]);
    const sessionManager = makeSessionManager(['new-owner-token', 'revoked-fresh-token']);
    const server = await startServer(db, sessionManager);
    try {
      const issued = await request(server, '/api/auth/smirk/challenge', {
        body: { socketId: 'fresh-public-socket' }, token: 'fresh-token'
      });
      const proof = signedLegacyProof(issued.json.challenge, ownerKeyPair);
      const adopted = await request(server, '/api/auth/smirk/verify', {
        body: {
          socketId: 'fresh-public-socket', challenge: issued.json.challenge,
          publicKey: proof.publicKey, signature: proof.signature
        },
        token: 'fresh-token'
      });

      expect(adopted.status).toBe(200);
      expect(adopted.json).toMatchObject({
        success: true,
        adopted: true,
        sessionToken: 'new-owner-token',
        address: 'owner-address'
      });
      expect(db.users.get(1)).toMatchObject({
        socket_id: 'fresh-public-socket', anon_token: 'new-owner-token'
      });
      expect(db.users.get(2)).toMatchObject({
        socket_id: null, anon_token: 'revoked-fresh-token'
      });
      expect(Array.from(db.users.values()).filter(u => u.socket_id === 'fresh-public-socket'))
        .toHaveLength(1);
      expect(Array.from(db.users.values()).some(u => u.anon_token === 'old-owner-token')).toBe(false);
      expect(Array.from(db.users.values()).some(u => u.anon_token === 'fresh-token')).toBe(false);

      await new Promise(resolve => setImmediate(resolve));
      expect(sessionManager.disconnectUserSessions).toHaveBeenCalledWith(
        [2, 1],
        ['fresh-public-socket', 'old-owner-socket']
      );
    } finally {
      server.close();
    }
  });

  test('challenge issuance is bounded per IP', async () => {
    const db = createStateDb([
      { id: 1, socket_id: 'rate-socket', anon_token: 'rate-token', smirk_public_key: null }
    ]);
    const server = await startServer(db, makeSessionManager());
    try {
      for (let i = 0; i < 10; i += 1) {
        const result = await request(server, '/api/auth/smirk/challenge', {
          body: { socketId: 'rate-socket' }, token: 'rate-token'
        });
        expect(result.status).toBe(200);
      }
      const limited = await request(server, '/api/auth/smirk/challenge', {
        body: { socketId: 'rate-socket' }, token: 'rate-token'
      });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });
});
